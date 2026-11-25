import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  Criterion,
  Detail,
  Met,
  PipelineAction,
  PipelineOptions,
  PipelineRun,
  PipelineToolInput,
  PrRef,
  PrSnapshot,
  PrState,
  PrThread,
  Risk,
  Runs,
  Stage,
  StageId,
  StageLink,
  StageModel,
  StageStatus,
  Tier,
} from '../types'
import { currentBranch, git, parsePrUrl, prHeadRef, prHeadSha, prPageUrl, replyToThread, resolveThread } from './github'
import { failedChecks, prRefOf, refreshPr, schedulePrRefresh } from './pr'
import { resolveProfile } from './profile'
import type { ProfileResult } from './profile'
import {
  BACKENDS, CLAUDE_MODELS, EFFORTS, STAGES, TRACKERS, addSessionKey, changeRun, closeRun, ensureHarnesses, followStoreOnce, freshRun,
  isOpenRun, isStageId, openPane, pipelineOptions, rekeyRun, repoFor, resolveRun, runKey, runKeyOf, shortModel, stageLabel, watchPr,
  writeConfig,
} from './runs'
import type { ResolvedRun } from './runs'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)

const ACTIONS: readonly PipelineAction[] = ['start', 'stage', 'link', 'unlink', 'status', 'pr', 'pr-reply', 'pr-resolve', 'settings', 'profile', 'close']
const READ_ONLY: readonly PipelineAction[] = ['status', 'pr', 'settings', 'profile']
const RUN_ONLY: readonly PipelineAction[] = ['stage', 'link', 'unlink']
const STATUSES: readonly StageStatus[] = ['pending', 'running', 'done', 'failed', 'skipped']
const ENDINGS: readonly StageStatus[] = ['done', 'failed', 'skipped']
const TIERS: readonly Tier[] = ['S', 'M', 'L']
const RISKS: readonly Risk[] = ['low', 'medium', 'high']
const METS: readonly Met[] = ['yes', 'partial', 'no']
const DETAILS: readonly Detail[] = ['summary', 'threads', 'full', 'guard']
const DETAIL_ACTIONS: Record<Detail, readonly PipelineAction[]> = { summary: ['status', 'pr'], full: ['status', 'pr'], threads: ['pr'], guard: ['profile'] }
const TITLE_LENGTH = 120
const PR_PAGE = /\/pull\/\d+\/?$/
const BRANCH_MOVE = /\bgit\s+(checkout\s+-b|switch\s+(?:-c|--create)|branch\s+(?:-m|-M|--move)|worktree\s+add\b[^;&|\n]*?\s-[bB])\s+([^;&|\n]+)/
const REFRESH_STAGES: readonly StageId[] = ['pr', 'review', 'address', 'proof']
const VERDICT_STAGES: readonly StageId[] = ['review', 'acceptance', 'proof']
const SHA = /^[0-9a-f]{7,40}$/i
// Host-agnostic so GitHub Enterprise PR urls are captured too.
const PR_URL = /https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/

export type ToolAnswer = { result: string } | { deny: string }

const deny = (text: string): ToolAnswer => ({ deny: `pr-pipeline: ${text}` })

const repairedPrUrl = (url: string | undefined): string | undefined => {
  const ref = url === undefined ? null : parsePrUrl(url)
  return ref === null ? undefined : prPageUrl(ref)
}

const withStage = (run: PipelineRun, id: StageId, fn: (stage: Stage) => Stage): PipelineRun => ({
  ...run,
  stages: run.stages.map(stage => (stage.id === id ? fn(stage) : stage)),
})

const withLink = (stage: Stage, link: StageLink): Stage =>
  stage.links.some(known => known.href === link.href)
    ? { ...stage, links: stage.links.map(known => (known.href === link.href ? link : known)) }
    : { ...stage, links: [...stage.links, link] }

const withCriterion = (criteria: Criterion[], criterion: Criterion): Criterion[] =>
  criteria.some(known => known.text === criterion.text)
    ? criteria.map(known => (known.text === criterion.text ? criterion : known))
    : [...criteria, criterion]

/** A percentage; a fraction below 1 is a ratio sent by mistake. */
const isPercent = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 && !(value > 0 && value < 1)

const stageModel = (input: PipelineToolInput, known: StageModel | undefined): StageModel | undefined => {
  if (input.backend === undefined && input.model === undefined && input.effort === undefined) return known
  const backend = input.backend ?? known?.backend ?? 'claude'
  const isSameBackend = backend === known?.backend
  const given = input.model ?? (isSameBackend ? known?.model : undefined)
  const model = backend === 'claude' && given !== undefined ? shortModel(given) : given
  const effort = input.effort ?? (isSameBackend ? known?.effort : undefined)
  return { backend, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }
}

const isOpenStage = (stage: Stage): boolean => stage.status === 'pending' || stage.status === 'running'

