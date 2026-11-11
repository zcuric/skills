# pr-pipeline

Hand it a ticket and it takes the work all the way to a PR that is ready to merge: it writes the spec, implements, opens the PR, runs an AI review, answers the review, verifies end to end, checks every acceptance criterion and judges the merge risk. Each of those nine stages is recorded in a pane beside the chat, so you and your colleagues can see what was done, what was decided and what needs a human look. The pane also shows the PR itself (checks, review threads, a guarded Merge button), so there is nothing to open on GitHub.

It works with Jira, GitHub issues, Linear, or a task typed in words, in any GitHub repo.

## Install

```
/plugin install pr-pipeline --marketplace zcuric/skills
```

Needs the GitHub CLI (`gh`) logged in. Jira and Linear tickets need their MCP connector (Linear also works through the `linear` CLI).

## What you see

- **Runs switcher** with the repo, branch and current stage of every run, then the run header with ticket, tracker and repo, and the confidence and merge-risk lights. A run follows its branch through `git checkout -b`, `git switch -c` and `git branch -m`.
- **Stages header**: stages done, and when the run last updated (its total time once every stage has finished). A run with a stage running and no update for 30 minutes shows "Stalled at <stage>" under Needs attention.
- **Pull request card**: checks, review decision and reviewers, mergeability, and the Merge button once checks, review and risk allow it.
- **Threads card**: unresolved review threads with their diff hunk, a reply box, Resolve, and Fix (hands the thread to the pipeline).
- **Stage rows**: elapsed time, the attempt number when a stage ran again; open one for what the stage did, its warnings, the model that ran it, and for the acceptance stage every criterion with its evidence.
- **Stale review**: commits pushed after the AI review show as `N commits since AI review · proof stale`; press it to have just those commits reviewed.

## Starting a run

| You type | It runs |
| --- | --- |
| `/pipeline ABC-123` | a Jira (or Linear) ticket |
| `/pipeline #123` | issue 123 in the current repo |
| `/pipeline owner/repo#123` | an issue in another repo |
| `/pipeline <issue or PR URL>` | that issue; a PR URL picks up the open PR from the review stage on |
| `/pipeline "add CSV export to the orders list"` | the task in words, no tracker |

