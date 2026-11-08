import { gh } from './github-app.ts';

export interface JitRunner { runnerId: number; runnerName: string; encodedJitConfig: string }

/** Runner names tie a container to its reservation and to THIS installation (plan 4a R1): cif-<instance>-<slot>-<first 8 of reservation id>. */
export const runnerPrefix = (instance: string) => `cif-${instance}-`;
export const runnerName = (instance: string, slot: number, reservationId: string) => `${runnerPrefix(instance)}${slot}-${reservationId.slice(0, 8)}`;

/**
 * Mint a single-use, repo-level JIT runner config. The returned encodedJitConfig is a credential:
 * hand it straight to the launcher, never log it, never store it (plan V9).
 */
export async function mintJit(
  installationToken: string,
  repo: string,
  opts: { name: string; labels: string[]; runnerGroupId: number },
): Promise<JitRunner> {
  const r = await gh<{ runner: { id: number; name: string }; encoded_jit_config: string }>(
    `/repos/${repo}/actions/runners/generate-jitconfig`,
    installationToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.name, runner_group_id: opts.runnerGroupId, labels: opts.labels, work_folder: '_work' }),
    },
  );
  return { runnerId: r.runner.id, runnerName: r.runner.name, encodedJitConfig: r.encoded_jit_config };
}

/** Remove a runner that never ran (or whose container died) so no stale registration stays on GitHub. */
export async function deleteRunner(installationToken: string, repo: string, runnerId: number): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runners/${runnerId}`, {
    method: 'DELETE',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${installationToken}` },
  });
  if (res.status !== 204 && res.status !== 404) throw new Error(`GitHub DELETE runner ${runnerId} -> ${res.status}`); // 404: already gone, fine
}

/** Runners registered on the repo (name + id), for reconciling registrations that have no reservation (crash between mint and persist). */
export async function listRunners(installationToken: string, repo: string): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh<{ runners: { id: number; name: string }[] }>(`/repos/${repo}/actions/runners?per_page=100&page=${page}`, installationToken);
    out.push(...r.runners.map(({ id, name }) => ({ id, name })));
    if (r.runners.length < 100) return out;
  }
  throw new Error('more than 1000 runners; refusing to sweep');
}
