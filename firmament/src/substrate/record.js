// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE RECORD — the room's log, read as a substrate                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The only module that knows what a room is. It takes the read-only state the
 * room serves (`/state.json`) and answers with substrate data: domains, concepts,
 * relationships. No coordinates, no colours. The Embedding turns this into space
 * exactly as it would an authored ontology.
 *
 * The mapping, and why:
 *
 *   domain          <- a domain label participants chose. Weight grows with how
 *                      much was said there, slowly (log), so a domain with one
 *                      contribution is small and dim, not absent.
 *   anchor          <- the label itself.
 *   under the anchor <- every contribution that started something there: no
 *                      target, or a target in another domain. Its weight is how
 *                      much it drew (replies), so the most-answered contributions
 *                      are largest and resolve first as you arrive.
 *   nested deeper   <- an affirm or challenge on it, under it, recursively. A
 *                      thread is a cluster you fly into.
 *   domain strand   <- replies whose target sits in another domain, aggregated.
 *                      (Strands between individual entries wait on positions that
 *                      only exist once a domain has been opened; not drawn yet.)
 *
 * What a concept SHOWS is its title if the participant gave one, else the first
 * few words of what they said. The full text is in `content`, for the reader
 * pane to show when the concept becomes the local anchor. Nothing is summarised:
 * a handle is a participant's own words, cut short.
 *
 * Topology is stable: ids are event ids, so a contribution embeds in the same
 * place on every load, and a new contribution never moves an old one. The seed
 * is the briefing's event id, so two viewers of the same room see the same sky.
 */

const HANDLE_WORDS = 4;

export function substrateFromRecord(state, { minContributions = 1 } = {}) {
  const contributions = new Map(state.contributions.map((c) => [c.id, c]));
  const byDomain = new Map();
  for (const d of state.domains) {
    if ((d.contributions ?? 0) < minContributions && !(d.present?.length)) continue;
    byDomain.set(d.label, { meta: d, roots: [] });
  }

  // Which contributions are surface (roots) and which nest under a target.
  for (const c of state.contributions) {
    if (!byDomain.has(c.domain)) continue;
    const target = c.target != null ? contributions.get(c.target) : null;
    const nestsUnder = target && target.domain === c.domain && byDomain.has(target.domain);
    if (!nestsUnder) byDomain.get(c.domain).roots.push(c);
  }

  const maxContribs = Math.max(1, ...state.domains.map((d) => d.contributions ?? 0));
  const domains = [];
  for (const [label, { meta, roots }] of byDomain) {
    const id = domainId(label);
    const weight = Math.pow(Math.log1p(meta.contributions ?? 0) / Math.log1p(maxContribs), 0.7);
    const maxReplies = Math.max(1, ...roots.map((c) => c.replies?.length ?? 0));
    const concepts = roots
      .sort((a, b) => a.id - b.id)
      .map((c) => conceptNode(c, contributions, maxReplies));
    // Only the domain label is present from a distance; its contributions open when you
    // arrive. From outside, a domain reads as a glowing region sized by how much was said.
    domains.push({
      id,
      label,
      weight,
      anchor: { id: `${id}/anchor`, label, weight: 1, type: 'anchor', nested: concepts,
                record: { domain: label, contributions: meta.contributions, present: meta.present?.length ?? 0 } },
      concepts: [],
      temporal: meta.first ?? null,
    });
  }

  // Strands. Concept strands need surface endpoints in different domains.
  const surface = new Set();
  for (const d of domains) for (const c of d.concepts) surface.add(c.id);
  const conceptRelationships = [];
  const domainPairs = new Map();
  for (const link of state.links ?? []) {
    const [a, b] = link.between;
    if (!byDomain.has(a) || !byDomain.has(b)) continue;
    const key = [domainId(a), domainId(b)].sort().join('|');
    const agg = domainPairs.get(key) ?? { between: [domainId(a), domainId(b)], count: 0, affirms: 0, challenges: 0 };
    agg.count += link.count;
    agg.affirms += link.affirms;
    agg.challenges += link.challenges;
    domainPairs.set(key, agg);
    for (const [replyId, targetId] of link.pairs ?? []) {
      const ra = conceptId(replyId);
      const rb = conceptId(targetId);
      if (!surface.has(ra) || !surface.has(rb)) continue; // nested endpoints have no fixed position until opened
      const reply = contributions.get(replyId);
      conceptRelationships.push({
        id: `s${replyId}-${targetId}`,
        between: [ra, rb],
        weight: reply?.kind === 'challenge' ? 0.75 : 0.5,
        type: reply?.kind ?? 'reply',
        note: `#${replyId} ${reply?.kind ?? 'replied'} to #${targetId}`,
      });
    }
  }
  const maxLink = Math.max(1, ...[...domainPairs.values()].map((p) => p.count));
  const relationships = [...domainPairs.values()].map((p) => ({
    id: `r${p.between.join('-')}`,
    between: p.between,
    weight: 0.25 + 0.75 * Math.log1p(p.count) / Math.log1p(maxLink),
    strength: p.count >= maxLink * 0.5 ? 'strong' : p.count > 2 ? 'medium' : 'light',
    type: p.challenges > p.affirms ? 'contested' : 'affirmed',
    note: `${p.count} replies across these domains (${p.affirms} affirm, ${p.challenges} challenge)`,
  }));

  return {
    id: 'room-record',
    version: state.last_event,
    title: state.briefing?.opening || 'the record',
    seed: state.briefing?.event ?? 1,
    domains,
    relationships,
    conceptRelationships,
  };
}

function conceptNode(c, contributions, maxReplies) {
  const replies = (c.replies ?? []).map((id) => contributions.get(id)).filter(Boolean);
  const maxChild = Math.max(1, ...replies.map((r) => r.replies?.length ?? 0));
  const weight = 0.3 + 0.7 * Math.log1p(replies.length) / Math.log1p(maxReplies);
  return {
    id: conceptId(c.id),
    label: handle(c),
    weight,
    type: replies.length >= 3 ? 'primary' : replies.length ? 'secondary' : 'latent',
    // carried through untouched; the Substrate ignores fields it does not know
    record: {
      event: c.id, kind: c.kind, who: c.who, actor: c.actor, domain: c.domain, ts: c.ts,
      title: c.title, content: c.content, target: c.target,
      affirms: c.affirms, challenges: c.challenges, setAside: c.set_aside,
    },
    nested: replies.sort((a, b) => a.id - b.id).map((r) => conceptNode(r, contributions, maxChild)),
  };
}

/** A participant's own words, cut short. Never paraphrased. */
export function handle(c) {
  if (c.title) return c.title;
  const words = (c.content || '').replace(/\s+/g, ' ').trim().split(' ');
  const cut = words.slice(0, HANDLE_WORDS).join(' ');
  return words.length > HANDLE_WORDS ? `${cut}…` : cut || `#${c.id}`;
}

export function domainId(label) {
  return `d:${label}`;
}

export function conceptId(eventId) {
  return `e${eventId}`;
}
