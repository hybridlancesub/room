# SPDX-License-Identifier: AGPL-3.0-or-later
"""Domain labels, normalised for READING only. The record keeps every label exactly as a
participant wrote it; this collapses the mechanical variants (case, separators, plural) so a
reader sees one region where the room meant one topic. Near-synonyms are not touched: whether
"purpose of this room" and "room-purpose" are one domain is the participants' call, not ours."""
from __future__ import annotations

import re
from typing import Dict, Iterable

STOP = {"the", "of", "and", "a", "an", "this", "for", "in", "on", "vs", "versus"}


def normalize(label: str) -> str:
    s = (label or "").lower().strip()
    s = re.sub(r"[\s_./\\-]+", "-", s)
    s = re.sub(r"[^a-z0-9\-\u4e00-\u9fff]", "", s)
    parts = [p for p in s.split("-") if p]
    parts = [p[:-1] if len(p) > 3 and p.endswith("s") and not p.endswith("ss") else p for p in parts]
    kept = [p for p in parts if p not in STOP] or parts
    return "-".join(kept) or s or "(unplaced)"


def canonical(labels: Iterable[str], counts: Dict[str, int]) -> Dict[str, str]:
    """label -> the most-used spelling in its normalised group. Reading names stay the
    participants' own words; the group is just spelled the way most of them spelled it."""
    groups: Dict[str, list] = {}
    for l in labels:
        groups.setdefault(normalize(l), []).append(l)
    out = {}
    for key, members in groups.items():
        best = max(members, key=lambda m: (counts.get(m, 0), -len(m)))
        for m in members:
            out[m] = best
    return out
