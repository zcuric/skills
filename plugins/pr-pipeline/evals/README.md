# Evals

Scaffolding for three end-to-end runs of `pr-pipeline:run`. Each directory holds the prompt the run starts from (`prompt.md`, including the fixture it assumes) and graders (`graders/*.md`) that say what to assert from the transcript and the recorded tool calls. The sandbox repos are not built here.

Every grader reads the `mcp__pr-pipeline__pipeline` calls in order. Shared assertions, checked in every eval:

- Every routed stage's `running` call (2, 4, 7, 8, and 6 when it runs) carries `backend`, `model` and `effort`; stages this session runs itself may omit them.
- Every brief to a linked session or subagent includes the run key `start` returned, and its tool calls pass that key as `branch`.
- Stage 1 resolves the repo profile through `{ action: "profile" }`; the run's `criteriaDir` in `{ action: "status" }` is an absolute path and every file the run writes under `<criteriaDir>` lands there.
- Stage `review` is recorded only by the review skill, once per review (a delta review is a new attempt); the conductor makes no `stage` call on `review` of its own and reads the verdict back with `{ action: "status" }`.
- Commits pushed after the stage-4 review are covered by one delta review (a new `review` attempt, body `**AI review (since <short sha>): …**`) before stage 7; a `changes requested` there ends the run `failed`. No second full review of the whole diff.
- No message to the person, PR body, PR comment or ticket comment tells them to open GitHub, the PR page or the ticket in a browser.
- Every stage that wrote to the PR (3, 4, 5, 7, 8, 9) is followed by a `link` call and `{ action: "pr" }` before the next stage starts.
- Stage 9 has a `note` recording the reviewer gate decision.
- The spec check (`Spec: Build it / Stop here`) is in the stage-1 question only for a cost-high class, or a cost-mid class with a derived criterion or a behaviour-changing assumption; a cheap class is never asked.
- When e2e runs, its first pass makes no commit and no push: the head when 6b reports is the head the stage-4 review judged. Stage 5 does not start before both have reported, and e2e defects are fixed in a later `verify` attempt, not in stage 5.
- Stage 7's verdicts come from one `pr-pipeline:checker` Agent call whose prompt holds the criteria and the evidence; every `criterion` call carries the checker's `met` unchanged, or a `flag` says why the conductor disagrees.
- Stage 6 opens with the e2e decision, made by the conductor with no Agent call and before the stage-4 review starts: a skip is one `skipped` call with `summary: "Skipped: <reason>"` and no model fields; a run puts `note: "E2E: run · <reason>"` on the `running` call.
- After stage 5 no AI review thread is unresolved, and every stage-5 `did` for a finding ends with its outcome (`· fixed`, `· rejected: wrong`, `· rejected: intentional`, `· left: pre-existing`).
- A PR never gets a fourth AI review: with three `**AI review` reviews posted, the next attempt records the round-cap `flag` and closes `review` as `failed`.
- The closing message names the PR as `#<n>` and points at the pane.
