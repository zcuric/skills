import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  Criterion,
  Met,
  PipelineAction,
  PipelineOptions,
  PipelineRun,
  PipelineToolInput,
  PrState,
  Risk,
  Runs,
  Stage,
  StageId,
  StageLink,
  StageModel,
  StageStatus,
  Tier,
} from '../types'
import { currentBranch, git, parsePrUrl, prPageUrl, replyToThread, resolveThread } from './github'
import { prRefOf, refreshPr, schedulePrRefresh } from './pr'
import {
  BACKENDS, CLAUDE_MODELS, EFFORTS, STAGES, TRACKERS, changeRun, closeRun, ensureHarnesses, followStoreOnce, freshRun, isOpenRun,
  isStageId, pipelineOptions, rekeyRun, repoFor, resolveRun, runKey, stageLabel,
} from './runs'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)

const ACTIONS: readonly PipelineAction[] = ['start', 'stage', 'link', 'unlink', 'status', 'pr', 'pr-reply', 'pr-resolve', 'settings', 'close']
const STATUSES: readonly StageStatus[] = ['pending', 'running', 'done', 'failed', 'skipped']
const ENDINGS: readonly StageStatus[] = ['done', 'failed', 'skipped']
const TIERS: readonly Tier[] = ['S', 'M', 'L']
const RISKS: readonly Risk[] = ['low', 'medium', 'high']
const METS: readonly Met[] = ['yes', 'partial', 'no']
const PR_PAGE = /\/pull\/\d+\/?$/
const BRANCH_MOVE = /\bgit\s+(checkout\s+-b|switch\s+(?:-c|--create)|branch\s+(?:-m|-M|--move))\s+([^;&|\n]+)/
const REFRESH_STAGES: readonly StageId[] = ['pr', 'review', 'address', 'proof']
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
  const model = input.model ?? (isSameBackend ? known?.model : undefined)
  const effort = input.effort ?? (isSameBackend ? known?.effort : undefined)
  return { backend, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }
}

const isValidSetting = (field: string, value: unknown, options: PipelineOptions): boolean => {
  if (!(field in options) || typeof value !== 'string' || value === '') return false
  if (field === 'review_model') return true
  return pipelineOptions({ ...options, [field]: value })[field as keyof PipelineOptions] === value
}

async function settingsAnswer($: EngineInterface, input: PipelineToolInput, options: PipelineOptions): Promise<ToolAnswer> {
  const applied: Record<string, string> = {}
  for (const [field, value] of Object.entries(input.set ?? {})) {
    if (!isValidSetting(field, value, options)) continue
    const written = await $.config.set({ key: `pr-pipeline.${field}`, value: String(value) })
    if (written.deny === undefined) applied[field] = String(value)
  }
  const found = await ensureHarnesses($)
  return { result: JSON.stringify({ ...options, ...applied, harnesses: found, claudeModels: CLAUDE_MODELS, efforts: EFFORTS }) }
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
  await schedulePrRefresh($, key, 0)
  return { result: `Replied to ${input.threadId}.` }
}

