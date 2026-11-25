# Stage 9: final proof

Read `{ action: "pr", fresh: true }` first: a failing check is handled as `ci.md` says before the proof is posted; pending checks are named under Not verified.

**Human look.** Yes when the merge risk is medium or high, the acceptance confidence is under 80, the AI review ended `changes requested`, the spec check was due and nobody confirmed it, the definition gate built a proposal nobody confirmed, `changedGuarded` is not empty (call `{ action: "profile", detail: "guard" }`), stage 5 escalated a person's thread, or a check hit the three-push cap. The stage flags in `{ action: "status" }` show the definition, thread and push-cap cases. Record it as a `note` on stage 9 (`Needs a human look: risk medium` or `No human look needed: risk low, confidence 92%, review lgtm 5/5`). The person decides who to ask; the pipeline never requests reviewers.

Post one PR comment headed "Pipeline proof", holding evidence only:

```markdown
## Pipeline proof

<one line: what a human must look at and why, or `Nothing needs a human look.`>

| Criterion | Evidence |
| --- | --- |
| ✅ Due date in the past is refused | `DueDateTest::past_date_refused` |
| ⚠️ Error shows under the field | screenshot below; mobile width not driven |

Security: clean · 9 areas checked, 3 n/a

**Risks**
- Rollback: files already uploaded stay after a revert. `app/Jobs/X.php:41`

**Not verified:** <lanes or criteria not driven live; pending checks; each `notVerified` entry in `security.json`>

<at most 3 screenshots, one per visual criterion; the rest stay in the linked artifact>
```

- **Risks** prints the stage-8 bullets of the categories that are not ✅, each prefixed with its category; omit the heading when all five are ✅. **Not verified** is omitted when empty.
- The `Security:` line is copied from the latest review body as it stands.
- One test name or one live observation per row. A defect e2e found and fixed is one evidence row under its criterion.
- No badges, no emoji status line, no risk table, no Review section, no model or effort names, no finding counts outside the `Security:` line. Under 1200 characters before the screenshots.

Attach screenshots with `gh pr comment <n> --body-file proof.md --attach ./after.jpg` run from `<criteriaDir>/e2e/` with relative paths, so the inline references rewrite. Refresh the status strip last, so the body, the proof comment and the pane agree. Swap labels to `aiVerified` and `readyToMerge` (a high merge risk keeps `stateReview` instead of `readyToMerge` and the first line says why).

Post a short proof summary to the ticket where the tracker has comments: PR number and link, merge risk, confidence, acceptance `met/total`, review verdict and score (`lgtm 5/5`), and whether it needs a human look. Text tracker: write it to `<criteriaDir>/proof.md`. Link the PR comment and the ticket comment to the stage, `{ action: "pr" }`, and mark the stage `done` last, with summary `ready to merge · risk low` (or `ready for review · risk medium`). A commit after that turns the proof stale in the pane and needs the delta review, acceptance and proof again.

Then one short message to the person: PR #n, merge risk, confidence, whether it needs a human look and why (or `Merge from the pane when checks are green.`), what a reviewer should focus on, anything flagged.
