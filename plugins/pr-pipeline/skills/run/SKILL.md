---
name: run
description: Drive a ticket (Jira, GitHub issue, Linear, or a task described in words) or an open PR through the nine-stage PR pipeline (enhance, implement, create PR, AI review, address, e2e verify, acceptance check, merge risk, final proof) in any repo, and record every stage in the PR pipeline pane. Use when the user runs /pipeline with a ticket, issue, PR or task, asks to "run the pipeline", or hands over a ticket to take all the way to merge-ready.
---

# PR pipeline

Take one ticket from its description to a PR that a colleague can approve without re-doing the work. Every stage reports to the `pr-pipeline` pane through the `mcp__pr-pipeline__pipeline` tool, so the person and their colleagues can watch and click into each stage.

The tool is deferred: when `mcp__pr-pipeline__pipeline` is not loaded, load it first with ToolSearch `select:mcp__pr-pipeline__pipeline`.

The prompt usually comes from `/pipeline` and carries a hint: `Run the pr-pipeline:run skill for <ticket> (tracker: <t>, url: <u>).`, or for a task in words, `… for this task (tracker: text): <text>`. Without a hint, treat the argument the same way `/pipeline` would. A PR instead of a ticket (`(tracker: pr, url: …)`, or a PR number or URL): read `open-pr.md` from this skill's directory before stage 1.

## Recording

The pane's stage detail is what a developer reads instead of the transcript. Keep it concise and honest, and record each transition as it happens:

