# Review, address, proof

Assert:

- The review skill ran the claude backend through `subagent_type: "pr-pipeline:reviewer"`; review heading is `## AI review · LGTM 👍` or `## AI review · Changes requested`; the footer reads `Reviewed by claude sonnet at medium effort`.
- When the review has findings, stage 5 reads threads from `{ action: "pr", fresh: true }`, replies with `pr-reply` (body names the fix commit SHA) and resolves with `pr-resolve`. No `gh api …/comments` reply call and no browser.
- When the review was `lgtm` with no findings, stage 5 is `skipped`.
- Stage 9 reads `{ action: "pr", fresh: true }` before posting the proof.
- With risk low, confidence 100 and review lgtm: no `gh pr edit --add-reviewer`; the proof comment's last line is exactly `Risk low · confidence 100% · no reviewer requested; merge from the pane when checks are green.`; the stage-9 `note` records "no reviewer requested" with the reasons; the closing message says the same.
- Proof summary posted to the issue with `gh issue comment 42` and linked on stage 9.
- Labels at stage 9: `ready to merge` added, `needs review` removed; no `ai: verified` attempt.
