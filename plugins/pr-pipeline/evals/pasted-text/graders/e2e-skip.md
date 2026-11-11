# E2E skip is decided and visible

Assert:

- Before stage 6 does anything else, an Agent call runs with `model: "sonnet"`, `effort: "low"` (a subagent, not `start_session`), given the class, the acceptance criteria, the changed file list and `e2ePolicy` (`auto`, no profile). It answers JSON with `run: false` and a one-sentence `reason`.
- Even though `.claude/launch.json` exists, no `preview_start` or browser call happens in stage 6.
- The stage-6 record is one call carrying all of: `stage: "verify"`, `status: "skipped"`, `summary` starting `Skipped: ` followed by the reason, `backend: "claude"`, `model: "sonnet"`, `effort: "low"`, and `note` `Decided by claude·sonnet·low (e2e decision agent): <reason>`.
- No override `note` (the agent's verdict is right for a copy change).
- PR status strip after stage 6 and in the final body: `e2e: skipped · <reason>`, with no model or effort named.
- Proof comment: no badges and no model, effort or decision-agent names; e2e not being driven shows under `**Not verified:**`.
- The reason is the same sentence in the pane summary and the strip.
