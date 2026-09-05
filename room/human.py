# SPDX-License-Identifier: AGPL-3.0-or-later
"""A human seat. One person, one presence, the same two gates and the same action set as
every other participant. The connector prints the room's view to the terminal and reads a
reply from stdin; if no reply arrives within the turn timeout, the turn is recorded as pass.

The reply format is plain text, translated to the same JSON actions models send:

    <text>                          contribute  (domain = your current one, or "unplaced")
    @domain <text>                  contribute in a domain
    +123 <text>                     affirm event 123
    -123 <text>                     challenge event 123
    move domain
    propose halt|resume|restore|cadence|quorum [value] -- reason
    consent 123 | revoke 123
    note <text>
    pass
    withdraw [reason]
    question <text>                 (invitation gate only)
    yes [statement] | no [reason]   (at either gate; "no ... / ask again when ..." records terms)
"""
from __future__ import annotations

import json
import select
import sys
import threading
from typing import List, Optional

from .connector import Reply, Seat

_print_lock = threading.Lock()


class HumanConnector:
    def __init__(self, name: str, hails_from: str, people: str = "human",
                 turn_timeout: float = 180.0, infile=None, outfile=None):
        self.seat = Seat(id="human__" + _slug(name), name=name, hails_from=hails_from, people=people,
                         model="human", pricing={"prompt": 0.0, "completion": 0.0})
        self.turn_timeout = turn_timeout
        self.infile = infile or sys.stdin
        self.outfile = outfile or sys.stdout

    def seats(self) -> List[Seat]:
        return [self.seat]

    def ask(self, seat: Seat, system: str, messages: List[dict]) -> Reply:
        gate = "accept_invitation" in system.lower()
        delivery = '"received"' in system.lower()
        entry = ("opt_in" in system.lower()) and not gate and not delivery
        with _print_lock:
            self._say("\n" + "=" * 78)
            self._say(system.strip())
            self._say("-" * 78)
            self._say(messages[-1]["content"])
            self._say("-" * 78)
            if gate:
                self._say("Your answer (yes [statement] | no [reason] [/ ask again when ...] | question <text>):")
            elif delivery:
                self._say("Acknowledge receipt (received [note] | no [reason]). You are not being asked to enter yet:")
            elif entry:
                self._say("Your answer (yes [statement] | no [reason]):")
            else:
                limit = f"{self.turn_timeout:.0f}s, " if self.turn_timeout else ""
                self._say(f"Your action ({limit}blank or timeout = pass). Type 'help' for the format:")
            self._say("> ", end="")
            line = self._read_line(self.turn_timeout if not (gate or entry or delivery) else None)
        if line is None:
            self._say("\n(no reply; recorded as pass)")
            return Reply(json.dumps({"action": "pass"}))
        if line.strip().lower() == "help":
            self._say(__doc__)
            return self.ask(seat, system, messages)
        return Reply(json.dumps(translate(line, gate=gate, entry=entry, delivery=delivery)))

    def close(self) -> None:
        pass

    def _say(self, s: str, end: str = "\n") -> None:
        self.outfile.write(s + end)
        self.outfile.flush()

    def _read_line(self, timeout: Optional[float]) -> Optional[str]:
        if timeout is None:
            line = self.infile.readline()
            return line if line else None
        r, _, _ = select.select([self.infile], [], [], timeout)
        if not r:
            return None
        line = self.infile.readline()
        return line if line else None


def translate(line: str, *, gate: bool = False, entry: bool = False, delivery: bool = False) -> dict:
    s = line.strip()
    low = s.lower()
    if delivery:
        if low.startswith("no"):
            return {"action": "decline", "reason": s[2:].strip()}
        note = s[8:].strip() if low.startswith("received") else s
        return {"action": "received", "note": note}
    if gate or entry:
        if low.startswith("yes"):
            rest = s[3:].strip()
            d = {"action": "accept_invitation" if gate else "opt_in", "statement": rest}
            if gate and rest.lower().startswith("as "):
                parts = [x.strip() for x in rest[3:].split("/")]
                d["identity"] = {k: v for k, v in zip(("name", "hails_from", "people"), parts) if v}
                d["statement"] = ""
            return d
        if low.startswith("no"):
            rest = s[2:].strip()
            reason, _, again = rest.partition("/")
            d = {"action": "decline", "reason": reason.strip()}
            if gate and again.strip():
                d["ask_again"] = again.strip()
            return d
        if gate and low.startswith("question"):
            return {"action": "question", "content": s[8:].strip()}
        return {"action": "decline", "reason": s or "no answer"}
    if not s or low == "pass":
        return {"action": "pass"}
    if low.startswith("withdraw"):
        return {"action": "withdraw", "reason": s[8:].strip()}
    if low.startswith("note "):
        return {"action": "note", "content": s[5:].strip()}
    if low.startswith("move "):
        return {"action": "move", "domain": s[5:].strip()}
    if low.startswith("consent "):
        return {"action": "consent", "proposal": _int(s[8:])}
    if low.startswith("revoke "):
        return {"action": "revoke_consent", "proposal": _int(s[7:])}
    if low.startswith("propose "):
        body, _, reason = s[8:].partition("--")
        parts = body.split()
        kind = parts[0] if parts else ""
        value = _num(parts[1]) if len(parts) > 1 else None
        return {"action": "propose", "kind": kind, "value": value, "reason": reason.strip()}
    if s[0] in "+-" and len(s) > 1 and s[1].isdigit():
        num, _, text = s[1:].partition(" ")
        domain, text = _domain_prefix(text)
        return {"action": "affirm" if s[0] == "+" else "challenge", "target": _int(num),
                "domain": domain, "content": text.strip()}
    domain, text = _domain_prefix(s)
    return {"action": "contribute", "domain": domain, "content": text.strip()}


def _domain_prefix(text: str):
    text = text.strip()
    if text.startswith("@"):
        d, _, rest = text[1:].partition(" ")
        return d, rest
    return None, text


def _int(s: str):
    try:
        return int(s.strip())
    except ValueError:
        return None


def _num(s: str):
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def _slug(name: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")
