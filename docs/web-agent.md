# Web agent

`web-agent/` contains `julia-web-agent`, a general web agent. Claude reads the page and julia-browser
acts on it. The agent completes tasks on live websites: search, fill forms, compare results, and
report what it found.

```bash
pip install julia-browser anthropic
pip install -e web-agent
export ANTHROPIC_API_KEY=...

julia-web-agent "Find the cheapest 4-star hotel in Lisbon for next weekend" --record runs/
python -m julia_web_agent "Who designed Rust and when did it first appear?" --start-url https://en.wikipedia.org
```

```python
from julia_web_agent import WebAgent

with WebAgent(max_steps=30) as agent:
    result = agent.run("Find today's top story on Hacker News and its points",
                       start_url="https://news.ycombinator.com")
print(result.status, result.answer)
```

The full reference is in [web-agent/README.md](../web-agent/README.md).
