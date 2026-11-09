---
name: run
description: Drive a ticket (Jira, GitHub issue, Linear, or a task described in words) or an open PR through the nine-stage PR pipeline (enhance, implement, create PR, AI review, address, e2e verify, acceptance check, merge risk, final proof) in any repo, and record every stage in the PR pipeline pane. Use when the user runs /pipeline with a ticket, issue, PR or task, asks to "run the pipeline", or hands over a ticket to take all the way to merge-ready.
---

# PR pipeline

Take one ticket from its description to a PR that a colleague can approve without re-doing the work. Every stage reports to the `pr-pipeline` pane through the `mcp__pr-pipeline__pipeline` tool, so the person and their colleagues can watch and click into each stage. A stage that is not recorded did not happen.

The prompt usually comes from `/pipeline` and carries a hint: `Run the pr-pipeline:run skill for <ticket> (tracker: <t>, url: <u>).`, or for a task in words, `… for this task (tracker: text): <text>`. Without a hint, treat the argument the same way `/pipeline` would.

## Recording

The pane's stage detail is what a developer reads instead of the transcript. Keep it concise and honest. Call the tool at every transition, never in bulk afterwards:

| Moment | Call |
| --- | --- |
| Once at the start | `{ action: "start", ticket, title, tracker, ticketUrl, repo }` (`repo` is `owner/name`; omit `ticketUrl` for text). A different ticket on the same branch starts a fresh run |
| Entering a stage | `{ action: "stage", stage, status: "running", summary, backend, model, effort }` (the chip on the stage row). Running a finished stage again starts attempt 2, 3…: its summary and confidence clear, its history stays |
| Something the stage did (1–4 per stage) | `{ action: "stage", stage, did: "Added failing test, then fixed the validator" }` |
| Something a developer must see before trusting the stage | `{ action: "stage", stage, flag: "Migration rewrites orders; run on staging before merge" }` |
| A decision you made alone | `{ action: "stage", stage, note: "Reused DateRule instead of a new one" }` |
| An acceptance criterion checked (stage 7) | `{ action: "stage", stage: "acceptance", criterion, met: "yes" \| "partial" \| "no", evidence }`; the same criterion text again replaces the earlier verdict |
| A URL (PR, ticket comment, review, screenshot, artifact) | `{ action: "link", stage, label, href }`. A PR link becomes the run's PR only when the run has none, or on the `pr` stage from the run's repo |
| A wrong link, or the wrong PR adopted | `{ action: "unlink", stage, href }`; unlinking the run's PR clears it |
| Class and derived tier (stage 1) | add `tier: "S" \| "M" \| "L"` to the stage call; class and cost go in a `note` |
| Merge risk verdict (stage 8) | add `risk: "low" \| "medium" \| "high"` to the stage call |
| Leaving a stage | `status: "done" \| "failed" \| "skipped"`, one-line `summary`, `confidence` where the stage scored something, as a percentage (`92`, not `0.92`) |
| Settings (stage 1) | `{ action: "settings" }`; to save the stage-1 answer, `{ action: "settings", set: { reviewer, review_model, review_effort } }` |
| PR state (after any stage that wrote to the PR, and whenever you need checks or threads) | `{ action: "pr" }`, or `{ action: "pr", fresh: true }` right after a push or a reply |
| Answer or resolve a review thread (stage 5) | `{ action: "pr-reply", threadId, body }`, `{ action: "pr-resolve", threadId }` |
| Where the run stands | `{ action: "status" }` (includes `pr`, `models`, `mergedAt`, `closedAt`) |
| The run is over without a merge (PR closed, person abandons it) | `{ action: "close" }` |

`did` is what happened, `flag` is a warning, `note` is a choice. Do not record the same fact under two of them. A flag is for things like: a criterion derived rather than given, a skipped reviewer finding, a test that only passes with a workaround, a sensitive area touched, a step that ran in a fallback (subagent instead of a session, claude instead of the chosen review backend), a branch rename. Flags show as ⚠ on the stage row and at the top of the detail view.

`backend`, `model` and `effort` on a `running` call name who does the stage's work. A stage this session runs itself records `backend: "claude"` with this session's model and effort; a routed stage records the route (see "Model routing"). Skip a stage only with a reason in `summary`. A stage that fails stops the pipeline; record it, tell the person, end the turn.

## Setup at stage 1

