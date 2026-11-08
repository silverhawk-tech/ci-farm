// ci-master dashboard. Everything from the API is untrusted text (run names, branch names...): it is only ever set with textContent, never innerHTML.
const app = document.getElementById('app');
let token = sessionStorage.getItem('cim_token') || '';
const store = { get: () => { try { return localStorage.getItem('cim_view'); } catch { return null; } }, set: (v) => { try { localStorage.setItem('cim_view', v); } catch { /* private window: choice just isn't remembered */ } } };
const isCompact = () => { const v = store.get(); return v ? v === 'compact' : window.innerWidth < 520; };
let auditShown = 6; // rows shown in the audit card; 'Show more' raises it
let showReads = false; // the dashboard's own refreshes are logged as audit_read (once per 5 min); hidden from this view by default, still recorded
const auditRows = () => (showReads ? state.audit.rows : state.audit.rows.filter((r) => r.action !== 'audit_read'));
let state = { status: null, resources: [], runs: [], approvals: [], audit: null, error: '' };

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; /* CSSOM, not the attribute: the CSP forbids inline style attributes */ else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const ask = (title, fields) => new Promise((resolve) => {
  const inputs = fields.map((f) => h('input', { name: f.name, placeholder: f.label, type: f.secret ? 'password' : 'text', autocomplete: 'off', inputmode: f.numeric ? 'numeric' : null, required: 'required' }));
  const dlg = h('dialog', {}, h('form', { method: 'dialog' }, h('strong', {}, title), ...inputs.map((i) => h('label', {}, h('span', { class: 'muted' }, i.placeholder), h('br'), i)),
    h('menu', {}, h('button', { type: 'button', onclick: () => { dlg.close(); resolve(null); } }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Confirm'))));
  dlg.addEventListener('submit', () => resolve(Object.fromEntries(inputs.map((i) => [i.name, i.value]))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
});
const flash = (msg) => { state.error = msg; render(); };

async function refresh() {
  if (!token) return render();
  const [s, r, ru, ap, au] = await Promise.all([api('GET', '/v1/status'), api('GET', '/v1/resources'), api('GET', '/v1/runs'), api('GET', '/v1/approvals'), api('GET', `/v1/audit?limit=${showReads ? auditShown + 1 : Math.min(500, (auditShown + 1) * 8)}`)]);
  if (s.status === 401) { token = ''; sessionStorage.removeItem('cim_token'); state.error = 'Token not accepted.'; return render(); }
  state = { status: s.json.data ?? null, resources: r.json.data ?? [], runs: ru.json.data ?? [], approvals: ap.json.data ?? [], audit: au.json.data ?? null, error: state.error };
  render();
}
async function act(action, params, needsCode) {
  let body = { ...params };
  if (needsCode) { const a = await ask('Authenticator code', [{ name: 'totp', label: '6-digit code', numeric: true }]); if (!a) return; body.totp = a.totp; }
  const r = await api('POST', `/v1/actions/${action}`, body);
  state.error = r.json.status === 'done' || r.json.status === 'pending_approval' ? '' : `${action}: ${r.json.reason || r.json.error || r.status}`;
  await refresh();
}
async function decide(id, verdict) {
  let totp; // Deny only stops something, so it needs no code; Approve does
  if (verdict === 'approve') { const a = await ask(`Approve request #${id}`, [{ name: 'totp', label: '6-digit authenticator code', numeric: true }]); if (!a) return; totp = a.totp; }
  const r = await api('POST', `/v1/approvals/${id}/decide`, { verdict, totp });
  state.error = r.status === 200 ? '' : `Approval failed: ${r.json.reason || r.json.error}`;
  await refresh();
}

const LABEL = { cancel_run: 'Cancel run', delete_run: 'Delete run', rerun_all: 'Re-run all jobs of run', rerun_failed: 'Re-run failed jobs of run', kill_slot: 'Kill the job in slot', restart_slot: 'Restart slot', pause_all: 'Pause everything', resume_all: 'Resume everything', pause_slot: 'Hold slot', resume_slot: 'Release slot', register_project: 'Register project' };
const describe = (a) => { try { const b = JSON.parse(a.binding), t = b.target || {}; return `${LABEL[a.action] || a.action}${t.run_id ? ` ${t.run_id}` : ''}${t.slot ? ` ${t.slot}` : ''}${b.repo && b.repo !== '-' ? ` in ${b.repo}` : ''}${t.head_sha ? ` at ${String(t.head_sha).slice(0, 7)}` : ''}${b.params && b.params.reason ? `. Reason: ${b.params.reason}` : ''}`; } catch { return a.action; } };
const pill = (text, kind) => h('span', { class: `pill ${kind}` }, text);
const hiddenStore = { get: () => { try { return new Set(JSON.parse(localStorage.getItem('cim_hidden') || '[]')); } catch { return new Set(); } }, set: (ids) => { try { localStorage.setItem('cim_hidden', JSON.stringify([...ids].slice(-500))); } catch { /* not remembered */ } } };
let hidden = hiddenStore.get(), showHidden = false; // 'Clear finished' only hides rows in THIS browser; nothing is deleted on GitHub
const JOB = (j) => j.status === 'completed' ? (j.conclusion === 'success' ? ['\u2713', 'ok'] : j.conclusion === 'skipped' || j.conclusion === 'cancelled' ? ['\u2013', 'idle'] : ['\u2715', 'bad']) : j.status === 'in_progress' ? ['\u25B6', 'info'] : ['\u00B7', 'idle'];
const chips = (r) => r.progress && r.progress.jobs && r.progress.jobs.length ? h('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap;gap:4px' }, r.progress.jobs.map((j) => { const [i, k] = JOB(j); return pill(`${i} ${j.name}`, k); })) : null;
const runTitle = (r) => r.title || r.name;
const runMeta = (r) => `${r.name}${r.pr ? ` \u00B7 PR ${r.pr}` : ''}${r.branch ? ` \u00B7 ${r.branch}` : ''} \u00B7 ${r.head_sha.slice(0, 7)} \u00B7 ${new Date(r.created_at).toLocaleString()}`;
const runKind = (r) => r.superseded ? ['Superseded', 'info'] : r.status !== 'completed' ? (r.status === 'queued' && !(r.progress && r.progress.current) ? ['Queued', 'warn'] : ['Running', 'info']) : r.conclusion === 'success' ? ['Passed', 'ok'] : r.conclusion === 'cancelled' ? ['Cancelled', 'idle'] : ['Failed', 'bad'];
// Run table sort. Default: Status, so running and queued runs come first, then the rest newest first. Clicking a header sorts by it; clicking again reverses. Kept for this page view only.
const STATUS_RANK = { Running: 0, Queued: 1, Failed: 2, Passed: 3, Cancelled: 4, Superseded: 5 };
const when = (r) => Date.parse(r.created_at) || 0;
let sort = { key: 'status', dir: 1 };
const sortRuns = (runs) => [...runs].sort((a, b) => (sort.key === 'status' ? (STATUS_RANK[runKind(a)[0]] - STATUS_RANK[runKind(b)[0]]) * sort.dir : (when(b) - when(a)) * sort.dir) || when(b) - when(a));
const sortHead = (key, label) => h('th', { 'aria-sort': sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
  h('button', { class: 'sort', onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : 1 }; render(); } }, label, sort.key === key ? (sort.dir === 1 ? ' \u25B2' : ' \u25BC') : ''));
const spark = (vals, max) => {
  if (vals.length < 2) return h('span', { class: 'muted' }, 'collecting…');
  const pts = vals.map((v, i) => `${Math.round((i / (vals.length - 1)) * 150)},${Math.round(34 - Math.min(v / max, 1) * 32)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), pl = document.createElementNS(ns, 'polyline');
  svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 150 36'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'history');
  pl.setAttribute('points', pts); pl.setAttribute('stroke', 'var(--accent)'); svg.append(pl); return svg;
};
const bar = (pct, calm) => h('div', { class: `bar${!calm && pct > 85 ? ' hot' : ''}` }, h('i', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));

function render() {
  if (!token) {
    app.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'ci-master'), h('p', { class: 'muted' }, 'Paste your access token. It stays in this tab only.'),
      h('form', { onsubmit: (e) => { e.preventDefault(); token = e.target.t.value.trim(); sessionStorage.setItem('cim_token', token); state.error = ''; refresh(); } }, h('input', { name: 't', type: 'password', autocomplete: 'off', required: 'required', placeholder: 'cim_…' }), ' ', h('button', { class: 'primary' }, 'Sign in')),
      state.error && h('p', { class: 'err' }, state.error)));
    return;
  }
  const s = state.status, last = state.resources.at(-1);
  const compact = isCompact();
  document.body.classList.toggle('compact', compact);
  const kids = [];
  kids.push(h('div', { class: 'row between', style: 'margin-bottom:22px' },
    h('div', { class: 'row' }, h('h1', {}, 'ci-master'), s && (s.paused ? pill('Paused: running jobs finish, none start', 'warn') : pill('Running', 'ok'))),
    h('div', { class: 'row' }, s && h('button', { class: `${compact ? '' : 'big '}${s.paused ? 'go' : 'stop'}`, onclick: () => act(s.paused ? 'resume_all' : 'pause_all', {}) }, s.paused ? 'Resume all' : 'Pause all'), h('button', { onclick: () => { store.set(compact ? 'full' : 'compact'); render(); } }, compact ? 'Full view' : 'Compact'), h('button', { class: compact ? '' : 'big', onclick: () => { token = ''; sessionStorage.removeItem('cim_token'); render(); } }, 'Sign out'))));
  if (state.error) kids.push(h('div', { class: 'card err' }, state.error));
  const ar = s && s.auditReceiver;
  if (ar && !(ar.reachable && ar.state === 'in_sync' && ar.lag <= 5)) kids.push(h('div', { class: 'card err' }, h('strong', {}, ar.state === 'tampered' ? 'AUDIT TAMPERED: the receiver and the local chain disagree. New jobs are stopped. ' : ar.reachable ? `Audit receiver is ${ar.lag} rows behind. ` : 'Audit receiver unreachable. '),
    'Cancel, delete, re-run all, kill and restart are refused until the independent audit record is current again. ', ar.error));

  if (last && compact) kids.push(h('div', { class: 'card' }, h('div', { class: 'two' },
    h('div', {}, h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'CPU'), h('strong', {}, `${Math.round(last.cpuPercent)}%`)), bar(last.cpuPercent)),
    h('div', {}, h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'RAM'), h('strong', {}, `${(last.memUsedMb / 1024).toFixed(1)}/${(last.memTotalMb / 1024).toFixed(0)} GB`)), bar((last.memUsedMb / last.memTotalMb) * 100)))));
  else if (last) kids.push(h('div', { class: 'card' }, h('div', { class: 'row top' },
    h('div', { class: 'grow' }, h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Machine CPU'), h('strong', {}, `${last.cpuPercent}%`)), bar(last.cpuPercent), h('div', { class: 'muted' }, 'all cores, whole machine')),
    h('div', { class: 'grow' }, h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Machine RAM'), h('strong', {}, `${(last.memUsedMb / 1024).toFixed(1)} of ${(last.memTotalMb / 1024).toFixed(0)} GB`)), bar((last.memUsedMb / last.memTotalMb) * 100),
      h('div', { class: 'muted' }, `swap ${(last.swapUsedMb / 1024).toFixed(1)} GB · disk free ${last.diskFreeGb} GB`)),
    spark(state.resources.map((x) => x.cpuPercent), 100))));

  if (s && compact) kids.push(h('div', { class: 'card' }, Array.from({ length: s.maxSlots }, (_, i) => { const n = i + 1, x = s.slots.find((y) => y.slot === n), held = s.heldSlots.includes(n);
    return h('div', { class: 'row between', style: 'margin:3px 0' }, h('span', {}, `Slot ${n} `, h('span', { class: 'muted' }, x ? `${x.project}, job ${x.job_id}` : 'waiting')),
      held ? pill('Held', 'warn') : x ? pill(x.state, x.state === 'running' ? 'info' : 'warn') : pill('Idle', 'idle')); })));
  if (s && !compact) {
    const byslot = new Map(s.slots.map((x) => [x.slot, x]));
    const usage = new Map((last?.slots ?? []).map((u) => [u.reservationId, u]));
    const cards = [];
    for (let n = 1; n <= s.maxSlots; n++) {
      const x = byslot.get(n), held = s.heldSlots.includes(n), u = x && usage.get(x.id);
      cards.push(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('strong', {}, `Slot ${n}`), held ? pill('Held', 'warn') : x ? pill(x.state, x.state === 'running' ? 'info' : 'warn') : pill('Idle', 'idle')),
        h('div', { class: 'muted' }, x ? `${x.project}, job ${x.job_id}` : 'Waiting for a job'),
        u && (() => { const cores = s.projects?.find((p) => p.name === x.project)?.resources.cpus ?? 1, cpuPct = Math.min(100, u.cpuPercent / cores); // docker reports 100 = one core; show it against the slot's own limit
          return h('div', {}, h('div', { class: 'muted' }, `CPU ${(u.cpuPercent / 100).toFixed(1)} of ${cores} cores (${Math.round(cpuPct)}%)`), bar(cpuPct),
            h('div', { class: 'muted' }, `RAM ${(u.memUsedMb / 1024).toFixed(1)} of ${(u.memLimitMb / 1024).toFixed(0)} GB`), bar((u.memUsedMb / Math.max(u.memLimitMb, 1)) * 100)); })(),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => act(held ? 'resume_slot' : 'pause_slot', { slot: n }) }, held ? 'Release slot' : 'Hold slot'),
          x && ['started', 'running'].includes(x.state) && h('button', { onclick: () => act('kill_slot', { reservation_id: x.id }, true) }, 'Kill job…'))));
    }
    kids.push(h('div', { class: 'grid' }, cards));
  }

  if (state.approvals.length) kids.push(h('div', { class: 'card', style: 'border-color:var(--warn)' }, h('h2', {}, 'Needs your approval'),
    state.approvals.map((a) => h('div', { class: 'row between', style: 'margin:6px 0' }, h('div', {}, h('strong', {}, describe(a)), h('div', {}, `Requested by ${a.requester}`), h('div', { class: 'muted' }, `request #${a.id} · expires ${new Date(a.expires).toLocaleTimeString()}`)),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => decide(a.id, 'approve') }, 'Approve'), h('button', { onclick: () => decide(a.id, 'reject') }, 'Deny'))))));

  // Most recently active project first; the compact view (the phone default) gets one "latest run" line per project instead of the full tables.
  for (const p of state.runs) for (const r of p.runs) if (r.status !== 'completed') hidden.delete(r.id); // a cleared run that is running again (a re-run) is shown again
  const newest = (p) => Math.max(0, ...p.runs.map((r) => Date.parse(r.created_at) || 0));
  const projects = [...state.runs].sort((a, b) => newest(b) - newest(a));
  if (compact) for (const p of projects) { const r = p.runs[0];
    kids.push(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('strong', {}, p.project), r ? pill(...runKind(r)) : pill('No runs', 'idle')),
      r && r.progress && h('div', { style: 'margin-top:6px' }, bar(r.progress.percent, true), h('div', { class: 'muted' }, `${r.progress.percent}% · job ${Math.min(r.progress.jobsDone + 1, r.progress.jobsTotal)} of ${r.progress.jobsTotal}${r.progress.current ? ` · ${r.progress.current}` : ''}`)),
      r && chips(r), h('div', { class: 'muted' }, r ? `${runTitle(r)} \u00B7 ${r.name}${r.pr ? ` \u00B7 PR ${r.pr}` : ''}${r.branch ? ` \u00B7 ${r.branch}` : ''} \u00B7 ${new Date(r.created_at).toLocaleString()}` : 'No runs yet.'))); }
  for (const p of compact ? [] : projects) kids.push(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, `${p.project} \u00B7 ${p.repo}`), h('div', { class: 'row' },
      p.runs.some((r) => r.status === 'completed' && !hidden.has(r.id)) && h('button', { onclick: () => { for (const r of p.runs) if (r.status === 'completed') hidden.add(r.id); while (hidden.size > 500) hidden.delete(hidden.values().next().value); hiddenStore.set(hidden); render(); } }, 'Clear finished'),
      p.runs.some((r) => hidden.has(r.id) && r.status === 'completed') && h('button', { onclick: () => { showHidden = !showHidden; render(); } }, showHidden ? 'Hide cleared again' : 'Show cleared'))),
    p.runs.length ? h('table', {}, h('thead', {}, h('tr', {}, sortHead('run', 'Run (by time)'), sortHead('status', 'Status'), h('th', {}, 'Actions'))), h('tbody', {}, sortRuns(p.runs).filter((r) => showHidden || !(hidden.has(r.id) && r.status === 'completed')).slice(0, 12).map((r) => { const [t, k] = runKind(r);
      const P = { project: p.project, run_id: r.id };
      return h('tr', {}, h('td', {}, h('strong', {}, runTitle(r)), h('div', { class: 'muted' }, runMeta(r))), h('td', {}, pill(t, k), chips(r), r.progress && h('div', { style: 'margin-top:6px;min-width:120px' }, bar(r.progress.percent, true), h('div', { class: 'muted' }, `${r.progress.percent}% · job ${Math.min(r.progress.jobsDone + 1, r.progress.jobsTotal)} of ${r.progress.jobsTotal}${r.progress.current ? ` · ${r.progress.current}` : ''}`))),
        h('td', {}, h('div', { class: 'row' },
          r.status === 'completed' && r.conclusion === 'failure' && !r.superseded && h('button', { onclick: async () => { const a = await ask('Re-run failed jobs', [{ name: 'reason', label: 'Reason (kept in the audit log)' }]); if (a) act('rerun_failed', { ...P, reason: a.reason }); } }, 'Re-run failed'),
          r.status !== 'completed' && h('button', { onclick: () => act('cancel_run', P, true) }, 'Cancel…'),
          r.status === 'completed' && h('button', { title: 'Hide this run in this browser only; nothing is deleted on GitHub', onclick: () => { hidden.add(r.id); while (hidden.size > 500) hidden.delete(hidden.values().next().value); hiddenStore.set(hidden); render(); } }, 'Clear'),
          r.status === 'completed' && h('button', { onclick: () => act('delete_run', P, true) }, 'Delete…'))));
    }))) : h('p', { class: 'muted' }, 'No runs yet.')));

  if (state.audit && !compact) kids.push(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, 'Audit log'), state.audit.chain.ok ? pill(`chain intact · ${state.audit.chain.rows} rows`, 'ok') : pill(`CHAIN BROKEN at ${state.audit.chain.brokenAt}`, 'bad')),
    h('table', {}, h('tbody', {}, auditRows().slice(0, auditShown).map((r) => h('tr', {}, h('td', { class: 'muted' }, new Date(r.ts).toLocaleTimeString()), h('td', {}, `${r.actor} (${r.actorType})`), h('td', {}, r.action), h('td', {}, pill(r.result, r.result === 'done' ? 'ok' : r.result === 'denied' || r.result === 'refused' || r.result === 'error' ? 'bad' : 'idle'))))))));
  if (state.audit && !compact && ar && ar.head) kids.at(-1).append(h('div', { class: 'muted', style: 'margin-top:6px' }, `Independent copy: row ${ar.head.seq}, ${ar.head.hash.slice(0, 16)}… checked ${Math.max(0, Math.round((Date.now() - ar.lastOk) / 1000))} s ago${ar.refusals ? `, ${ar.refusals} refused` : ''}. Keep a note of this somewhere outside this machine.`));
  if (state.audit && !compact) {
    const more = auditRows().length > auditShown, less = auditShown > 6;
    kids.at(-1).append(h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { onclick: () => { showReads = !showReads; refresh(); } }, showReads ? 'Hide reads' : 'Show reads'),
      more && h('button', { onclick: () => { auditShown += 20; refresh(); } }, 'Show more'), less && h('button', { onclick: () => { auditShown = 6; refresh(); } }, 'Show less')));
  }
  app.replaceChildren(...kids);
}
window.addEventListener('resize', render);
render(); refresh(); setInterval(refresh, 7000);
