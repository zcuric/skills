import { atom, read, update } from 'claude-code'
import type { Color as EngineColor, EngineInterface, PluginOptions } from 'claude-code'

import type {
  Backend,
  CwdLook,
  Effort,
  Harnesses,
  MergeMethod,
  PipelineOptions,
  PipelineRun,
  PipelineToolInput,
  PrState,
  RepoRef,
  Runs,
  Stage,
  StageId,
  StageModel,
  Tracker,
} from '../types'
import { currentBranch, detectHarnesses, openPrOfCheckout, repoRef } from './github'

/** Before one key per run, every run sat under this one key. */
const LEGACY_STORE_KEY = 'runs'
const RUN_PREFIX = 'run:'
const POLL_PREFIX = 'poll:'
const SESSION_PREFIX = 'session:'
const PANE = 'pr-pipeline'

export const runStoreKey = (key: string): string => `${RUN_PREFIX}${key}`

/** When any session last fetched the run's PR; kept apart from the run so a poll never bumps it. */
export const pollStoreKey = (key: string): string => `${POLL_PREFIX}${key}`

export const STAGES: ReadonlyArray<{ id: StageId; label: string; blurb: string }> = [
  { id: 'enhance', label: 'Enhance', blurb: 'Ticket read, criteria extracted, spec posted, task class picked' },
  { id: 'implement', label: 'Implement', blurb: 'Bug reproduced or feature planned, code and tests written' },
  { id: 'pr', label: 'Create PR', blurb: 'PR opened with the ticket link, change outline and labels' },
  { id: 'review', label: 'AI review', blurb: 'Line comments with confidence, reviewer and model picked by class' },
  { id: 'address', label: 'Address', blurb: 'Review comments fixed and each thread answered' },
  { id: 'verify', label: 'E2E verify', blurb: 'Driven against the real stack, before/after screenshots' },
  { id: 'acceptance', label: 'Acceptance', blurb: 'Every criterion mapped to evidence' },
  { id: 'risk', label: 'Merge risk', blurb: 'Alignment, impact, verification, rollback, detection' },
  { id: 'proof', label: 'Final proof', blurb: 'Proof comment, human-look verdict, labels set' },
]

export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'opencode', 'custom']
export const REVIEW_COMMAND_MAX = 500
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TRACKERS: readonly Tracker[] = ['jira', 'github', 'linear', 'text', 'pr']
export const TRACKER_SETTINGS: ReadonlyArray<Tracker | 'auto'> = ['auto', 'jira', 'github', 'linear', 'text']
export const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase']
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const

const DAY_MS = 86_400_000
const HARNESS_TTL_MS = 10 * 60_000
const SESSION_TTL_MS = 30 * DAY_MS
const CWD_LOOK_MS = 5 * 60_000
const TRUNKS = ['main', 'master']

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const harnesses = atom({ plugin: 'pr-pipeline', key: 'harnesses' } as const, null as Harnesses | null)
const repos = atom({ plugin: 'pr-pipeline', key: 'repos' } as const, {} as Record<string, RepoRef | null>)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)
const sessionKeys = atom({ plugin: 'pr-pipeline', key: 'sessionKeys' } as const, [] as string[])
const cwdLook = atom({ plugin: 'pr-pipeline', key: 'cwdLook' } as const, null as CwdLook | null)
const openedByPerson = atom({ plugin: 'pr-pipeline', key: 'openedByPerson' } as const, false)

/** `owner/name#branch`, the form `status` and the pane use. */
const RUN_KEY = /^([\w.-]+\/[\w.-]+)#(.+)$/

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

export const freshRun = (key: string, now: number): PipelineRun => ({
  key,
  branch: branchOfKey(key),
  repo: repoOfKey(key),
  stages: STAGES.map(stage => freshStage(stage.id)),
  startedAt: now,
  updatedAt: now,
})

export const isOpenRun = (run: PipelineRun): boolean => run.closedAt === undefined

/** What ties runs to this session: the keys it recorded to, and the run key of its cwd branch. */
export type SessionScope = { keys: readonly string[]; cwdKey: string | null }

export const isSessionKey = (key: string, scope: SessionScope): boolean => key === scope.cwdKey || scope.keys.includes(key)

