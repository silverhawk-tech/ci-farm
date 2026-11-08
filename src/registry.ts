import { parse } from 'yaml';
import { z } from 'zod';

// Lane names that touch deploys or databases must never run on this machine (plan section 4, 8).
const SENSITIVE_LANE = /migrat|deploy|release|prod/i;

const project = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  labels: z.array(z.string().min(1)).min(1),
  max_slots: z.number().int().min(1).max(4),
  // Fork-PR-capable and privileged triggers are not offered at all; workflow_dispatch needs write access to the repo.
  allowed_events: z.array(z.enum(['push', 'pull_request', 'workflow_dispatch'])).min(1),
  // A push run is only scheduled when its branch is listed here (required whenever 'push' is allowed): anyone with write access can push a
  // branch that carries its own workflow, so the event alone proves nothing about which code runs.
  push_branches: z.array(z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/)).default([]),
  // Which isolation backend (broker, OS user, network rules) runs this project's slots. Every project today is in 'farm', the original single
  // broker; a project in any other group is only started when that group has its own broker socket configured (fail closed, see controld-main).
  isolation_group: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).default('farm'),
  runner_scope: z.literal('repo'),
  runner_group_id: z.number().int().positive(),
  unique_label: z.string().regex(/^ci-[a-z0-9-]{4,40}$/),
  rerun_allowed_workflows: z.array(z.string().regex(/^[\w.-]+\.ya?ml$/)).default([]),
  lanes: z.record(z.string(), z.enum(['self-hosted', 'github-hosted'])),
  resources: z.object({
    memory: z.string().regex(/^[1-9]\d*g$/),
    cpus: z.number().min(0.5).max(8),
    pids: z.number().int().min(256).max(32768),
  }),
}).superRefine((p, ctx) => {
  if (p.allowed_events.includes('push') && p.push_branches.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['push_branches'], message: "'push' needs push_branches (the protected branches that may run here)" });
  }
  for (const [lane, where] of Object.entries(p.lanes)) {
    if (SENSITIVE_LANE.test(lane) && where !== 'github-hosted') {
      ctx.addIssue({ code: 'custom', path: ['lanes', lane], message: 'deploy/migration lanes must stay github-hosted' });
    }
  }
});

// Several projects may share one repo (e.g. a PR lane and a push lane with different labels, limits and isolation groups). Names and unique
// labels stay globally unique: the label is what ties a queued job to exactly one project.
const registry = z.array(project).min(1).superRefine((ps, ctx) => {
  for (const key of ['name', 'unique_label'] as const) {
    const seen = new Set<string>();
    ps.forEach((p, i) => {
      const v = p[key].toLowerCase();
      if (seen.has(v)) ctx.addIssue({ code: 'custom', path: [i, key], message: `duplicate ${key}: ${p[key]}` });
      seen.add(v);
    });
  }
});

export type Project = z.infer<typeof project>;

export const DEFAULT_GROUP = 'farm';
/** The projects one broker may start: its own isolation group only. */
export const servedBy = (registry: Project[], group: string): Project[] => registry.filter((p) => p.isolation_group === group);

/** Parse and validate a registry file. Throws a readable error listing every problem. */
export function loadRegistry(yamlText: string): Project[] {
  const r = registry.safeParse(parse(yamlText));
  if (!r.success) {
    throw new Error('invalid registry:\n' + r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  return r.data;
}
