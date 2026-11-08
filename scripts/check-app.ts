// Read-only check of the GitHub App install. Run as ci-control. Prints names and permissions, never tokens.
import { readFileSync } from 'node:fs';
import { appJwt, gh, installationToken } from '../src/github-app.ts';
import { loadRegistry } from '../src/registry.ts';

const dir = process.env.CI_CONTROL_DIR ?? '/var/lib/ci-control';
const { appId, installationId } = JSON.parse(readFileSync(`${dir}/app.json`, 'utf8')) as { appId: number; installationId: number };
const pem = readFileSync(`${dir}/secrets/github-app.pem`, 'utf8');

const app = await gh<{ slug: string; owner: { login: string }; permissions: Record<string, string>; events: string[] }>('/app', appJwt(appId, pem));
console.log(`app: ${app.slug} (owner ${app.owner.login})`);
console.log(`permissions: ${JSON.stringify(app.permissions)}`);
console.log(`webhook events subscribed: ${app.events.length === 0 ? 'none (good)' : app.events.join(',')}`);

const token = await installationToken(appId, installationId, pem);
const repos = await gh<{ total_count: number; repositories: { full_name: string; private: boolean }[] }>('/installation/repositories', token);
console.log(`installed on ${repos.total_count} repo(s): ${repos.repositories.map((r) => `${r.full_name}${r.private ? ' (private)' : ' (PUBLIC)'}`).join(', ')}`);
// The App must be installed on exactly the repositories in the registry (override with CI_EXPECT_REPOS=a/b,c/d).
const registryPath = process.env.CI_REGISTRY ?? '/etc/ci-master/registry.yaml';
const expected = (process.env.CI_EXPECT_REPOS ? process.env.CI_EXPECT_REPOS.split(',') : [...new Set(loadRegistry(readFileSync(registryPath, 'utf8')).map((p) => p.repo))]).sort();
const got = repos.repositories.map((r) => r.full_name).sort();
const only = repos.repositories.every((r) => r.private) && JSON.stringify(got) === JSON.stringify(expected);
console.log(only ? `OK: installed on exactly [${expected.join(', ')}]` : `WARNING: installation is not exactly [${expected.join(', ')}]`);
process.exit(only ? 0 : 1);
