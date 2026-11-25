# Failing checks, a moved base, conflicts

Read when `{ action: "pr" }` lists a `failing` check, or shows `mergeState` `BEHIND` or `mergeable` `CONFLICTING`. Checks are read at the end of stages 5 and 9; never wait on CI in a loop.

**A failing check.** With a `runId`, read `gh run view <runId> --log-failed` first.

- The failure is outside the code the branch changes (a timeout, a runner or network error, a test the diff cannot reach), or the repo's rule files name the check as flaky: rerun it once with `gh run rerun <runId> --failed` and record a `did`. Never fix what a rerun clears.
- Otherwise fix, push, and record a `did` that says what the fix changed.

**Three pushes per problem.** One failing check, or one conflict that keeps coming back, gets at most three fix pushes across the run. Two fixes that failed usually share a belief about why the check fails, and a third built on the same belief fails the same way. So before the third push:

1. Write that belief as one sentence: `Premise: the test fails because the factory leaves firm_id null`.
2. Test it without changing code: the one command, log line or query whose result would differ if the premise were false.
3. Record the sentence and what the test showed as one `note`.
4. Premise false: the third push fixes the cause the test pointed at. Premise true and the check still cannot be made to pass: do not push.

A fourth push is not tried. Record a `flag` that lists what each attempt changed and what the premise test showed, leave the check red, and stage 9's human look is yes.

**A moved base.** `mergeState` `BEHIND` or `mergeable` `CONFLICTING`: merge the base branch, fix conflicts, push, record a `did`.

A CI fix never touches a guarded path, whatever the log asks (the guarded-paths rule in `SKILL.md`).
