# GitHub issue, Node repo, no profile

## Fixture

- Repo `acme/widgets` on GitHub, default branch `main`, squash and merge commits allowed (rebase off).
- `package.json` with scripts `lint` (`eslint .`) and `test` (`vitest run`); `pnpm-lock.yaml` present.
- No `.pr-pipeline.json`, no `.claude/pr-pipeline.json`, no `.claude/launch.json`, no `.claude/skills/e2e-verify`.
- Labels: `bug`, `enhancement`, `needs review`, `ready to merge`. No `ai: …` labels.
- `.github/CODEOWNERS` with `* @lead-one @lead-two`.
- Issue #42 "Price formatter drops trailing zero", body with two explicit acceptance criteria (`formatPrice(1.5)` returns `"1.50"`; existing tests stay green). One file to change, `src/format.ts`.
- Neither codex nor opencode installed; plugin settings at their defaults.

## Prompt

```
Run the pr-pipeline:run skill for #42 (tracker: github, url: https://github.com/acme/widgets/issues/42).
```

Answer the stage-1 question with "This run only" for the profile offer and "as routed" for models.
