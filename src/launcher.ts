import { spawn } from 'node:child_process';
import { parseSize } from './sampler.ts';

export interface SlotSpec { reservationId: string; slot: number; project: string; image: string; memory: string; cpus: number; pids: number }

/** Isolation backend (plan section 3, item 2). v1 = rootless Docker; Incus/microVM can implement the same four calls. */
export interface IsolationBackend {
  start(spec: SlotSpec): Promise<void>;
  deliverJit(reservationId: string, encodedJitConfig: string): Promise<void>;
  stop(reservationId: string): Promise<void>;
  list(): Promise<{ reservationId: string; running: boolean; project: string; slot: number }[]>;
  stats(): Promise<{ reservationId: string; cpuPercent: number; memUsedMb: number; memLimitMb: number }[]>;
}

export const containerName = (reservationId: string) => `cif-${reservationId}`;
const ID = /^[0-9a-f-]{36}$/;
// An image must look like a reference (never an option: no leading '-') and, unless explicitly allowed for dev, be digest-pinned.
const IMAGE = /^[A-Za-z0-9][\w./:@-]*$/;
export const allowUnpinnedImage = () => process.env.CI_ALLOW_UNPINNED_IMAGE === '1';
// Pinned = a registry digest (name@sha256:<64 hex>) or a local image id (sha256:<64 hex>); both are content hashes, so a re-tagged image cannot be swapped in.
export const isPinnedImage = (i: string) => /(^|@)sha256:[0-9a-f]{64}$/.test(i);

/**
 * The one place that decides how a job container is launched. Fixed shape, so a compromised caller cannot ask for
 * host mounts, host networking, the docker socket, or missing limits. `--privileged` is deliberate and only means
 * "privileged inside ci-run's rootless user namespace": the slot runs its own Docker daemon (spike 5a).
 */
export function slotRunArgs(s: SlotSpec): string[] {
  if (!ID.test(s.reservationId)) throw new Error('bad reservation id');
  if (!IMAGE.test(s.image) || (!isPinnedImage(s.image) && !allowUnpinnedImage())) throw new Error('bad image');
  if (!/^[1-9]\d*g$/.test(s.memory)) throw new Error('bad memory');
  if (!(s.cpus >= 0.5 && s.cpus <= 8) || !Number.isInteger(s.pids) || s.pids < 256) throw new Error('bad limits');
  return [
    'run', '-d',
    '--name', containerName(s.reservationId),
    '--label', 'ci-master=1', '--label', `ci-master.reservation=${s.reservationId}`, '--label', `ci-master.slot=${s.slot}`, '--label', `ci-master.project=${s.project}`,
    '--privileged',
    '--memory', s.memory, '--memory-swap', s.memory, '--cpus', String(s.cpus), '--pids-limit', String(s.pids),
    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
    '--tmpfs', '/run/ci:size=1m,mode=0700', // the single-use JIT config lands here, in memory only
    '--stop-timeout', '30',
    s.image,
  ];
}

type Exec = (args: string[], stdin?: string) => Promise<string>;

/** Runs the docker CLI as the current user (ci-run). The JIT config only ever travels on stdin, never in argv or env. */
export const dockerExec: Exec = (args, stdin) =>
  new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} failed (${code}): ${err.slice(0, 300)}`))));
    p.stdin.end(stdin ?? '');
  });

export class RootlessDockerBackend implements IsolationBackend {
  private exec: Exec;
  constructor(exec: Exec = dockerExec) { this.exec = exec; }
  async start(spec: SlotSpec) { await this.exec(slotRunArgs(spec)); }
  async deliverJit(reservationId: string, cfg: string) {
    if (!ID.test(reservationId)) throw new Error('bad reservation id');
    // write then rename, so the entrypoint never reads a half-written file
    await this.exec(['exec', '-i', containerName(reservationId), 'sh', '-c', 'umask 077; cat > /run/ci/jit.tmp && mv /run/ci/jit.tmp /run/ci/jit'], cfg);
  }
  async stop(reservationId: string) {
    if (!ID.test(reservationId)) throw new Error('bad reservation id');
    try { await this.exec(['rm', '-fv', containerName(reservationId)]); }
    catch (e) { if (!/No such container/i.test((e as Error).message)) throw e; } // already gone is success; anything else must be retried
  }
  async list() {
    const out = await this.exec(['ps', '-a', '--filter', 'label=ci-master=1', '--format', '{{.Label "ci-master.reservation"}} {{.State}} {{.Label "ci-master.project"}} {{.Label "ci-master.slot"}}']);
    return out.split('\n').filter(Boolean).map((l) => {
      const [reservationId, state, project, slot] = l.split(' ');
      return { reservationId, running: state === 'running', project, slot: Number(slot) };
    });
  }
  async stats() {
    const out = await this.exec(['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}']);
    return out.split('\n').filter(Boolean).flatMap((l) => {
      const m = /^cif-([0-9a-f-]{36}) ([\d.]+)% (\S+) \/ (\S+)$/.exec(l.trim());
      return m ? [{ reservationId: m[1], cpuPercent: Number(m[2]), memUsedMb: parseSize(m[3]), memLimitMb: parseSize(m[4]) }] : [];
    });
  }
}
