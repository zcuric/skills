# Stage 5: address

Start once the review is posted and 6b has reported; its result arrives as a notification, so do not poll for it. Defects e2e found are not fixed here: they go back to the e2e run in 6c, after this stage's push.

Read the threads with `{ action: "pr", fresh: true, detail: "threads" }`: every unresolved thread, with its comments.

## AI threads

For each: fix it, commit, push, then `{ action: "pr-reply", threadId, body, resolve: true }`. No AI thread stays open: each ends fixed, or resolved with a reason.

- A finding with an `Also at` line is fixed at every place it names.
- A finding listed in `<criteriaDir>/security.json` is fixed with a test that fails without the fix: the finding's `attack` as a test, in which its actor is refused.
- The reply body is `Fixed in <sha>.`, plus one sentence only when the fix differs from what the comment asked; no test names, no restating the diff.
- When you disagree, reply with the reason in one sentence, resolve the thread and record a `flag`, so a person sees a finding was turned down.
- A pre-existing finding (`⚪ **[pre-existing · …]**`) is fixed when the fix is a few lines in a file the PR already changes; otherwise reply `Pre-existing; not changed in this PR.`, resolve, and record a `note` a person can turn into a ticket.
- A finding that a line in the repo's rule files or `REVIEW.md`, or a lint rule, would have prevented gets a `note`: `Prevent at source: <the rule> in <file>`. Do not edit those files in this PR.

Fix the held findings in `<criteriaDir>/review-held.json` too, without a thread.

## A person's threads

A thread from a person is not an AI finding, and the pipeline never resolves it.

- Fix it when the fix is small and inside the spec (a bug, a missed case, a rename, a missing test): reply `Fixed in <sha>.` without `resolve`, so the thread stays open for its author.
- Escalate it instead, with no code change, when it asks for a redesign or a new API, widens the scope past the spec, is a design question between people, needs a guarded path, or reports a security issue you cannot close with a test that proves the fix; also when you disagree with it. An escalated thread gets a one-sentence reply (`Left for a person: <reason>.`), stays open, and gets a `flag`; any one makes stage 9's human look yes.
- A person's thread whose last comment is one of those two replies is answered: on a later pass skip it, with no new fix, reply or `did`, until its author writes again.

## Recording and closing

Each thread and each held finding is one `did` that ends with what happened, since this is how the reviewer's noise gets measured: `src/orders/total.ts:42 · fixed`, `· rejected: wrong`, `· rejected: intentional`, `· left: pre-existing`. Collect them and send them as one `did` list on the closing call, with the notes and flags; the stage summary counts them (`4 fixed · 1 rejected`).

Run `lint` and the touched tests before the push. End with `{ action: "pr", fresh: true }`; a failing check or a base that moved is handled as `ci.md` says.

When the review's summary is `lgtm` with no findings and no `held` count (and `review-held.json` is absent or empty) and no person's thread is waiting for an answer, mark this stage `skipped`.