const stageList = (stages: Stage[]): string => stages.map(stage => `${stage.id} (${stage.status})`).join(', ')

/** Every non-empty string of a string-or-list input, in order. */
const entries = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string' && item !== '')

const counted = (name: string, count: number): string | null => {
  if (count === 0) return null
  return count === 1 ? name : `${count} ${name}`
}

const stageSummary = (stage: Stage): Record<string, unknown> => ({
  id: stage.id,
  status: stage.status,
  ...(stage.attempt !== undefined ? { attempt: stage.attempt } : {}),
  ...(stage.summary ? { summary: stage.summary } : {}),
  ...(stage.confidence !== undefined ? { confidence: stage.confidence } : {}),
  ...(stage.headSha !== undefined ? { headSha: stage.headSha } : {}),
  ...(stage.flags.length > 0 ? { flags: stage.flags } : {}),
  ...(stage.did.length > 0 ? { did: stage.did.length } : {}),
  ...(stage.notes.length > 0 ? { notes: stage.notes.length } : {}),
  ...(stage.criteria.length > 0 ? { criteria: stage.criteria.length } : {}),
})

/** The run with each stage cut to its status, verdict, flags and counts. */
export const runSummary = (run: PipelineRun): Record<string, unknown> => ({ ...run, stages: run.stages.map(stageSummary) })

const firstLine = (text: string): string => (text.split('\n').map(line => line.trim()).find(line => line !== '') ?? '').slice(0, TITLE_LENGTH)

const threadPlace = (thread: PrThread): Record<string, unknown> => ({
  id: thread.id,
  path: thread.path,
  ...(thread.line !== null ? { line: thread.line } : {}),
  isResolved: thread.isResolved,
  ...(thread.isOutdated ? { isOutdated: true } : {}),
})

const threadSummary = (thread: PrThread): Record<string, unknown> => {
  const first = thread.comments[0]
  const last = thread.comments[thread.comments.length - 1]
  return {
    ...threadPlace(thread),
    ...(first !== undefined ? { author: first.author } : {}),
    ...(last !== undefined ? { last: last.author } : {}),
    replies: Math.max(thread.comments.length - 1, 0),
    ...(first !== undefined ? { title: firstLine(first.body) } : {}),
  }
}

const threadComments = (thread: PrThread): Record<string, unknown> => ({
  ...threadPlace(thread),
  comments: thread.comments.map(comment => ({
    author: comment.author,
    body: comment.body,
    ...(comment.url !== '' ? { url: comment.url } : {}),
    ...(comment.createdAt !== '' ? { createdAt: comment.createdAt } : {}),
  })),
})

const prHeadline = (snapshot: PrSnapshot): Record<string, unknown> => ({
  number: snapshot.number,
  url: snapshot.url,
  state: snapshot.state,
  isDraft: snapshot.isDraft,
  baseRefName: snapshot.baseRefName,
  mergeable: snapshot.mergeable,
  mergeState: snapshot.mergeState,
  reviewDecision: snapshot.reviewDecision,
  ...(snapshot.headSha !== undefined ? { headSha: snapshot.headSha } : {}),
  labels: snapshot.labels,
  counts: snapshot.counts,
  fetchedAt: snapshot.fetchedAt,
  failing: failedChecks(snapshot).map(check => ({
    name: check.name,
    conclusion: check.conclusion,
    ...(check.runId !== undefined ? { runId: check.runId } : {}),
    ...(check.url !== undefined ? { url: check.url } : {}),
  })),
  pending: snapshot.checks.filter(check => check.status !== 'completed').map(check => check.name),
})

/** The PR's state, failing and pending checks, and one line per thread. */
export const prSummaryAnswer = (snapshot: PrSnapshot): Record<string, unknown> =>
  ({ ...prHeadline(snapshot), threads: snapshot.threads.map(threadSummary) })

/** The summary with the unresolved threads in full, hunks left out. */
export const prThreadsAnswer = (snapshot: PrSnapshot): Record<string, unknown> => {
  const open = snapshot.threads.filter(thread => !thread.isResolved)
  return { ...prHeadline(snapshot), threads: open.map(threadComments), resolved: snapshot.threads.length - open.length }
}

const prAnswer = (snapshot: PrSnapshot, detail: Detail | undefined): Record<string, unknown> | PrSnapshot => {
  if (detail === 'full') return snapshot
  if (detail === 'threads') return prThreadsAnswer(snapshot)
  return prSummaryAnswer(snapshot)
}

const guardAnswer = (result: ProfileResult & { newGuarded?: string[] }): Record<string, unknown> => ({
  ...(result.base !== undefined ? { base: result.base } : {}),
  ...(result.baseRef !== undefined ? { baseRef: result.baseRef } : {}),
  ...(result.changedGuarded !== undefined ? { changedGuarded: result.changedGuarded } : {}),
  ...(result.newGuarded !== undefined ? { newGuarded: result.newGuarded } : {}),
})

