'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago } = UI;

  let currentWindowMs = 86400000;
  const WINDOW_LABEL = { 3600000: 'the last hour', 86400000: 'the last 24 hours', 604800000: 'the last 7 days' };

  function bucketDecisions(items) {
    const c = { pass: 0, auto: 0, review: 0, block: 0 };
    let earliest = null;
    let agentsSeen = new Map();
    items.forEach((item) => {
      const status = String(item.status || '').toLowerCase();
      const auto = item.payload && item.payload.metadata && item.payload.metadata.autoApproved === true;
      if (status === 'block') c.block += 1;
      else if (status === 'review') c.review += 1;
      else if (status === 'allow' && auto) c.auto += 1;
      else if (status === 'allow') c.pass += 1;
      if (item.agentId) {
        const prev = agentsSeen.get(item.agentId);
        if (!prev || new Date(item.createdAt) > new Date(prev)) agentsSeen.set(item.agentId, item.createdAt);
      }
      if (!earliest || new Date(item.createdAt) < new Date(earliest)) earliest = item.createdAt;
    });
    return { counts: c, earliest, agentsSeen };
  }

  function sessionApproved() {
    return window.HuqanControlRoomApprovals ? window.HuqanControlRoomApprovals.getSessionApprovedCount() : 0;
  }

  function renderStatus(message, isError) {
    const el = $('#ov-status');
    if (!message) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = message;
    el.className = `status${isError ? ' bad' : ''}`;
  }

  // `counts.review` is every `review`-status gate_decision recorded in the
  // window, whether or not it has since been resolved: a gate decision is
  // only ever recorded once, at the moment the gate ran, and is never
  // re-emitted when a person later approves or rejects it (confirmed by
  // exercising the real endpoints while building this view -- see the final
  // report). Using it keeps the bar's segments summing to the total watched.
  // `openReviewCount` -- the live approval queue size -- is shown alongside
  // it as "open now" so a resolved review does not look like it vanished
  // from the total, and does not look like it is still waiting either.
  function renderVerdict(counts, openReviewCount, earliest, truncated) {
    const approved = sessionApproved();
    const total = counts.pass + approved + counts.auto + counts.review + counts.block;
    $('#ov-total').textContent = total.toLocaleString();
    $('#ov-total-label').textContent = `agent actions watched in ${WINDOW_LABEL[currentWindowMs] || 'the selected window'}`;
    const bar = $('#ov-vbar');
    const set = (name, value) => { const seg = bar.querySelector(`[data-bar="${name}"]`); if (seg) seg.style.flexGrow = Math.max(value, total ? 0 : 1); };
    set('pass', counts.pass); set('approved', approved); set('auto', counts.auto); set('review', counts.review); set('block', counts.block);
    $('#ov-vlegend').innerHTML = `
      <div class="vl" style="--c:var(--pass)"><b class="num">${counts.pass}</b><span>Passed on policy</span></div>
      <div class="vl" style="--c:color-mix(in oklab, var(--pass) 55%, var(--surface))"><b class="num">${approved}</b><span>Passed after your approval (this session)</span></div>
      <div class="vl" style="--c:var(--gold)"><b class="num">${counts.auto}</b><span>Auto-approved</span></div>
      <div class="vl" style="--c:var(--review)"><b class="num">${counts.review}</b><span>Waiting for review (${openReviewCount} open now)</span><br><button class="link" data-go="approvals">Review now</button></div>
      <div class="vl" style="--c:var(--block)"><b class="num">${counts.block}</b><span>Blocked before they ran</span></div>
    `;
    const since = earliest ? new Date(earliest).toLocaleString() : 'no decisions recorded yet';
    $('#ov-since').textContent = `Counting gate decisions since ${since}${truncated ? ' (more events exist than shown; this window was truncated at the read cap)' : ''}. HUQAN does not re-record a gate decision when it is later resolved, so "Waiting for review" here is every review decision made in the window; the "open now" figure is the live queue. "Passed after your approval" only counts approvals made in this browser session — the runtime does not yet expose historical approval outcomes.`;
  }

  function renderChart(dailyItems) {
    const byDay = new Map();
    dailyItems.forEach((item) => {
      const day = new Date(item.createdAt).toISOString().slice(0, 10);
      const bucket = byDay.get(day) || { pass: 0, review: 0, block: 0 };
      const status = String(item.status || '').toLowerCase();
      if (status === 'block') bucket.block += 1;
      else if (status === 'review') bucket.review += 1;
      else if (status === 'allow') bucket.pass += 1;
      byDay.set(day, bucket);
    });
    const days = [...byDay.keys()].sort().slice(-7);
    if (!days.length) { $('#ov-chart').innerHTML = '<p class="empty">No gate decisions recorded in the last 7 days.</p>'; return; }
    const rows = days.map((d) => ({ label: d.slice(5), ...byDay.get(d) }));
    const max = Math.max(1, ...rows.map((r) => r.pass + r.review + r.block));
    const W = 640, H = 200, L = 30, R = 10, T = 10, B = 24;
    const barW = (W - L - R) / rows.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gate decisions per day for the last 7 days">`;
    [0, 0.5, 1].forEach((f) => { const v = Math.round(max * f); s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke-dasharray="2 6"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; });
    rows.forEach((r, i) => {
      const x = L + i * barW + barW * 0.18;
      const w = barW * 0.64;
      let cursor = H - B;
      [['block', 'var(--block)'], ['review', 'var(--review)'], ['pass', 'var(--pass)']].forEach(([key, color]) => {
        const v = r[key];
        const h = (H - T - B) * (v / max);
        cursor -= h;
        s += `<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${esc(r.label)}: ${v} ${key}</title></rect>`;
      });
      s += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text>`;
    });
    s += '</svg><div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px"><span class="chip sq c-pass">Passed</span><span class="chip sq c-review">Review</span><span class="chip sq c-block">Blocked</span></div>';
    $('#ov-chart').innerHTML = s;
  }

  function renderApprovalsPanel(open) {
    const list = (open || []).slice(0, 4);
    $('#ov-approvals').innerHTML = list.length ? list.map((a) => `
      <div class="row"><span class="t">${esc(a.tool || 'action')}</span><span class="r"><button class="btn" data-go="approvals">Review</button></span>
      <span class="s"><span class="mono">${esc(a.tool)}</span> · ${ago(new Date(a.createdAt).toISOString())}</span></div>`).join('')
      : '<p class="empty">Nothing is waiting on you.</p>';
    const navCount = $('#nav-approvals-count');
    if (navCount) {
      if (list.length || (open && open.length)) { navCount.hidden = false; navCount.textContent = String((open || []).length); }
      else navCount.hidden = true;
    }
  }

  function renderAgentsPanel(agentsSeen) {
    const entries = [...agentsSeen.entries()].sort((a, b) => new Date(b[1]) - new Date(a[1])).slice(0, 5);
    $('#ov-agents').innerHTML = entries.length ? entries.map(([id, seen]) => `
      <div class="row"><span class="t mono">${esc(id)}</span><span class="r"><span class="chip c-pass">Seen recently</span></span>
      <span class="s">last gate decision ${ago(seen)}</span></div>`).join('')
      : '<p class="empty">No agent identity has reached a gate yet in this window.</p>';
  }

  function renderRecent(items) {
    $('#ov-recent').innerHTML = items.length ? items.slice(0, 6).map((a) => {
      const decision = a.receipt ? a.receipt.decision : '';
      const cls = decision === 'block' ? 'c-block' : decision === 'review' ? 'c-review' : decision ? 'c-pass' : 'c-muted';
      return `<div class="row"><span class="t">${esc(a.action || a.eventType)}</span><span class="r"><span class="chip ${cls}">${esc(decision || a.eventType)}</span></span>
      <span class="s"><span class="mono">${esc(a.actor)}</span>${a.tool ? ` used <span class="mono">${esc(a.tool)}</span>` : ''} · ${ago(a.timestamp)}</span></div>`;
    }).join('') : '<p class="empty">No activity recorded yet.</p>';
  }

  async function load() {
    if (!Data.hasKey()) {
      renderStatus('Connect an API key in the sidebar to load real Overview data.', true);
      return;
    }
    renderStatus('Loading…');
    const [decisionsResult, approvalsResult, activityResult, weekResult] = await Promise.all([
      Data.fetchGateDecisions({ windowMs: currentWindowMs }),
      Data.fetchOpenApprovals(),
      Data.fetchActivity({ limit: 6 }),
      currentWindowMs === 604800000 ? Promise.resolve(null) : Data.fetchGateDecisions({ windowMs: 604800000 }),
    ]);

    if (!decisionsResult.ok) {
      renderStatus(`Could not load gate decisions: ${decisionsResult.error?.message || decisionsResult.error?.code || 'unknown error'}`, true);
    } else {
      renderStatus('');
    }
    const bucketed = decisionsResult.ok ? bucketDecisions(decisionsResult.items) : { counts: { pass: 0, auto: 0, review: 0, block: 0 }, earliest: null, agentsSeen: new Map() };
    const openReviewCount = approvalsResult.ok ? approvalsResult.approvals.length : bucketed.counts.review;
    renderVerdict(bucketed.counts, openReviewCount, bucketed.earliest, decisionsResult.truncated);
    renderAgentsPanel(bucketed.agentsSeen);

    const weekItems = weekResult ? (weekResult.ok ? weekResult.items : []) : (decisionsResult.ok ? decisionsResult.items : []);
    renderChart(weekItems);

    if (approvalsResult.ok) renderApprovalsPanel(approvalsResult.approvals);
    else $('#ov-approvals').innerHTML = `<p class="empty">Could not load the approval queue.</p>`;

    if (activityResult.ok) renderRecent(activityResult.items);
    else $('#ov-recent').innerHTML = `<p class="empty">Could not load recent activity.</p>`;
  }

  $$('#ov-window [data-win]').forEach((btn) => btn.addEventListener('click', () => {
    currentWindowMs = Number(btn.dataset.win);
    $$('#ov-window [data-win]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  }));
  $('#ov-refresh')?.addEventListener('click', load);

  UI.registerView('overview', { onShow: load });
  window.HuqanControlRoomOverview = { reload: load };
})();