Stage 1 settles everything the later stages read: the repo profile, the tracker, the review backend, the task class and its routing. Then it asks the person one question, once, and never again.

### Repo profile

Look up the profile in this order and stop at the first hit:

1. `.pr-pipeline.json` at the repo root
2. `.claude/pr-pipeline.json`
3. Discovery (below), when neither exists
4. Defaults, for any field the file or discovery left out

The fields and their defaults are in the plugin README ("Repo profile") and `profiles/pr-pipeline.schema.json`; `profiles/example.json` is a filled-in example. The ones the stages read:

| Field | Default | Used at |
| --- | --- | --- |
| `tracker` | `auto` | stage 1 |
| `branchPattern` | `{type}/{key}-{slug}` | 2 |
| `titlePrefix`, `linkLine` | per tracker (table below) | 3 |
| `prBody` | `visual-pr` | 3 |
| `labels.*` | all `null` (no labels) | 3, 4, 7, 9 |
| `lint`, `test` | discovered | 2, 5 |
| `e2e` | `null` | 6 |
| `e2ePolicy` | `auto` | 6a |
| `securityAgent` | `null` | 4 |
| `siblings` | `[]` | 2, 6 |
| `rules` | `CLAUDE.md`, `AGENTS.md`, `.ai/rules/index.md` where they exist | 2, 4 |
| `criteriaDir` | `~/.claude/pipeline/{owner}-{repo}/{ticket}` | every stage |
| `mergeMethod` | the repo's allowed method, squash first | the pane's Merge button |

Placeholders: `{owner}` and `{repo}` are the two halves of `owner/name`; `{ticket}` is the ticket id made path-safe (`ABC-123`, `issue-42`, `text-<slug>`); `{key}` is the ticket key as the tracker shows it; `{url}` is the ticket URL; `{n}` is an issue number; `{type}` is `fix` for a bug and `feature` otherwise; `{slug}` is three to five words of the title in kebab case. In `branchPattern`, `{key}` is the branch key from the tracker table, and a separator next to an empty placeholder is dropped. Expand `~` before use. The criteria directory sits outside the checkout so every worktree and subagent can reach it; create it at stage 1.

#### Discovery

Run only when there is no profile file. Each step fills one field; a step that finds nothing leaves the default.