At the start it asks you one question, at most, covering only what it cannot decide alone (a gap in the ticket, the review backend the first time, whether to save the repo's conventions). Everything else it decides and writes down in the pane.

## The nine stages

| # | Stage | What happens |
| --- | --- | --- |
| 1 | Enhance | Reads the ticket, writes the acceptance criteria and a spec, posts the spec on the ticket, classifies the task and picks models |
| 2 | Implement | Branches, reproduces a bug with a failing test first, implements, lints, tests, commits |
| 3 | Create PR | Opens the PR with a skimmable body (link line, status strip, summary, one diagram, test plan) and labels |
| 4 | AI review | Posts one review: a one-line verdict and a line comment per confirmed defect; swaps the AI label |
| 5 | Address | Fixes findings, replies in each thread with the commit, resolves it |
| 6 | E2E verify | A quick check first (see below); then drives the real app: the repo's e2e skill, else a browser smoke from `.claude/launch.json`, else skipped with the reason |
| 7 | Acceptance | First a delta review of any commits since the AI review (changes requested there stops the run); then checks every criterion with evidence (test, screenshot, log line); a gap loops back to stage 2 once |
| 8 | Merge risk | Verdicts on alignment, impact, verification, rollback cost, error detection, and an overall low / medium / high |
| 9 | Final proof | One evidence-only PR comment, a summary on the ticket, and the decision on who reviews |

### When e2e is skipped

Not every change needs the running app. Before stage 6 starts, the pipeline checks the repo's `e2ePolicy`, then the changed files and the acceptance criteria. It skips e2e only when every changed file is copy, style, docs, config, CI or a dependency manifest and no criterion needs the running stack; otherwise it runs. The reason shows on the stage row in the pane (`Skipped: <reason>`) and in the e2e slot of the PR's status strip (`e2e: skipped · <reason>`). To force e2e, set `"e2ePolicy": "always"` in the repo profile, or say "run e2e" in your answer to the start question.

## What it costs

Stage 1 sorts the task into a class, and the class decides which model does each stage. Small things stay cheap; anything sensitive gets the strongest model on every lane.

| Class | Cost | Typical models |
| --- | --- | --- |
| copy | cheap | haiku throughout, e2e usually skipped |
| style | cheap | sonnet low, e2e with screenshots |
| quick-fix | cheap | sonnet low to implement, sonnet medium to review |
| feature | mid | opus low to implement, review and verify |
| query-perf | mid | opus, high-effort review, e2e with a measurement |
| business-logic | high | opus high |
| architecture | high | opus high |
| sensitive (auth, permissions, money, PII, migrations, contracts, infra, secrets, dependency bumps) | high | opus high everywhere, plus a security review pass |

Each stage row in the pane carries a chip with the model that ran it (`opus·high`, `codex·gpt-5-codex`). The start question lets you switch a run to opus everywhere.

## Nobody gets pinged

The pipeline never requests reviewers, assigns the PR, or @-mentions anyone, on the PR or on the ticket. The proof comment opens with one plain line instead: what a human must look at and why when the merge risk is medium or high, the confidence is under 80% or the AI review asked for changes, otherwise `Nothing needs a human look.` Who to ask is your call.

## Nothing to open on GitHub

- **Pull request card**: checks passed, failed and pending, failing check names, review decision, reviewers, mergeability, additions and deletions.
- **Threads card**: every review thread with its hunk; reply, resolve, or press Fix to have the pipeline handle it.
- **Merge**: shown only when the PR is open, not a draft, mergeable, approved, all checks green and nothing pending; it asks before merging with the repo's merge method. Otherwise the card says what is missing.
- **Fix CI**: reads the failing check's log, fixes, pushes.
- **Sync with base**: appears when the branch is behind; merges the base and pushes.

The skills follow the same rule: they read checks and threads through the pane's tool, reply and resolve through it, and their final message names the PR by number and points at the pane.

## When the PR merges

The run closes itself and leaves the Runs switcher: five minutes after the pane sees the PR merged, as soon as it sees the PR closed without merge, after 3 idle days without a PR, or after 14 idle days with one. Press Close to put a run away sooner, merged or not. With no open run, the pane shows the last closed one with a Reopen button.

## Reviewer backends

The AI review runs on claude by default (opus at low effort unless the task class routes otherwise). When Codex CLI or OpenCode is installed, the first run asks once which backend and model to use and saves the answer. Change it any time in the pane's Settings card or with `/config` (`pr-pipeline.reviewer`, `pr-pipeline.review_model`, `pr-pipeline.review_effort`).

- **codex**: runs `codex exec` in a read-only sandbox; effort maps to `model_reasoning_effort` (low, medium, high).
- **opencode**: runs `opencode run --model provider/model`; effort is ignored; any file it touches is reverted and flagged.

If the chosen backend is missing, fails, or answers with something that is not the review JSON after one retry, the review falls back to claude and the stage shows a warning saying so.

## Settings

All in `/config` under `pr-pipeline`, and the first four in the pane's Settings card:

| Setting | Default | Meaning |
| --- | --- | --- |
| `reviewer` | `claude` | Backend for the AI review: `claude`, `codex`, `opencode` |
| `review_model` | `opus` | Review model when routing does not pick one (always used for codex and opencode) |
| `review_effort` | `low` | Review effort when routing does not pick one |
| `tracker` | `auto` | Force a tracker: `jira`, `github`, `linear`, `text` |
| `merge_method` | `squash` | What the Merge button does: `squash`, `merge`, `rebase` |

## Repo profile

Each repo can describe its conventions in `.pr-pipeline.json` at the root (or `.claude/pr-pipeline.json`). Every field is optional. Stage 1 resolves the profile through the pane tool's `profile` action: it reads the file, or discovers the conventions when there is none, fills every default and creates the criteria directory. After discovery the start question offers once to save the result as `.pr-pipeline.json`; the saved file is left untracked for you to commit, or not. Schema: [`profiles/pr-pipeline.schema.json`](profiles/pr-pipeline.schema.json). A full example: [`profiles/example.json`](profiles/example.json).

| Field | Default | Meaning |
| --- | --- | --- |
| `tracker` | `auto` | Where tickets live: `auto`, `jira`, `github`, `linear`, `text`. `auto` detects from the `/pipeline` argument and the connectors present. |
| `branchPattern` | `{type}/{key}-{slug}` | Branch name. `{type}` is `fix` or `feature`, `{key}` the lowercased ticket key (`issue-42` for GitHub, empty for text), `{slug}` a few words of the title. |
| `titlePrefix` | `[{key}]` for Jira and Linear, none for GitHub and text | Prefix of the PR title. Empty string for none. |
| `linkLine` | `[{key}]({url})` for Jira and Linear, `Closes #{n}` for GitHub, none for text | First line of the PR body. Empty string for none. |
| `prBody` | `visual-pr` | `visual-pr`: status strip, summary, details, one change diagram, test plan. `plain`: link line, status strip, summary, test plan. |
| `labels` | every key `null` (discovery matches existing labels by name) | Label names for `typeBug`, `typeFeature`, `stateReview`, `aiChangesRequested`, `aiLgtm`, `aiVerified`, `readyToMerge`, `needsWork`. `null` skips that label. Labels are never created. |
| `lint` | discovered from `package.json`, `composer.json`, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod` | Lint command run before each push. |
| `test` | discovered, as for `lint` | Test command; narrowed to touched files where the runner allows. |
| `e2e` | `null` (`e2e-verify` when the repo has that skill) | Skill that drives the real stack at stage 6. Without one, a browser smoke from `.claude/launch.json`. |
| `e2ePolicy` | `auto` | Whether stage 6 runs. `auto`: runs unless every changed file is copy, style, docs, config, CI or a manifest and no criterion needs the running stack. `always`: every run. `never`: never. |
| `securityAgent` | `null` (`security-reviewer` when the repo has that agent) | Agent for the security pass on sensitive work, when the review backend is claude. Otherwise the plugin's own security prompt. |
| `siblings` | `[]` | Related repos as `{ name, path, contracts }`. Cross-repo work branches there too; `contracts: true` marks the repo that owns shared data contracts. |
| `rules` | whichever of `CLAUDE.md`, `AGENTS.md`, `.ai/rules/index.md` exist | Files the implementer and the reviewer must follow. |
| `criteriaDir` | `~/.claude/pipeline/{owner}-{repo}/{ticket}` | Where the run keeps acceptance criteria, the spec, review files and screenshots. Outside the checkout so worktrees and subagents share it. |
| `mergeMethod` | the repo's allowed method, squash first | Merge method for this repo. |

Discovery (the `profile` action, when there is no file) reads `gh repo view`, `gh label list` (matching `bug`, `feature`/`enhancement`, `review`, `ready to merge`, `needs (more) work` and the `ai: …` labels by name), the build files above, the repo's `.claude/skills` and `.claude/agents`, recent branch names, and the rule files.

## Files

| Path | What |
| --- | --- |
| `hooks/` | The pane, the `mcp__pr-pipeline__pipeline` tool, PR polling, Merge and the other pane buttons |
| `skills/run/` | The conductor that drives the nine stages, plus its tracker adapters, open-PR start and PR body template |
| `skills/review/` | The AI review, its backends and the security prompt |
| `skills/risk/` | The merge-risk verdict |
| `agents/reviewer.md` | The read-only reviewer the review skill dispatches |
| `profiles/` | Profile schema and a filled-in example |
| `evals/` | What three end-to-end runs should show (GitHub issue without a profile, Jira with a profile, a task in words) |