/** The selected run while it is open, whichever session it belongs to, else the session's most recently updated open run. */
export const pickedKey = (all: Runs, chosen: string | null, scope: SessionScope): string | null => {
  if (chosen !== null && all[chosen] !== undefined && isOpenRun(all[chosen])) return chosen
  return Object.values(all)
    .filter(run => isOpenRun(run) && isSessionKey(run.key, scope))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.key ?? null
}

export async function sessionScope($: EngineInterface): Promise<SessionScope> {
  return { keys: await read($, sessionKeys), cwdKey: (await read($, cwdLook))?.key ?? null }
}

export async function pickedKeyFor($: EngineInterface): Promise<string | null> {
  return pickedKey(await read($, runs), await read($, selectedKey), await sessionScope($))
}

/** Whether the run's toasts belong to this session: it is session-related or on view. */
export async function concernsSession($: EngineInterface, key: string): Promise<boolean> {
  return isSessionKey(key, await sessionScope($)) || (await pickedKeyFor($)) === key
}

export const hasSessionRun = (all: Runs, scope: SessionScope): boolean =>
  Object.values(all).some(run => isOpenRun(run) && isSessionKey(run.key, scope))

async function sessionStoreKey($: EngineInterface): Promise<string | null> {
  const id = await $.session.id().catch(() => null)
  return id === null || id === '' ? null : `${SESSION_PREFIX}${id}`
}

/** Brings back the keys this session recorded before a restart, then drops the keys of sessions idle for a month. */
export async function loadSessionKeys($: EngineInterface): Promise<void> {
  await restoreSessionKeys($)
  await pruneSessions($)
}

/** Restores the session's stored keys and writes them back, so a resumed session's entry is marked in use. */
async function restoreSessionKeys($: EngineInterface): Promise<void> {
  const storeKey = await sessionStoreKey($)
  if (storeKey === null) return
  const saved = await $.store.get(storeKey)
  const keys = (saved as { keys?: unknown } | undefined)?.keys
  if (!Array.isArray(keys)) return
  const known = keys.filter((key): key is string => typeof key === 'string')
  let merged: string[] = []
  await update($, sessionKeys, current => {
    merged = [...new Set([...current, ...known])]
    return merged
  })
  await saveSessionKeys($, merged)
}

async function saveSessionKeys($: EngineInterface, keys: string[]): Promise<void> {
  const storeKey = await sessionStoreKey($)
  if (storeKey === null) return
  await $.store.set(storeKey, { keys, at: await $.clock.now() })
}

export async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'PR pipeline' })
}

/** Ties the key to this session, opening the pane when an open run first becomes the session's; true when it opened it. */
export async function addSessionKey($: EngineInterface, key: string): Promise<boolean> {
  const scope = await sessionScope($)
  if (scope.keys.includes(key)) return false
  let keys: string[] = []
  await update($, sessionKeys, current => {
    keys = current.includes(key) ? current : [...current, key]
    return keys
  })
  await saveSessionKeys($, keys)
  const run = (await read($, runs))[key]
  if (key === scope.cwdKey || run === undefined || !isOpenRun(run)) return false
  void openPane($).catch(() => undefined)
  return true
}

