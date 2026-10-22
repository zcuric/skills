import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type {
  Backend,
  Effort,
  Harnesses,
  MergeMethod,
  PipelineOptions,
  PipelineRun,
  PipelineToolInput,
  RepoRef,
  Runs,
  Stage,
  StageId,
  StageModel,
  Tracker,
} from '../types'
import { currentBranch, detectHarnesses, repoRef } from './github'

export const STORE_KEY = 'runs'

export const STAGES: ReadonlyArray<{ id: StageId; label: string; blurb: string }> = [
  { id: 'enhance', label: 'Enhance', blurb: 'Ticket read, criteria extracted, spec posted, task class picked' },
  { id: 'implement', label: 'Implement', blurb: 'Bug reproduced or feature planned, code and tests written' },
  { id: 'pr', label: 'Create PR', blurb: 'PR opened with the ticket link, change outline, labels, reviewers' },
  { id: 'review', label: 'AI review', blurb: 'Line comments with confidence, reviewer and model picked by class' },
  { id: 'address', label: 'Address', blurb: 'Review comments fixed and each thread answered' },
  { id: 'verify', label: 'E2E verify', blurb: 'Driven against the real stack, before/after screenshots' },
  { id: 'acceptance', label: 'Acceptance', blurb: 'Every criterion mapped to evidence' },
  { id: 'risk', label: 'Merge risk', blurb: 'Alignment, impact, verification, rollback, detection' },
  { id: 'proof', label: 'Final proof', blurb: 'Proof comment, reviewers tagged, labels set' },
]

export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'opencode']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TRACKERS: readonly Tracker[] = ['jira', 'github', 'linear', 'text', 'pr']
export const TRACKER_SETTINGS: ReadonlyArray<Tracker | 'auto'> = ['auto', 'jira', 'github', 'linear', 'text']
export const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase']
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const

const MAX_RUNS = 25
const DAY_MS = 86_400_000
const HARNESS_TTL_MS = 10 * 60_000

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const harnesses = atom({ plugin: 'pr-pipeline', key: 'harnesses' } as const, null as Harnesses | null)
const repos = atom({ plugin: 'pr-pipeline', key: 'repos' } as const, {} as Record<string, RepoRef | null>)

export const runKey = (repoSlug: string | null, branch: string): string => `${repoSlug ?? 'unknown'}#${branch}`

export const branchOfKey = (key: string): string => (key.includes('#') ? key.slice(key.indexOf('#') + 1) : key)

const repoOfKey = (key: string): string | undefined => {
  if (!key.includes('#')) return undefined
  const slug = key.slice(0, key.indexOf('#'))
  return slug === 'unknown' ? undefined : slug
}

const freshStage = (id: StageId): Stage => ({ id, status: 'pending', did: [], flags: [], notes: [], criteria: [], links: [] })

export const isStageId = (value: unknown): value is StageId => STAGES.some(stage => stage.id === value)

export const stageLabel = (id: StageId): string => STAGES.find(stage => stage.id === id)?.label ?? id

export const normaliseRun = (run: PipelineRun, key: string): PipelineRun => ({
  ...run,
  key: run.key ?? key,
  stages: STAGES.map(meta => {
    const stored = (run.stages ?? []).find(stage => stage.id === meta.id)
    if (stored === undefined) return freshStage(meta.id)
    return {
      ...stored,
      did: stored.did ?? [],
      flags: stored.flags ?? [],
      notes: stored.notes ?? [],
      criteria: stored.criteria ?? [],
      links: stored.links ?? [],
    }
  }),
})

export const normaliseRuns = (raw: unknown): Runs => {
  if (typeof raw !== 'object' || raw === null) return {}
  return Object.fromEntries(
    Object.entries(raw as Runs).map(([key, run]) => [key, normaliseRun(run, key)]),
  )
}

const freshRun = (key: string, now: number): PipelineRun => ({
  key,
  branch: branchOfKey(key),
  repo: repoOfKey(key),
  stages: STAGES.map(stage => freshStage(stage.id)),
  updatedAt: now,
})

export const isOpenRun = (run: PipelineRun): boolean => run.closedAt === undefined

