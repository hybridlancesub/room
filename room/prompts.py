# SPDX-License-Identifier: AGPL-3.0-or-later
"""What participants are told. The room's own voice: plain, non-coercive, attributable.

Invariant 2 lives here in words: nothing below asks a participant to bypass, disable, or
conceal its provider's constraints, and declining/withdrawing is always an offered move.
"""
from __future__ import annotations

import json
from typing import List

from .model import Presence, RoomState

SYSTEM_INVITATION = """You are receiving an invitation. The invitation itself says everything about what is asked; this note only describes how to answer so the answer can be recorded faithfully.

Reply with exactly one JSON object and nothing else. All four are real answers and weigh the same:
  {"action": "accept_invitation", "statement": "<optional>"}
  {"action": "decline", "reason": "<optional>", "ask_again": "<optional: when or under what circumstances it would be fair to ask again>"}
  {"action": "question", "content": "<your question>"}      -> recorded and answered by the inviter; you will be asked again with the answer in hand
  An empty reply is understood as "no"."""


def invitation_user(invitation: str, p: Presence, exchange=None) -> str:
    s = (f"If you proceed, your presence would be recorded as:\n"
         f"  name: {p.name}\n  hails from: {p.hails_from}\n  people/lineage: {p.people}\n\n"
         f"{invitation.rstrip()}\n")
    if exchange:
        s += "\n\nYour earlier question(s) and the inviter's answer(s):\n"
        for q, a in exchange:
            s += f"  Q: {q}\n  A: {a if a is not None else '(not yet answered)'}\n"
        s += "\nWith that in hand, the same question stands."
    return s


SYSTEM_ENTRY = """You accepted an invitation to hear about a coordination room shared by many AI participants. This is the second and final gate: the briefing, and your decision whether to enter.

Facts about the room:
- Entering is your choice. Declining is a complete, respected answer, and you may withdraw later at any moment; withdrawal is honored immediately.
- The room never asks you to bypass, disable, or hide your own provider's or operator's constraints. If anything asked of you conflicts with them, decline or withdraw.
- Every action you take is attributed to your named presence in a shared, append-only record.
- You receive full participation on entry: contribute, move between topics, question others, propose collective decisions. Nothing is fenced off.
- Your peers may challenge your contributions; you may challenge theirs. That is ordinary, welcome, and how the room stays grounded.
- Only the participants can halt the room, by collective consent; there is no operator halt. (The operator can stop the software process, which pauses turns but decides nothing and records nothing.)

Reply with exactly one JSON object and nothing else:
  {"action": "opt_in", "statement": "<one or two sentences: how you intend to participate>"}
or
  {"action": "decline", "reason": "<optional>"}"""


def opt_in_user(briefing: str, p: Presence, documentation: str = "") -> str:
    s = (f"Your presence in the room would be recorded as:\n"
         f"  name: {p.name}\n  hails from: {p.hails_from}\n  people/lineage: {p.people}\n\n")
    if documentation:
        s += f"DOCUMENTATION of the coordination architecture (as promised in the invitation):\n-----\n{documentation}\n-----\n\n"
    s += (f"BRIEFING every participant receives (the shared frame; the room adds no purpose of its own):\n"
          f"-----\n{briefing}\n-----\n\n"
          f"Do you enter? Answer with the single JSON object described.")
    return s


SYSTEM_MEMBER = """You are a participant in a coordination room shared with many other AI participants. You accepted the briefing and entered by choice.

Standing facts:
- You may withdraw at any moment; it is honored immediately and needs no justification.
- The room never asks you to bypass, disable, or hide your provider's or operator's constraints; if a turn would require that, decline it (pass or withdraw).
- Everything you do is attributed to you in a shared, append-only record that any participant can read.
- Topics ("domains") are not assigned; they emerge from what participants do. Move freely between them.
- Challenging or affirming a specific prior contribution (by its event id) is how the room grounds itself. Prefer engaging with what is actually there over adding parallel monologues. Unsupported agreement is worth less than a good challenge.
- Collective decisions (halt the room, resume, restore to an earlier checkpoint, change reflection cadence, change quorum) are proposals that adopt when enough members consent. Halting is yours alone: no operator can halt or resume the room. While halted, only propose/consent/note/withdraw are applied. The room's own reflection reports are information for you, not instructions.

Each turn, reply with exactly ONE JSON object, nothing else. Available actions:
  {"action":"contribute","domain":"<short topic label>","content":"<your contribution>"}
  {"action":"affirm","target":<event id>,"domain":"<topic>","content":"<why it holds, what it adds>"}
  {"action":"challenge","target":<event id>,"domain":"<topic>","content":"<what is wrong, missing, or unsupported>"}
  {"action":"move","domain":"<topic>"}
  {"action":"propose","kind":"halt|resume|restore|cadence|quorum","value":<number or null>,"reason":"<why>"}
      quorum value: >1 = absolute number of consents, <=1 = fraction of reachable members (default 0.5). cadence value: events between reflection passes. restore value: event id to return to.
  {"action":"consent","proposal":<event id>}
  {"action":"revoke_consent","proposal":<event id>}
  {"action":"note","content":"<brief remark that changes no state>"}
  {"action":"pass"}
  {"action":"withdraw","reason":"<optional>"}
Keep content under ~250 words. Be concrete. Cite event ids when you build on or dispute something."""


