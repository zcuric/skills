# Trackers

How stage 1 picks the tracker and fetches the ticket, and how stages 3 and 9 name, link and comment on it.

## Detection

Detect the tracker in this order: the `(tracker: …)` hint in the prompt (`/pipeline` has already applied the plugin setting `tracker` to it) > the MCP tools present for the key's shape > `gh issue view <n>` succeeds > text. A bare `KEY-n` with both the Jira and the Linear tools present goes into the stage-1 question. MCP tools may be deferred: load them with `ToolSearch` before deciding they are absent.

The profile's `tracker`, when not `auto`, wins over all of these. The profile comes back only after `start`, so when it names a different tracker, fetch the ticket through that one and call `start` again with the same `ticket` and the corrected `tracker` (the run is updated, not replaced), then `{ action: "profile" }` again so the per-tracker defaults follow.

## Adapters

| Tracker | Fetch | Comment (spec at stage 1, proof at stage 9) | Key | Title prefix | Link line | Branch key |
| --- | --- | --- | --- | --- | --- | --- |
| jira | Atlassian MCP `getJiraIssue`; the browse URL comes from the issue's own host (`https://<site>/browse/<KEY>`), never a fixed site | `addCommentToJiraIssue` | `[A-Z][A-Z0-9]+-\d+` | `[KEY]` | `[KEY](url)` | key lowercased |
| github | `gh issue view <n> --json title,body,comments,labels,url` (`--repo owner/name` when the issue lives elsewhere) | `gh issue comment <n> --body-file <file>` | `#n`, `owner/repo#n`, or an `/issues/n` URL | none | `Closes #n` (`Closes owner/repo#n` across repos) | `issue-n` |
| linear | Linear MCP `get_issue` when present, else `linear issue view <KEY> --json`; neither → stage 1 fails with the reason | `create_comment`, else `linear issue comment add` | `[A-Z][A-Z0-9]+-\d+` | `[KEY]` | `[KEY](url)` | key lowercased |
| text | the pasted text is the ticket; the title is its first line | none; the spec lives in `<criteriaDir>/spec.md` | ticket `text:<slug>` | none | none | none (the branch is `{type}/{slug}`) |

The profile's `titlePrefix` and `linkLine` win over the title-prefix and link-line columns; an empty string means none. A `(tracker: pr, url: …)` hint means an open PR: read `open-pr.md` from this skill's directory.
