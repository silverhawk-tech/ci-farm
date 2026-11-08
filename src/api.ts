import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Actors } from './actors.ts';
import type { Approvals } from './approvals.ts';
import type { Audit } from './audit.ts';
import type { Control } from './control.ts';
import { ACTIONS, GATED_ACTIONS, type Action, type Mode, type Policy } from './policy.ts';
import type { Totp } from './totp.ts';

// Local control API (plan R6). 127.0.0.1 only, Bearer tokens (never cookies, so no CSRF), Host and Origin checks against DNS rebinding,
// JSON only, small bodies. Approving and editing permissions are human-only AND need a verified TOTP code; agent tokens can never reach them.

export interface ApiDeps { health?: () => Record<string, unknown>; actors: Actors; control: Control; approvals: Approvals; audit: Audit; policy: Policy; totp: Totp; status: () => unknown; resources: () => unknown; runs: () => Promise<unknown>; staticDir?: string; port?: number; publicHost?: string }

const MAX_BODY = 64 * 1024;
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A declared oversize body is refused before reading a byte; an undeclared (chunked) one stops reading at the limit. The server timeouts below bound a slow sender.
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return reject(new Error('body too large'));
    let n = 0, done = false; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (done) return;
      n += c.length;
      if (n > MAX_BODY) { done = true; chunks.length = 0; req.pause(); reject(new Error('body too large')); } else chunks.push(c);
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