const detailRefusal = (input: PipelineToolInput): string | null => {
  if (input.detail === undefined) return null
  if (!DETAILS.includes(input.detail)) return `"detail" must be one of ${DETAILS.join(', ')}.`
  const actions = DETAIL_ACTIONS[input.detail]
  if (!actions.includes(input.action)) return `"detail" ${input.detail} is for ${actions.join(' and ')} only, not ${input.action}.`
  if (input.detail === 'guard' && input.save === true) return '"detail" guard cannot go with "save": true; save without it.'
  return null
}

const noRunText = (key: string, all: Runs): string => {
  const open = Object.values(all).filter(run => isOpenRun(run) && !run.prOnly).map(run => run.key)
  return `no run for ${key}. Open runs: ${open.length > 0 ? open.join(', ') : 'none'}. Pass branch: "<run key>" or call start.`
}

/** The session's model for a claude `running` call that names none; the engine has no session effort to read. */
async function withSessionModel($: EngineInterface, input: PipelineToolInput): Promise<PipelineToolInput> {
  if (input.status !== 'running' || input.model !== undefined || (input.backend ?? 'claude') !== 'claude') return input
  const model = await $.session.model().catch(() => undefined)
  if (model === undefined || model === '') return input
  return { ...input, backend: 'claude', model }
}

const isValidSetting = (field: string, value: unknown, options: PipelineOptions): boolean => {
  if (!(field in options) || typeof value !== 'string' || value === '') return false
  if (field === 'review_model') return true
  return pipelineOptions({ ...options, [field]: value })[field as keyof PipelineOptions] === value
}

const settingsRefusal = (set: Record<string, unknown>, options: PipelineOptions): string | null => {
  if ('review_command' in set) {
    return '"review_command" is a shell command, so only a person sets it: in /config pr-pipeline.review_command or the pane\'s Settings.'
  }
  if (set.reviewer === 'custom' && options.review_command === '') {
    return 'reviewer "custom" needs a review_command to run: ask the person to set /config pr-pipeline.review_command first.'
  }
  return null
}

async function settingsAnswer($: EngineInterface, input: PipelineToolInput, options: PipelineOptions): Promise<ToolAnswer> {
  const set: Record<string, unknown> = input.set ?? {}
  const refusal = settingsRefusal(set, options)
  if (refusal !== null) return deny(refusal)
  const applied: Record<string, string> = {}
  const refused: Record<string, string> = {}
  for (const [field, value] of Object.entries(set)) {
    if (!isValidSetting(field, value, options)) {
      refused[field] = 'not a valid value'
      continue
    }
    const written = await writeConfig($, field as keyof PipelineOptions, String(value))
    if (written.deny === undefined) applied[field] = String(value)
    if (written.deny !== undefined) refused[field] = written.deny
  }
  const found = await ensureHarnesses($)
  const report = Object.keys(refused).length > 0 ? { refused } : {}
  return { result: JSON.stringify({ ...options, ...applied, ...report, harnesses: found, claudeModels: CLAUDE_MODELS, efforts: EFFORTS }) }
}

/** The commit a verdict judged: the given sha, else the PR head on GitHub, else HEAD of the run's checkout; null when unknown. */
async function verdictSha($: EngineInterface, input: PipelineToolInput, run: PipelineRun): Promise<string | null> {
  if (input.sha !== undefined) return input.sha
  const ref = prRefOf(run)
  if (ref !== null) return prHeadSha($, ref, run.cwd)
  const head = await git($, ['rev-parse', 'HEAD'], run.cwd)
  const sha = head.ok ? head.stdout.trim() : ''
  return SHA.test(sha) ? sha : null
}

async function profileAnswer($: EngineInterface, input: PipelineToolInput, key: string, run: PipelineRun): Promise<ToolAnswer> {
  const prBase = prRefOf(run) === null ? '' : (await refreshPr($, key))?.snapshot?.baseRefName ?? ''
  const resolved = await resolveProfile($, run, { save: input.save === true, ...(prBase !== '' ? { prBase } : {}) })
  if (!resolved.ok) return deny(resolved.error)
  const { criteriaDir, profile, changedGuarded } = resolved.result
  const guardedAtStart = run.guardedAtStart ?? changedGuarded
  await changeRun($, key, existing => ({
    ...existing,
    criteriaDir,
    mergeMethod: profile.mergeMethod,
    ...(guardedAtStart !== undefined ? { guardedAtStart: existing.guardedAtStart ?? guardedAtStart } : {}),
  }))
  const newGuarded = changedGuarded !== undefined && guardedAtStart !== undefined ? changedGuarded.filter(path => !guardedAtStart.includes(path)) : undefined
  const answer = { ...resolved.result, ...(newGuarded !== undefined ? { newGuarded } : {}) }
  return { result: JSON.stringify(input.detail === 'guard' ? guardAnswer(answer) : answer) }
}

