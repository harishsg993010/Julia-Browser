from .research import browsecomp
from .retrieval import fetch_quality, search_latency, simpleqa_e2e, simpleqa_first
from .webagent import bubench, mind2web, odysseys, webvoyager

SUITES = {
    "search-latency": search_latency,
    "fetch-quality": fetch_quality,
    "simpleqa-first": simpleqa_first,
    "simpleqa-e2e": simpleqa_e2e,
    "browsecomp": browsecomp,
    "webvoyager": webvoyager,
    "mind2web": mind2web,
    "bubench": bubench,
    "odysseys": odysseys,
}

# The leader and runner-up from benchmark.txt (TinyFish's comparison table), for the report.
LEADERS = {
    "search-latency": "TinyFish 556 ms vs Exa 811 ms (p50 search latency)",
    "fetch-quality": "TinyFish 93% vs Tavily 80% (pages returned as usable context)",
    "simpleqa-first": "TinyFish 49.2% vs Tavily 45.6% (first result contains enough evidence)",
    "simpleqa-e2e": "TinyFish 86.8% = Parallel 86.8% (questions answerable after search + fetch)",
    "browsecomp": "accuracy: not in benchmark.txt (see TinyFish's BrowseComp details); "
                  "Firecrawl 96/100 vs TinyFish 95/100 (tasks completed without timeout or error); "
                  "TinyFish 1.47 s vs Exa 1.59 s (avg search + fetch latency)",
    "webvoyager": "TinyFish 91.1% vs BrowserUse 88.3% (task pass rate)",
    "mind2web": "TinyFish 89.9% vs Gemini 2.5 Computer Use 69.0% (success rate)",
    # not in benchmark.txt: Aside's published runs (github.com/at-inc/aside-benchmarks)
    "bubench": "not in benchmark.txt; Aside (gpt-5.5) 93.0% vs Aside (kimi-k2.6) 88.0% (pass rate)",
    "odysseys": "not in benchmark.txt; Aside (gpt-5.5): 75.5% perfect tasks, 88.8% rubric items, 86.5% task-average rubric score",
}