/** Closes the pane once the session has no open run left, unless the person opened it or picked a run. */
export async function closePaneIfIdle($: EngineInterface): Promise<void> {
  if (await read($, openedByPerson)) return
  if (hasSessionRun(await read($, runs), await sessionScope($))) return
  if ((await pickedKeyFor($)) !== null) return
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** The key a run of `slug` and `branch` has, in the casing a stored run already uses. */
export async function runKeyOf($: EngineInterface, slug: string | null, branch: string): Promise<string> {
  if (slug === null) return runKey(null, branch)
  return runKey(canonicalSlug(slug, await read($, runs), null), branch)
}

export type WatchedPr = { prUrl: string; repo?: string; host?: string; cwd?: string }

/**
 * Follows a PR without a pipeline run: the one exception to "only `start` creates a run".
 * A missing or closed entry becomes a PR-only one; an open run only gains the PR when it has none.
 */
export async function watchPr($: EngineInterface, key: string, pr: WatchedPr): Promise<PipelineRun> {
  await followStoreOnce($)
  const previous = (await read($, runs))[key]
  if (previous !== undefined && isOpenRun(previous)) {
    return changeRun($, key, run => (run.prUrl === undefined ? { ...run, prUrl: pr.prUrl } : run), { touch: false })
  }
  const now = await $.clock.now()
  await update($, prStates, all => Object.fromEntries(Object.entries(all).filter(([known]) => known !== key)))
  return changeRun($, key, () => ({
    ...freshRun(key, now),
    prUrl: pr.prUrl,
    prOnly: true,
    ...(pr.repo !== undefined ? { repo: pr.repo } : {}),
    ...(pr.host !== undefined ? { host: pr.host } : {}),
    ...(pr.cwd !== undefined ? { cwd: pr.cwd } : {}),
  }), { create: true })
}

/**
 * Reads the cwd branch's run key, at session start and on a turn once the branch moved or five minutes passed.
 * A branch with no open run gets its open PR followed; a PR dismissed from the pane stays dismissed.
 */
export async function lookAtCwd($: EngineInterface, isStart: boolean): Promise<void> {
  const now = await $.clock.now()
  const previous = await read($, cwdLook)
  const cwd = await $.session.cwd()
  const branch = await currentBranch($, cwd)
  const repo = await repoFor($, cwd)
  const key = branch === null ? null : await runKeyOf($, repo?.slug ?? null, branch)
  if (!isStart && previous !== null && previous.key === key && now - previous.at < CWD_LOOK_MS) return
  const wasRelated = key !== null && isSessionKey(key, await sessionScope($))
  await update($, cwdLook, () => ({ key, at: now }))
  const all = await read($, runs)
  if (isStart && hasSessionRun(all, await sessionScope($))) await openPane($)
  if (key === null || branch === null) return
  const existing = all[key]
  if (existing !== undefined && isOpenRun(existing)) {
    if (!isStart && !wasRelated) await openPane($)
    return
  }
  if (TRUNKS.includes(branch) || repo === null) return
  const found = await openPrOfCheckout($, cwd)
  if (found === null || found.headRefName !== branch || existing?.prUrl === found.url) return
  await watchPr($, key, { prUrl: found.url, repo: repo.slug, host: repo.host, cwd })
  await addSessionKey($, key)
  await openPane($)
}

export async function repoFor($: EngineInterface, cwd: string): Promise<RepoRef | null> {
  const cache = await read($, repos)
  if (cwd in cache) return cache[cwd] ?? null
  const found = await repoRef($, cwd)
  await update($, repos, known => ({ ...known, [cwd]: found }))
  return found
}

/** The casing of a run key already stored, else of the origin remote, for a slug that differs only by case. */
const canonicalSlug = (slug: string, all: Runs, detected: RepoRef | null): string => {
  const lower = slug.toLowerCase()
  const known = Object.keys(all).map(repoOfKey).find(one => one?.toLowerCase() === lower)
  if (known !== undefined) return known
  return detected?.slug.toLowerCase() === lower ? detected.slug : slug
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
  const repo = input.repo !== undefined && input.repo !== '' ? { host: detected?.host ?? 'github.com', slug: canonicalSlug(input.repo, all, detected) } : detected
  if (input.branch !== undefined && all[input.branch] !== undefined && all[input.branch]?.key === input.branch && input.branch.includes('#')) {
    return { key: input.branch, repo, cwd }
  }
  const keyed = input.branch?.match(RUN_KEY)
  if (keyed?.[1] !== undefined && keyed[2] !== undefined) {
    const slug = canonicalSlug(keyed[1], all, detected)
    return { key: runKey(slug, keyed[2]), repo: { host: detected?.host ?? 'github.com', slug }, cwd }
  }
  const branch = input.branch ?? (await currentBranch($, cwd))
  if (branch === null) {
    const chosen = options.fromPane ? await pickedKeyFor($) : null
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

/** Never overwrites a run already at `to`. */
export async function rekeyRun($: EngineInterface, from: string, to: string, repo: RepoRef | null): Promise<boolean> {
  await followStoreOnce($)
  const now = await $.clock.now()
  let moved: PipelineRun | undefined
  await update($, runs, all => {
    const moving = all[from]
    if (moving === undefined || all[to] !== undefined) return all
    const { [from]: _dropped, ...rest } = all
    moved = {
      ...moving, key: to, branch: branchOfKey(to), repo: moving.repo ?? repo?.slug, host: moving.host ?? repo?.host, savedAt: nextSavedAt(moving, now),
    }
    return { ...rest, [to]: moved }
  })
  if (moved === undefined) return false
  await update($, selectedKey, chosen => (chosen === from ? to : chosen))
  await update($, cwdLook, look => (look?.key === from ? { ...look, key: to } : look))
  const keys = await read($, sessionKeys)
  if (keys.includes(from)) {
    const renamed = keys.map(key => (key === from ? to : key))
    await update($, sessionKeys, () => renamed)
    await saveSessionKeys($, renamed)
  }
  await writeRun($, moved)
  await forgetRun($, from)
  return true
}

export async function changeRun(
  $: EngineInterface,
  key: string,
  fn: (run: PipelineRun) => PipelineRun,
  options: { touch?: boolean; create?: boolean } = {},
): Promise<PipelineRun> {
  await followStoreOnce($)
  const now = await $.clock.now()
  let changed: PipelineRun | undefined
  await update($, runs, all => {
    const previous = all[key]
    if (previous === undefined && options.create !== true) return all
    const existing = previous !== undefined ? normaliseRun(previous, key) : freshRun(key, now)
    const next = fn(existing)
    const touched = options.touch === false ? next : { ...next, startedAt: next.startedAt ?? now, updatedAt: now }
    if (previous !== undefined && sameRun(touched, previous)) {
      changed = previous
      return all
    }
    changed = { ...touched, savedAt: nextSavedAt(previous, now) }
    return { ...all, [key]: changed }
  })
  if (changed === undefined) throw new Error(`no run for ${key}`)
  await writeRun($, changed)
  return changed
}

/** Moves the selection off a closed run, to the session's most recently updated open one; the stage detail and status line belong to the viewed run only. */
export async function closeRun($: EngineInterface, key: string): Promise<PipelineRun> {
  const viewed = await pickedKeyFor($)
  const now = await $.clock.now()
  const closed = await changeRun($, key, run => ({ ...run, closedAt: run.closedAt ?? now }), { touch: false })
  const all = await read($, runs)
  const scope = await sessionScope($)
  await update($, selectedKey, chosen => (chosen === key || chosen === null ? pickedKey(all, null, scope) : chosen))
  if (isSessionKey(key, scope)) await closePaneIfIdle($)
  if (viewed !== key) return closed
  await update($, openStage, () => null)
  $.ui.status(undefined)
  return closed
}

/** Same as `start` on a closed run: a merged PR closes it again five minutes after the next fetch. */
export async function reopenRun($: EngineInterface, key: string): Promise<void> {
  await changeRun($, key, ({ closedAt: _closedAt, mergedAt: _mergedAt, ...run }) => run)
  await update($, selectedKey, () => key)
  await update($, openStage, () => null)
}

/** Only a closed run goes: a week after it closed, or a month after its last update. */
const isPrunable = (run: PipelineRun, now: number): boolean =>
  run.closedAt !== undefined && (now - run.closedAt > 7 * DAY_MS || now - run.updatedAt > 30 * DAY_MS)

export const pruneRuns = (all: Runs, now: number): Runs =>
  Object.fromEntries(Object.entries(all).filter(([, run]) => !isPrunable(run, now)))

const savedAtOf = (run: PipelineRun): number => run.savedAt ?? run.updatedAt

/** Later than the copy it replaces, so this write wins the next merge in every session. */
const nextSavedAt = (previous: PipelineRun | undefined, now: number): number =>
  previous === undefined ? now : Math.max(now, savedAtOf(previous) + 1)

const sameRun = (a: PipelineRun, b: PipelineRun): boolean =>
  JSON.stringify({ ...a, savedAt: 0 }) === JSON.stringify({ ...b, savedAt: 0 })

/** JSON text of each run key as this session last read or wrote it. */
const seen = new Map<string, string>()

async function writeRun($: EngineInterface, run: PipelineRun): Promise<void> {
  const storeKey = runStoreKey(run.key)
  const text = JSON.stringify(run)
  if (seen.get(storeKey) === text) return
  seen.set(storeKey, text)
  await $.store.set(storeKey, run)
}

async function forgetRun($: EngineInterface, key: string): Promise<void> {
  seen.delete(runStoreKey(key))
  await $.store.delete(runStoreKey(key))
  await $.store.delete(pollStoreKey(key))
}

/** Splits the single legacy key into one key per run, keeping a newer per-run copy, then deletes it. */
async function migrateLegacyStore($: EngineInterface): Promise<void> {
  const legacy = await $.store.get(LEGACY_STORE_KEY)
  if (legacy === undefined) return
  for (const run of Object.values(normaliseRuns(legacy))) {
    const stored = await $.store.get(runStoreKey(run.key))
    if (stored !== undefined && savedAtOf(stored as PipelineRun) >= savedAtOf(run)) continue
    await $.store.set(runStoreKey(run.key), run)
  }
  await $.store.delete(LEGACY_STORE_KEY)
}

type StoreChanges = { changed: Runs; gone: string[] }

/** The runs whose stored text differs from what this session last saw, and the run keys deleted since; null when nothing moved. */
async function readStoreChanges($: EngineInterface): Promise<StoreChanges | null> {
  await migrateLegacyStore($)
  const changed: Runs = {}
  const present = new Set<string>()
  for (const storeKey of await $.store.keys()) {
    if (!storeKey.startsWith(RUN_PREFIX)) continue
    const value = await $.store.get(storeKey)
    if (value === undefined) continue
    present.add(storeKey)
    const text = JSON.stringify(value)
    if (seen.get(storeKey) === text) continue
    seen.set(storeKey, text)
    const key = storeKey.slice(RUN_PREFIX.length)
    changed[key] = normaliseRun(value as PipelineRun, key)
  }
  const gone = [...seen.keys()].filter(storeKey => !present.has(storeKey))
  gone.forEach(storeKey => seen.delete(storeKey))
  if (Object.keys(changed).length === 0 && gone.length === 0) return null
  return { changed, gone: gone.map(storeKey => storeKey.slice(RUN_PREFIX.length)) }
}

/** Per run, the copy saved last wins; this session's copy wins a tie. */
const mergeRuns = (local: Runs, { changed, gone }: StoreChanges): Runs => {
  const merged = Object.fromEntries(Object.entries(local).filter(([key]) => !gone.includes(key)))
  for (const [key, theirs] of Object.entries(changed)) {
    const ours = merged[key]
    if (ours === undefined || savedAtOf(theirs) > savedAtOf(ours)) merged[key] = theirs
  }
  return merged
}

export async function loadRuns($: EngineInterface): Promise<void> {
  seen.clear()
  await followStoreOnce($)
  await pruneStore($)
}

/** Picks up what other sessions wrote to the store since this one last read or wrote it. */
export async function followStoreOnce($: EngineInterface): Promise<void> {
  const changes = await readStoreChanges($)
  if (changes === null) return
  const before = await read($, runs)
  const viewed = await pickedKeyFor($)
  await update($, runs, local => mergeRuns(local, changes))
  await noticeClosedElsewhere($, before, viewed)
}

/** Does for the session's runs another session closed what `closeRun` does here: toast, move the selection, close an idle pane. */
async function noticeClosedElsewhere($: EngineInterface, before: Runs, viewed: string | null): Promise<void> {
  const after = await read($, runs)
  const scope = await sessionScope($)
  const closed = Object.values(before).filter(run => {
    const merged = after[run.key]
    return isOpenRun(run) && isSessionKey(run.key, scope) && merged !== undefined && !isOpenRun(merged)
  })
  if (closed.length === 0) return
  const closedKeys = closed.map(run => run.key)
  closed.forEach(run => void $.ui.toast(`Run ${run.ticket ?? run.branch} closed`))
  await update($, selectedKey, chosen => (chosen !== null && closedKeys.includes(chosen) ? pickedKey(after, null, scope) : chosen))
  if (viewed !== null && closedKeys.includes(viewed)) {
    await update($, openStage, () => null)
    $.ui.status(undefined)
  }
  await closePaneIfIdle($)
}

/** Drops the run keys of sessions that recorded nothing for a month. */
async function pruneSessions($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const storeKey of await $.store.keys()) {
    if (!storeKey.startsWith(SESSION_PREFIX)) continue
    const at = ((await $.store.get(storeKey)) as { at?: unknown } | undefined)?.at
    if (typeof at === 'number' && now - at <= SESSION_TTL_MS) continue
    await $.store.delete(storeKey)
  }
}

export async function pruneStore($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const doomed = Object.values(await read($, runs)).filter(run => isPrunable(run, now)).map(run => run.key)
  if (doomed.length === 0) return
  for (const key of doomed) await forgetRun($, key)
  await update($, runs, all => Object.fromEntries(Object.entries(all).filter(([key]) => !doomed.includes(key))))
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
  review_command: typeof raw.review_command === 'string' ? raw.review_command.trim().slice(0, REVIEW_COMMAND_MAX) : '',
  review_effort: pickOption(raw.review_effort, EFFORTS, 'low'),
  tracker: pickOption(raw.tracker, TRACKER_SETTINGS, 'auto'),
  merge_method: pickOption(raw.merge_method, MERGE_METHODS, 'squash'),
})

const SETTINGS_STORE_KEY = 'settings'

type StoredSettings = Partial<Record<keyof PipelineOptions, string>>

async function storedSettings($: EngineInterface): Promise<StoredSettings> {
  const value = await $.store.get(SETTINGS_STORE_KEY).catch(() => undefined)
  return typeof value === 'object' && value !== null ? (value as StoredSettings) : {}
}

/** The options in force: picks kept in the store (where `/config` has no row for the plugin) over `userConfig`. */
export async function liveOptions($: EngineInterface, base: PipelineOptions): Promise<PipelineOptions> {
  return pipelineOptions({ ...base, ...(await storedSettings($)) })
}

/** The /config row of one setting; a plugin loaded from a skills folder may have none. */
async function settingRowKey($: EngineInterface, field: keyof PipelineOptions): Promise<string | null> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find(one => one.key === `pr-pipeline.${field}`)
    ?? rows.find(one => one.key.startsWith('pr-pipeline@') && one.key.endsWith(`.${field}`))
  return row?.key ?? null
}