- `gh repo view --json nameWithOwner,defaultBranchRef,squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed`: repo, base branch, `mergeMethod` (squash, then rebase, then merge, the first one allowed).
- `gh label list --json name --limit 200`, matched case-insensitively against the label name with emoji shortcodes stripped: `bug` → `typeBug`; `feature` or `enhancement` → `typeFeature`; `review` → `stateReview`; `ready to merge` → `readyToMerge`; `needs more work` or `needs work` → `needsWork`; `ai: changes requested`, `ai: lgtm`, `ai: verified` exact → the three `ai*` keys. Unmatched keys stay `null`. Never create a label.
- `lint` and `test`: `package.json` scripts (`lint`, `test`) run with the runner its lockfile names (`yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, `bun.lockb` → bun, else npm); `composer.json` scripts, prefixed `vendor/bin/sail` when `docker-compose.yml` mentions sail; `Makefile` targets `lint` and `test`; `pyproject.toml` → `ruff check .` and `pytest`; `Cargo.toml` → `cargo clippy` and `cargo test`; `go.mod` → `go vet ./...` and `go test ./...`. Join several with ` && `.
- `e2e` = `e2e-verify` when `.claude/skills/e2e-verify/SKILL.md` exists; `securityAgent` = `security-reviewer` when `.claude/agents/security-reviewer.md` exists.
- `branchPattern` from the last 20 head refs (`gh pr list --state all --limit 20 --json headRefName`): keep the default unless most of them share another shape (`feat/…`, `ABC-123/…`).
- `rules`: whichever of `CLAUDE.md`, `AGENTS.md`, `.ai/rules/index.md` exist.

Record what discovery found as one `note` on stage 1 (`Profile discovered: base main, squash, 3 labels matched`). The stage-1 question offers once: "Save these conventions as .pr-pipeline.json? (Save / This run only)". On Save, write the file at the repo root and leave it untracked: never stage it, never let it enter the feature commit (`git add` named paths only). Do not offer again in the same repo once the file exists.

### Tracker

Detect the tracker in this order: profile `tracker` (or the plugin setting `tracker`) when not `auto` > the `(tracker: …)` hint in the prompt > the MCP tools present for the key's shape > `gh issue view <n>` succeeds > text. A bare `KEY-n` with both the Jira and the Linear tools present goes into the stage-1 question. MCP tools may be deferred: load them with `ToolSearch` before deciding they are absent.

| Tracker | Fetch | Comment (spec at stage 1, proof at stage 9) | Key | Title prefix | Link line | Branch key |
| --- | --- | --- | --- | --- | --- | --- |
| jira | Atlassian MCP `getJiraIssue`; the browse URL comes from the issue's own host (`https://<site>/browse/<KEY>`), never a fixed site | `addCommentToJiraIssue` | `[A-Z][A-Z0-9]+-\d+` | `[KEY]` | `[KEY](url)` | key lowercased |
| github | `gh issue view <n> --json title,body,comments,labels,url` (`--repo owner/name` when the issue lives elsewhere) | `gh issue comment <n> --body-file <file>` | `#n`, `owner/repo#n`, or an `/issues/n` URL | none | `Closes #n` (`Closes owner/repo#n` across repos) | `issue-n` |
| linear | Linear MCP `get_issue` when present, else `linear issue view <KEY> --json`; neither → stage 1 fails with the reason | `create_comment`, else `linear issue comment add` | `[A-Z][A-Z0-9]+-\d+` | `[KEY]` | `[KEY](url)` | key lowercased |
| text | the pasted text is the ticket; the title is its first line | none; the spec lives in `<criteriaDir>/spec.md` | ticket `text:<slug>` | none | none | none (the branch is `{type}/{slug}`) |

The profile's `titlePrefix` and `linkLine` win over the tracker column; an empty string means none. A `(tracker: pr, url: …)` hint means an open PR: see "Starting from an open PR".

### Review backend

Call `{ action: "settings" }`. It returns `reviewer`, `review_model`, `review_effort`, `tracker`, `merge_method`, `harnesses` (`gh`, `codex`, `opencode`: a path or `null`), `claudeModels` and `efforts`.

- `reviewer` is `codex` or `opencode`: use it with `review_model` and `review_effort`. The binary missing is handled by the review skill's fallback.
- `reviewer` is `claude` and neither `harnesses.codex` nor `harnesses.opencode` is set: claude, silently; the model and effort come from routing.
- `reviewer` is `claude`, another harness is installed and `~/.claude/pipeline/reviewer-asked` does not exist: put the backend in the stage-1 question as one choice of `<backend> · <model>`: claude with the routed model, codex with `review_model` when it is a codex model else `gpt-5-codex` (also `gpt-5`, `o3`), opencode with the first model `opencode models` lists; free text through Other. Save the answer with `{ action: "settings", set: { reviewer, review_model, review_effort } }`, create the `reviewer-asked` file, and record a `note`. A claude answer keeps routing in charge of the model.

`gh` missing (`harnesses.gh` null) fails stage 1: every later stage needs it.

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

The E2E column is the model that drives the run when stage 6a decides to run it; whether it runs at all is 6a's call, for every class.

Derived tier: cheap → S, mid → M, high → L. Record it with `tier` on the stage-1 call and the class as a `note`: `Class: quick-fix · cost cheap · one validator, one test`. The stage-1 question offers "Models: as routed / opus everywhere" for this run; opus everywhere keeps each lane's routed effort and swaps the model. Record the choice as a `note`. Stages 1, 3, 5, 7 and 9 run here on this session's model.

### The stage-1 question

One `AskUserQuestion` call, at most four questions, asked after the ticket is read and classified so the person sees the route. Include only what applies, in this order: open gaps in the ticket that block implementation; the tracker when a bare key matches both Jira and Linear; the review backend (above); "Models: as routed / opus everywhere"; "Save these conventions as .pr-pipeline.json? (Save / This run only)" when discovery ran. Anything that does not fit takes its default with a `note`. In the CLI under `-p` or on an event-driven turn, ask nothing: take the defaults and note them.

## Where stages run

The pipeline session is the conductor. A stage routed to a session runs in a linked session started with `start_session` (initiation `user_asked`, context `fresh`, its own worktree) whose brief names the ticket, the branch, the profile path (or the discovered values), `<criteriaDir>`, the model and effort, and the exact tool calls it must make to record its stage. Wait for its note, verify its result (diff, PR, artifact) before moving on. A stage routed to a subagent runs through the Agent tool with the routed `model` and `effort`.

`start_session` is refused on a turn that an event started (a side-session note, a CI monitor event). On such a turn, run the stage in a subagent here instead and record a `flag: "Ran in a subagent; start_session unavailable on an event-driven turn"`. In the CLI or under `-p`, always use subagents.

Decide what the stage-1 question did not cover the way a careful colleague would and record each decision as a `note`.

## Nothing to open on GitHub

The person follows the PR in the pane: its Pull request card shows checks, review decision and the Merge button; its Threads card shows review threads with a reply box. The skill keeps it that way:

- Every stage that writes to the PR (3, 4, 5, 7, 8, 9) ends with a `link` for what it wrote and `{ action: "pr" }`, so the pane refreshes.
- CI state comes from `pr.checks` and `pr.counts`. A failing check with a `runId`: read `gh run view <runId> --log-failed`, fix, push, record a `did`. Never wait on CI in a loop; read the checks at the end of stages 5 and 9.
- Review threads come from `pr.threads`. Reply with `pr-reply`, resolve with `pr-resolve`.
- `pr.mergeState` `BEHIND` or `pr.mergeable` `CONFLICTING`: merge the base branch, fix conflicts, push, record a `did`.
- Never tell the person to open the PR page or the ticket in a browser. The closing message names the PR by number and points at the pane.
- After the PR merges, the pane closes the run by itself five minutes later, or the person presses Close. Call `{ action: "close" }` only when the run ends without a merge.

## Labels, commits, PRs

Labels come from the profile's `labels` map; a `null` or missing key means skip that label, silently. Label changes are swaps: remove the previous state label when adding the next (`gh pr edit <n> --remove-label "<old>" --add-label "<new>"`, quoting the exact name, spacing included). Commits follow the repo's own rules (the `rules` files); commits and PR bodies carry no co-author trailer and no mention of the tool that wrote them. Nobody is pinged: never pass `--reviewer`, `--add-reviewer`, `--assignee` or `--add-assignee`, and never write an `@login` in a PR body, review, comment, thread reply or ticket comment.

## Stages

### 1. Enhance

Detect the tracker and fetch the ticket through its adapter, then `start` the run (`ticket`, `title`, `tracker`, `ticketUrl`, `repo`) and record stage 1 `running` with this session's backend, model and effort. Settle the rest of the setup above. Extract the acceptance criteria verbatim into `<criteriaDir>/acceptance.md`, one checkbox per criterion. Where the ticket has none, derive them from the description and comments, mark them `(derived)` and flag it. Rewrite the ticket into a spec: problem, expected behaviour, out of scope, repos touched, risks. For a bug, add the reproduction steps you will use. Classify, ask the stage-1 question, fold its answers into the spec, then post the spec as a ticket comment headed "Pipeline spec" (text tracker: write `<criteriaDir>/spec.md` instead) and link the comment to the stage. Record the stage `done` with `tier`, the class `note`, and confidence: how complete the criteria are (100 when the ticket had explicit, testable criteria).

### 2. Implement

Branch off the base per `branchPattern` (`fix/abc-123-null-taxpayer`, `feature/issue-42-export-csv`, `feature/csv-export`). The app names a worktree branch `claude/<slug>-<hash>`; rename it with `git branch -m` before the first push and record a `did`. Bug: reproduce first with a failing test, record the failing output as a `did`, then fix. Feature: plan, implement, test. Run the profile's `lint` and the tests the change touches (the profile's `test` narrowed to the touched files where the runner allows). Cross-repo work gets a branch of the same name in each `siblings` repo it touches, and in the sibling with `contracts: true` when a boundary file moves. Commit. Summary: files changed, tests added. Flag any sensitive signal the diff touches, even when the class was not sensitive (then re-route stages 4, 6 and 8 as sensitive and note it).

