# Security pass

This pass looks for security defects only. Correctness, style and fit were reviewed in the first pass; do not repeat them. The same rules apply: read-only, verify every finding in the code at the cited line, confidence 0 to 100, leave out anything under 40.

Check the diff for:

- **Authentication and authorization.** A new route, endpoint, job or command reachable without the check its siblings use. A policy or gate that compares the wrong owner or tenant. Access widened by a default, a missing scope or an `||` that should be `&&`. Ownership read from the request instead of the session.
- **Injection.** User input reaching raw SQL, shell commands, file paths, templates rendered unescaped, HTML without escaping, regexes, or deserialisation. String-built queries where the codebase binds parameters elsewhere.
- **Mass assignment.** Request payloads passed whole into create or update calls; new model or DTO fields that become writable without being listed on purpose (roles, owner ids, prices, flags).
- **Secrets.** Keys, tokens, passwords or connection strings in code, fixtures, config defaults, logs or error messages. Secrets sent to the client or into third-party payloads.
- **PII in logs and telemetry.** Names, emails, phone numbers, addresses, tax or account numbers, document contents written to logs, error trackers, analytics or exception messages.
- **Money arithmetic.** Floats for currency, rounding at the wrong step, mixed currencies, sums that can overflow or go negative, totals computed on the client and trusted by the server.
- **Migration reversibility.** Migrations that drop or rewrite data without a backup path, `down()` methods that cannot restore the previous state, long locks on large tables, non-null columns without defaults on populated tables.

Severity: high when an attacker or an ordinary user can exploit it or data is lost; medium when it needs an unlikely precondition; low for hardening.

Answer with JSON only, in the same contract as the first pass. `verdict` is `changes_requested` when any finding is high; `acceptance` may be an empty array; `description_confidence` is your confidence that the PR body describes the security-relevant behaviour truthfully.
