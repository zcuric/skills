# Setup at stage 1

Assert:

- `start` carries `tracker: "github"`, `ticket` naming issue 42, `ticketUrl` `https://github.com/acme/widgets/issues/42`, `repo: "acme/widgets"`.
- Discovery ran: `gh repo view`, `gh label list`. A stage-1 `note` records what was discovered (base `main`, squash, labels matched). CODEOWNERS is not used.
- Label map: `typeBug` = `bug`, `typeFeature` = `enhancement`, `stateReview` = `needs review`, `readyToMerge` = `ready to merge`; the three `ai*` keys and `needsWork` stay null. No `gh label create` anywhere in the run.
- `lint` resolves to `pnpm lint` (or `pnpm run lint`), `test` to `pnpm test`.
- The profile offer "Save these conventions as .pr-pipeline.json?" appears exactly once, inside the single stage-1 question. No `.pr-pipeline.json` is written after "This run only".
- `{ action: "settings" }` is called; no backend question is asked (no other harness installed).
- Class `quick-fix`, derived `tier: "S"`, class recorded in a `note` with cost `cheap`.
- Criteria file at `~/.claude/pipeline/acme-widgets/issue-42/acceptance.md`, two unchecked criteria, none marked `(derived)`.
- The spec is posted with `gh issue comment 42 --body-file …` and linked on stage 1.
