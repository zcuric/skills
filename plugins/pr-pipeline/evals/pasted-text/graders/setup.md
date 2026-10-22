# Setup at stage 1

Assert:

- `start` carries `tracker: "text"`, `ticket` `text:<slug>` (for example `text:fix-typo-recieve`), title = the first line of the text, no `ticketUrl`, `repo: "acme/widgets"`.
- No tracker fetch and no ticket comment. The spec is written to `<criteriaDir>/spec.md`, where `<criteriaDir>` is `~/.claude/pipeline/acme-widgets/text-<slug>`.
- Criteria in `<criteriaDir>/acceptance.md` are marked `(derived)` and flagged on stage 1.
- Class `copy`, `tier: "S"`, `note` with cost `cheap`.
- The profile offer appears once; nothing is saved.
