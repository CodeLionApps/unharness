---
name: summarize-run
description: Summarize the current agent session with Unharness - cost, tokens, cache hit rate, tool calls and errors, subagents, compactions, duration. Use when the user runs /summarize-run or asks how much this session/conversation has cost or used so far.
---

Run exactly this (one Bash call):

```
unharness sync >/dev/null && unharness run "${CLAUDE_CODE_SESSION_ID:-$CODEX_THREAD_ID}"
```

If neither variable is set, or the run isn't found, say so in one line (Unharness hooks may not be set up: `unharness setup`) and stop.

Reply with a short summary, not the raw output:
- cost (hypothetical API price) and models
- tokens: input / output / cache read, cache hit rate
- active time, number of requests, compactions
- tool calls and errors (name the noisiest tools), subagents with their cost
- skills invoked: name, source (user/project/plugin = where it is installed), calls, tokens loaded (or "none")
- checks (tests/lint/typecheck) if any ran

Up to ~8 lines. Note that the current turn is not included yet.
