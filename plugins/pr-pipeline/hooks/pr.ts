import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { MergeMethod, PipelineRun, PrRef, PrSnapshot, PrState, PrSummary, PrThread, Runs } from '../types'
import { fetchPr, mergePr, parsePrUrl, replyToThread, rerunFailed, resolveThread, toSummary } from './github'
import { changeRun, closeRun, pickedKey } from './runs'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)
const replying = atom({ plugin: 'pr-pipeline', key: 'replying' } as const, null as string | null)
const drafts = atom({ plugin: 'pr-pipeline', key: 'drafts' } as const, {} as Record<string, string>)
const prBusy = atom({ plugin: 'pr-pipeline', key: 'prBusy' } as const, null as string | null)

const DEBOUNCE_MS = 15_000
const STUCK_FETCH_MS = 45_000
export const CLOSE_AFTER_MS = 5 * 60_000
const OTHER_RUN_POLL_MS = 10 * 60_000

const pendingRefreshes = new Map<string, { timer: Timer; dueAt: number }>()
const rerunDone = new Set<string>()

export const prRefOf = (run: PipelineRun | undefined): PrRef | null =>
  run?.prUrl === undefined ? null : parsePrUrl(run.prUrl)

const withoutFetchedAt = (summary: PrSummary | undefined): string =>
  summary === undefined ? '' : JSON.stringify({ ...summary, fetchedAt: 0 })

type Seen = Pick<PrSummary, 'counts' | 'reviewDecision'>

const isAllGreen = (seen: Seen): boolean =>
  seen.counts.checksFailed === 0 && seen.counts.checksPending === 0 && seen.counts.checksPassed > 0

function transitionToasts($: EngineInterface, before: Seen | undefined, after: PrSnapshot): void {
  if (before === undefined) return
  if (isAllGreen(after) && !isAllGreen(before)) $.ui.toast(`PR #${after.number}: all checks passed`)
  if (after.counts.threadsOpen > before.counts.threadsOpen) {
    const open = after.counts.threadsOpen
    $.ui.toast(`PR #${after.number}: ${open} open review thread${open === 1 ? '' : 's'}`)
  }
  if (after.reviewDecision === 'APPROVED' && before.reviewDecision !== 'APPROVED') $.ui.toast(`PR #${after.number} approved`)
}

export async function refreshPr(
  $: EngineInterface,
  key: string,
  options: { fresh?: boolean; reason?: string } = {},
): Promise<PrState | undefined> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  if (run === undefined || ref === null) return undefined
  const now = await $.clock.now()
  const current = (await read($, prStates))[key]
  if (!options.fresh && current?.isFetching) return current
  if (!options.fresh && current !== undefined && now - current.fetchedAt < DEBOUNCE_MS) return current
  await update($, prStates, all => ({ ...all, [key]: { ...all[key], fetchedAt: now, isFetching: true } }))

  const fetched = await fetchPr($, ref, now, run.cwd)
  if (!fetched.ok) {
    await update($, prStates, all => ({ ...all, [key]: { ...all[key], error: fetched.error, fetchedAt: now, isFetching: false } }))
    return (await read($, prStates))[key]
  }

  const snapshot = fetched.snapshot
  const next: PrState = { snapshot, fetchedAt: now, isFetching: false }
  await update($, prStates, all => (JSON.stringify(all[key]) === JSON.stringify(next) ? all : { ...all, [key]: next }))
  transitionToasts($, current?.snapshot ?? run.pr, snapshot)

  const summary = toSummary(snapshot)
  const isNewlyMerged = snapshot.state === 'MERGED' && run.mergedAt === undefined
  if (withoutFetchedAt(summary) !== withoutFetchedAt(run.pr) || isNewlyMerged) {
    await changeRun($, key, existing => ({
      ...existing,
      pr: summary,
      mergedAt: isNewlyMerged ? now : existing.mergedAt,
    }), { touch: false })
  }
  if (isNewlyMerged) $.ui.toast(`PR #${snapshot.number} merged · run closes in 5 min`)
  return next
}

async function firePendingRefresh($: EngineInterface, key: string): Promise<void> {
  pendingRefreshes.delete(key)
  if ((await read($, replying)) !== null) {
    await schedulePrRefresh($, key, 10_000)
    return
  }
  await refreshPr($, key, { fresh: true, reason: 'scheduled' })
}

/** One pending timer per run: a later request keeps the sooner one. */
export async function schedulePrRefresh($: EngineInterface, key: string, delayMs: number): Promise<void> {
  const run = (await read($, runs))[key]
  if (prRefOf(run) === null) return
  const dueAt = (await $.clock.now()) + delayMs
  const pending = pendingRefreshes.get(key)
  if (pending !== undefined && pending.dueAt <= dueAt) return
  pending?.timer.cancel()
  const timer = $.clock.after(Math.max(1, delayMs), () => {
    void firePendingRefresh($, key).catch(err => $.ui.toast(String(err)))
  })
  pendingRefreshes.set(key, { timer, dueAt })
}

