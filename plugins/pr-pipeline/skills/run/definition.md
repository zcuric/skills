# Definition gate

A ticket can be clear enough to classify and still not say what to build. A run that builds from it ends with a confident PR for the wrong thing, and the spec check catches that only when the person reading it already knows what was meant. The gate runs inside stage 1, after the ticket and the code around it are read and before the spec is drafted. It decides whether the ticket is defined, and when it is not, it does the exploring a product owner or a designer would have done, cheaply, before any code is written.

A defined ticket costs nothing here: no agent, no file, no question. Most tickets are defined.

## The signals

Mark each signal `given` (the ticket, a comment, a linked or parent ticket, or an attachment states it), `found` (the code or another ticket settles it; say where) or `missing`. Missing means you looked in all of those places. A ticket that leaves out what the repo already answers is `found`.

**Product**, for every run of the gate:

| Signal | Given or found when |
| --- | --- |
| Who | the user or role the change is for is named, or the screen it lives on has one audience |
| Why | the problem or the trigger is stated: what happens today that should not, or what someone cannot do |
| Done | at least one outcome a person could observe and check; a criterion you would have to mark `(derived)` does not count |
| Edge | the description reads as one deliverable. Missing when it names more than one problem, or could fairly be read as two differently sized pieces of work, and nothing says which is meant |

**Design**, only when the change is user-facing (a screen, a flow, an email, a document someone receives) or adds a boundary (a new entity, table, endpoint, event or contract):

| Signal | Given or found when |
| --- | --- |
| Look and flow | a design link or attachment exists, or the change extends a screen or flow already in the repo that you can name. A new screen or flow with neither is missing |
| States | what shows when there is nothing, while it loads, when it fails and when the user is not allowed; found when the pattern being followed already has them |
| Shape | for a new entity, endpoint or contract: its fields and which side owns them; found when the closest existing one is a clear model |
| One shape | one structure is the obvious fit. Missing when two or more are reasonable across a module boundary and they differ in cost or behaviour: a choice nobody has made |

## The verdict

- **Product is `undefined`** when Why or Done is missing, or two or more product signals are.
- **Design is `undefined`** when Look and flow is missing, or two or more design signals are.
- Anything else that is missing makes that side `thin`: fill it the way stage 1 already does, with a criterion marked `(derived)` or a Decision marked `(assumed)`, and let the spec check decide.
- Nothing missing: `defined`.

Between thin and undefined, ask whether two capable engineers would build visibly different things from this ticket. If they would, it is undefined.

Record one `note`, and only when a side is not `defined`: `Definition: product thin (scope edge assumed) · design undefined (new screen, no design, no screen to follow)`. Both sides `defined` or `thin`: go back to the stage-1 steps. Otherwise explore, product first, since the design depends on it.

## Product exploration

Run it when product is `undefined`. It reads; it changes no code, creates no ticket and contacts nobody.

- The profile names a `product` skill: run that skill with the brief below.
- Otherwise run the brief in a subagent (sonnet · medium).

The brief carries the ticket text, its comments and linked tickets, what the code does today with `path:line`, and the signals that are missing. The result goes under a **Product** heading in `<criteriaDir>/definition-notes.md`, at most 40 lines:

| Part | Holds |
| --- | --- |
| Problem | what the evidence supports, with what is evidence and what is a guess kept apart |
| Readings | two or three ways to read the ticket: who each serves, what gets built, its size (S, M, L), what it leaves out |
| Recommended | one reading and the reason; its non-goals |
| Criteria | acceptance criteria for the recommended reading, each one observable |
| For a person | at most five questions that no ticket or code settles, each with the default the recommended reading takes |

## Design pass

Run it when design is `undefined`, after the product side is settled (given, or the recommended reading).

- The profile names a `design` skill: run that skill with the brief below, in a subagent.
- Otherwise run the brief in a subagent at the class's stage-2 model, effort low.

The brief carries the ticket, the Product part of the notes when there is one, the closest existing screens or modules with their paths, and the signals that are missing. It builds nothing on the branch. The result goes under a **Design** heading in the same file, at most 60 lines:

| Part | Holds |
| --- | --- |
| Follows | the existing screen, component or module the change extends, and what it reuses from it |
| Flow | the steps the user takes, one line each; for a boundary, the shape: fields, types, which side owns each |
| States | empty, loading, error, not allowed: what shows in each |
| Options | only where more than one shape is reasonable: two options, what each costs, the recommended one and why |
| For a person | what is taste or product preference and nothing else |

Two rules for the pass:

- A fork that running something would settle is settled by running it, not by asking: a throwaway script, a scratch component in the Browser pane, a query against local data, kept in `<criteriaDir>/prototype/` and never on the branch. Record what it showed as a `note`. Only preference reaches the person.
- The design reuses the repo's components, tokens and naming. A visual element the repo does not have is listed under "For a person", not invented.

## Asking, and what follows

Post `<criteriaDir>/definition-notes.md` as a ticket comment headed "Pipeline definition notes" (the text tracker has no comment) and `link` it to stage 1. Show the Recommended reading, the chosen design option and the "For a person" questions in a short message, then put one question into the stage-1 question: `Definition: Build as proposed / Stop here`. Free text through Other is an answer to fold in. This question stands in for the spec check.

- **Build as proposed.** The notes' Criteria go into `<criteriaDir>/acceptance.md` marked `(derived)`. The readings not taken go under the spec's **Stays as it is**, each default taken under **Decisions** marked `(assumed)`, and the design under the spec's **Design** section (`spec-format.md`). Record `note: "Definition confirmed: <the reading, in a few words>"`.
- **Stop here.** Close stage 1 `failed` with summary `Stopped: ticket needs product definition` (or `needs a design`, or both) and end the turn. The notes are on the ticket for whoever defines it; `/pipeline` on the ticket again starts over.
- **Nothing can be asked** (the CLI under `-p`, an event-driven turn): build as proposed and record `flag: "Definition assumed, nobody confirmed it; see Pipeline definition notes"`. That flag makes stage 9's human look yes.

The implementer's brief names `<criteriaDir>/definition-notes.md` as a file to read after the spec whenever it exists.
