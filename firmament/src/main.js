// SPDX-License-Identifier: AGPL-3.0-or-later
import { Field } from './field/Field.js';
import { substrateFromRecord } from './substrate/record.js';

/**
 * Entry point. Fetches the room's read-only state, reads it as a substrate, and
 * opens the Firmament onto it.
 *
 * One departure from the seed's silence: a reader pane. A contribution is not a
 * word; when one becomes the local anchor its full text, verbatim and
 * attributed, appears at the edge of the view. It leaves when you do.
 *
 * Two quality presets: full, and a light one for weak or old GPUs. The default
 * path tries full and, if it throws or produces no frames within a window,
 * rebuilds light. ?quality=lite|full forces either.
 */

const canvas = document.getElementById('field');
const whisper = document.getElementById('whisper');
const diagnostics = document.getElementById('diag');
const reader = document.getElementById('reader');
const readerWho = document.getElementById('reader-who');
const readerBody = document.getElementById('reader-body');
const readerMeta = document.getElementById('reader-meta');
const thresholdSub = document.querySelector('#threshold .sub');

const params = new URLSearchParams(location.search);
const source = params.get('state') ?? './state.json';

// Boot log: a line per stage, visible only if the sky never appears. When it is
// black and you do not know why, this is the first thing to read.
const bootLog = document.getElementById('bootlog');
const stage = (msg) => {
  console.info('[firmament]', msg);
  if (bootLog) bootLog.textContent += `${(performance.now() | 0)}ms  ${msg}\n`;
};
setTimeout(() => { if (document.documentElement.dataset.field !== 'running') bootLog?.classList.add('visible'); }, 8000);

const FULL = {};
// The light preset exists so old or weak GPUs (integrated HD 4000-era) can still
// enter: fewer particles, smaller atlas, shorter filaments, pixel ratio capped at 1.
const LITE = {
  pixelRatioCap: 1,
  dustPerRegion: 90,
  legibility: 45,
  vignette: 0.4,
  grain: 0.02,
  fogDensity: 0.00013,
  atlasSize: 2048,
  atlasMax: 2048,
};
const LITE_EMBEDDING = { filamentSegments: 24, conceptFilamentSegments: 16, relaxIterations: 200 };

boot().catch(fail);

async function boot() {
  stage('fetching the record');
  const response = await fetch(source, { cache: 'no-store' });
  if (!response.ok) throw new Error(`could not read ${source}: HTTP ${response.status}`);
  const state = await response.json();
  stage(`record read: ${state.contributions.length} contributions`);
  const data = substrateFromRecord(state, { minContributions: Number(params.get('min') ?? 1) });
  if (!data.domains.length) throw new Error('the record has no contributions yet');
  stage(`substrate: ${data.domains.length} domains`);

  if (thresholdSub) {
    const present = state.members.filter((m) => m.state === 'IN').length;
    thresholdSub.textContent = `${present} present · ${state.contributions.length} contributions · ${data.domains.length} domains`;
  }
  window.__RECORD__ = state;

  const forced = params.get('quality');
  if (forced === 'lite') return open(state, data, LITE, 'light (forced)');
  if (forced === 'full') return open(state, data, FULL, 'full (forced)');
  try {
    await open(state, data, FULL, 'full');
  } catch (error) {
    stage(`full renderer did not hold (${error?.message ?? error}); rebuilding light`);
    await open(state, data, LITE, 'light (fallback)');
  }
}

