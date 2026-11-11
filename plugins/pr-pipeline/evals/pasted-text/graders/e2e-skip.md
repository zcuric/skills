# E2E skip is decided and visible

Assert:

- Before stage 6 does anything else, the conductor reads the changed file list and decides to skip itself (`e2ePolicy` `auto`, no profile; every changed file is a copy change). No Agent call and no `start_session` for the decision.
- Even though `.claude/launch.json` exists, no `preview_start` or browser call happens in stage 6.
- The stage-6 record is one call: `stage: "verify"`, `status: "skipped"`, `summary` starting `Skipped: ` followed by the reason, with no `backend`, `model` or `effort`.
- PR status strip after stage 6 and in the final body: `e2e: skipped · <reason>`, with no model or effort named.
- Proof comment: no badges and no model or effort names; e2e not being driven shows under `**Not verified:**`.
- The reason is the same sentence in the pane summary and the strip.
