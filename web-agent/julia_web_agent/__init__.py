"""julia-web-agent: a general web agent that browses with julia-browser and thinks with Claude."""

from .agent import Result, Step, WebAgent
from .browser import Session
from .llm import DEFAULT_MODEL, LLM

__version__ = "0.1.0"
__all__ = ["WebAgent", "Result", "Step", "Session", "LLM", "DEFAULT_MODEL", "__version__"]
