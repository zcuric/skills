---
name: risk
description: Assess the risk of merging an open PR across alignment, impact, verification, rollback cost and error detection, and return a low/medium/high verdict with per-category verdicts. Use for "how risky is this PR", "merge risk for PR n", or as stage 8 of the PR pipeline.
---

# Merge risk

One verdict a reviewer can act on, backed by five category verdicts and the gaps behind them. Read, do not change anything.

## Gather

```bash
gh pr view <n> --json number,title,body,url,files,reviews,comments
gh pr diff <n>
gh api repos/{owner}/{repo}/pulls/<n>/comments
```

Also read, when they exist: `<criteriaDir>/acceptance.md`, `<criteriaDir>/review.json`, the screenshots and measurements in `<criteriaDir>/e2e/`, and the e2e artifact the pipeline linked. Standalone, `<criteriaDir>` comes from the repo profile (default `~/.claude/pipeline/{owner}-{repo}/{ticket}`); when it does not exist, judge from the PR alone and say so under Verification. Open every changed file at the changed lines; a verdict on the diff alone is a guess.

The pipeline passes the task class. A sensitive class, or any sensitive signal in the diff (the list under Impact), raises Impact to at least medium regardless of how small the change is.

## Categories

| Category | Verdicts | Low risk means |
| --- | --- | --- |
| Alignment | poor ⚠️ · decent 👀 · good ✅ | Code does what the ticket and PR body say. Drive-bys and behaviour assumptions are written down. |
| Impact | large ⚠️ · medium 👀 · small ✅ | Scope is contained and away from sensitive paths. Sensitive regardless of size: auth, permissions, payments, PII, secrets, data migrations, dependency bumps, infra/config, cross-system contracts, anything that widens access, weakens validation or logs sensitive data. Consider consumers, layout shift, mobile. |
| Verification | poor ⚠️ · decent 👀 · good ✅ | Behaviour is proven. UI change needs before/after screenshots; a performance-relevant change needs a measurement; edge cases are tested or documented with a link to the code. Missing proof for a UI change is poor. |
| Rollback cost | high ⚠️ · medium 👀 · low ✅ | Reverting the commit restores the previous state. Migrations that drop or rewrite data, emails sent, external records created, contract changes shipped to a sibling system are one-way doors. |
| Error detection | poor ⚠️ · decent 👀 · good ✅ · n/a ✅ | A production break is noticed before a user reports it. Look for swallowed exceptions, silent fallbacks, `try/catch` that logs nothing, jobs without failure handling. |

## Score

Internal only. ⚠️ = 3, 👀 = 2, ✅ = 1. Weights: Impact 2, Verification 2, Rollback cost 1.5, Error detection 1, Alignment 1. Score = Σ(verdict × weight) / 7.5. Low under 1.5, medium 1.5 to under 2.25, high 2.25 and up. Never print the numbers.

## Output

Return exactly this, so the caller can paste it and the pipeline can parse it:

```markdown
**🟢 Merge risk: low**

**Alignment:** good ✅
**Impact:** small ✅
**Verification:** good ✅
**Rollback cost:** low ✅
**Error detection:** decent 👀
- A failed tag sync goes unnoticed until a user reports missing tags. `app/Jobs/SyncTags.php:41`
```

The first line carries the traffic light: 🟢 low, 🟡 medium, 🔴 high. Under each category, bullets only for gaps that raised the verdict. No bullets under a ✅, ever. Each bullet is the consequence in one sentence plus one file:line. Keep it under 12 lines.

Whichever model runs this skill, the verdict rules above are the same. When called from the pipeline, the caller records `risk`, the summary, each category line as a `did` and each ⚠️ as a `flag` on stage `risk`, and the proof prints only the bullets of the categories that are not ✅; the skill itself records nothing.