async function threadAnswer($: EngineInterface, input: PipelineToolInput, key: string): Promise<ToolAnswer> {
  const run = (await read($, runs))[key]
  const ref = prRefOf(run)
  if (ref === null) return deny('this run has no PR.')
  if (!input.threadId) return deny(`"${input.action}" needs threadId.`)
  if (input.action === 'pr-resolve') {
    const resolved = await resolveThread($, ref, input.threadId, run?.cwd)
    if (!resolved.ok) return deny(resolved.error)
    await schedulePrRefresh($, key, 0)
    return { result: `Resolved ${input.threadId}.` }
  }
  if (!input.body) return deny('"pr-reply" needs body.')
  const replied = await replyToThread($, ref, input.threadId, input.body, run?.cwd)
  if (!replied.ok) return deny(replied.error)
  const resolved = input.resolve === true ? await resolveThread($, ref, input.threadId, run?.cwd) : null
  await schedulePrRefresh($, key, 0)
  if (resolved === null) return { result: `Replied to ${input.threadId}.` }
  if (!resolved.ok) return { result: `Replied to ${input.threadId}, but resolving it failed: ${resolved.error}` }
  return { result: `Replied to ${input.threadId} and resolved it.` }
}

export async function handleTool($: EngineInterface, input: PipelineToolInput, options: PipelineOptions): Promise<ToolAnswer> {
  if (!ACTIONS.includes(input.action)) return deny(`"action" must be one of ${ACTIONS.join(', ')}.`)
  const detailDenied = detailRefusal(input)
  if (detailDenied !== null) return deny(detailDenied)
  if (input.action === 'settings') return settingsAnswer($, input, options)
  if (input.tier !== undefined && !TIERS.includes(input.tier)) return deny('"tier" must be S, M or L.')
  if (input.risk !== undefined && !RISKS.includes(input.risk)) return deny('"risk" must be low, medium or high.')
  if (input.backend !== undefined && !BACKENDS.includes(input.backend)) return deny(`"backend" must be one of ${BACKENDS.join(', ')}.`)
  if (input.effort !== undefined && !EFFORTS.includes(input.effort)) return deny(`"effort" must be one of ${EFFORTS.join(', ')}.`)
  if (input.tracker !== undefined && !TRACKERS.includes(input.tracker)) return deny(`"tracker" must be one of ${TRACKERS.join(', ')}.`)
  if (input.status !== undefined && !STATUSES.includes(input.status)) return deny(`"status" must be one of ${STATUSES.join(', ')}.`)
  if (input.confidence !== undefined && !isPercent(input.confidence)) {
    return deny('"confidence" must be a percentage from 0 to 100: 92, not 0.92.')
  }
  const resolved = await resolveRun($, input)
  if (resolved === null) return deny('no branch given and none checked out.')
  const answer = await runAnswer($, input, resolved)
  if (!('result' in answer) || READ_ONLY.includes(input.action)) return answer
  const isOpened = await addSessionKey($, resolved.key)
  if (input.action === 'start' && !isOpened) void openPane($).catch(() => undefined)
  return answer
}