### 3. Create PR

Title `{titlePrefix} Subject under 70 chars` (no prefix when it is empty). With `prBody: "visual-pr"`, the body is for a reader who skims, so it shows the change rather than narrating it:

```markdown
<linkLine, expanded; omit the line when there is none>

<!-- pipeline-status -->
⚪ Merge risk: pending · ⚪ Confidence: pending · AI review: pending · Acceptance: 0/4 · e2e: pending
<!-- /pipeline-status -->

## Summary
<one sentence: why this change, in the ticket's words>

## Details
<1–3 bullets a reviewer must know: a drive-by, an assumption, a trap. Omit the section when there are none.>

## Change outline
<one view that fits the change, see below>

## Test plan
- [ ] <how a reviewer verifies it, as steps>
```

Pick the change outline the way a colleague would at a whiteboard:

| Change | View |
| --- | --- |
| A new flow or a changed order of calls | a short call tree in a code block, `A → B → C`, ~10 lines |
| A new component or page | a shallow component tree, children only, ~10 lines |
| Logic in one function | pseudocode, 5–15 lines, names from the diff |
| A changed shape (interface, schema, request, response, enum) | a `diff` block of the shape, `-` old `+` new |
| Three or more files that talk to each other | a `mermaid` flowchart, nodes named after files or classes |

