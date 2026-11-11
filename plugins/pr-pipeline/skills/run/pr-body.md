# PR body

The body stage 3 writes. With `prBody: "visual-pr"` it is for a reader who skims, so it shows the change rather than narrating it:

```markdown
<linkLine, expanded; omit the line when there is none>

<!-- pipeline-status -->
⚪ Merge risk: pending · Review: pending · Acceptance: 0/4 · e2e: pending
<!-- /pipeline-status -->

## Summary
<one sentence: why this change, in the ticket's words>

## Details
<At most 3 bullets, each under 200 characters: only what would change a reviewer's decision (a product call, a one-way door, a paired PR to ship with). How it was implemented, what e2e found, and anything the outline shows do not belong here. Omit the section when there are none.>

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
| A flow with a decision, a skip or a failure path | a `mermaid` `flowchart TD`, 4–10 nodes named as steps in plain domain words, `{question?}` nodes with labelled `Yes`/`No` edges |

One view, under 25 lines, and the only diagram in the body. It shows what the changed code does when it runs, so a reader who skips the diff learns the behaviour: never draw the pipeline, the review, or a map of which files changed. Keep the body under 1000 characters of prose; the views do not count. With `prBody: "plain"`: link line, the status strip, Summary and Test plan only.
