# Starting from an open PR

A `(tracker: pr, url: …)` hint, or a PR number or URL as the argument, picks up an existing PR.

1. Read it with `gh pr view <n> --json number,title,body,headRefName,baseRefName,url` and check out its branch.
2. Find the ticket from the body's link line (a tracker key, `Closes #n`, a ticket URL) and fetch it through its tracker (`trackers.md`). With no ticket, use the PR body as a text ticket.
3. `start` the run with the ticket's tracker (or `pr` when there is no ticket), the PR URL as `prUrl`, and `repo`; then `{ action: "profile" }` as usual.
4. Stage 1 runs as usual. Stages 2 and 3 are `skipped` with summary `PR #n already open`, unless the acceptance check later finds a gap. Continue from stage 4.
