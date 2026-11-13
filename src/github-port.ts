import { readFileSync } from 'node:fs';
import { gh, GitHubError, installationToken } from './github-app.ts';
import { deleteRunner, listRunners, mintJit } from './jit.ts';
import { fetchQueue, fetchRecentRuns, listAll, stillEligible, type Job, type Run } from './poller.ts';
import type { GithubPort } from './controld.ts';
import type { ActionsPort, RunProgress } from './control.ts';

export interface AppConfig { appId: number; installationId: number }

/** Real GitHub adapter for the orchestrator. The installation token lives only in memory (1 h, refreshed after 50 min). */
export function makeGithubPort(dir: string): GithubPort {
  const { appId, installationId } = JSON.parse(readFileSync(`${dir}/app.json`, 'utf8')) as AppConfig;
  const pem = readFileSync(`${dir}/secrets/github-app.pem`, 'utf8');
  let tok = '', exp = 0;
  const token = async () => {
    if (Date.now() > exp) { tok = await installationToken(appId, installationId, pem); exp = Date.now() + 50 * 60_000; }
    return tok;
  };
  return {
    queue: async (p) => fetchQueue(await token(), p),
    stillEligible: async (p, c) => stillEligible(await token(), p, c),
    mint: async (p, name) => mintJit(await token(), p.repo, { name, labels: [...p.labels, p.unique_label], runnerGroupId: p.runner_group_id }),
    removeRunner: async (repo, id) => deleteRunner(await token(), repo, id),
    listRunners: async (p) => listRunners(await token(), p.repo),
    // Which job did THIS runner actually take? A JIT runner is not bound to the job we reserved it for (plan 4a R1).
    jobByRunner: async (p, runnerName, reservedJobId) => {
      const t = await token();
      const find = (jobs: Job[]) => jobs.find((j) => j.runner_name === runnerName);
      const reserved = await gh<Job & { run_id: number }>(`/repos/${p.repo}/actions/jobs/${reservedJobId}`, t);
      let job = reserved.runner_name === runnerName ? reserved : undefined;
      let run: Run | undefined;
      if (!job) {
        const recent = await fetchRecentRuns(t, p.repo);
        for (const r of recent.filter((x) => x.status !== 'completed')) {
          job = find(await listAll<Job>(t, `/repos/${p.repo}/actions/runs/${r.id}/jobs?filter=latest`, 'jobs'));
          if (job) { run = r; break; }
        }
      }
      if (!job) return null;
      run ??= await gh<Run>(`/repos/${p.repo}/actions/runs/${job.run_id}`, t);
      return { job, run };
    },
    runnerBusy: async (repo, runnerId) => {
      try {
        const r = await gh<{ busy: boolean }>(`/repos/${repo}/actions/runners/${runnerId}`, await token());
        return r.busy;
      } catch (e) {
        if ((e instanceof GitHubError && e.status === 404) || (e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
  };
}

/** GitHub side of the control actions (Actions: write). Same installation token as minting, held only inside controld. */
/** Pure: progress of one run from its jobs. A finished job counts 1, a running job counts its finished steps / its steps, a queued job counts 0. */
export function runProgress(jobs: { name: string; status: string; conclusion?: string | null; steps?: { name: string; status: string }[] }[]): RunProgress | undefined {
  if (jobs.length === 0) return undefined;
  let sum = 0, done = 0, current: string | null = null;
  for (const j of jobs) {
    if (j.status === 'completed') { sum += 1; done += 1; continue; }
    const steps = j.steps ?? [];
    if (j.status === 'in_progress' && steps.length > 0) {
      sum += steps.filter((x) => x.status === 'completed').length / steps.length;
      current ??= steps.find((x) => x.status === 'in_progress')?.name ?? j.name;
    }
  }
  return { jobsDone: done, jobsTotal: jobs.length, percent: Math.min(99, Math.floor((sum / jobs.length) * 100)), current, jobs: jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion ?? null })) };
}

export function makeActionsPort(dir: string): ActionsPort {
  const { appId, installationId } = JSON.parse(readFileSync(`${dir}/app.json`, 'utf8')) as AppConfig;
  const pem = readFileSync(`${dir}/secrets/github-app.pem`, 'utf8');
  let tok = '', exp = 0;
  const token = async () => { if (Date.now() > exp) { tok = await installationToken(appId, installationId, pem); exp = Date.now() + 50 * 60_000; } return tok; };
  const progressCache = new Map<number, { at: number; value: RunProgress | undefined }>(); // 10 s: dashboard refreshes must not multiply GitHub calls
  const progressOf = async (repo: string, runId: number): Promise<RunProgress | undefined> => {
    const hit = progressCache.get(runId);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    const value = await gh<{ jobs: { name: string; status: string; conclusion?: string | null; steps?: { name: string; status: string }[] }[] }>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, await token()).then((r) => runProgress(r.jobs), () => undefined);
    progressCache.set(runId, { at: Date.now(), value });
    if (progressCache.size > 200) progressCache.delete(progressCache.keys().next().value as number);
    return value;
  };
  const post = async (repo: string, runId: number, suffix: string, method = 'POST') => void (await gh(`/repos/${repo}/actions/runs/${runId}${suffix}`, await token(), { method }));
  return {
    recentRuns: async (repo) => {
      const { workflow_runs } = await gh<{ workflow_runs: (Run & { name: string; display_title?: string | null; path: string; conclusion: string | null; created_at: string })[] }>(`/repos/${repo}/actions/runs?per_page=30`, await token());
      const live = new Map(await Promise.all(workflow_runs.filter((r) => r.status !== 'completed').map(async (r) => [r.id, await progressOf(repo, r.id)] as const)));
      return workflow_runs.map((r) => ({
        ...(live.get(r.id) ? { progress: live.get(r.id) } : {}),
        id: r.id, name: r.name, title: r.display_title ?? null, branch: r.head_branch, status: r.status, conclusion: r.conclusion, head_sha: r.head_sha, event: r.event, pr: r.pull_requests[0]?.number ?? null, created_at: r.created_at, workflow_path: r.path.split('@')[0],
        // within this page: a newer run of the same workflow and PR exists. The authoritative check still runs before any action.
        superseded: r.event === 'pull_request' && !!r.pull_requests[0] && workflow_runs.some((x) => x.workflow_id === r.workflow_id && x.pull_requests[0]?.number === r.pull_requests[0].number && x.run_number > r.run_number),
      }));
    },
    runInfo: async (repo, runId) => {
      const t = await token();
      const r = await gh<Run & { path: string; conclusion: string | null }>(`/repos/${repo}/actions/runs/${runId}`, t);
      // Currentness fails closed: no PR identity, a PR whose head moved, or no way to see all newer runs all count as superseded.
      let superseded = false;
      if (r.event === 'pull_request') {
        const pr = r.pull_requests[0];
        if (!pr) superseded = true;
        else {
          const cur = await gh<{ head: { sha: string } }>(`/repos/${repo}/pulls/${pr.number}`, t);
          if (cur.head.sha !== r.head_sha) superseded = true;
          else {
            let seen = false;
            for (let page = 1; page <= 5 && !seen && !superseded; page++) {
              const { workflow_runs } = await gh<{ workflow_runs: Run[] }>(`/repos/${repo}/actions/runs?per_page=100&event=pull_request&page=${page}`, t);
              for (const x of workflow_runs) {
                if (x.id === r.id) { seen = true; break; }
                if (x.workflow_id === r.workflow_id && x.pull_requests[0]?.number === pr.number && x.run_number > r.run_number) superseded = true;
              }
              if (workflow_runs.length < 100) break;
            }
            if (!seen && !superseded) superseded = true; // never found our own run in the recent history: cannot judge
          }
        }
      }
      return { head_sha: r.head_sha, status: r.status, conclusion: r.conclusion, workflow_path: r.path.split('@')[0], superseded };
    },
    cancel: (repo, id) => post(repo, id, '/cancel'),
    rerunFailed: (repo, id) => post(repo, id, '/rerun-failed-jobs'),
    rerunAll: (repo, id) => post(repo, id, '/rerun'),
    deleteRun: (repo, id) => post(repo, id, '', 'DELETE'),
  };
}
