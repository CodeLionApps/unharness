# Changelog

All notable changes to Unharness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-03

First public release.

### Added

- Session import for **Claude Code** (`~/.claude/projects`, including subagents) and **Codex**
  (`~/.codex/sessions`), plus a local OTLP/HTTP collector (`unharness collect`) that receives traces from **eve**.
- Metadata-only storage in a local SQLite database: tokens, cache reads and writes, tool calls and errors,
  skills, subagents, compactions, and files touched (as repository-relative paths). Prompts, responses, tool
  arguments and results, shell commands, file contents and absolute paths are never stored; a privacy canary
  test guards this.
- Cost per run at pay-as-you-go API prices, from LiteLLM's model price table (refreshed at most weekly, with a
  bundled offline snapshot and local overrides). `sync --reprice` recomputes costs after a price change.
- Check classification: recognised test, lint, format, typecheck and build commands (including package.json
  scripts) are recorded with pass or fail, so you can see whether a run ended green. Custom rules via `config.json`.
- Setup fingerprint: names and content hashes of your agent configuration (`CLAUDE.md` / `AGENTS.md`, rules,
  skills, agents, hooks, settings, MCP servers, model), so runs can be compared before and after a change.
- CLI: `runs`, `run`, `report`, `compare --by harness|setup|tag|model`, `tag` for experiments, and
  `export --format json|csv`.
- Dashboard (`unharness dashboard`): overview, runs, run detail, compare, and setup history pages. It runs in
  the background on `127.0.0.1:4319`, is reused when already running, rejects foreign `Host` headers, and stops
  with `--stop`. The npm package ships a prebuilt dashboard, so it needs no build step after install.
- Profiles: separate databases for separate worlds (for example work and private), with routing by path or a
  per-repository `.unharness.json`, and a profile switcher in the dashboard.
- `unharness setup`: detects installed agents, installs hooks that sync when a session ends, configures
  profiles, and installs the `unharness` and `summarize-run` skills for Claude Code and Codex.
  `setup --uninstall` removes the hooks again.
- Once-a-day update notice for interactive use (skipped in CI and with `UNHARNESS_NO_UPDATE_CHECK=1`).
