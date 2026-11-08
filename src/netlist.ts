import { isIPv4, isIPv6 } from 'node:net';

// Strict parser for a list of source addresses (SSH allow-list, `from=` of a key). No host names, no wildcards, no zone ids, no /0:
// a typo must fail closed instead of widening access. `any` is accepted only when the caller says so, and then it must be the whole list.

export type AddrList = { any: true } | { any: false; v4: string[]; v6: string[] };

function one(item: string): { v4: boolean; text: string } {
  const m = /^([0-9a-fA-F:.]+)(?:\/([0-9]{1,3}))?$/.exec(item);
  if (!m) throw new Error(`not an address or CIDR: ${JSON.stringify(item.slice(0, 60))}`);
  const [, addr, prefix] = m;
  const v4 = isIPv4(addr);
  if (!v4 && !isIPv6(addr)) throw new Error(`not an IP address: ${JSON.stringify(addr)}`);
  if (v4 && addr.split('.').some((o) => o.length > 1 && o.startsWith('0'))) throw new Error(`ambiguous leading zero in ${addr}`);
  if (prefix !== undefined) {
    const n = Number(prefix);
    if (prefix.length > 1 && prefix.startsWith('0')) throw new Error(`bad prefix length in ${item}`);
    if (n < 1 || n > (v4 ? 32 : 128)) throw new Error(`prefix length out of range (1..${v4 ? 32 : 128}) in ${item}`);
  }
  return { v4, text: addr.toLowerCase() + (prefix !== undefined ? `/${Number(prefix)}` : '') };
}

export function parseAddrList(text: string, opts: { allowAny?: boolean } = {}): AddrList {
  const items = text.split(',').map((s) => s.trim());
  if (items.length > 64) throw new Error('too many entries (64 at most)');
  if (items.some((s) => s === '')) throw new Error('empty entry in the list');
  if (items.includes('any')) {
    if (!opts.allowAny) throw new Error("'any' is not allowed here");
    if (items.length !== 1) throw new Error("'any' must be the only entry");
    return { any: true };
  }
  const v4: string[] = [], v6: string[] = [];
  for (const it of items) { const r = one(it); (r.v4 ? v4 : v6).push(r.text); }
  return { any: false, v4: [...new Set(v4)], v6: [...new Set(v6)] };
}

/** The list as it is written into authorized_keys `from="..."` (comma separated, normalised). */
export const fromOption = (l: AddrList): string | null => (l.any ? null : [...l.v4, ...l.v6].join(','));