async function resetStuckFetches($: EngineInterface, now: number): Promise<void> {
  const all = await read($, prStates)
  const stuck = Object.entries(all).filter(([, state]) => state.isFetching && now - state.fetchedAt >= STUCK_FETCH_MS)
  if (stuck.length === 0) return
  await update($, prStates, states => ({
    ...states,
    ...Object.fromEntries(stuck.map(([key, state]) => [key, { ...state, isFetching: false }])),
  }))
}

const DAY_MS = 86_400_000
export const IDLE_NO_PR_MS = 3 * DAY_MS
export const IDLE_WITH_PR_MS = 14 * DAY_MS

/** Why an open run should close now, or null: merged 5 min ago, PR closed unmerged, or idle too long. */
export function endReason(run: PipelineRun, now: number): string | null {
  if (run.closedAt !== undefined) return null
  if (run.mergedAt !== undefined) return now - run.mergedAt >= CLOSE_AFTER_MS ? 'closed' : null
  if (run.pr?.state === 'CLOSED' && run.pr.fetchedAt >= run.updatedAt) return 'closed · PR closed without merge'
  const idle = now - run.updatedAt
  if (run.prUrl === undefined && idle >= IDLE_NO_PR_MS) return 'closed · no PR, idle 3 days'
  if (idle >= IDLE_WITH_PR_MS) return 'closed · idle 14 days'
  return null
}

async function closeEndedRuns($: EngineInterface, now: number): Promise<void> {
  for (const run of Object.values(await read($, runs))) {
    const reason = endReason(run, now)
    if (reason === null) continue
    await closeRun($, run.key)
    $.ui.toast(`Run ${run.ticket ?? run.branch} ${reason}`)
  }
}

const isPolled = (run: PipelineRun | undefined): run is PipelineRun =>
  run?.prUrl !== undefined && run.closedAt === undefined && run.pr?.state !== 'CLOSED'

/** Polls the selected run, plus the one other run whose PR was fetched longest ago, so its merge is seen and it closes. */
export async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await resetStuckFetches($, now)
  await closeEndedRuns($, now)
  if ((await read($, replying)) !== null) return
  const all = await read($, runs)
  const key = pickedKey(all, await read($, selectedKey))
  if (key !== null && isPolled(all[key])) await refreshPr($, key, { reason: 'poll' })
  const states = await read($, prStates)
  const fetchedAt = (run: PipelineRun): number => states[run.key]?.fetchedAt ?? run.pr?.fetchedAt ?? 0
  const stalest = Object.values(all)
    .filter(run => run.key !== key && run.mergedAt === undefined && isPolled(run))
    .sort((a, b) => fetchedAt(a) - fetchedAt(b))[0]
  if (stalest === undefined || now - fetchedAt(stalest) < OTHER_RUN_POLL_MS) return
  await refreshPr($, stalest.key, { reason: 'poll-other' })
}

export const failedChecks = (snapshot: PrSnapshot): PrSnapshot['checks'] =>
  snapshot.checks.filter(check => ['failure', 'error', 'timed_out', 'action_required', 'cancelled', 'startup_failure'].includes(check.conclusion ?? ''))

/** Failed runs not rerun yet for this snapshot. */
export const rerunnableIds = (key: string, snapshot: PrSnapshot): string[] => [
  ...new Set(
    failedChecks(snapshot)
      .map(check => check.runId)
      .filter((runId): runId is string => runId !== undefined && !rerunDone.has(`${key}|${snapshot.fetchedAt}|${runId}`)),
  ),
]

export const failingRunIds = (snapshot: PrSnapshot): string[] => [
  ...new Set(failedChecks(snapshot).map(check => check.runId).filter((runId): runId is string => runId !== undefined)),
]

const runContext = (run: PipelineRun, ref: PrRef): string =>
  `repo ${ref.slug}, ticket ${run.ticket ?? 'none'}${run.tier ? `, tier ${run.tier}` : ''}`

export const reviewPrompt = (run: PipelineRun, ref: PrRef): string =>
  `Run the pr-pipeline:review skill for PR #${ref.number} (${runContext(run, ref)}).`

export const riskPrompt = (run: PipelineRun, ref: PrRef): string =>
  `Run the pr-pipeline:risk skill for PR #${ref.number} (${runContext(run, ref)}).`

export const fixCiPrompt = (ref: PrRef, runIds: string[]): string => {
  const commands = runIds.map(runId => `\`gh run view ${runId} --log-failed --repo ${ref.slug}\``).join(', ')
  const source = commands === '' ? `the failing checks of PR #${ref.number}` : commands
  return `CI is failing on PR #${ref.number} (repo ${ref.slug}). Read the failing logs with ${source}, fix the cause, commit and push, then record a did on the address stage of the pipeline.`
}

