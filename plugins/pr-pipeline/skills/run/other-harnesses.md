# Running in another harness

The run, review and risk skills are written for Claude Code, where a pane records the run and a tool (`mcp__pr-pipeline__pipeline`) feeds it. In Codex, OpenCode or any other agent that can read files and run `git` and `gh`, the nine stages, the spec, the review rules, the PR body and the proof are the same. Only the plumbing differs: there is no pane, so the record lives in a file, and each tool call becomes a file write or a `gh` command.

Read this once at the start, then follow the skills as written with the substitutions below. Where a skill names another skill (`pr-pipeline:review`, `pr-pipeline:risk`), read that skill's `SKILL.md` in the sibling directory (`../review/`, `../risk/`). When a skill directory is a symlink, resolve its real path first, so `../` and `agents/reviewer.md` (two directories up) are found.

## The run record

Keep `<criteriaDir>/run.md`; it stands in for the pane. Write to it at every moment the Recording table names, as it happens:

```markdown
# ABC-123 · Refuse a due date in the past
run: acme/orders#fix/abc-123-past-due-date · tracker jira · tier S · started 2026-03-02 10:14

## 1 enhance · done · criteria explicit · 100%
- note: Class: quick-fix · cost cheap · one validator, one test
- link: Pipeline spec https://…

## 4 review · done · lgtm · 4/5 · 2 findings · head 3f9c2ab
- ran: codex · gpt-5-codex · high
- did: src/orders/total.ts:42 · medium · null customer
- flag: Review fell back to …
```

One heading per stage attempt (`## 4 review (2)` for the second), with status, summary and confidence on the heading line; `did`, `flag`, `note`, `link` and `criterion` lines under it. `review`, `acceptance` and `proof` marked done carry `head <sha>` from `git rev-parse --short HEAD`: that is the `headSha` the delta review and the stale-proof rule read. The run key is `owner/repo#branch`.

## Substitutions

| The skills say | Here |
| --- | --- |
| `{ action: "start" }`, `stage`, `link`, `unlink`, `close` | Write the line to `run.md`. |
| `{ action: "status" }` | Read `run.md`. |
| `{ action: "profile" }` | Read `.pr-pipeline.json`, else `.claude/pr-pipeline.json`. Without one, discover: `gh repo view --json nameWithOwner,defaultBranchRef`, `gh label list`, the lint and test commands in the build files, the rule files that exist (`AGENTS.md`, `CLAUDE.md`, `.ai/rules/index.md`). Fill the rest from the defaults in the plugin's `profiles/pr-pipeline.schema.json`. `criteriaDir` defaults to `~/.claude/pipeline/{owner}-{repo}/{ticket}`; create it. Offer to save a discovered profile in the stage-1 question. |
| `{ action: "settings" }` | There are no plugin settings. The reviewer is a fresh run of this harness (below) unless the person names another; tracker `auto`; merge method `squash`. Find other CLIs with `command -v`. |
| `{ action: "pr" }` | `gh pr view <n> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid`. Threads: the GraphQL query below. |
| `pr-reply`, `pr-resolve` | The two GraphQL mutations below. |
| ToolSearch, "the tool is deferred" | Nothing to load. |
| `AskUserQuestion` | Ask in chat, one message, the same items in the same order, once. In a non-interactive run take the defaults and note them. |
| Agent tool, `start_session`, "session" or "subagent" in the routing table | The harness's own subagent when it has one; else a fresh non-interactive run of its CLI with the brief as the prompt (`codex exec`, `opencode run`); else this session. The brief is the same either way. |
| Models `haiku`, `sonnet`, `opus` and an effort | The harness's small, default and strongest model, at the nearest effort it has. Record what ran on the stage's `ran:` line. |
| The claude review backend | See "Review" below. |
| `subagent_type: "pr-pipeline:checker"` (the review's verifier, stage 7's acceptance check) | A fresh process with the prompt file and the rules from `agents/checker.md`, as the reviewer runs. Never this session. |
| Stages 4 and 6b started together | In the background when the harness can run a second process; otherwise stage 4, then 6b. |
| The spec check | Ask in chat with the rest of the stage-1 question. |
| Browser-pane smoke from `.claude/launch.json` | The profile's `e2e` skill or command when there is one; else the harness's own browser tool; else stage 6 is `skipped` with the reason, flagged when a criterion needs the running stack. |
| "points at the pane", "never tell the person to open the PR page" | The closing message gives the PR number and URL and the path of `run.md`. |
| The Merge button, Fix CI, Sync with base | The person merges. Failing checks and a base that moved are handled as the skill says, with `gh`. |

```bash
# unresolved threads
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body url}}}}}}}' -f o=<owner> -f r=<repo> -F n=<n>
# reply
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}' -f t=<threadId> -f b='Fixed in 3f9c2ab.'
# resolve
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=<threadId>
```

## Review

The rule that matters most carries over unchanged: the session that wrote the code does not review it. The reviewer, the security pass and the verifier each run in a fresh process that sees only the prompt file.

- Default backend: this harness's own CLI, non-interactive and read-only where it can be, with `<criteriaDir>/review-prompt.md` as the whole prompt, the reviewer rules from `agents/reviewer.md` included as section 1 and the diff as section 7. For Codex and OpenCode the commands are the ones in the review skill's backend table.
- A second harness installed (`claude`, `codex`, `opencode`): offer it in the stage-1 question. A reviewer from a different model family than the implementer catches more. `claude` here is `claude -p --model <model> --permission-mode plan < <criteriaDir>/review-prompt.md`.
- Where the review skill says "fall back to claude", fall back to this harness's default backend, and flag it the same way.
- A harness with no way to start a fresh process reviews in this session, reading only the prompt file and the code, and records `flag: "Review ran in the implementing session; get a second look"`.

## What does not carry over

No live view, no stalled-run warning, no stale-review button: read `run.md`. Nothing closes the run when the PR merges. Linked sessions with their own worktree become plain subprocesses in this checkout, so run one stage at a time.
