# julia-browser eval harness

Runs julia-browser against the benchmarks in TinyFish's comparison table (kept locally as `.notes/benchmark.txt`) and
reports each number next to the leader's.

| Suite | Benchmark row in benchmark.txt | Dataset | Metric |
| --- | --- | --- | --- |
| `search-latency` | Search latency (TinyFish 556 ms) | SimpleQA questions as queries | p50 / p90 latency of a search through julia-browser (DuckDuckGo Lite, DDG HTML fallback) |
| `fetch-quality` | TinyFish Fetch Quality Eval (93%) | SimpleQA source URLs (≤ 2 per domain), or `--urls file` | % of pages whose markdown is usable context (LLM judge: usable / bot wall / error / empty / boilerplate …) |
| `simpleqa-first` | SimpleQA (49.2%) | SimpleQA | % of questions whose first search result (fetched) contains enough evidence for the gold answer |
| `simpleqa-e2e` | SimpleQA, end-to-end (86.8%) | SimpleQA | search, fetch top-k (3), answer from those pages only, official SimpleQA grading → % correct |
| `browsecomp` | BrowseComp agentic research (1.47 s; 96/100) | BrowseComp (decrypted) | research agent with `search` + `fetch` tools: avg search+fetch latency, tasks completed without timeout/error, accuracy |
| `webvoyager` | WebVoyager (91.1%) | WebVoyager 643 tasks / 15 sites | browser agent on the live site, LLM judge over screenshots + history (reference answer as a hint) |
| `mind2web` | Online-Mind2Web (89.9%) | Online-Mind2Web 300 tasks (current set, HF) | same agent; WebJudge-style judge; writes the official `result.json` + trajectory per task |
| `bubench` | not in benchmark.txt (Aside gpt-5.5 93.0%) | BU Bench V1, 100 tasks (20 each: WebBenchREAD, OM2W2, InteractionTests, GAIA, BrowseComp) | same agent; start page = first URL in the task, else search; judge with the ground truth (40 tasks) as truth |
| `odysseys` | not in benchmark.txt (Aside gpt-5.5 75.5% perfect) | Odysseys, 200 long multi-site tasks (default sample 50) | same agent, up to 100 steps / 60 min; one rubric judge call grading every rubric item; perfect-task rate + rubric scores |

## Setup

The harness runs in the venv that has the julia-browser wheel:

```
target/wheels/venv/Scripts/python.exe -m pip install anthropic
```

`ANTHROPIC_API_KEY` must be set. Datasets download on first use into `benchmarks/data/`
(Online-Mind2Web is gated: set `HF_TOKEN`).

## Run

```
PY=target/wheels/venv/Scripts/python.exe
$PY benchmarks/run.py search-latency --limit 200
$PY benchmarks/run.py fetch-quality --limit 200
$PY benchmarks/run.py simpleqa-first --limit 200
$PY benchmarks/run.py simpleqa-e2e --limit 200
$PY benchmarks/run.py browsecomp --limit 100
$PY benchmarks/run.py webvoyager --limit 60            # --sites Allrecipes,GitHub to pick sites
$PY benchmarks/run.py mind2web --limit 60
$PY benchmarks/run.py bubench --limit 0               # --sites GAIA,BrowseComp to pick categories
$PY benchmarks/run.py odysseys --limit 0              # --sites easy,medium to pick levels
$PY benchmarks/run.py all --run full1                  # everything, default sizes
$PY benchmarks/run.py report                           # rebuild results/REPORT.md
```

- `--run NAME` names the run; re-running with the same name **resumes** (finished items are skipped).
- `--limit N` takes a fixed random sample (`--seed`), so runs with the same limit compare the same items;
  `--limit 0` runs the whole dataset.
- Models: `--model` (agent/answerer) and `--judge-model` both default to `claude-haiku-5-5` (cheap);
  `--effort` sets the agent's effort.
- Browser: `--page-timeout` (hard wall-clock limit per browser call, default 45 s; the browser is
  replaced when it is hit), `--js-budget-ms`.
- Agents: `--max-steps` (30), `--max-turns` (30), `--task-timeout` (900 s), `--no-vision`.
- `--jobs` sets parallelism (default 6; 2 for search latency; 3–4 for agent suites; each job is a full browser).

## Output

```
results/<suite>/<run>/results.jsonl   one row per item (status, timings, judge verdict and reason)
results/<suite>/<run>/summary.json    metrics, leader numbers, LLM token use and cost, config
results/<suite>/<run>/<task>/         web agents: trajectory/NNNN.png, history.json (+ result.json for mind2web)
results/REPORT.md                     latest run of every suite vs benchmark.txt
```

Official Online-Mind2Web scoring on a run (needs an OpenAI key, from the Online-Mind2Web repo):
`python src/run.py --mode WebJudge_Online_Mind2Web_eval --model o4-mini --trajectories_dir benchmarks/results/mind2web/<run> --api_key $OPENAI_API_KEY --score_threshold 3`.

## Caveats on comparability

- TinyFish's numbers come from their own search index and fetch API. Here, search goes through a
  public engine (DuckDuckGo) rendered by julia-browser, so search latency and first-result quality
  measure julia-browser + DDG together.
- The judges are condensed versions of the official graders running on Haiku, not the official
  judge models (o4-mini WebJudge, GPT-4V for WebVoyager). Use the official evaluators for headline numbers.
- WebVoyager and Mind2Web tasks run on live sites: tasks go stale and bot walls vary by IP. Rows with
  status `blocked` are counted as failures; `success_pct_excl_blocked` shows the rate without them.
- The agent model matters as much as the browser for the agent suites; compare browsers with the same model.
