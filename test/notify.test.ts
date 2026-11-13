import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatMessage, makeNotifier, type NotifyEvent } from '../src/notify.ts';

test('formatMessage: finished with PR and without PR', () => {
  const withPr: NotifyEvent = {
    state: 'finished',
    repo: 'example-org/example-repo',
    run_id: 12345,
    job_id: 67890,
    head_sha: 'abc1234',
    pr_number: 42,
    project: 'farm',
    created_at: 10_000,
  };
  // 4m12s = 252 seconds = 252,000 ms
  const text1 = formatMessage(withPr, 10_000 + 252_000);
  assert.equal(
    text1,
    '✅ finished · example-org/example-repo · PR #42 · 4m12s\nhttps://github.com/example-org/example-repo/actions/runs/12345/job/67890'
  );

  const withoutPr: NotifyEvent = {
    ...withPr,
    pr_number: null,
  };
  const text2 = formatMessage(withoutPr, 10_000 + 65_000);
  assert.equal(
    text2,
    '✅ finished · example-org/example-repo · 1m5s\nhttps://github.com/example-org/example-repo/actions/runs/12345/job/67890'
  );
});

test('formatMessage: failed with PR, without PR, and error truncation', () => {
  const failedWithPr: NotifyEvent = {
    state: 'failed',
    repo: 'example-org/example-repo',
    run_id: 12345,
    job_id: 67890,
    head_sha: 'abc1234',
    pr_number: 99,
    project: 'farm',
    error: 'container exited before a job started',
    created_at: 1_000,
  };
  const text1 = formatMessage(failedWithPr, 1_000 + 30_000);
  assert.equal(
    text1,
    '❌ failed · example-org/example-repo · PR #99 · 0m30s\nhttps://github.com/example-org/example-repo/actions/runs/12345/job/67890\nreason: container exited before a job started'
  );

  const failedWithoutPr: NotifyEvent = {
    ...failedWithPr,
    pr_number: null,
  };
  const text2 = formatMessage(failedWithoutPr, 1_000 + 30_000);
  assert.equal(
    text2,
    '❌ failed · example-org/example-repo · 0m30s\nhttps://github.com/example-org/example-repo/actions/runs/12345/job/67890\nreason: container exited before a job started'
  );

  // Unknown text (broker/GitHub/exception messages) is never forwarded; a known reason keeps only its fixed phrase.
  const secretish: NotifyEvent = { ...failedWithPr, error: 'GitHub POST /x -> 401 Bearer ghs_SECRET ' + 'x'.repeat(350) };
  const text3 = formatMessage(secretish, 1_000);
  assert.ok(text3.endsWith('reason: internal error (see the farm log)'));
  assert.ok(!text3.includes('ghs_SECRET') && !text3.includes('xxx'));
  const disallowed: NotifyEvent = { ...failedWithPr, error: 'runner took a disallowed job 5 (pull_request_target)' };
  assert.ok(formatMessage(disallowed, 1_000).endsWith('reason: runner took a disallowed job'));
  // A failure with no error text (null or omitted) gets the generic reason, never "null" or "undefined".
  assert.ok(formatMessage({ ...failedWithPr, error: null }, 1_000).endsWith('reason: internal error (see the farm log)'));
  const { error: _omit, ...noError } = failedWithPr;
  assert.ok(formatMessage(noError, 1_000).endsWith('reason: internal error (see the farm log)'));
});

test('silent flag: finished is silent (disable_notification: true), failed is not (false)', async () => {
  const requests: { url: string; body: any }[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = makeNotifier(
    { TELEGRAM_BOT_TOKEN: 'SECRET_BOT_TOKEN', TELEGRAM_CHAT_ID: 'CHAT_123' },
    mockFetch,
    () => {},
    { delayMs: 0, sleepFn: async () => {} }
  );

  const eventFinished: NotifyEvent = {
    state: 'finished',
    repo: 'my-org/repo',
    run_id: 1,
    job_id: 2,
    created_at: Date.now(),
  };
  notifier(eventFinished);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/botSECRET_BOT_TOKEN/sendMessage');
  assert.equal(requests[0].body.chat_id, 'CHAT_123');
  assert.equal(requests[0].body.disable_notification, true);
  assert.equal(requests[0].body.disable_web_page_preview, true);

  const eventFailed: NotifyEvent = {
    state: 'failed',
    repo: 'my-org/repo',
    run_id: 1,
    job_id: 3,
    error: 'failed step',
    created_at: Date.now(),
  };
  notifier(eventFailed);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.disable_notification, false);
  assert.equal(requests[1].body.disable_web_page_preview, true);
});

