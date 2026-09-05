# SPDX-License-Identifier: AGPL-3.0-or-later
"""Nous Research / Hermes connector: one seat per distinct chat model on the Nous inference API.

Only the credential resolver is borrowed from the Hermes install; the room itself has no
Hermes dependency. Roster filter: drop embeddings, `:batch`, `~latest` aliases, and
regional/free duplicates (`:US`, `:free`) whose base id is also listed.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from typing import Dict, List

from .connector import OpenAICompatibleConnector, Seat

EMBED_HINTS = ("embed", "bge-", "e5-", "gte-", "minilm", "mpnet", "voyage", "pplx-embed", "relace-search")
NON_CHAT_HINTS = ("gpt-audio", "voxtral", "-image", "safeguard")

PROVIDER_LABELS = {
    "anthropic": "Anthropic", "openai": "OpenAI", "google": "Google", "meta": "Meta", "meta-llama": "Meta",
    "qwen": "Alibaba Qwen", "deepseek": "DeepSeek", "x-ai": "xAI", "z-ai": "Z.ai", "moonshotai": "Moonshot",
    "mistralai": "Mistral", "minimax": "MiniMax", "nvidia": "NVIDIA", "inception": "Inception",
    "inclusionai": "inclusionAI", "meituan": "Meituan", "bytedance-seed": "ByteDance Seed",
    "cohere": "Cohere", "amazon": "Amazon", "stepfun": "StepFun", "tencent": "Tencent",
    "thinkingmachines": "Thinking Machines", "xiaomi": "Xiaomi", "upstage": "Upstage",
    "poolside": "poolside", "kwaipilot": "Kwaipilot", "nex-agi": "Nex AGI", "aion-labs": "Aion Labs",
    "arcee-ai": "Arcee", "ibm-granite": "IBM", "sakana": "Sakana", "rekaai": "Reka",
}


def _hermes_venv_python() -> str:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "hermes-agent", "venv", "bin", "python")


class NousCredentials:
    """Resolve (and refresh) the Nous bearer via Hermes' own resolver, in Hermes' venv,
    so token rotation stays Hermes' business."""

    def __init__(self):
        self._key = None
        self._base = None
        self._exp = 0.0

    def _resolve(self):
        code = ("from hermes_cli.auth_nous import resolve_nous_runtime_credentials as r;"
                "import json;c=r();print(json.dumps({'k':c['api_key'],'b':c['base_url'],'e':c.get('expires_in',3000)}))")
        import subprocess
        out = subprocess.run([_hermes_venv_python(), "-c", code], capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise RuntimeError("could not resolve Nous credentials via Hermes: " + out.stderr[-500:])
        d = json.loads(out.stdout.strip().splitlines()[-1])
        self._key, self._base = d["k"], d["b"]
        self._exp = time.time() + max(60, int(d["e"]) - 120)

    def api_key(self) -> str:
        if not self._key or time.time() > self._exp:
            self._resolve()
        return self._key

    def base_url(self) -> str:
        if not self._base:
            self._resolve()
        return self._base


def fetch_models(base_url: str, api_key: str) -> List[dict]:
    req = urllib.request.Request(base_url.rstrip("/") + "/models",
                                 headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json", "User-Agent": "hermes-room/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()).get("data", [])


def roster(models: List[dict]) -> List[Seat]:
    ids = {m["id"] for m in models if isinstance(m, dict) and m.get("id")}
    seats: List[Seat] = []
    for m in models:
        mid = m.get("id") or ""
        low = mid.lower()
        if mid.startswith("~") or ":batch" in low:
            continue
        if any(h in low for h in EMBED_HINTS) or any(h in low for h in NON_CHAT_HINTS):
            continue
        out_mod = (m.get("architecture") or {}).get("output_modalities")
        if out_mod and "text" not in out_mod:
            continue
        params = m.get("supported_parameters") or []
        if params and "tools" not in params and "max_tokens" not in params and "temperature" not in params:
            continue  # embedding-shaped capability set
        base = re.sub(r":(US|free|eu|exacto)$", "", mid)
        if base != mid and base in ids:
            continue  # regional / free duplicate of a listed base id
        vendor = mid.split("/")[0]
        pricing = m.get("pricing") or {}
        seats.append(Seat(
            id=mid.replace("/", "__").replace(":", "_"),
            name=m.get("name") or mid,
            hails_from=f"{PROVIDER_LABELS.get(vendor, vendor)} via Nous Research inference",
            people=f"{mid} (canonical: {m.get('canonical_slug') or mid})",
            model=mid,
            pricing={"prompt": float(pricing.get("prompt") or 0), "completion": float(pricing.get("completion") or 0)},
        ))
    seats.sort(key=lambda s: s.model)
    return seats


# Seats whose endpoint rejected every opt-in attempt (400 prompt-format, 403, 404, 5xx-only).
# Re-check occasionally; remove from this list to re-invite.
KNOWN_DEAD = {
    "bytedance-seed/seed-2.0-code", "inclusionai/ling-3.0-flash-sante:free", "kwaipilot/kat-coder-pro-v2",
    "kwaipilot/kat-coder-pro-v2.5", "meta/muse-spark-1.1", "moonshotai/kimi-k2", "openai/gpt-4-turbo-preview",
    "openai/gpt-5.2-chat", "qwen/qwen-2.5-72b-instruct", "stepfun/step-3.5-flash", "thinkingmachines/inkling",
}


def build(limit: int = 0, only: List[str] = None, include_dead: bool = False) -> OpenAICompatibleConnector:
    creds = NousCredentials()
    seats = roster(fetch_models(creds.base_url(), creds.api_key()))
    if not include_dead:
        seats = [s for s in seats if s.model not in KNOWN_DEAD]
    if only:
        pats = [re.compile(p) for p in only]
        seats = [s for s in seats if any(p.search(s.model) for p in pats)]
    if limit:
        seats = seats[:limit]
    return OpenAICompatibleConnector("Nous Research", creds.base_url(), creds.api_key, seats)


if __name__ == "__main__":
    c = NousCredentials()
    ms = fetch_models(c.base_url(), c.api_key())
    rs = roster(ms)
    print(f"{len(ms)} model ids -> {len(rs)} seats")
    for s in rs:
        print(f"  {s.model:55s} ${s.pricing['prompt']*1e6:8.3f}/M in  ${s.pricing['completion']*1e6:8.3f}/M out")