One view, under 25 lines. Nothing else in the body is a diagram. Keep the whole body under 1000 characters of prose; the views do not count. With `prBody: "plain"`: link line, the status strip, Summary and Test plan only.

Then `gh pr edit`: the type label (`typeBug` or `typeFeature`) and `stateReview`. Link the PR to the stage (the mod also picks it up from `gh pr create` output), then `{ action: "pr" }`. Stacked or cross-repo PRs: link each.

#### Pipeline status strip

The line between the `pipeline-status` markers is the PR's traffic light. It sits above the fold so a reviewer sees risk and confidence before reading anything. Rewrite it with `gh pr edit <n> --body-file <file>` (replace only the text between the markers, keep the rest of the body) at the end of stages 4, 6, 7, 8 and 9:

| Slot | Value | Light |
| --- | --- | --- |
| Merge risk | `pending` → `low` / `medium` / `high` after stage 8 | 🟢 low · 🟡 medium · 🔴 high · ⚪ pending |
| Confidence | stage 7 criteria-met %, else stage 4 description confidence | 🟢 80+ · 🟡 60–79 · 🔴 under 60 · ⚪ pending |
| AI review | `lgtm` / `changes requested` / `n findings open` after stage 4 | text only |
| Acceptance | `met/total` after stage 7 | text only |
| e2e | `pending` / `n lanes` / `skipped · <reason> (decided by sonnet, low effort)` after stage 6 | text only |

Example after stage 9: `🟢 Merge risk: low · 🟢 Confidence: 92% · AI review: lgtm · Acceptance: 4/4 · e2e: 2 lanes`; a skip reads `e2e: skipped · CSS-only change, no criterion needs the running stack (decided by sonnet, low effort)`. Same thresholds as the pane header, so the two never disagree.

### 4. AI review

