"""Claude client for the agent (Anthropic SDK), with token and cost accounting."""

import threading

import anthropic

DEFAULT_MODEL = "claude-haiku-5-5"

# $ per 1M tokens (input, output)
PRICES = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}
# Models that take the server-side refusal fallback
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"}


class LLM:
    def __init__(self, model=DEFAULT_MODEL, effort="medium", client=None):
        self.model = model
        self.effort = effort
        self.client = client or anthropic.Anthropic(max_retries=8, timeout=600)
        self._lock = threading.Lock()
        self.usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "requests": 0}

    def create(self, *, messages, system=None, tools=None, max_tokens=8000, tool_choice=None, cache=True):
        kw = {"model": self.model, "max_tokens": max_tokens, "messages": messages,
              "output_config": {"effort": self.effort}}
        if system:
            kw["system"] = system
        if tools:
            kw["tools"] = tools
        if tool_choice:
            kw["tool_choice"] = tool_choice
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
        return {**u, "model": self.model, "usd": round(usd, 4)}
