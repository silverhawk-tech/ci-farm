import { connect } from 'node:net';

/** One request per connection, newline-delimited JSON. Used by controld; never logs request bodies (they can hold a JIT config). */
export function brokerCall<T = { ok: boolean; error?: string }>(socketPath: string, req: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath);
    let buf = '';
    s.setTimeout(30_000, () => s.destroy(new Error('broker timeout')));
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (d) => { buf += d; if (buf.length > 4_000_000) s.destroy(new Error('reply too large')); }); // a hostile or broken peer cannot make the caller buffer without bound
    s.on('error', reject);
    s.on('close', () => { try { resolve(JSON.parse(buf) as T); } catch { reject(new Error('broker closed without a valid reply')); } });
  });
}
