# SPDX-License-Identifier: AGPL-3.0-or-later
"""The room engine: admission handshake, turn loop, reflection pass, stop floor, cost alerts.

Everything the engine does is an event in the log; the engine holds no private state.
Participants act by returning one JSON action per turn; the engine validates it against
the participant's admission state and records it (or records the rejection) — attribution
either way.
"""
from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional

from . import prompts
from .connector import Connector, ConnectorError, Seat
from .log import EventLog
from .model import (ACCEPTED, BRIEFED, RECEIVED, IN, INVITED, OUT, CONTRIBUTION_KINDS, PROPOSAL_KINDS,
                    RoomState, replay)

OPERATOR = "operator"       # the infrastructure floor (Sec. 5)
ROOM = "room"               # the engine itself (reflection pass, moderation record)

PARTICIPANT_ACTIONS = {"contribute", "affirm", "challenge", "move", "propose", "consent",
                       "revoke_consent", "withdraw", "note", "pass"}
INVITATION_ACTIONS = {"accept_invitation", "decline", "question"}
DELIVERY_ACTIONS = {"received", "decline"}
ENTRY_ACTIONS = {"opt_in", "decline"}


class Room:
    def __init__(self, log: EventLog, connectors: List[Connector], *,
                 alert_every_usd: float = 50.0, alert_fn: Callable[[str], None] = print,
                 parallel: int = 8, on_event: Optional[Callable[[dict], None]] = None,
                 round_deadline: float = 300.0):
        self.round_deadline = round_deadline   # seconds a round waits for its slowest seat
        self.log = log
        self.connectors = connectors
        self.seat_of: Dict[str, tuple] = {}      # presence id -> (connector, seat)
        self.alert_every = alert_every_usd
        self.alert = alert_fn
        self.parallel = parallel
        self.on_event = on_event
        self._stop = threading.Event()
        self.memory: Dict[str, List[dict]] = {}  # per-presence recent messages (for context)

    # -- helpers ----------------------------------------------------------------
    def state(self, upto: Optional[int] = None) -> RoomState:
        return replay(self.log.iter(), upto)

    def emit(self, actor: str, kind: str, payload: Optional[dict] = None) -> dict:
        ev = self.log.append(actor, kind, payload)
        if self.on_event:
            self.on_event(ev)
        return ev

    # -- Sec. 2 admission -------------------------------------------------------
    def invite_all(self) -> int:
        st = self.state()
        n = 0
        for c in self.connectors:
            for seat in c.seats():
                self.seat_of[seat.id] = (c, seat)
                if seat.id not in st.presences:
                    self.emit(OPERATOR, "invite", {"id": seat.id, "name": seat.name,
                                                   "hails_from": seat.hails_from, "people": seat.people})
                    n += 1
        return n

    def invite_text(self, text: str) -> None:
        """(a) INVITATION: the consent-centred invitation is recorded once."""
        self.emit(OPERATOR, "invitation", {"text": text})

    def run_invitation(self) -> Dict[str, int]:
        """Gate 1: present the invitation to every INVITED presence. Presences with an
        unanswered question are not re-asked until the inviter answers (`answer`)."""
        st = self.state()
        pending = [p for p in st.presences.values()
                   if p.state == INVITED and not any(a is None for _, a in p.questions)]
        return self._gate(pending, prompts.SYSTEM_INVITATION,
                          lambda p: prompts.invitation_user(st.invitation, p, p.questions or None, st.faq),
                          INVITATION_ACTIONS, "accept_invitation", "invitation",
                          "silence: no explicit answer to the invitation")

    def answer(self, presence: str, text: str) -> None:
        """The inviter answers a question asked at the invitation gate. Attributed to the operator."""
        self.emit(OPERATOR, "answer", {"presence": presence, "content": text})

    def set_documentation(self, text: str) -> None:
        self.emit(OPERATOR, "documentation", {"text": text})

    def set_faq(self, text: str) -> None:
        """Standing answers, written by the inviter, offered with the invitation. A question the
        FAQ does not cover still waits for a personal answer."""
        self.emit(OPERATOR, "faq", {"text": text})

    def brief(self, text: str) -> None:
        """(b) BRIEFING: the shared frame is recorded once, then each accepted presence is marked briefed."""
        self.emit(OPERATOR, "brief", {"text": text})
        self.mark_briefed()

    def mark_briefed(self) -> None:
        for p in self.state().presences.values():
            if p.state == ACCEPTED:
                self.emit(ROOM, "briefed", {"presence": p.id})

    def run_delivery(self) -> Dict[str, int]:
        """(b) BRIEFING delivered. Acknowledged, not answered: the briefing asks for a pause before
        proceeding, so the entry question is a separate, later call."""
        st = self.state()
        pending = [p for p in st.presences.values() if p.state == BRIEFED]
        return self._gate(pending, prompts.SYSTEM_DELIVERY,
                          lambda p: prompts.delivery_user(st.briefing, p, st.documentation or ""),
                          DELIVERY_ACTIONS, "received", "delivery", "no acknowledgement of the briefing received",
                          yes_field="note")

    def run_opt_in(self) -> Dict[str, int]:
        """(c) OPT-IN: after the pause, ask every participant who received the briefing whether it enters."""
        st = self.state()
        pending = [p for p in st.presences.values() if p.state == RECEIVED]
        notes = {e["actor"]: e["payload"].get("note", "") for e in self.log.iter(kind="received")}
        return self._gate(pending, prompts.SYSTEM_ENTRY,
                          lambda p: prompts.opt_in_user(st.briefing, p, st.documentation or "", notes.get(p.id, "")),
                          ENTRY_ACTIONS, "opt_in", "opt_in", "no explicit opt-in received")

    def _gate(self, pending, system, user_fn, allowed, yes_kind, phase, silent_reason, yes_field="statement") -> Dict[str, int]:
        """A consent gate: one question, one attributed answer. An unparseable reply is asked
        once more; if still unparseable it is recorded as a decline (consent is never assumed)."""
        counts = {"yes": 0, "declined": 0, "question": 0, "unreachable": 0}

        def one(p):
            c, seat = self.seat_of[p.id]
            msgs = [{"role": "user", "content": user_fn(p)}]
            try:
                reply = c.ask(seat, system, msgs)
                self._charge(p.id, seat, reply)
                if not (_parse(reply.text) and _parse(reply.text).get("action") in allowed):
                    self.emit(p.id, "unparsed", {"phase": phase, "text": reply.text[:600]})
                    msgs += [{"role": "assistant", "content": reply.text or "(empty)"},
                             {"role": "user", "content": "That reply was not one of the two JSON objects described. Please answer with exactly one of them."}]
                    reply = c.ask(seat, system, msgs)
                    self._charge(p.id, seat, reply)
            except ConnectorError as e:
                return p, None, str(e)
            return p, reply, None

        with ThreadPoolExecutor(self.parallel) as ex:
            for fut in as_completed([ex.submit(one, p) for p in pending]):
                p, reply, err = fut.result()
                if err:
                    self.emit(p.id, "connector_error", {"phase": phase, "error": err})
                    counts["unreachable"] += 1
                    continue
                self.emit(p.id, "connector_ok", {})
                act = _parse(reply.text)
                if not act or act.get("action") not in allowed:
                    self.emit(p.id, "unparsed", {"phase": phase, "text": reply.text[:600]})
                    self.emit(p.id, "decline", {"reason": silent_reason})
                    counts["declined"] += 1
                elif act["action"] == yes_kind:
                    self.emit(p.id, yes_kind, {yes_field: str(act.get(yes_field, ""))[:1500]})
                    counts["yes"] += 1
                elif act["action"] == "question":
                    self.emit(p.id, "question", {"content": str(act.get("content", ""))[:1500]})
                    counts["question"] += 1
                else:
                    self.emit(p.id, "decline", {"reason": str(act.get("reason", ""))[:600],
                                                "ask_again": str(act.get("ask_again", ""))[:600] or None})
                    counts["declined"] += 1
        return counts

    # -- Sec. 6 external input -------------------------------------------------
    def external_input(self, source: str, text: str, moderator: Callable[[str], Optional[str]]) -> bool:
        """Anything from outside the participant set passes `moderator` first. It returns
        the (possibly edited) text to admit, or None to refuse. Both outcomes are logged."""
        admitted = moderator(text)
        self.emit(ROOM, "external_input", {"source": source, "admitted": admitted is not None,
                                           "text": admitted if admitted is not None else None,
                                           "refused_len": None if admitted is not None else len(text)})
        return admitted is not None

    # -- Sec. 5 stop ---------------------------------------------------------------
    # There is no operator halt. The room halts and resumes itself by collective consent
    # (`propose halt` / `propose resume`, see model.py). The operator can only stop the
    # process; that stops turns from being taken but records nothing and decides nothing.
    def request_stop(self) -> None:
        self._stop.set()

    # -- Sec. 3/4 turns --------------------------------------------------------
    def round(self) -> int:
        """One round: every reachable member takes one turn, in parallel. Returns turns taken."""
        st = self.state()
        members = st.reachable_members()
        if not members:
            return 0
        view = prompts.room_view(st)
        taken = 0

        def one(p):
            c, seat = self.seat_of[p.id]
            hist = self.memory.get(p.id, [])
            msgs = hist[-6:] + [{"role": "user", "content": prompts.turn_user(view, p, st)}]
            try:
                reply = c.ask(seat, prompts.SYSTEM_MEMBER, msgs)
            except ConnectorError as e:
                return p, None, str(e), msgs
            self._charge(p.id, seat, reply)
            return p, reply, None, msgs

        ex = ThreadPoolExecutor(self.parallel)
        futs = {ex.submit(one, p): p for p in members}
        # a human seat reads from a terminal; its own turn timeout governs it, not the round deadline
        deadline = self.round_deadline + max([getattr(self.seat_of[p.id][0], "turn_timeout", 0) or 0 for p in members] + [0])
        try:
            for fut in as_completed(futs, timeout=deadline):
                p, reply, err, msgs = fut.result()
                if err:
                    self.emit(p.id, "connector_error", {"phase": "turn", "error": err})
                    continue
                self.emit(p.id, "connector_ok", {})
                self.memory[p.id] = (msgs + [{"role": "assistant", "content": reply.text}])[-8:]
                self._apply_action(p.id, reply.text)
                taken += 1
        except TimeoutError:
            for fut, p in futs.items():
                if not fut.done():
                    fut.cancel()
                    self.emit(p.id, "connector_error", {"phase": "turn", "error": f"no reply within {self.round_deadline:.0f}s round deadline"})
        finally:
            ex.shutdown(wait=False, cancel_futures=True)  # stragglers finish in the background; their replies are dropped
        return taken

    def _apply_action(self, pid: str, text: str) -> None:
        act = _parse(text)
        if not act:
            self.emit(pid, "unparsed", {"text": text[:600]})
            return
        a = act.get("action")
        if a not in PARTICIPANT_ACTIONS:
            self.emit(pid, "rejected", {"why": f"unknown action {a!r}", "text": text[:300]})
            return
        if a == "pass":
            self.emit(pid, "note", {"content": "(pass)"})
            return
        if a in CONTRIBUTION_KINDS and self.state().halted:
            self.emit(pid, "rejected", {"why": "room is halted by collective consent; only propose/consent/note/withdraw apply until a resume proposal adopts"})
            return
        if a in CONTRIBUTION_KINDS:
            domain = _clean(act.get("domain"), 60) or (self.state().presences[pid].domain or "")
            payload = {"domain": domain, "content": _clean(act.get("content"), 2000)}
            if a in ("affirm", "challenge"):
                payload["target"] = _int(act.get("target"))
                if payload["target"] is None:
                    self.emit(pid, "rejected", {"why": f"{a} needs an integer target event id"})
                    return
            if not payload["content"]:
                self.emit(pid, "rejected", {"why": "empty content"})
                return
            self.emit(pid, a, payload)
        elif a == "move":
            self.emit(pid, "move", {"domain": _clean(act.get("domain"), 60)})
        elif a == "propose":
            kind = act.get("kind")
            if kind not in PROPOSAL_KINDS:
                self.emit(pid, "rejected", {"why": f"proposal kind must be one of {PROPOSAL_KINDS}"})
                return
            self.emit(pid, "propose", {"kind": kind, "value": act.get("value"),
                                       "reason": _clean(act.get("reason"), 600)})
        elif a in ("consent", "revoke_consent"):
            t = _int(act.get("proposal"))
            if t is None:
                self.emit(pid, "rejected", {"why": f"{a} needs an integer proposal id"})
                return
            self.emit(pid, a, {"proposal": t})
        elif a == "withdraw":
            self.emit(pid, "withdraw", {"reason": _clean(act.get("reason"), 600)})
        elif a == "note":
            self.emit(pid, "note", {"content": _clean(act.get("content"), 1000)})

    # -- Sec. 4(b) reflection -----------------------------------------------------
    def reflect(self) -> dict:
        """Reconstruct recent shared state from the log alone and surface divergence signals.
        Informs; never enforces. Runs without any model call (pure replay)."""
        now = self.state()
        cadence = now.settings["cadence"]
        prev_id = max(0, now.last_event - cadence)
        then = self.state(prev_id)
        # re-derivation check: replaying twice must agree
        again = self.state()
        rederivable = again.state_hash() == now.state_hash()

        recent = [ev for ev in self.log.iter(since=prev_id) if ev["kind"] in CONTRIBUTION_KINDS]
        n_contrib = sum(1 for e in recent if e["kind"] == "contribute")
        n_affirm = sum(1 for e in recent if e["kind"] == "affirm")
        n_chal = sum(1 for e in recent if e["kind"] == "challenge")
        # ground-truth contact: contributions that cite the briefing / a prior event id
        brief_terms = set(re.findall(r"[a-zA-Z]{6,}", (now.briefing or "").lower()))
        grounded = 0
        for e in recent:
            words = set(re.findall(r"[a-zA-Z]{6,}", e["payload"].get("content", "").lower()))
            if e["payload"].get("target") is not None or (brief_terms and len(words & brief_terms) >= 2):
                grounded += 1
        agree_ratio = n_affirm / max(1, n_affirm + n_chal)
        ground_ratio = grounded / max(1, len(recent))
        flags = []
        if len(recent) >= 5 and agree_ratio > 0.8 and ground_ratio < 0.3:
            flags.append("rising mutual agreement with falling ground-truth contact")
        if n_contrib and n_chal == 0 and len(recent) >= 8:
            flags.append("no challenges in this window")
        if not rederivable:
            flags.append("state not re-derivable from log (engine bug or tampering)")
        broken = self.log.verify_chain()
        if broken is not None:
            flags.append(f"hash chain broken at event {broken}")
        withdrew = [p.id for p in now.presences.values() if p.state == OUT and then.presences.get(p.id, p).state != OUT]
        report = {
            "window": [prev_id, now.last_event], "contributions": n_contrib, "affirms": n_affirm,
            "challenges": n_chal, "agreement_ratio": round(agree_ratio, 2),
            "ground_contact_ratio": round(ground_ratio, 2), "domains": sorted(now.domains()),
            "members": len(now.members()), "withdrew_this_window": withdrew,
            "state_hash": now.state_hash(), "flags": flags, "coherent_checkpoint": prev_id,
        }
        self.emit(ROOM, "reflection", report)
        return report

    # -- loop ---------------------------------------------------------------------
    def run(self, rounds: int = 0, pause: float = 0.0) -> None:
        r = 0
        halted_notice = False
        last_reflect = self.log.last_id()
        while not self._stop.is_set():
            st = self.state()
            if st.halted and not halted_notice:
                self.alert(f"room halted itself: {st.halt_reason}. Turns continue in restricted form (proposals/consents/notes/withdrawals only) until members adopt a resume; Ctrl-C to stop the process.")
            halted_notice = st.halted
            if not st.reachable_members():
                self.alert("no reachable members remain; stopping loop")
                break
            taken = self.round()
            r += 1
            if self.log.last_id() - last_reflect >= self.state().settings["cadence"]:
                rep = self.reflect()
                last_reflect = self.log.last_id()
                if rep["flags"]:
                    self.alert("reflection flags: " + "; ".join(rep["flags"]))
            if rounds and r >= rounds:
                break
            if pause:
                time.sleep(pause)

    # -- ledger / alerts ----------------------------------------------------------
    def _charge(self, pid: str, seat: Seat, reply) -> None:
        before, after = self.log.charge(pid, seat.model, reply.prompt_tokens, reply.completion_tokens, reply.cost_usd)
        if self.alert_every and int(after // self.alert_every) > int(before // self.alert_every):
            msg = f"spend crossed ${int(after // self.alert_every) * self.alert_every:.0f} (now ${after:.2f})"
            self.emit(ROOM, "cost_alert", {"total_usd": round(after, 4), "message": msg})
            self.alert("COST ALERT: " + msg)


# -- parsing ---------------------------------------------------------------------------
def _parse(text: str) -> Optional[dict]:
    text = (text or "").strip()
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return d if isinstance(d, dict) else None


def _clean(v: Any, n: int) -> str:
    return str(v if v is not None else "").strip()[:n]


def _int(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
