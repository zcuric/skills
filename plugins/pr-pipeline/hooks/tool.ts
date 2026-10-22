import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  Criterion,
  Met,
  PipelineOptions,
  PipelineRun,
  PipelineToolInput,
  Risk,
  Runs,
  Stage,
  StageId,
  StageLink,
  StageModel,
  Tier,
} from '../types'
import { parsePrUrl, prPageUrl, replyToThread, resolveThread } from './github'
import { prRefOf, refreshPr, schedulePrRefresh } from './pr'
import {
  BACKENDS, CLAUDE_MODELS, EFFORTS, STAGES, changeRun, closeRun, ensureHarnesses, isStageId, pipelineOptions, resolveRun, stageLabel,
} from './runs'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)

const TIERS: readonly Tier[] = ['S', 'M', 'L']
const RISKS: readonly Risk[] = ['low', 'medium', 'high']
const METS: readonly Met[] = ['yes', 'partial', 'no']
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
  if (input.action === 'settings') return settingsAnswer($, input, options)
  if (input.tier !== undefined && !TIERS.includes(input.tier)) return deny('"tier" must be S, M or L.')
  if (input.risk !== undefined && !RISKS.includes(input.risk)) return deny('"risk" must be low, medium or high.')
  if (input.backend !== undefined && !BACKENDS.includes(input.backend)) return deny(`"backend" must be one of ${BACKENDS.join(', ')}.`)
  if (input.effort !== undefined && !EFFORTS.includes(input.effort)) return deny(`"effort" must be one of ${EFFORTS.join(', ')}.`)
  const resolved = await resolveRun($, input)
  if (resolved === null) return deny('no branch given and none checked out.')
  const { key } = resolved
  const before = (await read($, runs))[key]

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
    // Starting a closed run reopens it; a merged PR closes it again five minutes after the next fetch.
    const run = await changeRun($, key, ({ closedAt: _closedAt, mergedAt: _mergedAt, ...existing }) => ({
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
    }))
    await update($, selectedKey, () => key)
    await update($, openStage, () => null)
    if (run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
    return { result: `Pipeline run opened for ${key}${run.ticket ? ` (${run.ticket})` : ''}.` }
  }

  if (!isStageId(input.stage)) return deny(`"stage" must be one of ${STAGES.map(s => s.id).join(', ')}.`)
  const stageId = input.stage
  const now = await $.clock.now()

  if (input.action === 'link') {
    if (!input.href) return deny('"link" needs href.')
    const link: StageLink = { label: input.label ?? input.href, href: input.href }
    const isPrPage = /\/pull\/\d+\/?$/.test(link.href)
    const run = await changeRun($, key, existing =>
      withStage({ ...existing, prUrl: isPrPage ? repairedPrUrl(link.href) ?? link.href : existing.prUrl }, stageId, stage => withLink(stage, link)))
    await update($, selectedKey, () => key)
    if (run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
    return { result: `Linked ${link.label} to ${stageId}.` }
  }

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
    return withStage({
      ...existing,
      ticket: input.ticket ?? existing.ticket,
      prUrl: prUrl ?? existing.prUrl,
      tier: input.tier ?? existing.tier,
      risk: input.risk ?? existing.risk,
      models: model === undefined ? existing.models : { ...existing.models, [stageId]: model },
    }, stageId, stage => {
      const nextStatus = status ?? stage.status
      const isStarting = nextStatus === 'running' && stage.startedAt === undefined
      const isEnding = nextStatus === 'done' || nextStatus === 'failed' || nextStatus === 'skipped'
      return {
        ...stage,
        status: nextStatus,
        startedAt: isStarting ? now : stage.startedAt,
        finishedAt: isEnding ? now : undefined,
        summary: input.summary ?? stage.summary,
        confidence: input.confidence ?? stage.confidence,
        did: input.did ? [...stage.did, input.did] : stage.did,
        flags: input.flag ? [...stage.flags, input.flag] : stage.flags,
        notes: input.note ? [...stage.notes, input.note] : stage.notes,
        criteria: criterion ? [...stage.criteria, criterion] : stage.criteria,
      }
    })
  })
  await update($, selectedKey, () => key)

  const isTransition = status !== undefined && status !== beforeStatus && REFRESH_STAGES.includes(stageId)
  if (isTransition || run.prUrl !== before?.prUrl) await schedulePrRefresh($, key, 2_000)
  if (status === 'running') $.ui.status(`pipeline: ${stageLabel(stageId)}`)
  if (status === 'failed') $.ui.toast(`Pipeline stage ${stageId} failed${input.summary ? `: ${input.summary}` : ''}`)
  if (stageId === 'proof' && status === 'done') {
    $.ui.status(undefined)
    $.ui.toast(`Pipeline done: ${run.branch} is ready for human review`)
  }

  const appended = [input.did && 'did', input.flag && 'flag', input.note && 'note', criterion && 'criterion'].filter(Boolean)
  const tail = appended.length > 0 ? ` (+${appended.join(', ')})` : ''
  return { result: `Stage ${stageId} ${status ?? 'updated'}${input.summary ? `: ${input.summary}` : ''}${tail}.` }
}

export async function afterBash($: EngineInterface, command: string, stdout: string): Promise<void> {
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
  'to a status (running, done, failed, skipped) with a one-line summary; it also appends ' +
  '"did" (what was done), "flag" (a warning a developer must see), "note" (a decision), ' +
  'or a "criterion" with "met" yes|partial|no and "evidence"; "confidence" 0-100; ' +
  '"backend", "model" and "effort" record who ran the stage; ' +
  '"tier" at triage and "risk" low|medium|high at the merge-risk stage are kept on the run. ' +
  'action "link" attaches a labelled URL to a stage; a PR page URL becomes the run\'s PR. ' +
  'action "pr" returns the live PR (checks, reviews, threads) as JSON; "fresh" skips the 15 s cache. ' +
  'action "pr-reply" (threadId, body) replies to a review thread; "pr-resolve" (threadId) resolves one. ' +
  'action "settings" returns the review settings and detected tools; "set" writes settings. ' +
  'action "close" closes the run. action "status" returns the run as JSON.'

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'stage', 'link', 'status', 'pr', 'pr-reply', 'pr-resolve', 'settings', 'close'] },
    branch: { type: 'string', description: 'Branch, or a run key owner/name#branch; defaults to the checked-out branch' },
    repo: { type: 'string', description: 'owner/name; defaults to the origin remote' },
    ticket: { type: 'string' },
    ticketUrl: { type: 'string' },
    tracker: { type: 'string', enum: ['jira', 'github', 'linear', 'text', 'pr'] },
    title: { type: 'string' },
    prUrl: { type: 'string' },
    tier: { type: 'string', enum: [...TIERS], description: 'Difficulty tier from triage' },
    risk: { type: 'string', enum: [...RISKS], description: 'Merge risk verdict' },
    stage: { type: 'string', enum: STAGES.map(stage => stage.id) },
    status: { type: 'string', enum: ['pending', 'running', 'done', 'failed', 'skipped'] },
    summary: { type: 'string', description: 'One line shown on the stage row' },
    did: { type: 'string', description: 'One thing the stage did, for a developer skimming' },
    flag: { type: 'string', description: 'A warning the developer must see before trusting the stage' },
    note: { type: 'string', description: 'A decision or finding, appended to the stage' },
    criterion: { type: 'string', description: 'An acceptance criterion, with met and evidence' },
    met: { type: 'string', enum: [...METS] },
    evidence: { type: 'string', description: 'Test name, screenshot path, log line, row' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
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
