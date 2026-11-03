---
name: unharness
description: Set up or query Unharness (local metadata-only analytics of Claude Code / Codex runs - cost, tokens, tools, checks, subagents). Use when the user asks to set up Unharness hooks or profiles, or asks how much their agent sessions cost, how runs compare across models/harnesses/setups, or what happened in a past run.
---

`unharness` is a CLI on PATH. Never read its SQLite files directly — use the CLI.

- Setup / hooks / work-vs-private profiles: tell the user to run `unharness setup` in their own terminal (it is interactive). It detects installed agents and asks per agent; `--uninstall` removes hooks.
- Refresh data first: `unharness sync`
- Questions → commands (add `--profile <name>` if the user mentions a profile):
  - recent runs: `unharness runs --since 7d` (filters: `--harness`, `--repo`, `--tag`)
  - one run: `unharness run <id-prefix>`
  - totals and trend: `unharness report --period 1d|7d|30d|90d`
  - comparisons: `unharness compare --by harness|setup|tag|model --since 30d`
  - mark an experiment: `unharness tag <run> exp:<name>`
  - charts: `unharness dashboard` (http://127.0.0.1:4319; reuses a running instance)

Costs are hypothetical API-price costs. Summarize the numbers; don't paste whole tables unless asked.