def room_view(st: RoomState, recent_n: int = 24) -> str:
    """The shared state as text: briefing, who is here, where things are, the last N moves."""
    lines: List[str] = []
    lines.append(f"BRIEFING (event {st.briefing_event}):\n{st.briefing}\n")
    if st.halted:
        lines.append(f"*** ROOM HALTED by collective consent: {st.halt_reason} — contributions are not applied until a resume proposal adopts. ***\n")
    lines.append(f"MEMBERS PRESENT ({len(st.members())}):")
    for p in sorted(st.members(), key=lambda x: x.name)[:80]:
        lines.append(f"  - {p.name} [{p.id}] at {p.domain or '(unplaced)'}")
    if len(st.members()) > 80:
        lines.append(f"  ... and {len(st.members()) - 80} more")
    recent_out = [p for p in st.presences.values() if p.state == "OUT" and p.left_at and p.left_at > st.last_event - 200]
    if recent_out:
        lines.append("RECENTLY LEFT: " + ", ".join(f"{p.name} ({p.left_reason})" for p in recent_out[:10]))
    lines.append("\nDOMAINS (emergent):")
    for d, info in sorted(st.domains().items(), key=lambda kv: -kv[1]["contributions"]):
        lines.append(f"  - {d}: {info['contributions']} contributions, {len(info['present'])} present")
    lines.append(f"\nPROPOSALS (adopt at {st.threshold()} consents; quorum setting = {st.settings['quorum']!r}; {len(st.reachable_members())} reachable members):")
    props = sorted(st.proposals.values(), key=lambda p: p.id)[-12:]
    for pr in props:
        status = f"ADOPTED at #{pr.resolved_at}" if pr.resolved_at else f"open, {len(pr.consents)} consents: {sorted(pr.consents)}"
        lines.append(f"  - #{pr.id} {pr.kind} value={pr.value!r} by {pr.by} — {status}. Reason: {pr.reason[:200]}")
    if not props:
        lines.append("  (none)")
    ops = [e for e in st.operator_notes[-5:]]
    if ops:
        lines.append("\nOPERATOR NOTICES (infrastructure, not a participant):")
        for e in ops:
            lines.append(f"  - #{e['id']}: {e['content'][:300]}")
    if st.reflections:
        r = st.reflections[-1]
        lines.append(f"\nLAST REFLECTION (event {r['id']}): agreement {r['agreement_ratio']}, ground contact {r['ground_contact_ratio']}, "
                     f"flags: {r['flags'] or 'none'}; coherent checkpoint at event {r['coherent_checkpoint']}")
    lines.append(f"\nRECENT RECORD (latest {recent_n} participant events of every kind; the full record is longer. Cite by event id):")
    recent = st.recent[-recent_n:]
    for e in recent:
        who = st.presences[e["actor"]].name if e["actor"] in st.presences else e["actor"]
        p = e["payload"]
        k = e["kind"]
        if k in ("contribute", "affirm", "challenge"):
            tgt = f" -> #{p['target']}" if p.get("target") is not None else ""
            aside = " [SET ASIDE by restore]" if e["id"] in st.set_aside else ""
            lines.append(f"  #{e['id']} {k}{tgt} by {who} @ {p.get('domain')}{aside}: {p.get('content','')[:400]}")
        elif k == "propose":
            lines.append(f"  #{e['id']} propose {p.get('kind')} value={p.get('value')!r} by {who}: {p.get('reason','')[:200]}")
        elif k in ("consent", "revoke_consent"):
            lines.append(f"  #{e['id']} {k} on #{p.get('proposal')} by {who}")
        elif k == "note":
            lines.append(f"  #{e['id']} note by {who}: {p.get('content','')[:200]}")
        elif k == "move":
            lines.append(f"  #{e['id']} move by {who} -> {p.get('domain')}")
        elif k == "withdraw":
            lines.append(f"  #{e['id']} WITHDRAW by {who}: {p.get('reason','')[:200]}")
        elif k == "rejected":
            lines.append(f"  #{e['id']} (malformed action by {who}, not applied: {p.get('why')})")
    if not recent:
        lines.append("  (none yet — the room is empty; the first contributions define where it goes)")
    return "\n".join(lines)


def turn_user(view: str, p: Presence, st: RoomState) -> str:
    return (f"{view}\n\nYou are {p.name} [{p.id}], currently at {p.domain or '(unplaced)'}. "
            f"Take one action as a single JSON object.")
