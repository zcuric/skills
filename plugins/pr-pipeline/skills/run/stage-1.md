# Stage 1: enhance

Stage 1 settles everything the later stages read: the tracker, the repo profile, the review backend, the task class and its routing, and whether the ticket is defined enough to build. Then it asks the person one question, once, and never again. Settle the setup below in the order the Steps at the end give.

**Tracker.** Read `trackers.md` from this skill's directory at stage 1, every run: it has the detection order, how to fetch the ticket, and the key, title prefix, link line, branch key and comment command per tracker that stages 2, 3 and 9 use.

### Repo profile

Call `{ action: "profile" }` right after `start`. It returns `{ source, path?, fromBase?, discovered?, base?, baseRef?, changedGuarded?, newGuarded?, profile, criteriaDir }`; `base` is the base branch of the run's PR once it has one (a stacked PR's parent), else the repo's default branch (`$BASE` below; fall back to `main`): the profile from `.pr-pipeline.json` or `.claude/pr-pipeline.json`, or discovered from the repo when neither exists, with every default filled, and `criteriaDir` as an absolute path the tool has already created. Use `profile` and that `criteriaDir` (`<criteriaDir>` below) everywhere. With `source: "discovered"`, record the `discovered` line as a stage-1 `note` and offer the save in the stage-1 question; on Save call `{ action: "profile", save: true }`, which writes `.pr-pipeline.json` untracked (commits add named paths only, so it never enters one).

### Review backend

Call `{ action: "settings" }`. It returns `reviewer`, `review_model`, `review_effort`, `review_command`, `tracker`, `merge_method`, `harnesses` (`gh`, `codex`, `opencode`: a path or `null`), `claudeModels` and `efforts`. `gh` missing fails stage 1: every later stage needs it.

- `reviewer` is `codex`, `opencode` or `custom` (any other agent CLI, run through `review_command`): use it with `review_model` and `review_effort`. The binary missing is handled by the review skill's fallback.
- `reviewer` is `claude` and neither `harnesses.codex` nor `harnesses.opencode` is set: claude, silently; the model and effort come from routing.
- `reviewer` is `claude`, another harness is installed and `~/.claude/pipeline/reviewer-asked` does not exist: put the backend in the stage-1 question as one choice of `<backend> · <model>`: claude with the routed model, codex with `review_model` when it is a codex model else `gpt-5-codex` (also `gpt-5`, `o3`), opencode with the first model `opencode models` lists; free text through Other. Save the answer with `{ action: "settings", set: { reviewer, review_model, review_effort } }`, create the `reviewer-asked` file, and record a `note`. A claude answer keeps routing in charge of the model.

### Task class and model routing

Classify the ticket into one class. Check `sensitive` first: any one signal makes it sensitive, whatever the size.

| Class | Signals | Cost |
| --- | --- | --- |
| sensitive | authentication, permissions or roles, money or billing arithmetic, PII, data migrations, cross-system contracts (a profile sibling with `contracts: true`), infrastructure or CI config, secrets, dependency bumps | high |
| architecture | a new module, service or boundary; a shared abstraction many callers use; more than one repo | high |
| business-logic | domain rules, calculations, state machines, eligibility, scheduling | high |
| query-perf | slow queries, N+1, indexes, caching, a latency or memory target | mid |
| feature | a new user-facing capability spanning a few layers | mid |
| quick-fix | a bug with a clear reproduction in one to three files | cheap |
| style | layout, CSS, visual polish, no behaviour change | cheap |
| copy | text, translations, labels only | cheap |

Routing, all claude unless the review backend is set to another harness (then the review column uses `review_model` and the effort mapped to that backend):

| Class | 2 Implement | 4 Review | 6 E2E | 7 Check | 8 Risk |
| --- | --- | --- | --- | --- | --- |
| copy | haiku · low, subagent | haiku · low | sonnet · low, if 6a runs it (rarely) | haiku · low | haiku · low |
| style | sonnet · low, subagent | sonnet · low | sonnet · low, session, screenshots | sonnet · low | haiku · low |
| quick-fix | sonnet · low, subagent | sonnet · medium | sonnet · low | sonnet · low | sonnet · low |
| feature | opus · low, session | opus · low | opus · low, session | sonnet · medium | sonnet · medium |
| query-perf | opus · low, session | opus · high | opus · low, with a measurement lane | sonnet · medium | opus · low |
| business-logic | opus · high, session | opus · high | opus · low | opus · low | opus · high |
| architecture | opus · high, session | opus · high | opus · low | opus · low | opus · high |
| sensitive | opus · high, session | opus · high | opus · high, every lane | opus · high | opus · high |