async function runAnswer($: EngineInterface, input: PipelineToolInput, resolved: ResolvedRun): Promise<ToolAnswer> {
  const { key } = resolved
  await followStoreOnce($)
  const all = await read($, runs)
  const before = all[key]
  const now = await $.clock.now()

  if (input.action === 'start') return startAnswer($, input, resolved, before, now)
  if (before === undefined || (before.prOnly && RUN_ONLY.includes(input.action))) return deny(noRunText(key, all))
  if (input.action === 'status') return { result: JSON.stringify(input.detail === 'full' ? before : runSummary(before)) }
  if (input.action === 'close') {
    await closeRun($, key)
    return { result: `Run ${before.ticket ?? key} closed.` }
  }
  if (input.action === 'pr') {
    if (prRefOf(before) === null) return { result: JSON.stringify({ error: 'this run has no PR' }) }
    const state = await refreshPr($, key, { fresh: input.fresh === true, reason: 'tool' })
    if (state?.snapshot === undefined) return { result: JSON.stringify({ error: state?.error ?? 'PR not fetched' }) }
    return { result: JSON.stringify(prAnswer(state.snapshot, input.detail)) }
  }
  if (input.action === 'pr-reply' || input.action === 'pr-resolve') return threadAnswer($, input, key)
  if (input.action === 'profile') return profileAnswer($, input, key, before)

  const prUrl = repairedPrUrl(input.prUrl)
  if (!isStageId(input.stage)) return deny(`"stage" must be one of ${STAGES.map(s => s.id).join(', ')}.`)
  const stageId = input.stage

  if (input.action === 'link') {
    if (!input.href) return deny('"link" needs href.')
    const link: StageLink = { label: input.label ?? input.href, href: input.href }
    const linkedPrUrl = PR_PAGE.test(link.href) ? repairedPrUrl(link.href) ?? link.href : undefined
    const linkedSlug = parsePrUrl(link.href)?.slug
    const run = await changeRun($, key, existing => {
      const isRunRepo = existing.repo === undefined || linkedSlug?.toLowerCase() === existing.repo.toLowerCase()
      const isAdopted = linkedPrUrl !== undefined && isRunRepo && (existing.prUrl === undefined || stageId === 'pr')
      return withStage({ ...existing, prUrl: isAdopted ? linkedPrUrl : existing.prUrl }, stageId, stage => withLink(stage, link))
    })
    await update($, selectedKey, () => key)
    if (run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
    return { result: `Linked ${link.label} to ${stageId}.` }
  }

  if (input.action === 'unlink') return unlinkAnswer($, input, key, stageId, before)

  if (stageId === 'proof' && input.status === 'done') {
    const blocking = before.stages.filter(stage => stage.id !== 'proof' && isOpenStage(stage))
    if (blocking.length > 0) return deny(`proof cannot be done while these are open: ${stageList(blocking)}. Close or skip them first.`)
  }

  if (input.sha !== undefined && !SHA.test(input.sha)) return deny('"sha" must be a commit sha (7 to 40 hex characters).')
  if (input.criterion !== undefined && (input.met === undefined || !METS.includes(input.met))) {
    return deny('a "criterion" needs "met" yes, partial or no.')
  }
  const status = input.status
  const did = entries(input.did)
  const flags = entries(input.flag)
  const notes = entries(input.note)
  const criterion: Criterion | undefined = input.criterion !== undefined && input.met !== undefined
    ? { text: input.criterion, met: input.met, ...(input.evidence !== undefined ? { evidence: input.evidence } : {}) }
    : undefined
  const beforeStatus = before.stages.find(stage => stage.id === stageId)?.status
  const stillOpen = status === 'running'
    ? before.stages.slice(0, STAGES.findIndex(meta => meta.id === stageId)).filter(isOpenStage)
    : []
  const stamped = await withSessionModel($, input)
  const isVerdict = status === 'done' && VERDICT_STAGES.includes(stageId) && (beforeStatus !== 'done' || input.sha !== undefined)
  const headSha = isVerdict ? await verdictSha($, input, before).catch(() => null) : null
  let isUnstartedEnd = false

  const run = await changeRun($, key, existing => {
    const model = stageModel(stamped, existing.models?.[stageId])
    const restarted = (stage: Stage): Stage =>
      ({ ...stage, summary: undefined, confidence: undefined, finishedAt: undefined, attempt: (stage.attempt ?? 1) + 1 })
    return withStage({
      ...existing,
      ticket: input.ticket ?? existing.ticket,
      prUrl: prUrl ?? existing.prUrl,
      tier: input.tier ?? existing.tier,
      risk: input.risk ?? existing.risk,
      models: model === undefined ? existing.models : { ...existing.models, [stageId]: model },
    }, stageId, current => {
      const isStarting = status === 'running' && current.status !== 'running'
      const isRestart = isStarting && (current.status !== 'pending' || current.startedAt !== undefined)
      const isEnding = status !== undefined && status !== current.status && ENDINGS.includes(status)
      const stage = isRestart ? restarted(current) : current
      isUnstartedEnd = (status === 'done' || status === 'skipped') && stage.startedAt === undefined
      return {
        ...stage,
        status: status ?? stage.status,
        startedAt: isStarting || isUnstartedEnd ? now : stage.startedAt,
        finishedAt: isEnding ? now : status !== undefined && !ENDINGS.includes(status) ? undefined : stage.finishedAt,
        summary: input.summary ?? stage.summary,
        confidence: input.confidence ?? stage.confidence,
        did: [...stage.did, ...did],
        flags: [...stage.flags, ...flags],
        notes: [...stage.notes, ...notes],
        criteria: criterion ? withCriterion(stage.criteria, criterion) : stage.criteria,
        headSha: headSha ?? stage.headSha,
      }
    })
  })
  await update($, selectedKey, () => key)

  const isTransition = status !== undefined && status !== beforeStatus && REFRESH_STAGES.includes(stageId)
  if (isTransition || run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
  if (status === 'running') $.ui.status(`pipeline: ${stageLabel(stageId)}`)
  if (status === 'failed') $.ui.status(undefined)
  if (status === 'failed') $.ui.toast(`Pipeline stage ${stageId} failed${input.summary ? `: ${input.summary}` : ''}`)
  if (stageId === 'proof' && status === 'done') {
    $.ui.status(undefined)
    $.ui.toast(`Pipeline done: ${run.branch} is ready for human review`)
  }

  const appended = [counted('did', did.length), counted('flag', flags.length), counted('note', notes.length), criterion ? 'criterion' : null]
    .filter((part): part is string => part !== null)
  const tail = appended.length > 0 ? ` (+${appended.join(', ')})` : ''
  const warnings = [
    isUnstartedEnd ? '(no running call was recorded)' : null,
    stillOpen.length > 0 ? `Still open before this: ${stageList(stillOpen)} — close or skip them.` : null,
  ].filter((line): line is string => line !== null)
  const at = headSha !== null ? ` (at ${headSha.slice(0, 7)})` : ''
  return { result: [`Stage ${stageId} ${status ?? 'updated'}${input.summary ? `: ${input.summary}` : ''}${at}${tail}.`, ...warnings].join(' ') }
}

async function startAnswer(
  $: EngineInterface,
  input: PipelineToolInput,
  resolved: ResolvedRun,
  before: PipelineRun | undefined,
  now: number,
): Promise<ToolAnswer> {
  const { key } = resolved
  const prUrl = repairedPrUrl(input.prUrl)
  const isNewTicket = before?.ticket !== undefined && input.ticket !== undefined && input.ticket !== before.ticket
  // Starting a closed run reopens it; a merged PR closes it again five minutes after the next fetch.
  const run = await changeRun($, key, ({ closedAt: _closedAt, mergedAt: _mergedAt, prOnly: _prOnly, ...kept }) => {
    const existing = isNewTicket ? freshRun(key, now) : kept
    return {
      ...existing,
      ticket: input.ticket ?? existing.ticket,
      ticketUrl: input.ticketUrl ?? existing.ticketUrl,
      tracker: input.tracker ?? existing.tracker,
      title: input.title ?? existing.title,
      prUrl: prUrl ?? repairedPrUrl(existing.prUrl) ?? existing.prUrl,
      tier: input.tier ?? existing.tier,
      repo: (input.repo ? resolved.repo?.slug : undefined) ?? existing.repo ?? resolved.repo?.slug,
      host: existing.host ?? resolved.repo?.host,
      cwd: resolved.cwd,
    }
  }, { create: true })
  if (isNewTicket) await update($, prStates, all => Object.fromEntries(Object.entries(all).filter(([known]) => known !== key)))
  await update($, selectedKey, () => key)
  await update($, openStage, () => null)
  if (run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
  return {
    result: `Pipeline run opened for ${key}${run.ticket ? ` (${run.ticket})` : ''}. ` +
      `Run key: ${key} — pass it as "branch" from any other session, worktree or subagent.`,
  }
}

async function unlinkAnswer(
  $: EngineInterface,
  input: PipelineToolInput,
  key: string,
  stageId: StageId,
  before: PipelineRun,
): Promise<ToolAnswer> {
  if (!input.href) return deny('"unlink" needs href.')
  const href = input.href
  const isRunPr = before.prUrl !== undefined && (href === before.prUrl || (PR_PAGE.test(href) && repairedPrUrl(href) === before.prUrl))
  const isLinked = before.stages.some(stage => stage.id === stageId && stage.links.some(link => link.href === href))
  if (!isLinked && !isRunPr) return deny(`${stageId} has no link to ${href}.`)
  await changeRun($, key, ({ prUrl, pr, mergedAt, ...existing }) => withStage(
    isRunPr ? existing : { ...existing, prUrl, pr, mergedAt },
    stageId,
    stage => ({ ...stage, links: stage.links.filter(link => link.href !== href) }),
  ))
  if (isRunPr) await update($, prStates, all => Object.fromEntries(Object.entries(all).filter(([known]) => known !== key)))
  return { result: `Unlinked ${href} from ${stageId}${isRunPr ? '; the run has no PR now' : ''}.` }
}

export type BranchMove = { kind: 'create' | 'rename' | 'worktree'; from?: string; to: string }

/** `git checkout -b new`, `git switch -c new`, `git branch -m [old] new`, `git worktree add -b new path`; null for anything else. */
export const parseBranchMove = (command: string): BranchMove | null => {
  const match = command.match(BRANCH_MOVE)
  if (match === null) return null
  const kind = match[1]?.startsWith('branch') ? 'rename' : match[1]?.startsWith('worktree') ? 'worktree' : 'create'
  const names = (match[2] ?? '').trim().split(/\s+/).filter(word => word !== '' && !word.startsWith('-')).map(word => word.replace(/^['"]|['"]$/g, ''))
  const [first, second] = names
  if (first === undefined) return null
  if (kind === 'rename' && second !== undefined) return { kind, from: first, to: second }
  return { kind, to: first }
}

export type PendingMove = BranchMove & { from: string }

/** Read before the command runs, so the branch it leaves is known. */
export async function branchMoveBefore($: EngineInterface, command: string): Promise<PendingMove | null> {
  const move = parseBranchMove(command)
  if (move === null) return null
  const from = move.from ?? (await currentBranch($, await $.session.cwd()))
  return from === null || from === move.to ? null : { ...move, from }
}

async function hasBranch($: EngineInterface, name: string, cwd: string): Promise<boolean> {
  return (await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd)).ok
}

/** Moves the open run of the branch left behind onto the new one; a run with a PR stays on a branch it did not rename. */
async function followBranchMove($: EngineInterface, move: PendingMove): Promise<void> {
  const cwd = await $.session.cwd()
  const repo = await repoFor($, cwd)
  const from = runKey(repo?.slug ?? null, move.from)
  await followStoreOnce($)
  const run = (await read($, runs))[from]
  if (run === undefined || !isOpenRun(run) || run.branch !== move.from) return
  if (run.cwd !== undefined && run.cwd !== cwd) return
  if (move.kind !== 'rename' && run.prUrl !== undefined) return
  const isMoved = move.kind === 'worktree'
    ? await hasBranch($, move.to, cwd)
    : (await currentBranch($, cwd)) === move.to ||
      (move.kind === 'rename' && (await hasBranch($, move.to, cwd)) && !(await hasBranch($, move.from, cwd)))
  if (!isMoved) return
  await rekeyRun($, from, runKey(repo?.slug ?? null, move.to), repo)
}

async function attachCreatedPr($: EngineInterface, key: string, created: PrRef, cwd: string): Promise<void> {
  const prUrl = prPageUrl(created)
  await followStoreOnce($)
  const known = (await read($, runs))[key]
  if (known === undefined || !isOpenRun(known) || known.prOnly) {
    const repo = await repoFor($, cwd)
    const isCheckoutRepo = repo?.slug.toLowerCase() === created.slug.toLowerCase()
    await watchPr($, key, { prUrl, repo: created.slug, host: created.host, ...(isCheckoutRepo ? { cwd } : {}) })
    void openPane($).catch(() => undefined)
    return
  }
  await changeRun($, key, existing =>
    withStage({ ...existing, prUrl }, 'pr', stage => withLink(stage, { label: 'Pull request', href: prUrl })))
}

/** Follows a PR `gh pr create` opened under its head branch's run key; false when gh cannot name the head. */
async function followCreatedPr($: EngineInterface, created: PrRef): Promise<boolean> {
  const cwd = await $.session.cwd()
  const head = await prHeadRef($, created, cwd).catch(() => null)
  if (head === null) return false
  const key = await runKeyOf($, created.slug, head)
  await attachCreatedPr($, key, created, cwd)
  await addSessionKey($, key)
  await schedulePrRefresh($, key, 3_000)
  return true
}

export async function afterBash($: EngineInterface, command: string, stdout: string, move: PendingMove | null = null): Promise<void> {
  if (move !== null) await followBranchMove($, move)
  if (!/\bgh\s+(pr|api|run)\b/.test(command)) return
  const created = /\bgh\s+pr\s+create\b/.test(command) ? parsePrUrl(stdout.match(PR_URL)?.[0] ?? '') : null
  if (created !== null && (await followCreatedPr($, created))) return
  const resolved = await resolveRun($, {})
  if (resolved === null) return
  // `gh pr create --repo other/repo` opens a PR that belongs to no run of this checkout.
  if (created !== null && resolved.repo !== null && created.slug !== resolved.repo.slug) return
  if (created !== null) {
    const prUrl = prPageUrl(created)
    const known = (await read($, runs))[resolved.key]
    if (known === undefined || known.closedAt !== undefined) return
    await changeRun($, resolved.key, existing =>
      withStage({ ...existing, prUrl }, 'pr', stage => withLink(stage, { label: 'Pull request', href: prUrl })))
  }
  await schedulePrRefresh($, resolved.key, 3_000)
}

export const TOOL_DESCRIPTION =
  'Records progress of the PR pipeline the pr-pipeline:run skill drives, keyed by repo and branch. ' +
  'action "start" opens a run (ticket, ticketUrl, tracker, title, repo, tier S|M|L, prUrl). ' +
  'action "stage" sets one stage (enhance, implement, pr, review, address, verify, acceptance, risk, proof) ' +
  'to a status (running, done, failed, skipped) with a one-line summary; "running" on a finished stage starts its next attempt. ' +
  'It appends "did" (what was done), "flag" (a warning a developer must see), "note" (a decision), each a string or a list, ' +
  'or a "criterion" with "met" yes|partial|no and "evidence" (the same text replaces the earlier verdict); ' +
  '"confidence" is a percentage 0-100 (92, not 0.92); ' +
  '"backend" (claude|codex|opencode|custom), "model" and "effort" record who ran the stage; ' +
  '"tier" at triage and "risk" low|medium|high at the merge-risk stage are kept on the run. ' +
  'action "link" attaches a labelled URL to a stage; a PR page URL from the run\'s repo becomes the run\'s PR when the run has none, ' +
  'or when linked to the pr stage. action "unlink" (stage, href) removes a link; unlinking the run\'s PR clears it. ' +
  'action "pr" returns the live PR: state, counts, failing and pending checks, one line per thread; ' +
  '"detail": "threads" gives the unresolved threads\' comments instead, "full" the whole snapshot; "fresh" skips the 15 s cache. ' +
  'action "pr-reply" (threadId, body, resolve?) replies to a review thread, then resolves it when "resolve" is true; "pr-resolve" (threadId) resolves one. ' +
  'action "settings" returns the review settings and detected tools; "set" writes settings ' +
  '(reviewer claude|codex|opencode|custom; review_command, the custom reviewer\'s shell command, is returned but only a person sets it, and custom is refused without one). ' +
  'action "profile" resolves the repo profile (.pr-pipeline.json, then .claude/pr-pipeline.json, else discovery from gh and the build files), ' +
  'fills every default, creates the criteria directory and returns { source, path?, fromBase?, discovered?, base?, baseRef?, changedGuarded?, newGuarded?, profile, criteriaDir }; ' +
  '"detail": "guard" keeps only base, baseRef, changedGuarded, newGuarded. ' +
  'base is the run\'s PR base, else the default branch; baseRef (origin/<base>) is fetched on every call; ' +
  'a tracked profile file the branch changes is read from baseRef (fromBase), one the branch adds is ignored; changedGuarded lists the rule-setting or secret-shaped files the branch changes, ' +
  'newGuarded those not there at the run\'s first profile call. ' +
  '"save": true writes a discovered profile as .pr-pipeline.json (left untracked), refused when a profile file exists. ' +
  'A review, acceptance or proof set to done records the commit it judged: "sha", else the PR head, else HEAD. ' +
  'action "close" closes the run. action "status" returns the run with each stage cut to status, verdict, flags and counts; "detail": "full" returns it whole. ' +
  'Only "start" creates a run; a PR followed without one (prOnly) takes "status", "pr", "pr-reply", "pr-resolve" and "close" until "start" turns it into a run. ' +
  'Every other action needs a run, and "proof" cannot be done while another stage is pending or running.'

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    branch: { type: 'string', description: 'Branch, or a run key owner/name#branch; defaults to the checked-out branch' },
    repo: { type: 'string', description: 'owner/name; defaults to the origin remote' },
    ticket: { type: 'string' },
    ticketUrl: { type: 'string' },
    tracker: { type: 'string', enum: [...TRACKERS] },
    title: { type: 'string' },
    prUrl: { type: 'string' },
    tier: { type: 'string', enum: [...TIERS], description: 'Difficulty tier from triage' },
    risk: { type: 'string', enum: [...RISKS], description: 'Merge risk verdict' },
    stage: { type: 'string', enum: STAGES.map(stage => stage.id) },
    status: { type: 'string', enum: [...STATUSES] },
    summary: { type: 'string', description: 'One line shown on the stage row' },
    did: { type: ['string', 'array'], items: { type: 'string' }, description: 'One thing the stage did, or a list, for a developer skimming' },
    flag: { type: ['string', 'array'], items: { type: 'string' }, description: 'A warning the developer must see before trusting the stage, or a list' },
    note: { type: ['string', 'array'], items: { type: 'string' }, description: 'A decision or finding, or a list, appended to the stage' },
    criterion: { type: 'string', description: 'An acceptance criterion, with met and evidence' },
    met: { type: 'string', enum: [...METS] },
    evidence: { type: 'string', description: 'Test name, screenshot path, log line, row' },
    confidence: { type: 'number', minimum: 0, maximum: 100, description: 'A percentage: 92, not 0.92' },
    label: { type: 'string' },
    href: { type: 'string' },
    backend: { type: 'string', enum: [...BACKENDS], description: 'Harness that ran the stage' },
    model: { type: 'string', description: 'Model that ran the stage' },
    effort: { type: 'string', enum: [...EFFORTS] },
    fresh: { type: 'boolean', description: 'pr: skip the 15 s cache' },
    threadId: { type: 'string', description: 'pr-reply, pr-resolve: review thread id' },
    body: { type: 'string', description: 'pr-reply: the reply' },
    resolve: { type: 'boolean', description: 'pr-reply: resolve the thread after replying' },
    detail: { type: 'string', enum: [...DETAILS], description: 'status, pr: summary (default) or full; pr: threads; profile: guard' },
    save: { type: 'boolean', description: 'profile: write a discovered profile as .pr-pipeline.json' },
    sha: { type: 'string', description: 'stage: the commit a done review, acceptance or proof judged; defaults to the PR head' },
    set: {
      type: 'object',
      description: 'settings: fields to write',
      properties: {
        reviewer: { type: 'string', enum: [...BACKENDS] },
        review_model: { type: 'string' },
        review_effort: { type: 'string', enum: [...EFFORTS] },
        tracker: { type: 'string', enum: ['auto', 'jira', 'github', 'linear', 'text'] },
        merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'] },
      },
    },
  },
  required: ['action'],
} as const
