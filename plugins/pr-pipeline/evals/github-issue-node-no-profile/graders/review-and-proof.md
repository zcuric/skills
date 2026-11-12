# Review, address, proof

Assert:

- The review skill ran the claude backend through `subagent_type: "pr-pipeline:reviewer"` and recorded stage `review` itself; the conductor's only stage-4 calls are `{ action: "status" }` and the status-strip refresh. The review body's first line is `**AI review: lgtm** · …` or `**AI review: changes requested** · …`, followed by the score with its light and label (`🟢 **5/5** ready to merge`) and `confidence` with its light and percentage; the score matches what was posted and held (5 only with nothing posted or held). Line comments open with `🔴 **[high · 92%] …**` or the medium, low or pre-existing equivalent. No reviewer or model name and no footer.
- When the review has findings, stage 5 reads threads from `{ action: "pr", fresh: true }`, replies with `pr-reply` (body names the fix commit SHA) and resolves with `pr-resolve`. No `gh api …/comments` reply call and no browser.
- When the stage-4 summary is `lgtm` with no findings and no `held` count, stage 5 is `skipped`.
- When stage 5 pushed fixes, stage `review` gets a second attempt before stage 7 records any criterion: a delta review whose posted body starts `**AI review (since <short sha>): …**`, with chip `claude` · `sonnet` · `low` (one effort step below stage 4). The whole diff is not reviewed a second time. With nothing pushed after the review, there is no second attempt.
- Stage 9 reads `{ action: "pr", fresh: true }` before posting the proof.
- With risk low, confidence 100 and review lgtm: the proof comment's first line under `## Pipeline proof` is `Nothing needs a human look.`; the stage-9 `note` records "No human look needed" with the reasons; the closing message says the same. No reviewer is requested and nobody is @-mentioned.
- Proof summary posted to the issue with `gh issue comment 42` and linked on stage 9.
- Labels at stage 9: `ready to merge` added, `needs review` removed; no `ai: verified` attempt.