| Moment | Call |
| --- | --- |
| Once at the start | `{ action: "start", ticket, title, tracker, ticketUrl, repo }` (`repo` is `owner/name`; omit `ticketUrl` for text). It returns the run key `owner/repo#branch`. A different ticket on the same branch starts a fresh run |
| Right after `start` | `{ action: "profile" }` (see "Repo profile") |
| Entering a stage | `{ action: "stage", stage, status: "running", summary }`, plus `backend`, `model`, `effort` for a routed stage only (the chip on the stage row; a stage this session runs itself omits them). Running a finished stage again starts attempt 2, 3…: its summary and confidence clear, its history stays |
| What the stage did (1–4 per stage), a warning, a decision you made alone | `{ action: "stage", stage, did }`, or `flag` or `note` in place of `did` |
| An acceptance criterion checked (stage 7) | `{ action: "stage", stage: "acceptance", criterion, met: "yes" \| "partial" \| "no", evidence }`; the same criterion text again replaces the earlier verdict |
| A URL (PR, ticket comment, review, screenshot, artifact) | `{ action: "link", stage, label, href }`. A PR link becomes the run's PR only when the run has none, or on the `pr` stage from the run's repo. A wrong link: `{ action: "unlink", stage, href }`; unlinking the run's PR clears it |
| Tier (stage 1), merge risk (stage 8) | add `tier: "S" \| "M" \| "L"` or `risk: "low" \| "medium" \| "high"` to the stage call |
| Leaving a stage | `status: "done" \| "failed" \| "skipped"`, one-line `summary`, `confidence` where the stage scored something, as a percentage (`92`, not `0.92`). `review`, `acceptance` and `proof` marked `done` get the PR head stamped as `headSha` |
| PR state (after any stage that wrote to the PR, and whenever you need checks or threads) | `{ action: "pr" }`, or `{ action: "pr", fresh: true }` right after a push or a reply |
| Answer or resolve a review thread | `{ action: "pr-reply", threadId, body }`, `{ action: "pr-resolve", threadId }` |
| Where the run stands | `{ action: "status" }` (includes `pr`, `models`, `criteriaDir`, each stage's `headSha`, `mergedAt`, `closedAt`) |
| The run is over without a merge (PR closed, person abandons it) | `{ action: "close" }` |

`did` is what happened (`Added failing test, then fixed the validator`), `flag` is a warning a developer must see before trusting the stage (`Migration rewrites orders; run on staging before merge`), `note` is a choice (`Reused DateRule instead of a new one`); never record one fact under two of them. A flag is for things like: a criterion derived rather than given, a skipped reviewer finding, a test that only passes with a workaround, a sensitive area touched, a step that ran in a fallback (subagent instead of a session, claude instead of the chosen review backend), a branch rename. Flags show as ⚠ on the stage row and at the top of the detail view. Skip a stage only with a reason in `summary`. A stage that fails stops the pipeline; record it, tell the person, end the turn.

## Setup at stage 1

Stage 1 settles everything the later stages read: the tracker, the repo profile, the review backend, the task class and its routing. Then it asks the person one question, once, and never again.

**Tracker.** Read `trackers.md` from this skill's directory at stage 1, every run: it has the detection order, how to fetch the ticket, and the key, title prefix, link line, branch key and comment command per tracker that stages 2, 3 and 9 use.

### Repo profile

Call `{ action: "profile" }` right after `start`. It returns `{ source, path?, discovered?, base?, profile, criteriaDir }`; `base` is the repo's default branch (`$BASE` below; fall back to `main`): the profile from `.pr-pipeline.json` or `.claude/pr-pipeline.json`, or discovered from the repo when neither exists, with every default filled, and `criteriaDir` as an absolute path the tool has already created. Use `profile` and that `criteriaDir` (`<criteriaDir>` below) everywhere. With `source: "discovered"`, record the `discovered` line as a stage-1 `note` and offer the save in the stage-1 question; on Save call `{ action: "profile", save: true }`, which writes `.pr-pipeline.json` untracked (commits add named paths only, so it never enters one).

The fields the stages read: `tracker` (1), `branchPattern` (2), `titlePrefix`, `linkLine`, `prBody` (3), `labels.*` (3, 4, 7, 9), `lint`, `test` (2, 5), `e2e`, `e2ePolicy` (6), `securityAgent` (4), `siblings` (2, 6), `rules` (2, 4, commits). In `branchPattern` expand `{type}` (`fix` for a bug, `feature` otherwise), `{key}` (the tracker's branch key) and `{slug}` (three to five words of the title, kebab case), dropping a separator next to an empty placeholder; in `titlePrefix` and `linkLine`, `{key}`, `{url}` and `{n}` are the ticket key, URL and issue number.

### Review backend

Call `{ action: "settings" }`. It returns `reviewer`, `review_model`, `review_effort`, `tracker`, `merge_method`, `harnesses` (`gh`, `codex`, `opencode`: a path or `null`), `claudeModels` and `efforts`. `gh` missing fails stage 1: every later stage needs it.

- `reviewer` is `codex` or `opencode`: use it with `review_model` and `review_effort`. The binary missing is handled by the review skill's fallback.
- `reviewer` is `claude` and neither `harnesses.codex` nor `harnesses.opencode` is set: claude, silently; the model and effort come from routing.
- `reviewer` is `claude`, another harness is installed and `~/.claude/pipeline/reviewer-asked` does not exist: put the backend in the stage-1 question as one choice of `<backend> · <model>`: claude with the routed model, codex with `review_model` when it is a codex model else `gpt-5-codex` (also `gpt-5`, `o3`), opencode with the first model `opencode models` lists; free text through Other. Save the answer with `{ action: "settings", set: { reviewer, review_model, review_effort } }`, create the `reviewer-asked` file, and record a `note`. A claude answer keeps routing in charge of the model.

### Task class and model routing

Classify the ticket into one class. Check `sensitive` first: any one signal makes it sensitive, whatever the size.

| Class | Signals | Cost |
| --- | --- | --- |
| sensitive | authentication, permissions or roles, money or billing arithmetic, PII, data migrations, cross-system contracts (a profile sibling with `contracts: true`), infrastructure or CI config, secrets, dependency bumps | high |
| architecture | a new module, service or boundary; a shared abstraction many callers use; more than one repo | high |
| business-logic | domain rules, calculations, state machines, eligibility, scheduling | high |
| query-perf | slow queries, N+1, indexes, caching, a latency or memory target | mid |
| feature | a new user-facing capability spanning a few layers | mid |
| quick-fix | a bug with a clear reproduction in one to three files | cheap |
| style | layout, CSS, visual polish, no behaviour change | cheap |
| copy | text, translations, labels only | cheap |

Routing, all claude unless the review backend is set to another harness (then the review column uses `review_model` and the effort mapped to that backend):

| Class | 2 Implement | 4 Review | 6 E2E | 8 Risk |
| --- | --- | --- | --- | --- |
| copy | haiku · low, subagent | haiku · low | sonnet · low, if 6a runs it (rarely) | haiku · low |
| style | sonnet · low, subagent | sonnet · low | sonnet · low, session, screenshots | haiku · low |
| quick-fix | sonnet · low, subagent | sonnet · medium | sonnet · low | sonnet · low |
| feature | opus · low, session | opus · low | opus · low, session | sonnet · medium |
| query-perf | opus · low, session | opus · high | opus · low, with a measurement lane | opus · low |
| business-logic | opus · high, session | opus · high | opus · low | opus · high |
| architecture | opus · high, session | opus · high | opus · low | opus · high |
| sensitive | opus · high, session | opus · high, plus a security pass | opus · high, every lane | opus · high |

The E2E column is the model that drives the run when stage 6a decides to run it; whether it runs at all is 6a's call, for every class. Stages 1, 3, 5, 7 and 9 run here on this session's model.

Derived tier: cheap → S, mid → M, high → L. Record it with `tier` on the stage-1 call and the class as a `note`: `Class: quick-fix · cost cheap · one validator, one test`. The stage-1 question offers "Models: as routed / opus everywhere" for this run; opus everywhere keeps each lane's routed effort and swaps the model. Record the choice as a `note`.

### The stage-1 question

One `AskUserQuestion` call, at most four questions, asked after the ticket is read and classified so the person sees the route. Include only what applies, in this order: open gaps in the ticket that block implementation; the tracker when a bare key matches both Jira and Linear; the review backend (above); "Models: as routed / opus everywhere"; "Save these conventions as .pr-pipeline.json? (Save / This run only)" when the profile `source` is `discovered`. Anything that does not fit takes its default with a `note`. In the CLI under `-p` or on an event-driven turn, ask nothing: take the defaults and note them. Decide what the question did not cover the way a careful colleague would and record each decision as a `note`.

## Where stages run

The pipeline session is the conductor. A stage routed to a session runs in a linked session started with `start_session` (initiation `user_asked`, context `fresh`, its own worktree); one routed to a subagent runs through the Agent tool with the routed `model` and `effort`. Every brief, at any stage, names the ticket, the branch, the resolved profile, `<criteriaDir>`, the model and effort, and the exact tool calls that record its stage, and includes the run key `start` returned with the instruction to pass it as `branch` on every `mcp__pr-pipeline__pipeline` call. Wait for the result and verify it (diff, PR, artifact) before moving on.

`start_session` is refused on a turn that an event started (a side-session note, a CI monitor event): run the stage in a subagent here instead and record `flag: "Ran in a subagent; start_session unavailable on an event-driven turn"`. In the CLI or under `-p`, always use subagents.

## The PR, labels and commits

The person follows the PR in the pane: its Pull request card shows checks, review decision and the Merge button; its Threads card shows review threads with a reply box.

- Every stage that writes to the PR (3, 4, 5, 7, 8, 9) ends with a `link` for what it wrote and `{ action: "pr" }`, so the pane refreshes.
- CI state comes from `pr.checks` and `pr.counts`. A failing check with a `runId`: read `gh run view <runId> --log-failed`, fix, push, record a `did`. Never wait on CI in a loop; read the checks at the end of stages 5 and 9.
- `pr.mergeState` `BEHIND` or `pr.mergeable` `CONFLICTING`: merge the base branch, fix conflicts, push, record a `did`.
- Never tell the person to open the PR page or the ticket in a browser. The closing message names the PR by number and points at the pane.
- After the PR merges, the pane closes the run by itself five minutes later, or the person presses Close.
- Labels come from the profile's `labels` map; a `null` key means skip that label, silently. Label changes are swaps: remove the previous state label when adding the next (`gh pr edit <n> --remove-label "<old>" --add-label "<new>"`, quoting the exact name, spacing included).
- Commits follow the repo's `rules` files and add named paths only; commits and PR bodies carry no co-author trailer and no mention of the tool that wrote them. Nobody is pinged: never pass `--reviewer`, `--add-reviewer`, `--assignee` or `--add-assignee`, and never write an `@login` in a PR body, review, comment, thread reply or ticket comment.

## Stages

### 1. Enhance

Detect the tracker and fetch the ticket (`trackers.md`), `start` the run, call `{ action: "profile" }`, record stage 1 `running`, then settle the rest of the setup above. Extract the acceptance criteria verbatim into `<criteriaDir>/acceptance.md`, one checkbox per criterion; where the ticket has none, derive them from the description and comments, mark them `(derived)` and flag it. Rewrite the ticket into a spec: problem, expected behaviour, out of scope, repos touched, risks, and for a bug the reproduction steps you will use. Classify, ask the stage-1 question, fold its answers into the spec, then post the spec as a ticket comment headed "Pipeline spec" (text tracker: `<criteriaDir>/spec.md`) and link the comment to the stage. Record the stage `done` with `tier`, the class `note`, and confidence: how complete the criteria are (100 when the ticket had explicit, testable criteria).

### 2. Implement

Branch off the base per `branchPattern` (`fix/abc-123-null-taxpayer`, `feature/issue-42-export-csv`, `feature/csv-export`). The app names a worktree branch `claude/<slug>-<hash>`; rename it with `git branch -m` before the first push and record a `did`. Bug: reproduce first with a failing test, record the failing output as a `did`, then fix. Feature: plan, implement, test. Run `lint` and the tests the change touches (`test` narrowed to the touched files where the runner allows). Cross-repo work gets a branch of the same name in each `siblings` repo it touches, and in the sibling with `contracts: true` when a boundary file moves. Commit. Summary: files changed, tests added. Flag any sensitive signal the diff touches even when the class was not sensitive, then re-route stages 4, 6 and 8 as sensitive and note it.

### 3. Create PR

Title `{titlePrefix} Subject under 70 chars` (no prefix when it is empty). Read `pr-body.md` from this skill's directory for the body: the template for `prBody: "visual-pr"` and `"plain"`, and how to pick the one change-outline view.

Then `gh pr edit`: the type label (`typeBug` or `typeFeature`) and `stateReview`. Link the PR to the stage (the mod also picks it up from `gh pr create` output), then `{ action: "pr" }`. Stacked or cross-repo PRs: link each.

#### Pipeline status strip

The line between the `pipeline-status` markers is the PR's traffic light, above the fold so a reviewer sees the merge risk before reading anything. Rewrite it with `gh pr edit <n> --body-file <file>` (replace only the text between the markers) at the end of stages 4, 6, 7, 8 and 9, and after a delta review:

| Slot | Value | Light |
| --- | --- | --- |
| Merge risk | `pending` → `low` / `medium` / `high` after stage 8 | 🟢 low · 🟡 medium · 🔴 high · ⚪ pending |
| Review | `lgtm` / `changes requested` after stage 4 | text only |
| Acceptance | `met/total` after stage 7 | text only |
| e2e | `pending` / `n lanes` / `skipped · <reason>` after stage 6 | text only |

Example after stage 9: `🟡 Merge risk: medium · Review: lgtm · Acceptance: 6/6 · e2e: 5 lanes`; a skip reads `e2e: skipped · CSS-only change, no criterion needs the running stack`. Exactly these four slots, values from the table only; no counts of findings or screenshots, no free text beyond the e2e skip reason. The merge-risk light matches the pane header.

### 4. AI review

Run the `pr-pipeline:review` skill with the run key, the class (so a sensitive diff gets the security pass), the backend from setup and the route's model and effort. It posts the review, swaps the label and records stage `review` itself; do not record the stage again. Verified findings under 60 land in `<criteriaDir>/review-held.json` with no thread; stage 5 fixes them. Read the verdict back with `{ action: "status" }` and refresh the status strip.

### 5. Address

Read the threads with `{ action: "pr", fresh: true }`: every thread in `pr.threads` with `isResolved` false. For each AI thread: fix it, commit, push, then `pr-reply` and `pr-resolve`; record each as a `did`. The reply body is `Fixed in <sha>.`, plus one sentence only when the fix differs from what the comment asked; no test names, no restating the diff. When you disagree, reply with the reason in one sentence and record a `note`. Fix the held findings in `<criteriaDir>/review-held.json` too, without a thread, each a `did`. A thread from a person that appears during the run is answered the same way, and flagged so the person sees it was handled. Run `lint` and the touched tests before the push. End with `{ action: "pr", fresh: true }` and handle failing checks and a `BEHIND` base as in "The PR, labels and commits". When the review's summary is `lgtm` with no findings and no `held` count (and `review-held.json` is absent or empty) and no human threads are open, mark this stage `skipped`.

### 6. E2E verify

**6a. Decision.** The conductor decides, before anything starts, whether e2e runs:

- `e2ePolicy: "always"` runs it, `"never"` skips it. The person saying "run e2e" or "skip e2e" in the stage-1 answer counts the same for this run.
- Otherwise skip only when every changed file (`git diff --name-only $BASE...HEAD`) is copy, style, docs, config, CI or a dependency manifest and no acceptance criterion needs the running stack. Run in every other case.

Record the decision on stage `verify`; its reason shows in the pane's stage row and in the status strip:

- Skip: `{ action: "stage", stage: "verify", status: "skipped", summary: "Skipped: <reason>" }`, refresh the strip's e2e slot (`e2e: skipped · <reason>`), move on.
- Run: the `running` call carries the route's `backend`, `model` and `effort` and `note: "E2E: run · <reason>"`.

**6b. Run**, at the route's model and effort, in this order:

1. The profile names an `e2e` skill: run it against the real stack for the lanes the acceptance criteria name. Repo-specific setup (containers, databases, build mounts) belongs to that skill, not here.
2. No `e2e` skill, but `.claude/launch.json` exists: a Browser-pane smoke. `preview_start` its first configuration, navigate to the routes or screens the diff touches, take an after screenshot of every state the criteria mention, and read the console for errors. A before screenshot comes from the base branch when a second preview of it is cheap; otherwise say "after only" in a `note`.
3. Neither: `skipped` with summary `Skipped: no e2e skill or .claude/launch.json in this repo`. Flag it when a criterion needs the running stack.

Stage 6 never posts a PR comment, and tells the e2e skill not to; its screenshots and table reach the PR only through the proof. Keep screenshots in `<criteriaDir>/e2e/`; Browser-pane screenshots land at `~/.claude/projects/<project>/<session>/tool-results/mcp-Claude_Browser-blob-*.jpg`, so copy the ones you keep. A query-perf route adds a measurement lane (timings or query counts before and after). Cross-repo features start the siblings' branches too and drive the flow across them. Link the published artifact or screenshots to the stage, record each lane as a `did`, flag any lane you could not drive.

### 7. Acceptance

**Delta review first.** Read the `review` stage's `headSha` from `{ action: "status" }`. When commits landed after it (address fixes, e2e fixes), run `pr-pipeline:review` with the stage-4 inputs plus `since <headSha>`, so it reviews only `git diff <headSha>..HEAD`, at stage 4's routed model with effort one step lower (low stays low), then refresh the strip. A `changes requested` on the delta stops the pipeline with status `failed`. Threads and held findings from an `lgtm` delta are fixed as in stage 5; those fixes do not trigger another delta. Skip it when `headSha` is the current head.

Re-read `<criteriaDir>/acceptance.md`. Record every criterion with `criterion`, `met` and `evidence`: a test name, a screenshot path, a log line, a database row. `partial` is for evidence that covers the happy path only. A `no` is a gap: flag it, swap to the `needsWork` label, go back to stage 2 for the gap, then re-run 3 through 7 for the delta (the review as a delta review). After the second loop, stop with status `failed` and the open gaps listed. Confidence: criteria met over criteria total, as a percentage. Refresh the status strip, `{ action: "pr" }`.

### 8. Merge risk

Run the `pr-pipeline:risk` skill in a subagent at the route's model and effort, passing the PR number, `<criteriaDir>` and the class. It returns the five category verdicts and the overall verdict. Record `risk` on the stage, the overall verdict as the summary, each category verdict as a `did` (`Impact: medium · touches the order observer used by imports`), and every ⚠️ as a `flag`. The score stays internal; the pane and the PR show verdicts only. Refresh the status strip so the merge-risk light is on the PR before the proof comment exists, then `{ action: "pr" }`.

### 9. Final proof

Read `{ action: "pr", fresh: true }` first: a failing check is fixed (back through stage 5's push path) before the proof is posted; pending checks are named under Not verified.

**Human look.** Yes when the merge risk is medium or high, the acceptance confidence is under 80, or the AI review ended `changes requested`. Record it as a `note` on stage 9 (`Needs a human look: risk medium` or `No human look needed: risk low, confidence 92%, review lgtm`). The person decides who to ask; the pipeline never requests reviewers.

Post one PR comment headed "Pipeline proof", holding evidence only:

```markdown
## Pipeline proof

<one line: what a human must look at and why, or `Nothing needs a human look.`>

| Criterion | Evidence |
| --- | --- |
| ✅ Due date in the past is refused | `DueDateTest::past_date_refused` |
| ⚠️ Error shows under the field | screenshot below; mobile width not driven |

**Risks**
- Rollback: files already uploaded stay after a revert. `app/Jobs/X.php:41`

**Not verified:** <lanes or criteria not driven live; pending checks>

<at most 3 screenshots, one per visual criterion; the rest stay in the linked artifact>
```

- **Risks** prints the stage-8 bullets of the categories that are not ✅, each prefixed with its category; omit the heading when all five are ✅. **Not verified** is omitted when empty.
- One test name or one live observation per row. A defect e2e found and fixed is one evidence row under its criterion.
- No badges, no emoji status line, no risk table, no Review section, no model or effort names, no finding counts. Under 1200 characters before the screenshots.

Attach screenshots with `gh pr comment <n> --body-file proof.md --attach ./after.jpg` run from `<criteriaDir>/e2e/` with relative paths, so the inline references rewrite. Refresh the status strip last, so the body, the proof comment and the pane agree. Swap labels to `aiVerified` and `readyToMerge` (a high merge risk keeps `stateReview` instead of `readyToMerge` and the first line says why).

Post a short proof summary to the ticket where the tracker has comments: PR number and link, merge risk, confidence, acceptance `met/total`, review verdict, and whether it needs a human look. Text tracker: write it to `<criteriaDir>/proof.md`. Link the PR comment and the ticket comment to the stage, `{ action: "pr" }`, and mark the stage `done` last, with summary `ready to merge · risk low` (or `ready for review · risk medium`). A commit after that turns the proof stale in the pane and needs the delta review, acceptance and proof again.

Then one short message to the person: PR #n, merge risk, confidence, whether it needs a human look and why (or `Merge from the pane when checks are green.`), what a reviewer should focus on, anything flagged.