The E2E column is the model that drives the run when stage 6a decides to run it; whether it runs at all is 6a's call, for every class. The Check column is stage 7's independent acceptance check. The security lane runs at stage 4 for every class, at a depth the diff's surface decides; `sensitive` forces deep. Stages 1, 3, 5 and 9, and the rest of stage 7, run here on this session's model.

Derived tier: cheap → S, mid → M, high → L. Record it with `tier` on the stage-1 call and the class as a `note`: `Class: quick-fix · cost cheap · one validator, one test`. The stage-1 question offers "Models: as routed / opus everywhere" for this run; opus everywhere keeps each lane's routed effort and swaps the model. Record the choice as a `note`.

Write the route to `<criteriaDir>/route.md` once the question is answered: the class, the cost and tier, the Models answer, and one line per routed stage (2, 4, 6, 7, 8) with its model, effort and where it runs (session, subagent, the review backend). Later stages read the route from this file, so a re-route (a sensitive signal found at stage 2) rewrites it.

**Definition gate.** For the classes `feature`, `business-logic` and `architecture`, and for `sensitive` when the ticket adds behaviour (not a dependency bump, a config change or a migration of existing data), read `definition.md` from this skill's directory and run the gate before drafting the spec. `copy`, `style`, `quick-fix` and `query-perf` never run it, and neither does a run that started from an open PR: do not read the file.

### The stage-1 question

One `AskUserQuestion` call, at most four questions, asked after the ticket is read and classified so the person sees the route. Include only what applies, in this order: open gaps in the ticket that block implementation; the definition question when the gate asks one (`definition.md`), else the spec check when it is due (below); the tracker when a bare key matches both Jira and Linear; the review backend (above); "Models: as routed / opus everywhere"; "Save these conventions as .pr-pipeline.json? (Save / This run only)" when the profile `source` is `discovered`. Anything that does not fit takes its default with a `note`. In the CLI under `-p` or on an event-driven turn, ask nothing: take the defaults and note them. Decide what the question did not cover the way a careful colleague would and record each decision as a `note`.

**Spec check.** The definition question stands in for it: a run asks one or the other, never both. A wrong spec costs the whole run, so a person confirms it before stage 2 when the class is cost high (sensitive, architecture, business-logic), or when it is cost mid and a criterion is `(derived)` or a Decision marked `(assumed)` changes what gets built. Cheap classes never stop for it. Show the draft's Goal, Expected and Acceptance criteria in a short message, then put `Spec: Build it / Stop here` in the question; free text through Other is a correction to fold into the spec. On Stop here: write and post the spec as in step 9, so the ticket can be fixed against it, close stage 1 `failed` with summary `Stopped at the spec` and end the turn; `/pipeline` on the ticket again starts over. When nothing can be asked, go on and record `flag: "Spec not confirmed by a person"`.

## Steps

The spec this stage writes is the brief every later stage works from, so the order matters:

1. Detect the tracker and fetch the ticket (`trackers.md`), `start` the run, call `{ action: "profile" }`, record stage 1 `running`, then settle the rest of the setup above.
2. Read `spec-format.md` from this skill's directory, then read around the ticket as it says: comments, linked and parent tickets, attachments, and the code the change will touch.
3. Extract the acceptance criteria word for word into `<criteriaDir>/acceptance.md`, one checkbox per criterion. Where the ticket has none, derive them from the description and comments, mark each `(derived)` and `flag` it.
4. Classify the ticket.
5. Run the definition gate when the class calls for it (above). It may add `<criteriaDir>/definition-notes.md`, criteria marked `(derived)` and a question.
6. Draft the spec in the format `spec-format.md` gives.
7. Ask the stage-1 question, with the definition question or the spec check when one is due, and fold the answers into the spec's Decisions.
8. Write the route to `<criteriaDir>/route.md`.
9. Write the spec to `<criteriaDir>/spec.md`, for every tracker: it is the file the stage-2 brief points at. Then post the same text as a ticket comment headed "Pipeline spec" (the text tracker has no comment) and `link` the comment to the stage.
10. Record the stage `done` with `tier`, the class `note`, and confidence: how complete the criteria are (100 when the ticket had explicit, testable criteria).
