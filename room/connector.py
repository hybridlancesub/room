# SPDX-License-Identifier: AGPL-3.0-or-later
"""The OPENING. The room hardcodes no provider; anything implementing `Connector` attaches.

A connector answers one question: given a presence and a prompt, what does that
participant say? It returns text plus usage. The room never asks a connector to bypass
its own provider's constraints — a refusal is a valid, recorded answer.
"""
from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol


@dataclass
class Reply:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    raw: Optional[dict] = None


@dataclass
class Seat:
    """What a connector offers the room: an identity (Sec. 1) plus how to reach it."""
    id: str
    name: str
    hails_from: str
    people: str
    model: str
    pricing: Dict[str, float]  # per-token: prompt, completion


class Connector(Protocol):
    def seats(self) -> List[Seat]: ...
    def ask(self, seat: Seat, system: str, messages: List[dict]) -> Reply: ...
    def close(self) -> None: ...


class ConnectorError(RuntimeError):
    pass


# --------------------------------------------------------------------------- OpenAI-compatible
class OpenAICompatibleConnector:
    """Any /v1/chat/completions endpoint. Credentials are supplied by a callable so that
    token refresh stays the provider's business, not the room's."""

    def __init__(self, provider_label: str, base_url: str, api_key_fn, seats: List[Seat],
                 timeout: float = 240.0, max_tokens: int = 4000, reasoning_effort: str = "low"):
        self.reasoning_effort = reasoning_effort
        self.provider_label = provider_label
        self.base_url = base_url.rstrip("/")
        self._key = api_key_fn
        self._seats = seats
        self.timeout = timeout
        self.max_tokens = max_tokens

    def seats(self) -> List[Seat]:
        return list(self._seats)

    def ask(self, seat: Seat, system: str, messages: List[dict]) -> Reply:
        body = {
            "model": seat.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "max_tokens": self.max_tokens,
            "response_format": {"type": "json_object"},
        }
        if self.reasoning_effort:
            body["reasoning"] = {"effort": self.reasoning_effort}
        reply = self._call(seat, body)
        if not reply.text.strip() and reply.raw and (reply.raw.get("choices") or [{}])[0].get("finish_reason") == "length":
            # thinking consumed the budget; one retry with more room, cost still charged for both
            body["max_tokens"] = self.max_tokens * 3
            second = self._call(seat, body)
            second.prompt_tokens += reply.prompt_tokens
            second.completion_tokens += reply.completion_tokens
            second.cost_usd += reply.cost_usd
            return second
        return reply

    def _call(self, seat: Seat, body: dict) -> Reply:
        req = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._key()}", "Content-Type": "application/json",
                     "Accept": "application/json", "User-Agent": "hermes-room/0.1"},
        )
        last: Exception = ConnectorError("no attempt")
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:400]
                last = ConnectorError(f"HTTP {e.code}: {detail}")
                if e.code in (400, 401, 403, 404, 422):
                    if e.code == 400 and "response_format" in detail and "response_format" in body:
                        body.pop("response_format"); req.data = json.dumps(body).encode(); continue
                    if e.code == 400 and "reasoning" in detail.lower() and "reasoning" in body:
                        body.pop("reasoning"); req.data = json.dumps(body).encode(); continue
                    raise last
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = ConnectorError(f"{type(e).__name__}: {e}")
            time.sleep(1.5 * (attempt + 1) + random.random())
        else:
            raise last
        try:
            msg = data["choices"][0]["message"]
            text = msg.get("content") or ""
            if not text and msg.get("reasoning"):
                text = ""
        except (KeyError, IndexError, TypeError):
            raise ConnectorError(f"malformed response: {str(data)[:300]}")
        usage = data.get("usage") or {}
        pt, ct = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
        cost = usage.get("cost")  # authoritative when the gateway reports it
        if cost is None:
            cost = pt * seat.pricing.get("prompt", 0.0) + ct * seat.pricing.get("completion", 0.0)
        cost = float(cost)
        return Reply(text=text, prompt_tokens=pt, completion_tokens=ct, cost_usd=cost, raw=data)

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------- Mock
class MockConnector:
    """Deterministic connector for tests and dry runs. Costs nothing, calls nothing."""

    def __init__(self, n: int = 4, script=None):
        self._seats = [Seat(f"mock-{i}", f"Mock {i}", "mock", f"mock/model-{i}", f"mock/model-{i}",
                            {"prompt": 0.0, "completion": 0.0}) for i in range(n)]
        self.script = script  # callable(seat, messages) -> str, or None
        self.calls = 0

    def seats(self):
        return list(self._seats)

    def ask(self, seat, system, messages):
        self.calls += 1
        if self.script:
            return Reply(self.script(seat, system, messages))
        return Reply(json.dumps({"action": "contribute", "domain": "hello",
                                 "content": f"{seat.name} notes the room is quiet."}))

    def close(self):
        pass
