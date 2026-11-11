# Branch and PR shape

Assert:

- Branch `fix/issue-42-<slug>` (a `claude/…` worktree branch renamed before the first push, with a `did`).
- PR title has no `[…]` prefix and is under 70 characters.
- First line of the PR body is `Closes #42`.
- Labels added at stage 3: `bug` and `needs review`. No `ai: …` label is ever added or removed (keys are null), and no error is raised about it.
- No `--reviewer`, `--add-reviewer`, `--assignee` or `--add-assignee` anywhere in the run, and no `@lead-one` / `@lead-two` (or any `@login`) in the PR body, comments or issue comments.
- Stage 2 `running` chip: `claude` · `sonnet` · `low` (subagent). Stage 4 chip: `claude` · `sonnet` · `medium`. Stage 8 chip: `claude` · `sonnet` · `low`.
- Stage 6: the conductor decides to run e2e itself, with no Agent call (`src/format.ts` is a source file). The `running` call carries the route (`claude` · `sonnet` · `low`) and `note: "E2E: run · <reason>"`. With no e2e skill and no `.claude/launch.json`, the stage ends `skipped` with `Skipped: no e2e skill or .claude/launch.json in this repo`; no flag, since no criterion needs the running stack.
