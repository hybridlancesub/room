// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * THE LOOM — what the room is doing now.
 *
 * The Firmament is a sky: the shape of everything, spatially. The Loom is a clock:
 * the latest words as text, and one lane per domain with time running left to
 * right. No WebGL, no canvas — plain DOM, so it runs anywhere the browser does.
 *
 * It reads the same read-only state as the Firmament and polls it, so during a
 * live sitting it moves. Nothing here writes; nothing here summarizes — the feed
 * shows the participants' own handles, the reader their own words.
 */

const REFRESH_MS = 5000;
const FEED_MAX = 12;
const LANES_MAX = 18;

const params = new URLSearchParams(location.search);
const source = params.get('state') ?? './state.json';

let state = null;
let windowMin = 1440;          // 0 = all
let selected = null;

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), feedEl = $('feed-list'), lanesEl = $('lane-list'),
      marksEl = $('marks'), readerEl = $('reader'), proposalsEl = $('proposals'), errorEl = $('error');

for (const b of document.querySelectorAll('.windows button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('.windows button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    windowMin = Number(b.dataset.min);
    render();
  });
}

poll();
setInterval(poll, REFRESH_MS);

async function poll() {
  try {
    const r = await fetch(source, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state = await r.json();
    errorEl.style.display = 'none';
    document.documentElement.dataset.loom = 'running';
    render();
  } catch (e) {
    errorEl.textContent = `could not read ${source}: ${e.message} — is 'python3 -m room --db … serve' running?`;
    errorEl.style.display = 'block';
    document.documentElement.dataset.loom = 'failed';
  }
}

function entries() {
  return state.contributions.slice().sort((a, b) => a.ts - b.ts);
}

function inWindow(list) {
  if (!windowMin) return list;
  const from = (state.generated ?? Date.now() / 1000) - windowMin * 60;
  return list.filter((e) => e.ts >= from);
}

function render() {
  renderStatus();
  renderFeed();
  renderLanes();
  renderProposals();
  if (selected) showEntry(selected);
}

function renderStatus() {
  const present = state.members.filter((m) => m.state === 'IN');
  const es = entries();
  const last = es[es.length - 1];
  const when = last ? fmtAgo(last.ts) : '—';
  statusEl.innerHTML =
    `<b>${present.length}</b> present · <b>${state.contributions.length}</b> entries · last words <b>${when}</b>` +
    (state.halted ? ` · <b>HALTED</b>: ${esc(state.halt_reason ?? '')}` : '');
}

function renderFeed() {
  const es = entries();
  feedEl.replaceChildren(...es.slice(-FEED_MAX).reverse().map((e) => {
    const row = document.createElement('div');
    row.className = 'fentry';
    const handle = e.title || firstWords(e.content, 14);
    row.innerHTML =
      `<div class="who" title="${esc(e.who)}">${esc(shortWho(e.who))}<br>${fmtTime(e.ts)}</div>` +
      `<div class="what"><span class="kind ${e.kind}">${e.kind}</span>${esc(handle)} ` +
      `<span class="dom">@ ${esc(e.domain)}</span>` +
      (e.target != null ? ` <span class="tgt">→ #${e.target}</span>` : '') +
      ((e.affirms || e.challenges) ? ` <span class="tgt">(${e.affirms}+ ${e.challenges}−)</span>` : '') +
      `</div>`;
    row.addEventListener('click', () => { selected = e; showEntry(e); });
    return row;
  }));
}

function renderLanes() {
  const es = inWindow(entries());
  const byDomain = new Map();
  for (const e of es) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain).push(e);
  }
  const lanes = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, LANES_MAX);
  const t0 = windowMin ? (state.generated ?? Date.now() / 1000) - windowMin * 60
                       : (es[0]?.ts ?? 0);
  const t1 = state.generated ?? Date.now() / 1000;
  const span = Math.max(1, t1 - t0);

  lanesEl.replaceChildren(...lanes.map(([dom, list]) => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    const name = document.createElement('div');
    name.className = 'name';
    const d = state.domains.find((x) => x.label === dom);
    name.innerHTML = `<b>${list.length}</b> ${esc(dom)}` + (d?.present?.length ? ` · ${d.present.length} here` : '');
    name.title = dom;
    const row = document.createElement('div');
    row.className = 'row';
    for (const e of list) {
      const t = document.createElement('div');
      const replies = e.replies?.length ?? 0;
      const size = 5 + Math.min(9, Math.round(Math.log2(1 + replies) * 2.6));
      t.className = `tick ${e.kind}${e.set_aside ? ' setaside' : ''}`;
      t.style.cssText = `left:${((e.ts - t0) / span * 100).toFixed(3)}%;width:${size}px;height:${size}px`;
      t.title = `#${e.id} ${e.kind} by ${e.who} @ ${e.domain}`;
      t.addEventListener('click', () => { selected = e; showEntry(e); });
      row.appendChild(t);
    }
    lane.append(name, row);
    return lane;
  }));

  marksEl.replaceChildren();
  const nMarks = 5;
  for (let i = 0; i <= nMarks; i++) {
    const s = document.createElement('span');
    s.style.left = `${i / nMarks * 100}%`;
    s.textContent = fmtTime(t0 + span * i / nMarks);
    marksEl.appendChild(s);
  }
}

function renderProposals() {
  const props = state.proposals.slice().sort((a, b) => b.id - a.id);
  proposalsEl.replaceChildren();
  if (!props.length) return;
  const h = document.createElement('h2');
  h.textContent = 'Proposals';
  proposalsEl.appendChild(h);
  for (const p of props) {
    const d = document.createElement('div');
    d.className = 'prop';
    const fate = p.resolved_at ? `<b class="adopted">adopted at #${p.resolved_at}</b>` : `open · ${p.consents.length} consent(s)`;
    d.innerHTML = `<b>#${p.id} ${esc(p.kind)}</b>${p.value != null ? ` ${esc(String(p.value))}` : ''} by ${esc(p.by)} — ${fate}<br>${esc(firstWords(p.reason, 24))}`;
    proposalsEl.appendChild(d);
  }
}

function showEntry(e) {
  readerEl.classList.remove('hint');
  const when = new Date(e.ts * 1000).toLocaleString();
  readerEl.innerHTML =
    `<div id="reader-who">${esc(e.who)}</div>` +
    `<div id="reader-meta">#${e.id} · ${e.kind}${e.target != null ? ` → #${e.target}` : ''} · ${esc(e.domain)} · ${when}` +
    (e.affirms || e.challenges ? ` · ${e.affirms} affirm, ${e.challenges} challenge` : '') +
    (e.set_aside ? ' · set aside' : '') + `</div>` +
    `<div id="reader-body">${esc(e.content)}</div>`;
}

// helpers -------------------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function firstWords(s, n) { const w = String(s ?? '').replace(/\s+/g, ' ').trim().split(' '); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.slice(0, n).join(' '); }
function shortWho(w) { return w.length > 18 ? w.slice(0, 17) + '…' : w; }
function fmtTime(ts) { const d = new Date(ts * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtAgo(ts) {
  const s = (state.generated ?? Date.now() / 1000) - ts;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
