import { createServer, type Server } from 'node:net';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { allowUnpinnedImage, isPinnedImage, type IsolationBackend } from './launcher.ts';
import type { Project } from './registry.ts';

// The broker is the only process that talks to Docker (runs as ci-run). controld connects over a Unix socket in a setgid directory whose
// group is ci-control; only that group can connect (Node cannot read SO_PEERCRED, so the filesystem is the access check; plan 3, item 3).
// Callers say WHAT to run (project + reservation id). Image and resource limits come from the broker's own registry, never from the request,
// and the broker enforces its own slot limits so a compromised controld cannot start containers without bound.
const id = z.string().regex(/^[0-9a-f-]{36}$/);
const request = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), reservationId: id, slot: z.number().int().min(1).max(16), project: z.string() }).strict(),
  z.object({ op: z.literal('deliver'), reservationId: id, jit: z.string().min(10).max(16384) }).strict(),
  z.object({ op: z.literal('stop'), reservationId: id }).strict(),
  z.object({ op: z.literal('list') }).strict(),
  z.object({ op: z.literal('stats') }).strict(),
]);

export interface BrokerOptions { socketPath: string; backend: IsolationBackend; registry: Project[]; image: string; globalMaxSlots?: number; socketMode?: number }

export function startBroker(o: BrokerOptions): Promise<Server> {
  if (!isPinnedImage(o.image) && !allowUnpinnedImage()) throw new Error('slot image must be digest-pinned (or set CI_ALLOW_UNPINNED_IMAGE=1 for dev)');
  const globalMax = o.globalMaxSlots ?? o.registry.reduce((n, p) => n + p.max_slots, 0);
  // start requests are serialised so the count-then-launch check cannot race
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = chain.then(f, f); chain = r.catch(() => {}); return r; };

  const handle = async (raw: string, alive: () => boolean): Promise<unknown> => {
    const parsed = request.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ok: false, error: 'bad request' };
    const r = parsed.data;
    try {
      switch (r.op) {
        case 'start': return await serial(async () => {
          if (!alive()) return { ok: false, error: 'caller gone' }; // a start that waited in the queue past its client's timeout must not run later
          const p = o.registry.find((x) => x.name === r.project);
          if (!p) return { ok: false, error: 'unknown project' };
          const existing = await o.backend.list();
          if (existing.length >= globalMax) return { ok: false, error: 'global slot limit' };
          if (existing.filter((c) => c.project === p.name).length >= p.max_slots) return { ok: false, error: 'project slot limit' };
          if (existing.some((c) => c.slot === r.slot || c.reservationId === r.reservationId)) return { ok: false, error: 'slot or reservation already in use' };
          await o.backend.start({ reservationId: r.reservationId, slot: r.slot, project: p.name, image: o.image, memory: p.resources.memory, cpus: p.resources.cpus, pids: p.resources.pids });
          return { ok: true };
        });
        case 'deliver': await o.backend.deliverJit(r.reservationId, r.jit); return { ok: true };
        case 'stop': await o.backend.stop(r.reservationId); return { ok: true };
        case 'list': return { ok: true, containers: await o.backend.list() };
        case 'stats': return { ok: true, stats: await o.backend.stats() };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) }; // backend errors never include the JIT config (it is on stdin only)
    }
  };

  const server = createServer((sock) => {
    let buf = '';
    let done = false;
    sock.setTimeout(30_000, () => sock.destroy());
    sock.on('data', (d) => {
      if (done) return;
      buf += d;
      if (buf.length > 32_768) return void sock.destroy(); // oversize request
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true; // exactly one request per connection: anything after the first newline is ignored
      sock.pause();
      handle(buf.slice(0, nl), () => !sock.destroyed).catch(() => ({ ok: false, error: 'bad request' })).then((res) => sock.end(JSON.stringify(res) + '\n'));
    });
    sock.on('error', () => {});
  });
  server.maxConnections = 8;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, () => { chmodSync(o.socketPath, o.socketMode ?? 0o660); resolve(server); });
  });
}
