---
name: review
description: Review an open PR with an AI reviewer (claude by default, codex or opencode when chosen) and post one GitHub review with a one-line verdict and a line comment per confirmed defect, then swap the ai review label. Use for "AI review this PR", "post an AI review on PR n", or as stage 4 of the PR pipeline.
---

# AI PR review

One GitHub review per run: a one- or two-line body plus one comment per finding, pinned to the exact line. The author cannot approve their own PR, so the verdict is a `COMMENT` review and a label, never `APPROVE`; people approve.

## Inputs

From the pipeline: the run key, the PR number, `<criteriaDir>`, the class, the backend, the model and the effort; pass the run key as `branch` on every `mcp__pr-pipeline__pipeline` call. Standalone (`/pr-pipeline:review <n>`): when a pipeline run exists for the branch, `{ action: "profile" }` returns the resolved profile and `criteriaDir`; otherwise read `.pr-pipeline.json`, then `.claude/pr-pipeline.json`, else defaults. Take the backend, model and effort from `{ action: "settings" }` (`reviewer`, `review_model`, `review_effort`), and treat the PR as the feature class unless the diff shows a sensitive signal (auth, permissions, money, PII, migrations, contracts, infra, secrets, dependency bumps).

**Delta mode.** `since <sha>` (from the pipeline before stage 7, or from the pane's stale-review button) reviews only `git diff <sha>..HEAD`: that diff, its files and `<sha>` as the base SHA stand in for the full diff, the changed file list and `$BASE` everywhere below. Everything else runs the same: one posted review, the label swap, and stage `review` recorded again through a new `running` call, which the tool turns into the next attempt.

## Gather

```bash
gh pr view <n> --json number,title,body,headRefName,baseRefName,url,files,author
gh pr diff <n>
BASE=$(git merge-base HEAD origin/<base>)
```

Read the acceptance criteria from `<criteriaDir>/acceptance.md`. When it is missing, find the ticket from the PR body's link line, fetch it through its tracker and extract the criteria now; with no ticket, use the PR body's stated intent and mark every criterion `(derived)`.

## The prompt file

Write `<criteriaDir>/review-prompt.md`, the one input every backend reads:

1. The rules and the JSON contract from the plugin's `agents/reviewer.md` (two directories up from this skill's directory), verbatim: everything after its front matter.
2. Branch, base SHA, PR title and body.
3. The acceptance criteria.
4. The changed file list.
5. The repo rule files to respect: the profile's `rules`.
6. For CLI backends (codex, opencode) only: the full diff (`git diff $BASE...HEAD`) in a `diff` block. A diff over 200 KB is cut to the file list with a note in the prompt that the reviewer must read the files itself.

## Backends

Every backend answers with the same JSON: the contract in `agents/reviewer.md` (`verdict`, `description_confidence`, `description_note`, `acceptance[]`, `findings[]`).

| Backend | How it runs | Models | Effort |
| --- | --- | --- | --- |
| claude | Agent tool, `subagent_type: "pr-pipeline:reviewer"`, `model` and `effort` from routing or settings, prompt = the prompt file's sections 2–5 (the agent already carries the rules) | `settings.claudeModels` | `low` … `max` |
| codex | `codex exec --model <m> --sandbox read-only -c model_reasoning_effort="<low\|medium\|high>" -o <criteriaDir>/review-codex.json - < <criteriaDir>/review-prompt.md`, run from the repo root | the codex config default, `gpt-5-codex`, `gpt-5`, `o3`, or free text | `xhigh` and `max` map to `high`; record a `note` when they do |
| opencode | `opencode run --model <provider/model> "$(cat <criteriaDir>/review-prompt.md)" > <criteriaDir>/review-opencode.txt`, run from the repo root | `opencode models` lists them | ignored; record a `note` |

opencode has no read-only sandbox. Run `git status --porcelain` before and after; on any difference, restore the tracked files it changed (`git restore <paths>`), `trash` the untracked files it created, and record a `flag: "opencode changed files during review; reverted"`.

### Choosing the backend

- `settings.reviewer` is `codex` or `opencode`: use it.
- Neither `settings.harnesses.codex` nor `settings.harnesses.opencode` is set: claude, silently.
- Otherwise the run skill's stage-1 question has already asked once and saved the answer through `{ action: "settings", set: { reviewer, review_model, review_effort } }`; standalone, use the settings as they are.

The model and effort come from the pipeline's routing for claude; for codex and opencode they come from `review_model` and `review_effort`.

### Parsing and fallback

Take the last balanced `{…}` in the output after stripping code fences, and parse it as JSON. A reply that does not parse or misses `verdict` is re-asked once with "Answer with the JSON object only." (claude: a follow-up to the same agent; codex and opencode: the same command again). Fall back to claude at the routed model and effort (standalone: `opus`, `low`) when the reply is still invalid, the binary is missing, the command exits non-zero, or the output is empty, and record `flag: "Review fell back to claude/<model>: <reason>"`. Keep `review-codex.json` or `review-opencode.txt` next to the prompt for the record.

### Security pass

For the sensitive class (and standalone when a sensitive signal is in the diff), add a second pass:

- backend claude and the profile names a `securityAgent`: spawn that agent with the prompt file's sections 2–5 plus "Report only security findings, as JSON in the `findings` shape of the contract above."
- otherwise: run the same backend again with `security-prompt.md` from this skill's directory appended to the prompt file (write it as `<criteriaDir>/review-prompt-security.md`).

Merge the security findings into the main ones by `path:line`: on a collision keep one finding with the higher severity and confidence. A high security finding sets the verdict to `changes_requested`.

## Verify

Check each finding yourself before posting: open the file at the line. Drop a finding whose line is not part of the diff or whose claim the code does not support. Keep the reviewer's confidence where you agree; lower it when you half agree.

Post a line comment only when all of these hold:

- Its confidence after your check is 60 or more.
- It is a defect: wrong behaviour, data exposure or loss, a broken contract, a test that cannot fail. Style, naming, comment length and "consider" are not posted.
- The ticket, the criteria or the PR body does not already answer it. An open question goes in the body as one `Question:` line.
- It is the only thread for its root cause. A security-pass duplicate merges into it silently.

Verified defects under 60 are not dropped: write them to `<criteriaDir>/review-held.json` in the `findings` shape, and stage 5 fixes them without a thread. Standalone, name them in the closing message.

## Post

Write `<criteriaDir>/review.json`:

```json
{
  "event": "COMMENT",
  "body": "<body markdown>",
  "comments": [
    { "path": "src/orders/total.ts", "line": 42, "side": "RIGHT", "body": "<line comment markdown>" }
  ]
}
```

```bash
gh api repos/{owner}/{repo}/pulls/<n>/reviews --input <criteriaDir>/review.json
```

### Line comment

````markdown
**[high] Archived clients still get the unmasked files**

If the client is archived between submit and the job, both files with full SSNs reach their portal: the upload's archive check reads the relation the sheet loaded `withInactive()`.

Check the taxpayer is active with a fresh query before building either file.
````

Line 1 is the severity in brackets plus the consequence a user or operator would see, not the mechanism. Then at most two sentences on when it happens and why, naming one or two identifiers. Then the fix in one sentence, or a `suggestion` block when the reviewer gave replacement code that compiles in place. 80 words at most outside the suggestion. No badges, no confidence number, no provenance tags ("security pass agrees"), no praise, no restating what the line does.

### Body

````markdown
**AI review: changes requested** · 1 high, 2 medium
Description: the body says guests get the discount; the diff skips them.
Question: Should an archived client still see files shared before the archive?
````

- Line 1 is the verdict and the posted findings counted by severity; in delta mode it reads `**AI review (since abc1234): lgtm** · …` with the short SHA. With no findings and a truthful description the whole body is `**AI review: lgtm** · no findings`.
- `Description:` only when `description_confidence` is under 80: what the body says against what the diff does, in one sentence.
- `Question:` one line per open question the ticket, the criteria and the PR body do not answer.
- Nothing else: no badges, no tables, no reviewer or model name, no footer. The reviewer's `acceptance` verdicts are not posted; stage 7 records the criteria and the proof shows them.

#### How the change runs

Only when the PR body has no `mermaid` diagram of its own (a PR the pipeline did not write), append the reviewer's reading of what the changed code does at runtime, so a reader who skips the diff still learns the behaviour:

````markdown
<details open><summary><b>How the change runs</b></summary>

```mermaid
flowchart TD
  A[Guest submits checkout] --> B[Create order]
  B --> C{Customer attached?}
  C -->|Yes| D[Apply customer discount]
  C -->|No| E["Read order.customer.discount ⚠️"]
  D --> F[Compute total]
  E --> F
```

</details>
````

- Top-down, 4–10 nodes, each a step in plain domain words (`Queue filing after commit`, not `FileJob.php`). Name a function only when the reader needs it to find the code.
- Every decision the diff adds or changes is a `{question?}` node with labelled `Yes`/`No` edges, including skip, retry and failure paths.
- Mark the node a posted finding lands on with `⚠️`.
- Never draw the review, the pipeline, the diff or a list of files. Omit the block when the change has no flow of three or more steps.

## Label and record

Swap the labels from the profile map; a `null` key is skipped:

```bash
gh pr edit <n> --remove-label "<labels.aiChangesRequested>" --add-label "<labels.aiLgtm>"   # or the reverse
```

Record with `mcp__pr-pipeline__pipeline` on stage `review`: the `running` call carries `backend`, `model` and `effort`; the closing call has status `done`, summary `lgtm · 3 findings` or `changes requested · 1 high` (keep the literal phrase `changes requested`; the pane keys on it), ending `· held n` when findings went to `review-held.json` (`lgtm · 2 findings · held 1`), confidence = `description_confidence`, one `did` per posted finding (`src/orders/total.ts:42 · high · null customer`), a `note` per reviewer acceptance verdict that is `false` or `partial` and per finding held for stage 5, a `flag` per finding dropped as unverifiable and per fallback, and a `link` to the review URL the API returned (`html_url`). End with `{ action: "pr" }` so the pane's Threads card shows the new comments. Standalone with no pipeline run for the branch, skip recording: the tool refuses stage calls without a run.