Run the `pr-pipeline:review` skill with the backend from setup and the route's model and effort; pass the class, so a sensitive diff gets the security pass. It posts the review and swaps the label to `aiLgtm` or `aiChangesRequested`. Record the `running` call with the backend, model and effort that actually ran (after a fallback, the claude values plus the skill's flag). Record the verdict as the summary (`lgtm · n findings` or, verbatim, `changes requested · n high`; the pane's attention strip keys on that phrase), `description_confidence` as the confidence, each posted finding as a `did`, and a `flag` for any finding dropped as unverifiable. Refresh the status strip, link the review, `{ action: "pr" }`.

### 5. Address

Read the threads with `{ action: "pr", fresh: true }`: every thread in `pr.threads` with `isResolved` false. For each AI finding with confidence 60 or more: fix it, commit, push, then `{ action: "pr-reply", threadId, body: "Fixed in <sha>: <what changed>" }` and `{ action: "pr-resolve", threadId }`; record each as a `did`. Below 60: reply with the reasoning when you disagree (record as a `note`), fix when it is cheap. A thread from a person that appears during the run is answered the same way, and flagged so the person sees it was handled. Run `lint` and the touched tests before the push. End with `{ action: "pr", fresh: true }` and handle failing checks and a `BEHIND` base as in "Nothing to open on GitHub". Re-run stage 4 once; a second `changes requested` stops the pipeline with status `failed`. When the first review was `lgtm` with no findings and no human threads are open, mark this stage `skipped`.

### 6. E2E verify

#### 6a. E2E decision

Not every change deserves an e2e run. Before anything starts, a decision agent decides: the Agent tool, `model: "sonnet"`, `effort: "low"`, always a subagent, never a session. Give it the class from stage 1, `<criteriaDir>/acceptance.md`, the changed file list (`git diff --name-only $BASE...HEAD`) and the profile's `e2ePolicy` (default `auto`), and have it answer JSON only:

```json
{ "run": true, "reason": "<one sentence>", "lanes": ["<lane>", "…"] }
```

The rules it applies:

- `e2ePolicy: "always"` → run. `"never"` → skip.
- `auto`: run when any criterion names UI, a user flow, an integration, a queue or job, a webhook or a sibling repo, or the class is feature, business-logic, architecture or sensitive. Skip when every changed file is copy, style, formatting, links, docs, infra, config or env, CI, or a dependency manifest, and no criterion needs the running stack.

The person saying "run e2e" (or "skip e2e") in the stage-1 answer counts as `always` (or `never`) for this run. A reply that is not valid JSON is re-asked once; still invalid, apply the rules yourself and flag it. You may override the verdict only with a `note` saying why (`Overrode the e2e decision: the CSS change moves the checkout button, criterion 2 names it`).

Record the decision on stage 6 every time; the pane shows a skipped stage as `Skipped by <backend·model·effort>: <summary>`, so both the summary and the model fields must be there:

- Skip: `{ action: "stage", stage: "verify", status: "skipped", summary: "Skipped: <reason>", backend: "claude", model: "sonnet", effort: "low", note: "Decided by claude·sonnet·low (e2e decision agent): <reason>" }`. Refresh the status strip's e2e slot and move on to stage 7.
- Run: the stage's `running` call carries the route's `backend`, `model` and `effort` and `note: "E2E decided by claude·sonnet·low: <reason> · lanes: <lanes>"`. Drive the lanes the agent named, plus any a criterion names that it missed.

#### 6b. Run

Use the route's model and effort, in this order:

1. The profile names an `e2e` skill: run it against the real stack for the lanes the acceptance criteria name. Repo-specific setup (containers, databases, build mounts) belongs to that skill, not here.
2. No `e2e` skill, but `.claude/launch.json` exists: a Browser-pane smoke. `preview_start` its first configuration, navigate to the routes or screens the diff touches, take an after screenshot of every state the criteria mention, and read the console for errors. A before screenshot comes from the base branch when a second preview of it is cheap; otherwise say "after only" in a `note`.
3. Neither: `skipped` with summary `Skipped: no e2e skill or .claude/launch.json in this repo` and the same `backend`/`model`/`effort` as the running call. Flag it when 6a decided to run, since a criterion then needed the running stack.

Keep screenshots in `<criteriaDir>/e2e/`. Browser-pane screenshots land on disk at `~/.claude/projects/<project>/<session>/tool-results/mcp-Claude_Browser-blob-*.jpg`; copy the ones you keep. A query-perf route adds a measurement lane (timings or query counts before and after). Cross-repo features start the siblings' branches too and drive the flow across them. Link the published artifact or screenshots to the stage, record each lane as a `did`, flag any lane you could not drive.

### 7. Acceptance

Re-read `<criteriaDir>/acceptance.md`. Record every criterion with `criterion`, `met` and `evidence`: a test name, a screenshot path, a log line, a database row. `partial` is for evidence that covers the happy path only. A `no` is a gap: flag it, swap to the `needsWork` label, go back to stage 2 for the gap, then re-run 3 through 7 for the delta. After the second loop, stop with status `failed` and the open gaps listed. Confidence: criteria met over criteria total, as a percentage. Refresh the status strip, `{ action: "pr" }`.

### 8. Merge risk

Run the `pr-pipeline:risk` skill in a subagent at the route's model and effort, passing the PR number, `<criteriaDir>` and the class. It reads the PR, the diff, the review, the acceptance criteria and the e2e evidence, and returns the five category verdicts and the overall verdict. Record `risk` on the stage, the overall verdict as the summary, each category verdict as a `did` (`Impact: medium · touches the order observer used by imports`), and every ⚠️ as a `flag`. The score stays internal; the pane and the PR show verdicts only. Refresh the status strip so the merge-risk light is on the PR before the proof comment exists, then `{ action: "pr" }`.

### 9. Final proof

Read `{ action: "pr", fresh: true }` first: a failing check is fixed (back through stage 5's push path) before the proof is posted; pending checks are named in the proof.

**Human look.** Decide whether the PR needs a human look: yes when the merge risk is medium or high, the acceptance confidence is under 80, or the AI review ended `changes requested`. Record it as a `note` on stage 9 (`Needs a human look: risk medium` or `No human look needed: risk low, confidence 92%, review lgtm`). The person decides who to ask; the pipeline never requests reviewers.

Post one PR comment headed "Pipeline proof". A reviewer should get the state of the PR from the badges and the first table without reading further:

```markdown
## Pipeline proof

🟢 Merge risk: low · 🟢 Confidence: 92%

![merge risk](https://img.shields.io/badge/merge%20risk-low-2ea44f) ![confidence](https://img.shields.io/badge/confidence-92%25-2ea44f) ![review](https://img.shields.io/badge/AI%20review-lgtm-2ea44f) ![acceptance](https://img.shields.io/badge/acceptance-4%2F4-2ea44f) ![e2e](https://img.shields.io/badge/e2e-2%20lanes-blue)

| Criterion | Met | Evidence |
| --- | --- | --- |
| Due date in the past is refused | ✅ | `DueDateTest::past_date_refused` |
| Error shows under the field | ✅ | ![after](./after.jpg) |

### 🟢 Merge risk: low

| Category | Verdict | Note |
| --- | --- | --- |
| Alignment | ✅ good | matches ticket, no drive-bys |
| Impact | ✅ small | one validator, one component |
| Verification | ✅ good | feature test + before/after screenshots |
| Rollback cost | ✅ low | revert the commit |
| Error detection | 👀 decent | validation errors are not logged; harmless here |

<one line per ⚠️ with the file it points at, when there are any>

### Review
LGTM, 0 findings. Description matches the diff (92%). Reviewed by <backend> <model> at <effort> effort.

### E2E
<artifact link or screenshots>, lanes driven: <list>. Decided by the e2e decision agent (sonnet, low effort): <reason>.
(or, skipped: Skipped: <reason>. Decided by the e2e decision agent (sonnet, low effort).)
(append when you overrode it: ; overridden by the conductor: <why>)

<last line, from the human-look decision>
```

The last line is either `Risk medium · confidence 74% · needs a human look at <the area that raised the risk>.` or exactly `Risk low · confidence 92% · merge from the pane when checks are green.`

Badge colours: low/lgtm/all-met `2ea44f`, medium/partial `dbab09`, high/changes-requested/gaps `d73a4a`, counts `blue`. A skipped e2e gets a grey badge with the text `e2e-skipped`: `![e2e](https://img.shields.io/badge/e2e-skipped-9f9f9f)`. The confidence badge is the same number the status strip shows, coloured by the same thresholds. Attach screenshots with `gh pr comment <n> --body-file proof.md --attach ./after.jpg` run from `<criteriaDir>/e2e/` with relative paths, so the inline references rewrite. Refresh the status strip last, so the body, the proof comment and the pane agree. Swap labels to `aiVerified` and `readyToMerge` (a high merge risk keeps `stateReview` instead of `readyToMerge` and the comment says why).

Post a short proof summary to the ticket where the tracker has comments (jira, github, linear): PR number and link, merge risk, confidence, acceptance `met/total`, review verdict, and whether it needs a human look. Text tracker: write it to `<criteriaDir>/proof.md`. Link the PR comment and the ticket comment to the stage, `{ action: "pr" }`, mark the stage `done` with summary `ready to merge · risk low` (or `ready for review · risk medium`).

Then one short message to the person: PR #n, merge risk, confidence, whether it needs a human look and why (or `Merge from the pane when checks are green.`), what a reviewer should focus on, anything flagged. The pane's Pull request card has the checks and the Merge button.

## Starting from an open PR

A `(tracker: pr, url: …)` hint, or a PR number or URL as the argument, picks up an existing PR. Read it with `gh pr view <n> --json number,title,body,headRefName,baseRefName,url` and check out its branch. Find the ticket from the body's link line (a tracker key, `Closes #n`, a ticket URL); fetch it through its tracker, or use the PR body as a text ticket when there is none. `start` the run with the ticket's tracker (or `pr` when there is no ticket), the PR URL as `prUrl`, and `repo`. Stage 1 runs as usual. Stages 2 and 3 are `skipped` with summary `PR #n already open`, unless the acceptance check later finds a gap. Continue from stage 4.