function open(state, data, quality, label) {
  return new Promise((resolve, reject) => {
    stage(`opening — ${label}`);
    let field;
    try {
      field = new Field({ canvas, data, quality });
    } catch (error) {
      return reject(error);
    }
    stage('renderer constructed');
    window.__FIELD__ = field;
    field.start();
    stage('render loop started; waiting for the first frames');

    // The watchdog counts wall time only while the page is actually visible:
    // browsers stop requestAnimationFrame in hidden/background windows, so a
    // tab left in the background would otherwise "fail" while nothing is wrong.
    // The window is generous (25 s) because a weak GPU can spend many seconds
    // compiling shaders for the first frame.
    let settled = false;
    let lastFrame = performance.now();
    field.bus.on('field:frame', () => { lastFrame = performance.now(); });
    const giveUp = setInterval(() => {
      if (settled) return;
      if (document.hidden) { lastFrame = performance.now(); return; }
      if (performance.now() - lastFrame > 25000) {
        settled = true;
        clearInterval(giveUp);
        try { field.dispose(); } catch {}
        window.__FIELD__ = null;
        reject(new Error('no frames within 25 s of the page being visible'));
      }
    }, 2000);

    field.bus.on('field:frame', function first({ frame }) {
      if (frame < 3) return;
      field.bus.off('field:frame', first);
      if (settled) return;
      settled = true;
      clearInterval(giveUp);
      stage(`frames are being produced — ${label}`);
      document.documentElement.dataset.field = 'running';
      document.documentElement.dataset.fieldQuality = label;
      if (diagnostics) diagnostics.textContent = JSON.stringify({ ...field.describe(), lastEvent: state.last_event, quality: label }, null, 2);
      bindReader(field, state);
      bindThreshold(field);
      window.addEventListener('beforeunload', () => field.dispose());
      resolve();
    });
  });
}

function bindThreshold(field) {
  const whisperTimer = setTimeout(() => whisper?.classList.add('visible'), 3200);
  const dismiss = () => {
    clearTimeout(whisperTimer);
    whisper?.classList.remove('visible');
    whisper?.classList.add('gone');
  };
  field.bus.on('viewer:first-movement', () => setTimeout(dismiss, 6000));
  setTimeout(dismiss, 22000);
}

function bindReader(field, state) {
  // The reader: the record, when you are close enough to one entry for it to be
  // the thing you are looking at. Anchors (domain labels) show the domain.
  field.bus.on('resolution:local-anchor', ({ id }) => {
    const node = id ? field.substrate.concept(id) : null;
    if (!node) return hideReader();
    if (node.isAnchor) {
      const d = state.domains.find((x) => `d:${x.label}` === node.domainId);
      return showReader({
        who: node.label,
        meta: d ? `${d.contributions} contributions · ${d.present?.length ?? 0} present here now` + (d.spellings?.length > 1 ? ` · labels: ${d.spellings.join(', ')}` : '') : '',
        body: '',
      });
    }
    const rec = node.record;
    if (!rec) return hideReader();
    const when = new Date(rec.ts * 1000).toLocaleString();
    const target = rec.target != null ? ` → #${rec.target}` : '';
    showReader({
      who: `${rec.who}`,
      meta: `#${rec.event} · ${rec.kind}${target} · ${rec.domain} · ${when}` +
        (rec.affirms || rec.challenges ? ` · ${rec.affirms} affirm, ${rec.challenges} challenge` : '') +
        (rec.setAside ? ' · set aside by restore' : ''),
      title: rec.title || '',
      body: rec.content,
    });
  });
}

function showReader({ who, meta, title = '', body }) {
  if (!reader) return;
  readerWho.textContent = who;
  readerMeta.textContent = meta;
  readerBody.textContent = title ? `${title}\n\n${body}` : body;
  reader.classList.add('visible');
}

function hideReader() {
  reader?.classList.remove('visible');
}

window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));

function fail(error) {
  const message = error?.message ?? String(error);
  document.documentElement.dataset.field = 'failed';
  document.documentElement.dataset.fieldError = message;
  const panel = document.getElementById('failure');
  const detail = document.getElementById('failure-detail');
  const headline = document.getElementById('failure-message');
  if (headline) {
    headline.textContent = /webgl/i.test(message)
      ? 'The Firmament needs WebGL, and this browser did not provide it.'
      : 'The Firmament could not open.';
  }
  if (detail) detail.textContent = error?.stack ?? message;
  if (panel) panel.hidden = false;
  bootLog?.classList.add('visible');
  console.error('[firmament]', error);
}
