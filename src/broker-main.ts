// Runs as ci-run. Starts the Docker broker on a group-restricted Unix socket.
import { readFileSync, rmSync } from 'node:fs';
import { RootlessDockerBackend } from './launcher.ts';
import { startBroker } from './broker.ts';
import { brokerCall } from './broker-client.ts';
import { DEFAULT_GROUP, loadRegistry, servedBy } from './registry.ts';

// A broker serves exactly one isolation group (default 'farm' = every project of the current registry), so it can never start another group's project.
const group = process.env.CI_ISOLATION_GROUP ?? DEFAULT_GROUP;
const registry = servedBy(loadRegistry(readFileSync(process.env.CI_REGISTRY ?? '/etc/ci-master/registry.yaml', 'utf8')), group);
if (registry.length === 0) { console.error(`no project in isolation group '${group}'; exiting`); process.exit(1); }
const socketPath = process.env.CI_BROKER_SOCKET ?? '/run/ci-master/broker.sock';
// Refuse to start if a broker already answers on this socket; only a dead socket file is removed.
const alive = await brokerCall(socketPath, { op: 'list' }).then(() => true, () => false);
if (alive) { console.error(`another broker already listens on ${socketPath}; exiting`); process.exit(1); }
rmSync(socketPath, { force: true });
await startBroker({ socketPath, registry, backend: new RootlessDockerBackend(), image: process.env.CI_SLOT_IMAGE ?? 'ci-master/slot:dev', globalMaxSlots: Number(process.env.CI_GLOBAL_MAX_SLOTS ?? 2) });
console.log(`broker listening on ${socketPath} (group ${group}) for ${registry.map((p) => p.name).join(', ')}`);
