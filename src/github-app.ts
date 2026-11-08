import { createSign } from 'node:crypto';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Short-lived JWT that authenticates as the GitHub App itself (RS256, max 10 min). */
export function appJwt(appId: number, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64u(sig)}`;
}

/** Carries the real HTTP status so callers classify refusals (4xx) separately from uncertain failures. */
export class GitHubError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export async function gh<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${init.method ?? 'GET'} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T; // 202/204 answers have no body
}

/** Installation token (1 h). Never log or print the returned value. */
export async function installationToken(appId: number, installationId: number, privateKeyPem: string): Promise<string> {
  const r = await gh<{ token: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(appId, privateKeyPem), { method: 'POST' });
  return r.token;
}
