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

boot().catch(fail);

async function boot() {
  const response = await fetch(source, { cache: 'no-store' });
  if (!response.ok) throw new Error(`could not read ${source}: HTTP ${response.status}`);
  const state = await response.json();
  const data = substrateFromRecord(state, { minContributions: Number(params.get('min') ?? 1) });
  if (!data.domains.length) throw new Error('the record has no contributions yet');

  if (thresholdSub) {
    thresholdSub.textContent = `${state.members.filter((m) => m.state === 'IN').length} present · ${state.contributions.length} contributions · ${data.domains.length} domains`;
  }

  const field = new Field({ canvas, data });
  field.start();
  window.__FIELD__ = field;
  window.__RECORD__ = state;

  const whisperTimer = setTimeout(() => whisper?.classList.add('visible'), 3200);
  const dismiss = () => {
    clearTimeout(whisperTimer);
    whisper?.classList.remove('visible');
    whisper?.classList.add('gone');
  };
  field.bus.on('viewer:first-movement', () => setTimeout(dismiss, 6000));
  setTimeout(dismiss, 22000);

  // The reader: the record, when you are close enough to one entry for it to be
  // the thing you are looking at. Anchors (domain labels) show the domain.
  field.bus.on('resolution:local-anchor', ({ id }) => {
    const node = id ? field.substrate.concept(id) : null;
    if (!node) return hideReader();
    if (node.isAnchor) {
      const d = state.domains.find((x) => `d:${x.label}` === node.domainId);
      return showReader({
        who: node.label,
        meta: d ? `${d.contributions} contributions · ${d.present?.length ?? 0} present here now` : '',
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

  field.bus.on('field:frame', function report({ frame }) {
    if (frame < 3) return;
    field.bus.off('field:frame', report);
    document.documentElement.dataset.field = 'running';
    if (diagnostics) diagnostics.textContent = JSON.stringify({ ...field.describe(), lastEvent: state.last_event }, null, 2);
  });

  window.addEventListener('beforeunload', () => field.dispose());
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
  console.error('[firmament]', error);
}
