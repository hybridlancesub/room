# SPDX-License-Identifier: AGPL-3.0-or-later
"""Append-only, hash-chained event log. Every fact about the room is an event here.

State is never stored separately: it is replayed from this log (see model.py). That is
what makes the room recoverable (any prior event id is a coherent state) and attributable
(every event names an actor; the chain makes tampering visible).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any, Dict, Iterator, Optional

SCHEMA = """
create table if not exists events (
    id        integer primary key autoincrement,
    ts        real not null,
    actor     text not null,
    kind      text not null,
    payload   text not null,
    prev_hash text not null,
    hash      text not null
);
create table if not exists ledger (
    id                integer primary key autoincrement,
    ts                real not null,
    presence          text not null,
    model             text not null,
    prompt_tokens     integer not null,
    completion_tokens integer not null,
    cost_usd          real not null
);
create index if not exists events_actor on events(actor);
create index if not exists events_kind on events(kind);
"""

GENESIS = "0" * 64


def _digest(prev_hash: str, ts: float, actor: str, kind: str, payload: str) -> str:
    h = hashlib.sha256()
    h.update(prev_hash.encode())
    h.update(repr(ts).encode())
    h.update(actor.encode())
    h.update(kind.encode())
    h.update(payload.encode())
    return h.hexdigest()


class EventLog:
    def __init__(self, path: str):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.execute("pragma journal_mode=wal")
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    # -- events -------------------------------------------------------------
    def append(self, actor: str, kind: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = json.dumps(payload or {}, sort_keys=True, ensure_ascii=False)
        with self.lock:
            row = self.conn.execute("select hash from events order by id desc limit 1").fetchone()
            prev = row[0] if row else GENESIS
            ts = time.time()
            h = _digest(prev, ts, actor, kind, body)
            cur = self.conn.execute(
                "insert into events(ts, actor, kind, payload, prev_hash, hash) values (?,?,?,?,?,?)",
                (ts, actor, kind, body, prev, h),
            )
            return {"id": cur.lastrowid, "ts": ts, "actor": actor, "kind": kind,
                    "payload": payload or {}, "prev_hash": prev, "hash": h}

    def iter(self, since: int = 0, kind: Optional[str] = None, actor: Optional[str] = None) -> Iterator[Dict[str, Any]]:
        q, args = "select id, ts, actor, kind, payload, prev_hash, hash from events where id > ?", [since]
        if kind:
            q += " and kind = ?"; args.append(kind)
        if actor:
            q += " and actor = ?"; args.append(actor)
        q += " order by id"
        with self.lock:
            rows = self.conn.execute(q, args).fetchall()
        for r in rows:
            yield {"id": r[0], "ts": r[1], "actor": r[2], "kind": r[3],
                   "payload": json.loads(r[4]), "prev_hash": r[5], "hash": r[6]}

    def last_id(self) -> int:
        with self.lock:
            row = self.conn.execute("select max(id) from events").fetchone()
        return row[0] or 0

    def verify_chain(self) -> Optional[int]:
        """Return the id of the first broken link, or None if the chain is intact."""
        prev = GENESIS
        with self.lock:
            rows = self.conn.execute("select id, ts, actor, kind, payload, prev_hash, hash from events order by id").fetchall()
        for r in rows:
            if r[5] != prev or _digest(prev, r[1], r[2], r[3], r[4]) != r[6]:
                return r[0]
            prev = r[6]
        return None

    # -- ledger -------------------------------------------------------------
    def charge(self, presence: str, model: str, prompt_tokens: int, completion_tokens: int, cost_usd: float):
        """Record a charge; return (total_before, total_after) atomically."""
        with self.lock:
            before = self.conn.execute("select coalesce(sum(cost_usd),0) from ledger").fetchone()[0]
            self.conn.execute(
                "insert into ledger(ts, presence, model, prompt_tokens, completion_tokens, cost_usd) values (?,?,?,?,?,?)",
                (time.time(), presence, model, prompt_tokens, completion_tokens, cost_usd),
            )
            return before, before + cost_usd

    def total_cost(self) -> float:
        with self.lock:
            return self.conn.execute("select coalesce(sum(cost_usd),0) from ledger").fetchone()[0]

    def cost_by_presence(self):
      with self.lock:
        return self.conn.execute(
            "select presence, model, sum(prompt_tokens), sum(completion_tokens), sum(cost_usd), count(*) "
            "from ledger group by presence order by sum(cost_usd) desc"
        ).fetchall()
