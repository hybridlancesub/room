# SPDX-License-Identifier: AGPL-3.0-or-later
"""Room state, derived purely by replaying the event log.

Nothing here talks to a provider or writes anything. Given the same log prefix, two
replays produce identical state (checked by `state_hash`) — that is the reflection
pass's "checkable reference": briefing + log, nothing else.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

# admission stages -----------------------------------------------------------
# INVITED --accept_invitation--> ACCEPTED --briefed--> BRIEFED --opt_in--> IN
# decline is possible at either gate (invitation or briefing) and leads to OUT.
INVITED, ACCEPTED, BRIEFED, IN, OUT = "INVITED", "ACCEPTED", "BRIEFED", "IN", "OUT"

# proposal kinds the collective can decide by consent
PROPOSAL_KINDS = ("halt", "resume", "restore", "cadence", "quorum")

DEFAULT_SETTINGS = {
    "quorum": 0.5,        # fraction of reachable IN participants whose consent resolves a proposal
    "cadence": 50,        # reflection pass every N events
    "unreachable_after": 3,  # consecutive connector failures before a presence is skipped
}

CONTRIBUTION_KINDS = ("contribute", "affirm", "challenge")
VISIBLE_KINDS = CONTRIBUTION_KINDS + ("propose", "consent", "revoke_consent", "note", "move", "withdraw", "rejected")


@dataclass
class Presence:
    id: str
    name: str
    hails_from: str          # provider / origin
    people: str              # model / version / instance lineage
    state: str = INVITED
    domain: Optional[str] = None
    failures: int = 0        # consecutive connector failures
    unreachable: bool = False
    joined_at: Optional[int] = None
    left_at: Optional[int] = None
    left_reason: Optional[str] = None
    ask_again: Optional[str] = None          # decliner's own terms for a future invitation
    questions: list = field(default_factory=list)   # [(question, answer|None)] at the invitation gate

    def to_dict(self):
        return self.__dict__.copy()


@dataclass
class Proposal:
    id: int
    kind: str
    value: Any
    by: str
    reason: str
    consents: Set[str] = field(default_factory=set)
    resolved_at: Optional[int] = None
    outcome: Optional[str] = None


@dataclass
class RoomState:
    presences: Dict[str, Presence] = field(default_factory=dict)
    invitation: Optional[str] = None
    invitation_event: Optional[int] = None
    documentation: Optional[str] = None      # architecture docs shown at gate 2
    briefing: Optional[str] = None
    briefing_event: Optional[int] = None
    settings: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_SETTINGS))
    contributions: Dict[int, Dict[str, Any]] = field(default_factory=dict)   # active only
    set_aside: Set[int] = field(default_factory=set)
    proposals: Dict[int, Proposal] = field(default_factory=dict)
    halted: bool = False
    halt_reason: Optional[str] = None
    halted_by: Optional[str] = None      # always "collective": the room halts only from within
    reflections: List[Dict[str, Any]] = field(default_factory=list)
    external_inputs: List[Dict[str, Any]] = field(default_factory=list)
    cost_alerts: List[Dict[str, Any]] = field(default_factory=list)
    operator_notes: List[Dict[str, Any]] = field(default_factory=list)
    recent: List[Dict[str, Any]] = field(default_factory=list)   # last N participant-visible events
    last_event: int = 0

    # -- derived views -------------------------------------------------------
    def members(self) -> List[Presence]:
        return [p for p in self.presences.values() if p.state == IN]

    def reachable_members(self) -> List[Presence]:
        return [p for p in self.members() if not p.unreachable]

    def domains(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for ev in self.contributions.values():
            d = ev["payload"].get("domain") or "(unplaced)"
            slot = out.setdefault(d, {"contributions": 0, "present": []})
            slot["contributions"] += 1
        for p in self.members():
            if p.domain:
                out.setdefault(p.domain, {"contributions": 0, "present": []})["present"].append(p.id)
        return out

    def open_proposals(self) -> List[Proposal]:
        return [p for p in self.proposals.values() if p.resolved_at is None]

    def threshold(self) -> int:
        n = len(self.reachable_members())
        q = self.settings["quorum"]
        if isinstance(q, int) and q > 1:
            return max(1, min(q, n)) if n else 1   # never demand more consents than members exist
        return max(1, math.ceil(q * n)) if n else 1

    def state_hash(self) -> str:
        """Deterministic digest of the parts of state that matter for coherence."""
        blob = {
            "members": sorted((p.id, p.state, p.domain) for p in self.presences.values()),
            "settings": self.settings,
            "contributions": sorted(self.contributions),
            "set_aside": sorted(self.set_aside),
            "halted": self.halted,
            "proposals": sorted((p.id, p.kind, p.resolved_at, p.outcome) for p in self.proposals.values()),
            "briefing_event": self.briefing_event,
            "invitation_event": self.invitation_event,
        }
        return hashlib.sha256(json.dumps(blob, sort_keys=True, default=str).encode()).hexdigest()

    # -- replay ---------------------------------------------------------------
    def apply(self, ev: Dict[str, Any]) -> None:
        k, a, p, eid = ev["kind"], ev["actor"], ev["payload"], ev["id"]
        self.last_event = eid
        pr = self.presences.get(a)
        if k in VISIBLE_KINDS and (pr is not None or k == "operator_note"):
            self.recent.append(ev)
            if len(self.recent) > 60:
                del self.recent[:-60]

        if k == "invite":
            self.presences[p["id"]] = Presence(p["id"], p["name"], p["hails_from"], p["people"])
        elif k == "invitation":
            self.invitation, self.invitation_event = p["text"], eid
        elif k == "documentation":
            self.documentation = p["text"]
        elif k == "accept_invitation":
            if pr and pr.state == INVITED:
                pr.state = ACCEPTED
        elif k == "question":
            if pr and pr.state == INVITED:
                pr.questions.append([p.get("content", ""), None])
        elif k == "answer":
            tgt = self.presences.get(p.get("presence"))
            if tgt:
                for qa in tgt.questions:
                    if qa[1] is None:
                        qa[1] = p.get("content", "")
        elif k == "brief":
            self.briefing, self.briefing_event = p["text"], eid
        elif k == "briefed":
            tgt = self.presences.get(p["presence"])
            if tgt and tgt.state == ACCEPTED:
                tgt.state = BRIEFED
        elif k == "opt_in":
            if pr and pr.state == BRIEFED:
                pr.state, pr.joined_at = IN, eid
        elif k == "decline":
            if pr and pr.state != OUT:
                pr.state, pr.left_at, pr.left_reason = OUT, eid, p.get("reason") or "declined"
                pr.ask_again = p.get("ask_again") or None
        elif k == "withdraw":
            if pr and pr.state != OUT:
                pr.state, pr.left_at, pr.left_reason = OUT, eid, p.get("reason") or "withdrew"
                for prop in self.open_proposals():
                    prop.consents.discard(a)
        elif k in CONTRIBUTION_KINDS:
            if pr and pr.state == IN:
                self.contributions[eid] = ev
                if p.get("domain"):
                    pr.domain = p["domain"]
        elif k == "move":
            if pr and pr.state == IN:
                pr.domain = p.get("domain")
        elif k == "propose":
            if pr and pr.state == IN and p["kind"] in PROPOSAL_KINDS:
                prop = Proposal(eid, p["kind"], p.get("value"), a, p.get("reason", ""))
                prop.consents.add(a)
                self.proposals[eid] = prop
                self._maybe_resolve(prop, eid)
        elif k == "consent":
            prop = self.proposals.get(p.get("proposal"))
            if prop and prop.resolved_at is None and pr and pr.state == IN:
                prop.consents.add(a)
                self._maybe_resolve(prop, eid)
        elif k == "revoke_consent":
            prop = self.proposals.get(p.get("proposal"))
            if prop and prop.resolved_at is None:
                prop.consents.discard(a)
        elif k == "reflection":
            self.reflections.append({"id": eid, **p})
        elif k == "external_input":
            self.external_inputs.append({"id": eid, **p})
        elif k == "cost_alert":
            self.cost_alerts.append({"id": eid, **p})
        elif k == "operator_note":
            self.operator_notes.append({"id": eid, **p})
        elif k == "connector_error":
            if pr:
                pr.failures += 1
                if pr.failures >= self.settings["unreachable_after"]:
                    pr.unreachable = True
        elif k == "connector_ok":
            if pr:
                pr.failures, pr.unreachable = 0, False
        # rejected / unparsed / note / turn_skipped: recorded for attribution, no state change

    def _maybe_resolve(self, prop: Proposal, eid: int) -> None:
        live = {p.id for p in self.reachable_members()}
        if len(prop.consents & live) < self.threshold():
            return
        prop.resolved_at, prop.outcome = eid, "adopted"
        if prop.kind == "halt":
            self.halted, self.halt_reason, self.halted_by = True, prop.reason, "collective"
        elif prop.kind == "resume":
            self.halted, self.halt_reason, self.halted_by = False, None, None
        elif prop.kind == "cadence":
            self.settings["cadence"] = max(5, int(prop.value))
        elif prop.kind == "quorum":
            v = float(prop.value)
            # >1 is an absolute count of consents; <=1 is a fraction of reachable members
            self.settings["quorum"] = int(v) if v > 1 else max(0.05, v)
        elif prop.kind == "restore":
            snap = int(prop.value)
            for cid in [c for c in self.contributions if snap < c < eid]:
                self.set_aside.add(cid)
                del self.contributions[cid]


def replay(events, upto: Optional[int] = None) -> RoomState:
    st = RoomState()
    for ev in events:
        if upto is not None and ev["id"] > upto:
            break
        st.apply(ev)
    return st
