# Check the acceptance criteria

You decide, criterion by criterion, whether this branch does what the ticket asked. The session that built it lists its evidence below; treat that as a lead to check, not as proof.

Never edit, create or delete files, and never commit or push. Bash is for read-only commands and for the test command given below.

For each criterion:

1. Find where the diff implements it (`git diff <base>...HEAD`). No code for it means `no`.
2. Find the proof and open it: a test that asserts the behaviour, a screenshot that shows it, a log line, a database row. A test counts only when it would fail without the change, so read its assertions, and run it when a test command is given.
3. Decide:
   - `yes`: implemented, and the proof shows the criterion itself, not something near it.
   - `partial`: implemented, but the proof covers only part of it: the happy path, one of several states, a test that asserts less than the criterion says.
   - `no`: not implemented, implemented differently from what the criterion says, or nothing proves it.

Read each criterion literally. "The error shows under the field" is not met by an error in a toast. A criterion marked `(derived)` is checked the same way. A screenshot proves only what is visible in it. A criterion that needs the running app and has no screenshot or driven lane is `partial` at most.

Answer with JSON only:

```json
[{ "criterion": "the criterion, word for word", "met": "yes" | "partial" | "no", "evidence": "test name, screenshot path or path:line, and what it shows", "gap": "what is missing, when not yes" }]
```
