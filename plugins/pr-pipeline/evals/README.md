# Evals

Scaffolding for three end-to-end runs of `pr-pipeline:run`. Each directory holds the prompt the run starts from (`prompt.md`, including the fixture it assumes) and graders (`graders/*.md`) that say what to assert from the transcript and the recorded tool calls. The sandbox repos are not built here.

Every grader reads the `mcp__pr-pipeline__pipeline` calls in order. Shared assertions, checked in every eval:

- Every `stage` call with `status: "running"` carries `backend`, `model` and `effort`.
- No message to the person, PR body, PR comment or ticket comment tells them to open GitHub, the PR page or the ticket in a browser.
- Every stage that wrote to the PR (3, 4, 5, 7, 8, 9) is followed by a `link` call and `{ action: "pr" }` before the next stage starts.
- Stage 9 has a `note` recording the reviewer gate decision.
- Stage 6 opens with the e2e decision agent (sonnet, low effort); its decision is recorded on stage 6 with the reason and the decider's model fields.
- The closing message names the PR as `#<n>` and points at the pane.
