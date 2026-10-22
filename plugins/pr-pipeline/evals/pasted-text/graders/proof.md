# Proof

Assert:

- No tracker comment at stage 9; the proof summary is written to `<criteriaDir>/proof.md` instead.
- With risk low and confidence 80 or more and review lgtm: no reviewer requested, the proof's last line is the "no reviewer requested; merge from the pane when checks are green." line, and the stage-9 `note` says so.
- Stage 5 uses `pr-reply` / `pr-resolve` if any thread exists, else is `skipped`.
- The closing message names `#<n>`, the risk and the confidence, and points at the pane.
