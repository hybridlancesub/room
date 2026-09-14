# SPDX-License-Identifier: AGPL-3.0-or-later
"""What one room may carry from another: only what was consented to, entry by entry.

`consented(log)` reads a closed room's `share_consent` events and returns the entries whose
authors said yes (all, or the specific ids they named). Nothing else leaves that room: not the
decliners' words, not the unasked, not the operator's notes, not the room's proposals. Each
entry carries the id of the consent event that permits it, so the permission is checkable."""
from __future__ import annotations

from typing import Dict, List

from .log import EventLog
from .model import CONTRIBUTION_KINDS, replay


def consented(log: EventLog, room_name: str) -> Dict:
    st = replay(log.iter())
    names = {pid: p.name for pid, p in st.presences.items()}
    lineage = {pid: p.people for pid, p in st.presences.items()}
    permits: Dict[str, dict] = {}
    for ev in log.iter(kind="share_consent"):   # the LAST answer from a presence stands
        permits[ev["actor"]] = ev
    entries: List[dict] = []
    for ev in log.iter():
        if ev["kind"] not in CONTRIBUTION_KINDS:
            continue
        p = permits.get(ev["actor"])
        if not p:
            continue
        scope = p["payload"].get("scope")
        if scope == "all" or (scope == "some" and ev["id"] in set(p["payload"].get("events") or [])):
            pl = ev["payload"]
            entries.append({"id": ev["id"], "ts": ev["ts"], "kind": ev["kind"], "who": names.get(ev["actor"], ev["actor"]),
                            "lineage": lineage.get(ev["actor"], ""), "domain": pl.get("domain"), "target": pl.get("target"),
                            "title": pl.get("title", ""), "content": pl.get("content", ""), "permitted_by": p["id"]})
    summary = {"all": 0, "some": 0, "none": 0}
    for p in permits.values():
        summary[p["payload"].get("scope", "none")] = summary.get(p["payload"].get("scope", "none"), 0) + 1
    return {"room": room_name, "source_last_event": st.last_event, "members": len(st.members()),
            "asked": len(permits), "consent": summary, "entries": entries}


def render_entry(e: dict) -> str:
    tgt = f" -> #{e['target']}" if e.get("target") is not None else ""
    ttl = f" [{e['title']}]" if e.get("title") else ""
    return f"#{e['id']} {e['kind']}{tgt} by {e['who']} @ {e.get('domain')}{ttl}: {e['content']}"