/** Writes one setting through `/config`, else into the store; `{ deny }` when refused, never a throw. */
export async function writeConfig($: EngineInterface, field: keyof PipelineOptions, value: string): Promise<{ deny?: string; stored?: true }> {
  const key = await settingRowKey($, field)
  const stored = await storedSettings($)
  const { [field]: _replaced, ...others } = stored
  if (key === null) {
    await $.store.set(SETTINGS_STORE_KEY, { ...others, [field]: value })
    return { stored: true }
  }
  const written = await $.config.set({ key, value }).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }))
  if (written.deny !== undefined) return { deny: written.deny }
  if (field in stored) await $.store.set(SETTINGS_STORE_KEY, others)
  return {}
}

/** `claude-opus-5-5` → `opus`, so one run never mixes full ids and family names. */
export const shortModel = (model: string): string =>
  CLAUDE_MODELS.find(family => model.toLowerCase().includes(family)) ?? model

/** `opus·low` on the claude backend, `codex·gpt-5-codex` for another backend. */
export const modelChip = (model: StageModel): string =>
  model.backend === 'claude'
    ? [model.model ?? 'claude', model.effort].filter(Boolean).join('·')
    : [model.backend, model.model].filter(Boolean).join('·')

export const modelFull = (model: StageModel): string =>
  [model.backend, model.model, model.effort].filter(Boolean).join('·')

/** A theme key (`success`, `warning`, …) or a CSS color; undefined draws the default. */
export type Color = EngineColor | undefined

/** Acceptance confidence (or its criteria met %), else review's; undefined when neither scored. */
export const runConfidence = (run: PipelineRun): number | undefined => {
  const acceptance = run.stages.find(stage => stage.id === 'acceptance')
  if (acceptance?.confidence !== undefined) return acceptance.confidence
  if (acceptance !== undefined && acceptance.criteria.length > 0) {
    const met = acceptance.criteria.filter(one => one.met === 'yes').length
    return Math.round((met / acceptance.criteria.length) * 100)
  }
  return run.stages.find(stage => stage.id === 'review')?.confidence
}

export const approvalRequired = (run: PipelineRun): boolean =>
  !(run.risk === 'low' && (runConfidence(run) ?? 0) >= 80)

/** Why the merge gate wants a human approval: `risk medium`, `confidence 72%`. */
export const approvalReason = (run: PipelineRun): string => {
  if (run.risk === undefined) return 'risk not assessed'
  if (run.risk !== 'low') return `risk ${run.risk}`
  const confidence = runConfidence(run)
  return confidence === undefined ? 'confidence not scored' : `confidence ${confidence}%`
}