test('no-op when unconfigured', async () => {
  let called = false;
  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };

  const noToken = makeNotifier({ TELEGRAM_CHAT_ID: '123' }, mockFetch);
  noToken({ state: 'finished', repo: 'r', run_id: 1, job_id: 1, created_at: 0 });

  const noChat = makeNotifier({ TELEGRAM_BOT_TOKEN: 'tok' }, mockFetch);
  noChat({ state: 'finished', repo: 'r', run_id: 1, job_id: 1, created_at: 0 });

  const empty = makeNotifier({}, mockFetch);
  empty({ state: 'finished', repo: 'r', run_id: 1, job_id: 1, created_at: 0 });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false);
});

test('fetch error and non-2xx are swallowed and the token never appears in any logged line', async () => {
  const token = 'SUPER_SECRET_TOKEN_99999';
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // 1. fetch error (network error / timeout)
  const throwingFetch: typeof fetch = async () => {
    throw new TypeError('Failed to fetch https://api.telegram.org/botSUPER_SECRET_TOKEN_99999/sendMessage');
  };
  const notifier1 = makeNotifier(
    { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: 'chat' },
    throwingFetch,
    log
  );
  assert.doesNotThrow(() => {
    notifier1({ state: 'finished', repo: 'r', run_id: 1, job_id: 1, created_at: 0 });
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('TypeError'));
  assert.ok(!logs[0].includes(token));
  assert.ok(!logs[0].includes('https://'));

  // 2. non-2xx status
  const non2xxFetch: typeof fetch = async () => {
    return new Response('Bad Request', { status: 400 });
  };
  const notifier2 = makeNotifier(
    { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: 'chat' },
    non2xxFetch,
    log
  );
  assert.doesNotThrow(() => {
    notifier2({ state: 'failed', repo: 'r', run_id: 1, job_id: 2, created_at: 0 });
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(logs.length, 2);
  assert.ok(logs[1].includes('400'));
  assert.ok(!logs[1].includes(token));
  assert.ok(!logs[1].includes('https://'));
});

test('spacing: sends are serialized with at least delayMs between sends', async () => {
  let fakeNow = 10_000;
  const sleeps: number[] = [];
  const sends: number[] = [];

  const mockFetch: typeof fetch = async () => {
    sends.push(fakeNow);
    return new Response('{}', { status: 200 });
  };

  const notifier = makeNotifier(
    { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' },
    mockFetch,
    () => {},
    {
      delayMs: 1100,
      now: () => fakeNow,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    }
  );

  notifier({ state: 'finished', repo: 'r', run_id: 1, job_id: 1, created_at: 0 });
  notifier({ state: 'finished', repo: 'r', run_id: 2, job_id: 2, created_at: 0 });

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sends.length, 2);
  assert.deepEqual(sleeps, [1100]);
  assert.equal(sends[0], 10_000);
  assert.equal(sends[1], 11_100);
});

test('queue cap: capped at 50 messages, drops oldest and logs dropped line', async () => {
  const logs: string[] = [];
  const sentJobs: number[] = [];

  let releaseFetch: () => void = () => {};
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  let gateActive = true;
  const mockFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    const m = body.text.match(/job\/(\d+)/);
    if (m) sentJobs.push(Number(m[1]));
    if (gateActive) {
      gateActive = false;
      await fetchGate;
    }
    return new Response('{}', { status: 200 });
  };

  const notifier = makeNotifier(
    { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' },
    mockFetch,
    (m) => logs.push(m),
    {
      delayMs: 0,
      sleepFn: async () => {},
    }
  );

  // Send 1 (job 0) starts processing, shifts out of queue, and pauses in fetch (1 in flight)
  notifier({ state: 'finished', repo: 'r', run_id: 1, job_id: 0, created_at: 0 });
  await new Promise((r) => setTimeout(r, 20));

  // While send 1 is waiting in fetch (1 in flight), push 55 more items (job_ids 1 to 55)
  for (let i = 1; i <= 55; i++) {
    notifier({ state: 'finished', repo: 'r', run_id: 1, job_id: i, created_at: 0 });
  }

  // 55 items pushed into a queue with capacity 50: items 1..5 should have been dropped
  const droppedLogs = logs.filter((l) => l.includes('dropped'));
  assert.equal(droppedLogs.length, 5);

  // Unpause fetch to process the rest
  releaseFetch();
  await new Promise((r) => setTimeout(r, 50));

  // Should have sent job 0 (first), then jobs 6 through 55 (50 items)
  assert.equal(sentJobs.length, 51);
  assert.equal(sentJobs[0], 0);
  assert.equal(sentJobs[1], 6);
  assert.equal(sentJobs[sentJobs.length - 1], 55);
});
