export interface NotifyEvent {
  state: 'finished' | 'failed' | string;
  repo: string;
  run_id: number;
  job_id: number;
  head_sha?: string;
  pr_number?: number | null;
  project?: string;
  error?: string | null;
  created_at: number;
  updated_at?: number;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s}s`;
}

// Only the controller's own fixed reasons leave the host. Anything else (broker, GitHub or exception text) is replaced, never forwarded.
const KNOWN_REASONS = [
  'runner took a disallowed job',
  'job exceeded the maximum run time',
  'no job picked up before the idle timeout',
  'container exited; job outcome unknown',
  'container exited before a job started',
  'stuck before start',
];
export function failureReason(error: string | null | undefined): string {
  return KNOWN_REASONS.find((r) => (error ?? '').startsWith(r)) ?? 'internal error (see the farm log)';
}

export function formatMessage(e: NotifyEvent, nowMs: number): string {
  const status = e.state === 'finished' ? '✅ finished' : '❌ failed';
  const pr = e.pr_number != null ? ` · PR #${e.pr_number}` : '';
  const duration = formatDuration(nowMs - e.created_at);
  const line1 = `${status} · ${e.repo}${pr} · ${duration}`;
  const line2 = `https://github.com/${e.repo}/actions/runs/${e.run_id}/job/${e.job_id}`;
  if (e.state === 'failed') return `${line1}\n${line2}\nreason: ${failureReason(e.error)}`;
  return `${line1}\n${line2}`;
}

export interface NotifierOptions {
  delayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function makeNotifier(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
  log: (m: string) => void = () => {},
  opts: NotifierOptions = {}
): (e: NotifyEvent) => void {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return () => {};
  }

  const delayMs = opts.delayMs ?? 1100;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;

  const MAX_QUEUE = 50;
  const queue: NotifyEvent[] = [];
  let busy = false;
  let chain: Promise<void> = Promise.resolve();
  let lastSend = 0;

  const sendOne = async (e: NotifyEvent) => {
    const text = formatMessage(e, now());
    const disableNotification = e.state === 'finished';
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      disable_notification: disableNotification,
      disable_web_page_preview: true,
    });
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        log(`telegram notification failed: HTTP ${res.status}`);
      }
    } catch (err) {
      const errorName = (err instanceof Error && err.name) ? err.name : 'Error';
      log(`telegram notification error: ${errorName}`);
    }
  };

  const pump = () => {
    if (busy) return;
    busy = true;
    chain = chain
      .then(async () => {
        while (queue.length > 0) {
          const item = queue.shift()!;
          const wait = delayMs - (now() - lastSend);
          if (wait > 0 && lastSend > 0) {
            await sleepFn(wait);
          }
          try {
            await sendOne(item);
          } finally {
            lastSend = now();
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (queue.length > 0) {
          pump();
        }
      });
  };

  return (e: NotifyEvent) => {
    try {
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        log('telegram notification dropped (queue full)');
      }
      queue.push(e);
      pump();
    } catch {
      // fire-and-forget: never throws
    }
  };
}
