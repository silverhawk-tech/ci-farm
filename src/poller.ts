import { gh } from './github-app.ts';
import type { Project } from './registry.ts';

export interface Run { id: number; workflow_id: number; run_number: number; event: string; head_sha: string; head_branch: string | null; status: string;
  pull_requests: { number: number }[]; head_repository: { full_name: string } | null }
export interface Job { id: number; run_id: number; status: string; labels: string[]; runner_name?: string | null }
export interface Candidate { run: Run; job: Job; prNumber: number | null }

/**
 * Only pull_request runs supersede each other (same workflow + same PR: the newest wins, matching the repo's concurrency group, plan 6a).
 * Every other event is its own group, so a push or manual run is never suppressed by accident.
 */
const groupKey = (r: Run) => (r.event === 'pull_request' ? `${r.workflow_id}:${r.pull_requests[0]?.number}` : `run:${r.id}`);

/** Event, fork and identity rules, shared by scheduling and by the check of the job a runner actually picked up. Fails closed. */
export function runAllowed(project: Project, run: Run): boolean {
  if (!(project.allowed_events as string[]).includes(run.event)) return false;
  if (run.head_repository?.full_name.toLowerCase() !== project.repo.toLowerCase()) return false; // fork PR or unknown head repo
  if (run.event === 'pull_request' && run.pull_requests[0]?.number === undefined) return false; // PR identity required but unavailable
  if (run.event === 'push' && !(run.head_branch && project.push_branches.includes(run.head_branch))) return false; // only the listed protected branches
  return true;
}

/** Newest run of each group among ALL active runs (queued or in progress), then only those that pass runAllowed. */
export function currentRuns(project: Project, active: Run[]): Run[] {
  const newest = new Map<string, Run>();
  for (const r of active) {
    const k = groupKey(r), cur = newest.get(k);
    if (!cur || r.run_number > cur.run_number) newest.set(k, r);
  }
  return [...newest.values()].filter((r) => runAllowed(project, r));
}

/** Pure decision: queued jobs, with our unique label, of current and allowed runs. */
export function selectEligible(project: Project, active: Run[], jobsByRun: Map<number, Job[]>): Candidate[] {
  const out: Candidate[] = [];
  for (const run of currentRuns(project, active)) {
    for (const job of jobsByRun.get(run.id) ?? []) {
      if (job.status === 'queued' && job.labels.includes(project.unique_label)) out.push({ run, job, prNumber: run.pull_requests[0]?.number ?? null });
    }
  }
  return out;
}

export const MAX_PAGES = 5;
/** All pages of a list endpoint, or an error: if there are more than we are willing to read, we cannot judge currentness, so fail closed. */
export async function listAll<T>(token: string, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh<Record<string, T[]>>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    out.push(...r[key]);
    if (r[key].length < 100) return out;
  }
  throw new Error(`more than ${MAX_PAGES * 100} items at ${path.split('?')[0]}; refusing to decide`);
}

/**
 * One list of the most recent runs of ALL statuses = one consistent snapshot (separate queued/in_progress queries could miss a run that
 * changes status between them). ponytail: only the newest 500 runs are read; GitHub expires queued runs after 24 h, so older ones are not live.
 */
export async function fetchRecentRuns(token: string, repo: string): Promise<Run[]> {
  const recent: Run[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh<{ workflow_runs: Run[] }>(`/repos/${repo}/actions/runs?per_page=100&page=${page}`, token);
    recent.push(...r.workflow_runs);
    if (r.workflow_runs.length < 100) break;
  }
  return recent;
}

/** Read-only fetch for one project. Refuses non-private repos (plan 4: private only), re-checked on every call, so also right before minting. */
export async function fetchQueue(token: string, project: Project): Promise<Candidate[]> {
  const repo = await gh<{ private: boolean }>(`/repos/${project.repo}`, token);
  if (repo.private !== true) throw new Error(`${project.repo} is not private; refusing to schedule`);
  const recent = await fetchRecentRuns(token, project.repo);
  const active = recent.filter((r) => r.status !== 'completed');
  const jobsByRun = new Map<number, Job[]>();
  for (const r of currentRuns(project, active)) jobsByRun.set(r.id, await listAll<Job>(token, `/repos/${project.repo}/actions/runs/${r.id}/jobs?filter=latest`, 'jobs'));
  return selectEligible(project, active, jobsByRun);
}

/** Last check before minting: is this job still eligible right now (not cancelled, not superseded, repo still private)? */
export async function stillEligible(token: string, project: Project, c: Candidate): Promise<boolean> {
  return (await fetchQueue(token, project)).some((x) => x.job.id === c.job.id && x.run.head_sha === c.run.head_sha);
}