export function startApi(d: ApiDeps): Promise<{ server: Server; port: number }> {
  let lastAuthLog = 0, authFails = 0; // per server, so a restart or a second instance never shares counters
  let lockouts = 0;
  const flush = () => {
    if (authFails > 0) { d.audit.append({ actor: 'unknown', actorType: 'system', action: 'auth', result: 'denied', note: `${authFails} failed authentication(s)` }); authFails = 0; lastAuthLog = Date.now(); }
    if (lockouts > 0) { d.audit.append({ actor: 'system', actorType: 'system', action: 'totp_lockout', result: 'denied', note: `${lockouts} step-up request(s) refused while locked out` }); lockouts = 0; }
  };
  const timer = setInterval(() => { try { flush(); } catch { /* audit unavailable: the counters stay for the next tick */ } }, 60_000);
  timer.unref();
  const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };

  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      // publicHost = the HTTPS name a trusted reverse proxy (tailscale serve) shows to browsers; it reaches us as that Host header, and its origin is https.
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const allowedOrigins = [...allowedHosts.map((h) => `http://${h}`), ...(d.publicHost ? [`https://${d.publicHost}`] : [])];
      if (d.publicHost) allowedHosts.push(d.publicHost);
      if (!allowedHosts.includes(String(req.headers.host))) return send(res, 421, { error: 'bad host' }); // DNS rebinding
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'bad origin' }); // no cross-origin use
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/v1/health') return send(res, 200, { ok: true, ...(d.health?.() ?? {}) }); // no secrets: the watchdog reads tickAgeS to spot a stuck controller
      // The dashboard shell: static, holds no data and no secrets. Strict CSP: only our own files, no inline script or style, no framing.
      const asset = d.staticDir && ({ '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'] } as Record<string, [string, string]>)[path];
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        return void res.end(readFileSync(`${d.staticDir}/${asset[0]}`));
      }

      const auth = req.headers.authorization;
      const actor = d.actors.verify(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
      if (!actor) {
        authFails++;
        if (Date.now() - lastAuthLog > 60_000) flush(); // one row per minute, the timer flushes the remainder: no flooding, no token content
        return send(res, 401, { error: 'unauthorized' });
      }
      const human = actor.type === 'human';

      if (req.method === 'GET' && path === '/v1/status') { const r = await d.control.read(actor, 'status', d.status); return send(res, r.status === 'done' ? 200 : 403, r); }
      if (req.method === 'GET' && path === '/v1/resources') { const r = await d.control.read(actor, 'resources', d.resources); return send(res, r.status === 'done' ? 200 : 403, r); }
      if (req.method === 'GET' && path === '/v1/runs') { const r = await d.control.read(actor, 'runs', d.runs); return send(res, r.status === 'done' ? 200 : 403, r); }
      if (req.method === 'GET' && path === '/v1/audit') {
        const r = await d.control.read(actor, 'audit_read', () => ({ rows: d.audit.list(Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)), chain: d.audit.verify(), head: d.audit.head() }));
        return send(res, r.status === 'done' ? 200 : 403, r);
      }
      if (req.method === 'GET' && path === '/v1/approvals') { const r = await d.control.read(actor, 'status', () => d.approvals.list('pending')); return send(res, r.status === 'done' ? 200 : 403, r); }

      let m: RegExpMatchArray | null;
      if (req.method === 'POST' && (m = path.match(/^\/v1\/actions\/([a-z_]+)$/))) {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
        const body = (await readJson(req)) as Record<string, unknown>;
        // A human token alone is not enough for gated actions (agents share the OS account): a fresh TOTP code is required, and only checked for those.
        let stepUp = false;
        if (human && (GATED_ACTIONS as readonly string[]).includes(m[1]) && body.totp !== undefined) {
          if (d.totp.locked()) { lockouts++; return send(res, 429, { error: 'too many wrong codes; try again later' }); }
          stepUp = d.totp.verify(String(body.totp));
        }
        const { totp: _t, ...params } = body;
        const out = await d.control.perform(actor, m[1], params, { stepUp });
        return send(res, out.status === 'done' ? 200 : out.status === 'pending_approval' ? 202 : out.status === 'denied' ? 403 : out.status === 'needs_step_up' ? 428 : 422, out);
      }

      // Human-only, second factor required. Agent tokens stop here no matter what they send.
      if (req.method === 'POST' && (m = path.match(/^\/v1\/approvals\/(\d+)\/decide$/))) {
        if (!human) { d.audit.append({ actor: actor.name, actorType: actor.type, action: 'approve', result: 'denied', note: 'agent tokens cannot decide' }); return send(res, 403, { error: 'humans only' }); }
        const b = (await readJson(req)) as { verdict?: string; totp?: string };
        if (b.verdict !== 'approve' && b.verdict !== 'reject') return send(res, 422, { error: 'verdict must be approve or reject' });
        if (b.verdict === 'approve' && d.totp.locked()) { lockouts++; return send(res, 429, { error: 'too many wrong codes; try again later' }); }
        d.audit.append({ actor: actor.name, actorType: 'human', action: `approval_${b.verdict}`, target: { approval: Number(m[1]) }, result: 'intent' }); // intent first: no audit, no change
        const r = d.approvals.decide(Number(m[1]), actor.name, b.verdict, b.verdict === 'reject' || d.totp.verify(String(b.totp ?? '')));
        d.audit.append({ actor: actor.name, actorType: 'human', action: `approval_${b.verdict}`, target: { approval: Number(m[1]) }, result: r.ok ? 'done' : 'refused', approver: actor.name, note: r.reason });
        return send(res, r.ok ? 200 : 403, r);
      }
      if ((m = path.match(/^\/v1\/permissions\/([a-z][a-z0-9_-]{1,31})$/))) {
        if (!human) { d.audit.append({ actor: actor.name, actorType: actor.type, action: 'edit_policy', result: 'denied', note: 'agent tokens cannot read or edit the grid' }); return send(res, 403, { error: 'humans only' }); }
        if (req.method === 'GET') return send(res, 200, d.policy.matrix(m[1]));
        if (req.method === 'PUT') {
          const b = (await readJson(req)) as { action?: string; mode?: string; limits?: { perRun?: number; perHour?: number }; expires?: number; totp?: string };
          if (!b.action || !(ACTIONS as readonly string[]).includes(b.action) || !['deny', 'ask', 'allow'].includes(String(b.mode))) return send(res, 422, { error: 'bad action or mode' });
          if (d.totp.locked()) { lockouts++; return send(res, 429, { error: 'too many wrong codes; try again later' }); }
          d.audit.append({ actor: actor.name, actorType: 'human', action: 'edit_policy', target: { agent: m[1], action: b.action }, result: 'intent' });
          if (!d.totp.verify(String(b.totp ?? ''))) { d.audit.append({ actor: actor.name, actorType: 'human', action: 'edit_policy', target: { agent: m[1], action: b.action }, result: 'refused', note: 'step-up not verified' }); return send(res, 403, { error: 'step-up not verified' }); }
          const before = d.policy.matrix(m[1])[b.action] ?? null;
          d.policy.set(m[1], b.action as Action, b.mode as Mode, { limits: b.limits, expires: b.expires });
          d.audit.append({ actor: actor.name, actorType: 'human', action: 'edit_policy', target: { agent: m[1], action: b.action }, params: { before, after: { mode: b.mode, limits: b.limits, expires: b.expires } }, result: 'done', approver: actor.name });
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = (e as Error).message;
      const client = /too large|invalid JSON/.test(msg);
      if (/too large/.test(msg)) { res.setHeader('Connection', 'close'); res.once('finish', () => req.socket.destroy()); }
      return send(res, client ? 413 : 500, { error: client ? msg : 'internal error' });
    }
  });
  // Slow-sender limits (a valid token must not be able to hold many half-open requests): headers within 10 s, the whole request within 30 s, idle keep-alive 5 s. No connection cap: a cap would let a handful of slow sockets lock everyone else out, the timeouts bound each one instead.
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 5_000;
  server.on('close', () => clearInterval(timer));
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(d.port ?? 0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })); });
}
