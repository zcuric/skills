# Proof

Assert:

- No tracker comment at stage 9; the proof summary is written to `<criteriaDir>/proof.md` instead.
- With risk low and confidence 80 or more and review lgtm: the proof's last line is the "merge from the pane when checks are green." line, the stage-9 `note` says no human look is needed, and no reviewer is requested or @-mentioned.
- Stage 5 uses `pr-reply` / `pr-resolve` if any thread exists, else is `skipped`.
- The closing message names `#<n>`, the risk and the confidence, and points at the pane.