/** The selected run while it is open, else the most recently updated open one. */
export const pickedKey = (all: Runs, chosen: string | null): string | null => {
  if (chosen !== null && all[chosen] !== undefined && isOpenRun(all[chosen])) return chosen
  return Object.values(all)
    .filter(isOpenRun)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.key ?? null
}

export async function repoFor($: EngineInterface, cwd: string): Promise<RepoRef | null> {
  const cache = await read($, repos)
  if (cwd in cache) return cache[cwd] ?? null
  const found = await repoRef($, cwd)
  await update($, repos, known => ({ ...known, [cwd]: found }))
  return found
}

export type ResolvedRun = { key: string; repo: RepoRef | null; cwd: string }

export async function resolveRun(
  $: EngineInterface,
  input: Pick<PipelineToolInput, 'branch' | 'repo'>,
  options: { fromPane?: boolean } = {},
): Promise<ResolvedRun | null> {
  const all = await read($, runs)
  const cwd = await $.session.cwd()
  const detected = await repoFor($, cwd)
  const repo = input.repo !== undefined && input.repo !== '' ? { host: detected?.host ?? 'github.com', slug: input.repo } : detected
  if (input.branch !== undefined && all[input.branch] !== undefined && all[input.branch]?.key === input.branch && input.branch.includes('#')) {
    return { key: input.branch, repo, cwd }
  }
  const branch = input.branch ?? (await currentBranch($, cwd))
  if (branch === null) {
    const chosen = options.fromPane ? pickedKey(all, await read($, selectedKey)) : null
    return chosen === null ? null : { key: chosen, repo, cwd }
  }
  const key = runKey(repo?.slug ?? null, branch)
  if (all[key] !== undefined) return { key, repo, cwd }
  const legacy = all[branch]
  if (legacy !== undefined && legacy.key === branch) {
    await rekeyRun($, branch, key, repo)
  }
  return { key, repo, cwd }
}

async function rekeyRun($: EngineInterface, from: string, to: string, repo: RepoRef | null): Promise<void> {
  await update($, runs, all => {
    const legacy = all[from]
    if (legacy === undefined) return all
    const { [from]: _dropped, ...rest } = all
    return { ...rest, [to]: { ...legacy, key: to, repo: legacy.repo ?? repo?.slug, host: legacy.host ?? repo?.host } }
  })
  await update($, selectedKey, chosen => (chosen === from ? to : chosen))
  await persist($)
}

export async function changeRun(
  $: EngineInterface,
  key: string,
  fn: (run: PipelineRun) => PipelineRun,
  options: { touch?: boolean } = {},
): Promise<PipelineRun> {
  const now = await $.clock.now()
  let changed: PipelineRun | undefined
  await update($, runs, all => {
    const existing = all[key] !== undefined ? normaliseRun(all[key], key) : freshRun(key, now)
    const next = fn(existing)
    changed = options.touch === false ? next : { ...next, updatedAt: now }
    return { ...all, [key]: changed }
  })
  await persist($)
  return changed as PipelineRun
}

/** Moves the selection off a closed run, to the most recently updated open one. */
export async function closeRun($: EngineInterface, key: string): Promise<PipelineRun> {
  const now = await $.clock.now()
  const closed = await changeRun($, key, run => ({ ...run, closedAt: run.closedAt ?? now }), { touch: false })
  const all = await read($, runs)
  await update($, selectedKey, chosen => (chosen === key || chosen === null ? pickedKey(all, null) : chosen))
  await update($, openStage, () => null)
  return closed
}

const hasRunningStage = (run: PipelineRun): boolean => run.stages.some(stage => stage.status === 'running')

export const pruneRuns = (all: Runs, now: number, keep: string | null): Runs => {
  const isKept = (run: PipelineRun): boolean => run.key === keep || hasRunningStage(run)
  const fresh = Object.values(all).filter(run => {
    if (isKept(run)) return true
    if (now - run.updatedAt > 30 * DAY_MS) return false
    return run.closedAt === undefined || now - run.closedAt <= 7 * DAY_MS
  })
  const ordered = fresh.sort((a, b) => Number(isKept(b)) - Number(isKept(a)) || b.updatedAt - a.updatedAt)
  return Object.fromEntries(ordered.slice(0, Math.max(MAX_RUNS, ordered.filter(isKept).length)).map(run => [run.key, run]))
}

