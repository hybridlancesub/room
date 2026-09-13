# SPDX-License-Identifier: AGPL-3.0-or-later
"""A read-only window onto the record, for a human observer's viewer (see firmament/).

Serves the replayed state as JSON on localhost. It writes nothing, accepts nothing, and is
not a participant-facing surface: participants never see it, and nothing here can reach the
room. It is the operator reading their own log, in a form a renderer can use.

    GET /state.json          domains, members, contributions (with affirm/challenge threads), proposals
    GET /event/<id>.json     one event in full
    GET /                    the viewer, if a directory was given
"""
from __future__ import annotations

import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

from .log import EventLog
from .model import CONTRIBUTION_KINDS, replay


def state_json(log: EventLog) -> Dict[str, Any]:
    """Everything a viewer needs, derived only from the log. Contributions carry their thread
    (affirms/challenges targeting them); cross-domain targets become relationships."""
    st = replay(log.iter())
    names = {pid: p.name for pid, p in st.presences.items()}
    contributions: Dict[int, Dict[str, Any]] = {}
    for ev in log.iter():
        if ev["kind"] not in CONTRIBUTION_KINDS or ev["actor"] not in st.presences:
            continue
        if st.presences[ev["actor"]].joined_at is None:
            continue  # recorded but never applied (acted before entry)
        p = ev["payload"]
        contributions[ev["id"]] = {
            "id": ev["id"], "ts": ev["ts"], "kind": ev["kind"], "actor": ev["actor"],
            "who": names.get(ev["actor"], ev["actor"]), "domain": p.get("domain") or "(unplaced)",
            "title": p.get("title") or "", "content": p.get("content", ""), "target": p.get("target"),
            "set_aside": ev["id"] in st.set_aside, "affirms": 0, "challenges": 0, "replies": [],
        }
    for c in contributions.values():
        t = c["target"]
        if t is not None and t in contributions:
            tgt = contributions[t]
            tgt["replies"].append(c["id"])
            tgt["affirms" if c["kind"] == "affirm" else "challenges"] += 1
    domains: Dict[str, Dict[str, Any]] = {}
    for c in contributions.values():
        d = domains.setdefault(c["domain"], {"label": c["domain"], "contributions": 0, "affirms": 0, "challenges": 0,
                                             "first": c["ts"], "last": c["ts"], "present": []})
        d["contributions"] += 1
        d["affirms"] += 1 if c["kind"] == "affirm" else 0
        d["challenges"] += 1 if c["kind"] == "challenge" else 0
        d["last"] = max(d["last"], c["ts"])
    for p in st.members():
        if p.domain:
            domains.setdefault(p.domain, {"label": p.domain, "contributions": 0, "affirms": 0, "challenges": 0,
                                          "first": None, "last": None, "present": []})["present"].append(p.id)
    links: Dict[tuple, Dict[str, Any]] = {}
    for c in contributions.values():
        t = c["target"]
        if t is None or t not in contributions:
            continue
        a, b = c["domain"], contributions[t]["domain"]
        if a == b:
            continue
        key = tuple(sorted((a, b)))
        l = links.setdefault(key, {"between": list(key), "count": 0, "affirms": 0, "challenges": 0, "pairs": []})
        l["count"] += 1
        l["affirms" if c["kind"] == "affirm" else "challenges"] += 1
        l["pairs"].append([c["id"], t])
    members = [{"id": p.id, "name": p.name, "hails_from": p.hails_from, "people": p.people, "state": p.state,
                "domain": p.domain, "joined_at": p.joined_at, "left_at": p.left_at, "left_reason": p.left_reason,
                "turns": p.turns, "turn_allowance": p.turn_allowance, "exhausted": p.exhausted,
                "unreachable": p.unreachable, "self_described": p.self_described}
               for p in st.presences.values() if p.joined_at is not None]
    proposals = [{"id": pr.id, "kind": pr.kind, "value": pr.value, "by": names.get(pr.by, pr.by), "reason": pr.reason,
                  "consents": sorted(pr.consents), "resolved_at": pr.resolved_at, "outcome": pr.outcome}
                 for pr in st.proposals.values()]
    return {
        "generated": time.time(), "last_event": st.last_event, "halted": st.halted, "halt_reason": st.halt_reason,
        "settings": st.settings,
        "briefing": {"event": st.briefing_event, "words": len((st.briefing or "").split()), "source": st.briefing_source,
                     "opening": (st.briefing or "").strip().splitlines()[0][:200] if st.briefing else ""},
        "domains": list(domains.values()), "members": members, "contributions": list(contributions.values()),
        "links": list(links.values()), "proposals": proposals,
        "reflections": st.reflections[-20:], "operator_notes": st.operator_notes,
    }


def make_handler(log: EventLog, viewer_dir: str):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=viewer_dir, **kw)

        def _json(self, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.split("?")[0] == "/state.json":
                return self._json(state_json(log))
            if self.path.startswith("/event/") and self.path.endswith(".json"):
                try:
                    eid = int(self.path[len("/event/"):-len(".json")])
                except ValueError:
                    self.send_error(404); return
                for ev in log.iter(since=eid - 1):
                    if ev["id"] == eid:
                        return self._json(ev)
                    break
                self.send_error(404); return
            if not viewer_dir:
                self.send_error(404, "no viewer directory; only /state.json is served"); return
            return super().do_GET()

        def do_POST(self):  # read-only, always
            self.send_error(405)

        def log_message(self, format, *args):
            pass
    return H


def serve(db: str, port: int = 8080, viewer_dir: str = "") -> None:
    log = EventLog(db)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(log, viewer_dir))
    print(f"read-only view of {db} at http://127.0.0.1:{port}/" + ("" if viewer_dir else "state.json"), file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
