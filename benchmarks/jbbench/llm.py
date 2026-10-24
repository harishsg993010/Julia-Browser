"""Claude client used by the agents and the judges (Anthropic SDK)."""

import json
import threading

import anthropic

# $ per 1M tokens (input, output), for the cost line in summaries.
PRICES = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}
# Models that take the server-side refusal fallback (`fallbacks: "default"`).
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}


class LLM:
    def __init__(self, model: str, effort: str = "medium"):
        self.model = model
        self.effort = effort
        self.client = anthropic.Anthropic(max_retries=8, timeout=600)
        self._lock = threading.Lock()
        self.usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "requests": 0}

    def create(self, *, messages, system=None, tools=None, max_tokens=16000, effort=None, output_format=None,
               cache=False, tool_choice=None):
        kw = {
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": messages,
            "output_config": {"effort": effort or self.effort},
        }
        if system:
            kw["system"] = system
        if tools:
            kw["tools"] = tools
        if tool_choice:
            kw["tool_choice"] = tool_choice
        if output_format:
            kw["output_config"]["format"] = output_format
        if cache:
            kw["cache_control"] = {"type": "ephemeral"}
        if self.model in FALLBACK_MODELS:
            kw["betas"] = ["server-side-fallback-2026-07-01"]
            kw["fallbacks"] = "default"
            resp = self.client.beta.messages.create(**kw)
        else:
            resp = self.client.messages.create(**kw)
        self._count(resp.usage)
        return resp

    def text(self, system, user, max_tokens=16000, effort=None):
        resp = self.create(system=system, messages=[{"role": "user", "content": user}],
                           max_tokens=max_tokens, effort=effort)
        if resp.stop_reason == "refusal":
            raise RuntimeError("model refused")
        return "".join(b.text for b in resp.content if b.type == "text")

    def json(self, system, user, schema, max_tokens=8000, effort=None):
        """One call constrained to `schema`; user may be a string or a list of content blocks."""
        resp = self.create(
            system=system,
            messages=[{"role": "user", "content": user}],
            max_tokens=max_tokens,
            effort=effort,
            output_format={"type": "json_schema", "schema": schema},
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("judge refused")
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text)

    def _count(self, u):
        with self._lock:
            self.usage["requests"] += 1
            self.usage["input"] += u.input_tokens or 0
            self.usage["output"] += u.output_tokens or 0
            self.usage["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
            self.usage["cache_write"] += getattr(u, "cache_creation_input_tokens", 0) or 0

    def cost(self):
        pin, pout = PRICES.get(self.model, (0, 0))
        u = self.usage
        usd = (u["input"] * pin + u["cache_write"] * pin * 1.25 + u["cache_read"] * pin * 0.1 + u["output"] * pout) / 1e6
        return {**u, "model": self.model, "usd": round(usd, 2)}


def obj_schema(**props):
    """Small helper: a strict JSON-schema object whose fields are all required."""
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