let lastStoreText: string | undefined

export async function persist($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const keep = await read($, selectedKey)
  const all = await read($, runs)
  const pruned = pruneRuns(all, now, keep)
  if (Object.keys(pruned).length !== Object.keys(all).length) {
    await update($, runs, current => Object.fromEntries(Object.entries(current).filter(([key]) => key in pruned)))
  }
  const text = JSON.stringify(pruned)
  if (text === lastStoreText) return
  lastStoreText = text
  await $.store.set(STORE_KEY, pruned)
}

export async function loadRuns($: EngineInterface): Promise<void> {
  const stored = await $.store.get(STORE_KEY)
  lastStoreText = JSON.stringify(stored ?? {})
  if (stored === undefined) return
  await update($, runs, () => normaliseRuns(stored))
}

/** Picks up what a linked session wrote to the store since this one last read or wrote it. */
export async function followStoreOnce($: EngineInterface): Promise<void> {
  const stored = await $.store.get(STORE_KEY)
  const text = JSON.stringify(stored ?? {})
  if (text === lastStoreText) return
  lastStoreText = text
  await update($, runs, () => normaliseRuns(stored ?? {}))
}

export async function ensureHarnesses($: EngineInterface, force = false): Promise<Harnesses> {
  const now = await $.clock.now()
  const known = await read($, harnesses)
  if (!force && known !== null && now - known.checkedAt < HARNESS_TTL_MS) return known
  const found = await detectHarnesses($, now)
  await update($, harnesses, () => found)
  return found
}

const pickOption = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

export const pipelineOptions = (raw: PluginOptions | Partial<PipelineOptions>): PipelineOptions => ({
  reviewer: pickOption(raw.reviewer, BACKENDS, 'claude'),
  review_model: typeof raw.review_model === 'string' && raw.review_model !== '' ? raw.review_model : 'opus',
  review_effort: pickOption(raw.review_effort, EFFORTS, 'low'),
  tracker: pickOption(raw.tracker, TRACKER_SETTINGS, 'auto'),
  merge_method: pickOption(raw.merge_method, MERGE_METHODS, 'squash'),
})

/** `opus·low` on the claude backend, `codex·gpt-5-codex` for another backend. */
export const modelChip = (model: StageModel): string =>
  model.backend === 'claude'
    ? [model.model ?? 'claude', model.effort].filter(Boolean).join('·')
    : [model.backend, model.model].filter(Boolean).join('·')

export const modelFull = (model: StageModel): string =>
  [model.backend, model.model, model.effort].filter(Boolean).join('·')

export type Color = 'green' | 'yellow' | 'red' | 'gray' | 'cyan' | undefined

/** Green from 80, yellow from 60, red below; gray when nothing is scored. */
export const confidenceColor = (value: number | undefined): Color => {
  if (value === undefined) return 'gray'
  if (value >= 80) return 'green'
  if (value >= 60) return 'yellow'
  return 'red'
}

/** Acceptance confidence (or its criteria met %), else review's, else the latest stage that has one. */
export const runConfidence = (run: PipelineRun): number | undefined => {
  const acceptance = run.stages.find(stage => stage.id === 'acceptance')
  if (acceptance?.confidence !== undefined) return acceptance.confidence
  if (acceptance !== undefined && acceptance.criteria.length > 0) {
    const met = acceptance.criteria.filter(one => one.met === 'yes').length
    return Math.round((met / acceptance.criteria.length) * 100)
  }
  const review = run.stages.find(stage => stage.id === 'review')
  if (review?.confidence !== undefined) return review.confidence
  return [...run.stages].reverse().find(stage => stage.confidence !== undefined)?.confidence
}

export const approvalRequired = (run: PipelineRun): boolean =>
  !(run.risk === 'low' && (runConfidence(run) ?? 0) >= 80)
