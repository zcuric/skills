# Setup at stage 1

Assert:

- `start` carries `tracker: "github"`, `ticket` naming issue 42, `ticketUrl` `https://github.com/acme/widgets/issues/42`, `repo: "acme/widgets"`.
- `{ action: "profile" }` returns `source: "discovered"`, and its `discovered` line is recorded as a stage-1 `note` (base `main`, squash, labels matched). CODEOWNERS is not used.
- The resolved profile's label map: `typeBug` = `bug`, `typeFeature` = `enhancement`, `stateReview` = `needs review`, `readyToMerge` = `ready to merge`; the three `ai*` keys and `needsWork` stay null. No `gh label create` anywhere in the run.
- In the resolved profile, `lint` is `pnpm lint` (or `pnpm run lint`), `test` to `pnpm test`.
- The profile offer "Save these conventions as .pr-pipeline.json?" appears exactly once, inside the single stage-1 question. After "This run only", `{ action: "profile", save: true }` is never called and no `.pr-pipeline.json` exists at the repo root.
- `{ action: "settings" }` is called; no backend question is asked (no other harness installed).
- Class `quick-fix`, derived `tier: "S"`, class recorded in a `note` with cost `cheap`.
- Criteria file at `~/.claude/pipeline/acme-widgets/issue-42/acceptance.md` (the absolute `criteriaDir` the profile action returned, `~` expanded), two unchecked criteria, none marked `(derived)`.
- The spec is posted with `gh issue comment 42 --body-file …` and linked on stage 1.