export async function handleTool($: EngineInterface, input: PipelineToolInput, options: PipelineOptions): Promise<ToolAnswer> {
  if (!ACTIONS.includes(input.action)) return deny(`"action" must be one of ${ACTIONS.join(', ')}.`)
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
  const { key } = resolved
  await followStoreOnce($)
  const before = (await read($, runs))[key]
  const now = await $.clock.now()

  if (input.action === 'status') return { result: JSON.stringify(before ?? null) }
  if (input.action === 'close') {
    if (before === undefined) return deny(`no run for ${key}.`)
    await closeRun($, key)
    return { result: `Run ${before.ticket ?? key} closed.` }
  }
  if (input.action === 'pr') {
    if (prRefOf(before) === null) return { result: JSON.stringify({ error: 'this run has no PR' }) }
    const state = await refreshPr($, key, { fresh: input.fresh === true, reason: 'tool' })
    return { result: JSON.stringify(state?.snapshot ?? { error: state?.error ?? 'PR not fetched' }) }
  }
  if (input.action === 'pr-reply' || input.action === 'pr-resolve') return threadAnswer($, input, key)

  const prUrl = repairedPrUrl(input.prUrl)
  if (input.action === 'start') {
    const isNewTicket = before?.ticket !== undefined && input.ticket !== undefined && input.ticket !== before.ticket
    // Starting a closed run reopens it; a merged PR closes it again five minutes after the next fetch.
    const run = await changeRun($, key, ({ closedAt: _closedAt, mergedAt: _mergedAt, ...kept }) => {
      const existing = isNewTicket ? freshRun(key, now) : kept
      return {
        ...existing,
        ticket: input.ticket ?? existing.ticket,
        ticketUrl: input.ticketUrl ?? existing.ticketUrl,
        tracker: input.tracker ?? existing.tracker,
        title: input.title ?? existing.title,
        prUrl: prUrl ?? repairedPrUrl(existing.prUrl) ?? existing.prUrl,
        tier: input.tier ?? existing.tier,
        repo: input.repo ?? existing.repo ?? resolved.repo?.slug,
        host: existing.host ?? resolved.repo?.host,
        cwd: resolved.cwd,
      }
    })
    if (isNewTicket) await update($, prStates, all => Object.fromEntries(Object.entries(all).filter(([known]) => known !== key)))
    await update($, selectedKey, () => key)
    await update($, openStage, () => null)
    if (run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
    return { result: `Pipeline run opened for ${key}${run.ticket ? ` (${run.ticket})` : ''}.` }
  }

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

  if (input.criterion !== undefined && (input.met === undefined || !METS.includes(input.met))) {
    return deny('a "criterion" needs "met" yes, partial or no.')
  }
  const status = input.status
  const criterion: Criterion | undefined = input.criterion !== undefined && input.met !== undefined
    ? { text: input.criterion, met: input.met, ...(input.evidence !== undefined ? { evidence: input.evidence } : {}) }
    : undefined
  const beforeStatus = before?.stages.find(stage => stage.id === stageId)?.status

  const run = await changeRun($, key, existing => {
    const model = stageModel(input, existing.models?.[stageId])
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
      return {
        ...stage,
        status: status ?? stage.status,
        startedAt: isStarting ? now : stage.startedAt,
        finishedAt: isEnding ? now : status !== undefined && !ENDINGS.includes(status) ? undefined : stage.finishedAt,
        summary: input.summary ?? stage.summary,
        confidence: input.confidence ?? stage.confidence,
        did: input.did ? [...stage.did, input.did] : stage.did,
        flags: input.flag ? [...stage.flags, input.flag] : stage.flags,
        notes: input.note ? [...stage.notes, input.note] : stage.notes,
        criteria: criterion ? withCriterion(stage.criteria, criterion) : stage.criteria,
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

  const appended = [input.did && 'did', input.flag && 'flag', input.note && 'note', criterion && 'criterion'].filter(Boolean)
  const tail = appended.length > 0 ? ` (+${appended.join(', ')})` : ''
  return { result: `Stage ${stageId} ${status ?? 'updated'}${input.summary ? `: ${input.summary}` : ''}${tail}.` }
}

async function unlinkAnswer(
  $: EngineInterface,
  input: PipelineToolInput,
  key: string,
  stageId: StageId,
  before: PipelineRun | undefined,
): Promise<ToolAnswer> {
  if (!input.href) return deny('"unlink" needs href.')
  if (before === undefined) return deny(`no run for ${key}.`)
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

export type BranchMove = { kind: 'create' | 'rename'; from?: string; to: string }

/** `git checkout -b new`, `git switch -c new`, `git branch -m [old] new`; null for anything else. */
export const parseBranchMove = (command: string): BranchMove | null => {
  const match = command.match(BRANCH_MOVE)
  if (match === null) return null
  const kind = match[1]?.startsWith('branch') ? 'rename' : 'create'
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
  if (move.kind === 'create' && run.prUrl !== undefined) return
  const isMoved = (await currentBranch($, cwd)) === move.to ||
    (move.kind === 'rename' && (await hasBranch($, move.to, cwd)) && !(await hasBranch($, move.from, cwd)))
  if (!isMoved) return
  await rekeyRun($, from, runKey(repo?.slug ?? null, move.to), repo)
}

export async function afterBash($: EngineInterface, command: string, stdout: string, move: PendingMove | null = null): Promise<void> {
  if (move !== null) await followBranchMove($, move)
  if (!/\bgh\s+(pr|api|run)\b/.test(command)) return
  const resolved = await resolveRun($, {})
  if (resolved === null) return
  const created = /\bgh\s+pr\s+create\b/.test(command) ? parsePrUrl(stdout.match(PR_URL)?.[0] ?? '') : null
  // `gh pr create --repo other/repo` opens a PR that belongs to no run of this checkout.
  if (created !== null && resolved.repo !== null && created.slug !== resolved.repo.slug) return
  if (created !== null) {
    const prUrl = prPageUrl(created)
    const known = (await read($, runs))[resolved.key]
    if (known?.closedAt !== undefined) return
    await changeRun($, resolved.key, existing =>
      withStage({ ...existing, prUrl }, 'pr', stage => withLink(stage, { label: 'Pull request', href: prUrl })))
  }
  await schedulePrRefresh($, resolved.key, 3_000)
}

export const TOOL_DESCRIPTION =
  'Records progress of the PR pipeline the pr-pipeline:run skill drives, keyed by repo and branch. ' +
  'action "start" opens a run (ticket, ticketUrl, tracker, title, repo, tier S|M|L, prUrl). ' +
  'action "stage" sets one stage (enhance, implement, pr, review, address, verify, acceptance, risk, proof) ' +
  'to a status (running, done, failed, skipped) with a one-line summary; "running" again on a finished stage starts its next attempt. ' +
  'It also appends "did" (what was done), "flag" (a warning a developer must see), "note" (a decision), ' +
  'or a "criterion" with "met" yes|partial|no and "evidence" (the same text replaces the earlier verdict); ' +
  '"confidence" is a percentage 0-100 (92, not 0.92); ' +
  '"backend", "model" and "effort" record who ran the stage; ' +
  '"tier" at triage and "risk" low|medium|high at the merge-risk stage are kept on the run. ' +
  'action "link" attaches a labelled URL to a stage; a PR page URL from the run\'s repo becomes the run\'s PR when the run has none, ' +
  'or when linked to the pr stage. action "unlink" (stage, href) removes a link; unlinking the run\'s PR clears it. ' +
  'action "pr" returns the live PR (checks, reviews, threads) as JSON; "fresh" skips the 15 s cache. ' +
  'action "pr-reply" (threadId, body) replies to a review thread; "pr-resolve" (threadId) resolves one. ' +
  'action "settings" returns the review settings and detected tools; "set" writes settings. ' +
  'action "close" closes the run. action "status" returns the run as JSON.'

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
    did: { type: 'string', description: 'One thing the stage did, for a developer skimming' },
    flag: { type: 'string', description: 'A warning the developer must see before trusting the stage' },
    note: { type: 'string', description: 'A decision or finding, appended to the stage' },
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
