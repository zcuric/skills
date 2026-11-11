# Branch and PR shape

Assert:

- Branch `fix/<slug>` (no key part, no doubled slug).
- Title without prefix; PR body has no link line and starts with the `pipeline-status` block.
- Stage 2 chip `claude` · `haiku` · `low` (subagent); stage 4 chip `claude` · `haiku` · `low`; stage 8 chip `claude` · `haiku` · `low`.
- Stage 6 is `skipped` by the conductor's e2e decision even though `.claude/launch.json` exists (details in `e2e-skip.md`).