export const syncPrompt = (ref: PrRef, snapshot: PrSnapshot): string =>
  `PR #${ref.number} (repo ${ref.slug}) is behind ${snapshot.baseRefName}. Merge ${snapshot.baseRefName} into ${snapshot.headRefName}, resolve any conflicts, run the affected tests, push, and record a did on the address stage of the pipeline.`

export const deltaReviewPrompt = (run: PipelineRun, ref: PrRef, reviewedSha: string, headSha: string): string =>
  `Run the pr-pipeline:review skill on PR #${ref.number} for the commits after ${reviewedSha} only (git diff ${reviewedSha}..${headSha}), passing branch "${run.key}". Then re-run the acceptance check and the proof if they were done.`

/** `3 commits since AI review · proof stale`; null while the review judged the current head or recorded no commit. */
export function staleVerdictText(run: PipelineRun, snapshot: PrSnapshot): string | null {
  const head = snapshot.headSha
  const reviewed = run.stages.find(stage => stage.id === 'review')?.headSha
  if (head === undefined || reviewed === undefined || reviewed === head) return null
  const at = snapshot.commitShas.indexOf(reviewed)
  const since = at < 0 ? null : snapshot.commitShas.length - 1 - at
  const proof = run.stages.find(stage => stage.id === 'proof')
  const isProofStale = proof?.status === 'done' && proof.headSha !== undefined && proof.headSha !== head
  const lead = since === null ? 'AI review predates a force-push' : `${since} commit${since === 1 ? '' : 's'} since AI review`
  return `${lead}${isProofStale ? ' · proof stale' : ''}`
}

export const fixThreadPrompt = (thread: PrThread): string => {
  const first = thread.comments[0]
  const where = `${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`
  return `Address the review comment at ${first?.url ?? where} (${where}, by ${first?.author ?? 'unknown'}): fix it, commit, reply in the thread with what changed and the SHA, resolve the thread, record a did on the address stage.`
}

async function claimBusy($: EngineInterface, key: string): Promise<boolean> {
  if ((await read($, prBusy)) !== null) return false
  await update($, prBusy, () => key)
  return true
}

async function releaseBusy($: EngineInterface): Promise<void> {
  await update($, prBusy, () => null)
}

export async function mergeFromPane($: EngineInterface, key: string, method: MergeMethod): Promise<void> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  if (run === undefined || ref === null || !(await claimBusy($, key))) return
  try {
    const chosen = run.mergeMethod ?? method
    const answer = await $.ui.ask(`Merge #${ref.number} with ${chosen}?`, ['Merge', 'Cancel']).catch(() => 'Cancel')
    if (answer !== 'Merge') return
    const merged = await mergePr($, ref, chosen, run.cwd)
    if (!merged.ok) {
      $.ui.toast(`Merge failed: ${merged.error}`)
      return
    }
  } finally {
    await releaseBusy($)
  }
  await refreshPr($, key, { fresh: true, reason: 'merged' })
}

export async function rerunFromPane($: EngineInterface, key: string): Promise<void> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  const snapshot = (await read($, prStates))[key]?.snapshot
  if (run === undefined || ref === null || snapshot === undefined || !(await claimBusy($, key))) return
  try {
    for (const runId of rerunnableIds(key, snapshot)) {
      rerunDone.add(`${key}|${snapshot.fetchedAt}|${runId}`)
      const rerun = await rerunFailed($, ref, runId, run.cwd)
      if (!rerun.ok) $.ui.toast(`Rerun failed: ${rerun.error}`)
    }
  } finally {
    await releaseBusy($)
  }
  await schedulePrRefresh($, key, 5_000)
}

export async function replyFromPane($: EngineInterface, key: string, threadId: string, body: string): Promise<void> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  if (run === undefined || ref === null || body.trim() === '' || !(await claimBusy($, key))) return
  try {
    const replied = await replyToThread($, ref, threadId, body, run.cwd)
    if (!replied.ok) {
      $.ui.toast(`Reply failed: ${replied.error}`)
      return
    }
    await update($, drafts, all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)))
    await update($, replying, () => null)
  } finally {
    await releaseBusy($)
  }
  await refreshPr($, key, { fresh: true, reason: 'replied' })
}

export async function resolveFromPane($: EngineInterface, key: string, threadId: string): Promise<void> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  if (run === undefined || ref === null || !(await claimBusy($, key))) return
  try {
    const resolved = await resolveThread($, ref, threadId, run.cwd)
    if (!resolved.ok) {
      $.ui.toast(`Resolve failed: ${resolved.error}`)
      return
    }
  } finally {
    await releaseBusy($)
  }
  await refreshPr($, key, { fresh: true, reason: 'resolved' })
}
