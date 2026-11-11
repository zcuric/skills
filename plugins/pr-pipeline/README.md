# pr-pipeline

Hand it a ticket and it takes the work all the way to a PR that is ready to merge: it writes the spec, implements, opens the PR, runs an AI review, answers the review, verifies end to end, checks every acceptance criterion and judges the merge risk. Each of those nine stages is recorded in a pane beside the chat, so you and your colleagues can see what was done, what was decided and what needs a human look. The pane also shows the PR itself (checks, review threads, a guarded Merge button), so there is nothing to open on GitHub.

It works with Jira, GitHub issues, Linear, or a task typed in words, in any GitHub repo. It is built for Claude Code; the same stages run in Codex, OpenCode and other agents without the pane (see [Other harnesses](#other-harnesses)).

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

At the start it asks you one question, at most, covering only what it cannot decide alone (a gap in the ticket, the spec on risky or under-specified work, the review backend the first time, whether to save the repo's conventions). Everything else it decides and writes down in the pane.

## The nine stages

| # | Stage | What happens |
| --- | --- | --- |
| 1 | Enhance | Reads the ticket, writes the acceptance criteria and a spec, posts the spec on the ticket, classifies the task and picks models; asks you to confirm the spec when the work is risky or the criteria had to be derived |
| 2 | Implement | Branches, reproduces a bug with a failing test first, implements, lints, tests, commits |
| 3 | Create PR | Opens the PR with a skimmable body (link line, status strip, summary, one diagram, test plan) and labels |
| 4 | AI review | Posts one review: a one-line verdict and a line comment per confirmed defect; swaps the AI label. Starts together with stage 6 |
| 5 | Address | Fixes findings, replies in each thread with the commit, resolves it; a finding it turns down is resolved with the reason and flagged |
| 6 | E2E verify | A quick check first (see below); then drives the real app in the background while stage 4 reviews: the repo's e2e skill, else a browser smoke from `.claude/launch.json`, else skipped with the reason. Defects it finds are fixed and driven again after stage 5 |
| 7 | Acceptance | First a delta review of any commits since the AI review (changes requested there stops the run); then a separate read-only agent checks every criterion against the evidence (test, screenshot, log line) and its verdicts are recorded as they stand; a gap loops back to stage 2 once |
| 8 | Merge risk | Verdicts on alignment, impact, verification, rollback cost, error detection, and an overall low / medium / high |
| 9 | Final proof | One evidence-only PR comment, a summary on the ticket, and the decision on who reviews |

Three things keep a run honest and quick:

- **The spec is confirmed before code on work that can go badly wrong.** Sensitive, architecture and business-logic tickets, and mid-size ones whose criteria had to be derived, stop once at stage 1 with `Spec: Build it / Stop here`. Small fixes, style and copy never stop. A run nobody could ask goes on, flags it, and the proof asks for a human look.
- **Review and e2e run side by side.** Both read the same commit and the first e2e pass changes nothing, so the review does not wait for the slowest stage. Review findings are fixed first; then the e2e run, with the stack still up, fixes what it found and drives those screens again.
- **The builder does not grade its own work.** At stage 7 a fresh agent that saw none of the build reads each criterion literally, opens the test or screenshot offered as proof, and answers yes, partial or no. The pipeline may point it at evidence it missed; it cannot raise a verdict.

### When e2e is skipped

Not every change needs the running app. Before stage 6 starts, the pipeline checks the repo's `e2ePolicy`, then the changed files and the acceptance criteria. It skips e2e only when every changed file is copy, style, docs, config, CI or a dependency manifest and no criterion needs the running stack; otherwise it runs. The reason shows on the stage row in the pane (`Skipped: <reason>`) and in the e2e slot of the PR's status strip (`e2e: skipped · <reason>`). To force e2e, set `"e2ePolicy": "always"` in the repo profile, or say "run e2e" in your answer to the start question.

## Getting the most out of it

**Write the criteria into the ticket.** Stage 1 copies the acceptance criteria word for word and every later stage checks against them. A ticket without criteria still runs, but they are derived and flagged, and the run's confidence drops. Three lines someone can test ("a due date in the past is refused, with the error under the field") do more than a paragraph of background.

**Read the spec, not the transcript.** In the first minutes the spec lands on the ticket as a "Pipeline spec" comment: the goal, what happens today with the files it opened, the expected behaviour, what stays as it is, how it will be verified. On risky or under-specified work the run stops there and asks you to confirm it; on anything else, if the spec has the wrong idea, stop the run and fix the ticket. That is the cheapest moment to correct it.

**Save the profile once per repo.** The first run discovers the lint and test commands, the labels and the rule files, and offers to save `.pr-pipeline.json`. Commit it, then add what discovery cannot know: the `e2e` skill, `siblings`, `e2ePolicy`.

**Tell the reviewer what matters in your code.** Put a `REVIEW.md` at the repo root or in a directory, written by the people who own that code: what a reviewer must always check there, what to skip, what a failure looks like. The reviewer reads every `REVIEW.md` above a changed file, and it wins over the reviewer's defaults.

```markdown
# Review notes: billing/

- Money is integer cents everywhere. A float in an amount is a high finding.
- Every query filters by `firm_id`. A missing tenant filter is a high finding.
- Skip naming in `legacy/`; it is being deleted.
```

**Give stage 6 something to drive.** An e2e skill named in the profile gives the strongest proof: a screenshot per criterion against the real stack. Without one the pipeline falls back to a browser smoke, or skips with the reason.

**Review risky work with a second model family.** With Codex, OpenCode or another agent CLI installed, make it the reviewer. A reviewer that did not write the code and does not share the implementer's blind spots finds more.

**Read the flags before you approve.** Each ⚠ on a stage row is something the pipeline decided alone or could not do: a derived criterion, a finding it turned down, a lane it could not drive, a fallback. Together with the first line of the proof comment, they are what to read.

**Feed the results back.** Stage 5 records what happened to each finding (`fixed`, `rejected: wrong`, `rejected: intentional`, `left: pre-existing`) and a `Prevent at source` note when a rule would have stopped the defect. A reviewer that keeps being turned down on the same point needs a line in `REVIEW.md`. A defect that keeps coming back needs a lint rule or a line in the repo's rule files.

**Use the pieces alone.** `/pipeline <PR url>` picks up a PR someone already opened, from the review stage on. `/pr-pipeline:review <n>` posts only the AI review. `/pr-pipeline:risk <n>` returns only the merge risk.

## The AI review

What stage 4 does to keep its comments few and worth reading:

- It reviews the diff against the repo, not on its own. It opens the callers and callees of what changed, and holds the change against the ticket's criteria and the claims in the PR description. For a bug fix it checks that the cause is gone, not only the symptom.
- Every finding is checked against the code before it is posted. For sensitive, architecture and business-logic work a separate verifier does the check, and a finding is dropped only when the verifier quotes the line that refutes it.
- Only defects are posted: wrong behaviour, data exposure or loss, a broken contract, a test that cannot fail. Each is one line comment that opens with the consequence. Style, naming and "consider" are never posted.
- A defect that repeats is one thread with an `Also at` line, so the whole class is fixed in one round. A defect the PR did not write is marked `[pre-existing]` and never moves the verdict.
- Later rounds review only the commits since the last review and do not repeat what was already posted. The third review of a PR is the last: the run stops and asks for a person, because further rounds mostly turn up older bugs in the same code.
- Every thread ends fixed, or resolved with a one-sentence reason. None is left open for you to chase.
- It never approves. The verdict is a comment and a label; people approve.

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
- **custom**: any other agent CLI. Set `review_command` to a command that takes the review prompt on stdin and prints its answer, with `{model}` where the model name goes (`your-agent --print --model {model}`). Effort is ignored; any file it touches is reverted and flagged. The command is read from your own settings only, never from a repo file, a ticket or a PR, and the pipeline cannot set it for you: you type it in `/config` or the Settings card.

The security pass and the verifier run on the same backend as the review.

If the chosen backend is missing, has no command, fails, or answers with something that is not the review JSON after one retry, the review falls back to claude and the stage shows a warning saying so.

## Other harnesses

The pane, the `/pipeline` command and the Merge button need Claude Code. The stages are markdown skills plus `git` and `gh`, so an agent in Codex, OpenCode or any other harness that reads files and runs commands can drive them:

1. Clone this repo where the agent can read it.
2. Tell the agent: `Read <clone>/plugins/pr-pipeline/skills/run/SKILL.md and follow it for ABC-123.`

To save typing, put that line in the harness's own custom command, or link `skills/run`, `skills/review` and `skills/risk` into its skills directory (`~/.codex/skills/`, `~/.config/opencode/skills/`).

The skill notices the pane tool is missing and reads [`skills/run/other-harnesses.md`](skills/run/other-harnesses.md), which swaps the pane for a run record at `<criteriaDir>/run.md`, the tool calls for `gh` commands, and subagents for fresh runs of that harness's own CLI. The spec, the review rules, the PR body and the proof comment are the same. `AGENTS.md` is read as a rule file next to `CLAUDE.md`. What you give up: the live pane, the Merge, Fix CI and Sync buttons, and the run closing itself on merge.

This path has not had a full end-to-end run yet. Expect rough edges.

The prompts also work on their own, in any agent or in CI: [`agents/reviewer.md`](agents/reviewer.md) (review rules and the JSON contract), [`skills/review/verify-prompt.md`](skills/review/verify-prompt.md), [`skills/review/security-prompt.md`](skills/review/security-prompt.md) and [`skills/run/spec-format.md`](skills/run/spec-format.md) each take a diff or a ticket and need nothing from the plugin.

## Settings

All in `/config` under `pr-pipeline`. The pane's Settings card edits all of them: the reviewer with its model and effort (a list of claude models, or any model id for the other reviewers), the review command once the reviewer is `custom`, the tracker and the merge method:

| Setting | Default | Meaning |
| --- | --- | --- |
| `reviewer` | `claude` | Backend for the AI review: `claude`, `codex`, `opencode`, `custom` |
| `review_model` | `opus` | Review model when routing does not pick one (always used for codex, opencode and custom) |
| `review_effort` | `low` | Review effort when routing does not pick one |
| `review_command` | empty | Shell command for the `custom` backend: prompt on stdin, answer on stdout, `{model}` replaced with `review_model` |
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
| `skills/run/` | The conductor that drives the nine stages, plus the spec format, the acceptance-check prompt, tracker adapters, open-PR start, PR body template and the guide for other harnesses |
| `skills/review/` | The AI review, its backends, and the verifier and security prompts |
| `skills/risk/` | The merge-risk verdict |
| `agents/reviewer.md` | The read-only reviewer the review skill dispatches |
| `agents/checker.md` | The read-only checker that verifies review findings and checks the acceptance criteria |
| `profiles/` | Profile schema and a filled-in example |
| `evals/` | What three end-to-end runs should show (GitHub issue without a profile, Jira with a profile, a task in words) |
