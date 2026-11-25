import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { PipelineOptions, PipelineRun, PipelineToolInput, PrSnapshot, PrState, RepoRef, Runs, Stage, StageId } from '../types'
import { chip, confidenceTone, gauge, INK, isGraphic, pulse, RISK_TONE, STATUS_TONE, tint, track } from './look'
import type { Tone } from './look'
import { card, duration, elapsed, isHuman, isSettingsOpen, prCard, settingsGear, settingsView, stageDetail, STATUS_GLYPH, submitPrompt, threadsCard } from './pane-pr'
import type { PaneContext, PaneEvent } from './pane-pr'
import { deltaReviewPrompt, failingRunIds, fixCiPrompt, heldKey, isPollDue, prRefOf, refreshPr, staleVerdictText, syncPrompt, tick } from './pr'
import {
  STAGES, closeRun, ensureHarnesses, followStoreOnce, isOpenRun, isSessionKey, liveOptions, loadRuns, loadSessionKeys, lookAtCwd, modelChip,
  pickedKeyFor, pipelineOptions, reopenRun, runConfidence, sessionScope, stageLabel,
} from './runs'
import { ARGUMENT_HINT, classifyTicket } from './ticket'
import { afterBash, branchMoveBefore, handleTool, INPUT_SCHEMA, TOOL_DESCRIPTION } from './tool'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)
const repos = atom({ plugin: 'pr-pipeline', key: 'repos' } as const, {} as Record<string, RepoRef | null>)
const showOtherRuns = atom({ plugin: 'pr-pipeline', key: 'showOtherRuns' } as const, false)
const openedByPerson = atom({ plugin: 'pr-pipeline', key: 'openedByPerson' } as const, false)

const PANE = 'pr-pipeline'
const TOOL = 'mcp__pr-pipeline__pipeline'
const LABEL_WIDTH = Math.max(...STAGES.map(stage => stage.label.length))
const CHANGES_REQUESTED = /changes[\s_-]*requested|request(ed|s)?[\s_-]+changes/i
const STALL_MS = 30 * 60_000

type Attention = { key: string; text: string; tone: Tone; onPress?: () => unknown }
type Els = Elements[RenderSurface]

const unmetCount = (stage: Stage): number => stage.criteria.filter(one => one.met !== 'yes').length

/** The latest outcome only: notes and flags keep earlier attempts' history. */
const requestsChanges = (stage: Stage): boolean => stage.id === 'review' && CHANGES_REQUESTED.test(stage.summary ?? '')

async function refreshIfStale($: EngineInterface): Promise<void> {
  const all = await read($, runs)
  const key = await pickedKeyFor($)
  const run = key === null ? undefined : all[key]
  const now = await $.clock.now()
  if (run === undefined || run.key === (await heldKey($, now)) || !(await isPollDue($, run, now))) return
  await refreshPr($, run.key, { reason: 'turn' })
}

/** Opens the pane only when the session has an open run or a followed PR. */
async function startSession($: EngineInterface): Promise<void> {
  await loadRuns($)
  await loadSessionKeys($)
  $.clock.every(60_000, () => void tick($).catch(err => $.ui.toast(String(err))))
  $.clock.every(10_000, () => void followStoreOnce($).catch(err => $.ui.toast(String(err))))
  void ensureHarnesses($).catch(err => $.ui.toast(String(err)))
  void lookAtCwd($, true).catch(err => $.ui.toast(String(err)))
}

function prAttention($: EngineInterface, run: PipelineRun, snapshot: PrSnapshot | undefined): Attention[] {
  const ref = prRefOf(run)
  if (snapshot === undefined || ref === null || snapshot.state !== 'OPEN') return []
  const changesBy = [...new Set(snapshot.reviews.filter(review => review.state === 'CHANGES_REQUESTED' && isHuman(review.author)).map(review => review.author))]
  const humanThreads = snapshot.threads.filter(thread => !thread.isResolved && isHuman(thread.comments[0]?.author ?? 'bot'))
  const failed = snapshot.counts.checksFailed
  const stale = run.closedAt === undefined ? staleVerdictText(run, snapshot) : null
  const reviewedSha = run.stages.find(stage => stage.id === 'review')?.headSha
  const items: Array<Attention | null> = [
    stale !== null && reviewedSha !== undefined && snapshot.headSha !== undefined
      ? { key: 'attn:stale', text: stale, tone: 'warn', onPress: () => submitPrompt($, deltaReviewPrompt(run, ref, reviewedSha, snapshot.headSha ?? '')) }
      : null,
    failed > 0 ? { key: 'attn:ci', text: `✗ ${failed} failing check${failed === 1 ? '' : 's'}`, tone: 'bad', onPress: () => submitPrompt($, fixCiPrompt(ref, failingRunIds(snapshot))) } : null,
    changesBy.length > 0 ? { key: 'attn:changes', text: `Changes requested by ${changesBy.join(', ')}`, tone: 'bad' } : null,
    humanThreads.length > 0 ? { key: 'attn:threads', text: `${humanThreads.length} open review thread${humanThreads.length === 1 ? '' : 's'}`, tone: 'warn' } : null,
    snapshot.mergeState === 'BEHIND' ? { key: 'attn:behind', text: 'behind base', tone: 'warn', onPress: () => submitPrompt($, syncPrompt(ref, snapshot)) } : null,
  ]
  return items.filter((item): item is Attention => item !== null)
}

/** The failed, else running, else next pending stage; undefined once every stage has ended. */
function currentStageId(run: PipelineRun): StageId | undefined {
  return (run.stages.find(stage => stage.status === 'failed')
    ?? run.stages.find(stage => stage.status === 'running')
    ?? run.stages.find(stage => stage.status === 'pending'))?.id
}

/** `◐ AI review`, `✕ Address`, `● done` for a run row. */
function runBrief(run: PipelineRun): { text: string; tone: Tone } {
  const current = run.stages.find(stage => stage.id === currentStageId(run))
  if (current === undefined) return { text: `${STATUS_GLYPH.done} done`, tone: 'good' }
  return { text: `${STATUS_GLYPH[current.status]} ${stageLabel(current.id)}`, tone: STATUS_TONE[current.status] }
}

const runName = (run: PipelineRun): string => run.ticket ?? run.title ?? run.branch

function runRows($: EngineInterface, els: Els, list: PipelineRun[], picked: string | null, cwdRepo: string | undefined) {
  const { Box, Text, Button } = els
  return list.map(one => {
    const brief = one.prOnly ? { text: 'PR only', tone: 'muted' as Tone } : runBrief(one)
    const isPicked = one.key === picked
    return (
      <Box key={`runRow:${one.key}`} flexDirection="row" paddingX={1}
        backgroundColor={isPicked ? tint(els, 'info', 0.12) : undefined} hover={{ backgroundColor: tint(els, 'info', 0.08) }}>
        <Button key={`run:${one.key}`} plain onPress={() => update($, selectedKey, () => one.key).then(() => update($, openStage, () => null))}>
          <Text color={isPicked ? INK.info : undefined} dimColor={!isPicked}>{isPicked ? '● ' : '○ '}</Text>
          <Text weight={one.repo !== undefined && one.repo === cwdRepo ? 'bold' : 'regular'} dimColor={!isPicked}>
            {`${one.repo ?? 'unknown'} · ${one.branch}`}
          </Text>
          <Text dimColor mono>{one.ticket ? `  ${one.ticket}` : ''}</Text>
          <Text color={brief.tone === 'muted' ? undefined : INK[brief.tone]} dimColor={brief.tone === 'muted'}>{`  ${brief.text}`}</Text>
        </Button>
      </Box>
    )
  })
}

/** Other sessions' open runs, behind a row that starts collapsed. */
async function otherRunsBlock($: EngineInterface, els: Els, others: PipelineRun[], picked: string | null, cwdRepo: string | undefined) {
  if (others.length === 0) return null
  const { Box, Button } = els
  const isShown = await read($, showOtherRuns)
  return (
    <Box key="others" flexDirection="column" rowGap={0}>
      <Button key="others:toggle" plain dimColor label={`${isShown ? '▾' : '▸'} Other open runs · ${others.length}`}
        onPress={() => update($, showOtherRuns, shown => !shown)} />
      {isShown ? runRows($, els, others, picked, cwdRepo) : null}
    </Box>
  )
}

function attentionStrip(els: Els, attention: Attention[]) {
  if (attention.length === 0) return null
  const { Box, Text, Button } = els
  const attentionTone: Tone = attention.some(item => item.tone === 'bad') ? 'bad' : 'warn'
  return (
    <Box key="attention" flexDirection="column" rowGap={0} paddingX={2} paddingY={1}
      borderStyle="round" borderColor={INK[attentionTone]} backgroundColor={tint(els, attentionTone, 0.1)}>
      <Text size="caption" weight="bold" color={INK[attentionTone]}>{`⚠ NEEDS ATTENTION · ${attention.length}`}</Text>
      {attention.map(item => {
        const text = <Text color={INK[item.tone]} weight={item.tone === 'bad' ? 'semibold' : 'regular'}>{item.text}</Text>
        const dot = <Text key="dot" color={INK[item.tone]}>{'• '}</Text>
        if (item.onPress === undefined) return <Box key={`${item.key}:row`} flexDirection="row">{dot}<Text key={item.key} color={INK[item.tone]}>{item.text}</Text></Box>
        return (
          <Box key={`${item.key}:row`} flexDirection="row" hover={{ backgroundColor: tint(els, item.tone, 0.12) }}>
            {dot}
            <Button key={item.key} plain onPress={item.onPress}>{text}</Button>
          </Box>
        )
      })}
    </Box>
  )
}

/** A PR followed without a pipeline run: its header, PR and threads, and no stages. */
function prOnlyHeader($: EngineInterface, els: Els, ctx: PaneContext) {
  const { Box, Text, Button, Link } = els
  const { key, run, options } = ctx
  const prNumber = prRefOf(run)?.number
  const prUrl = run.prUrl
  return card(els, 'run', [
    <Box key="run:top" flexDirection="column" flexShrink={1} minWidth={0}>
      <Text key="run:title" size="title" weight="bold" wrap="wrap">{run.title ?? run.pr?.title ?? run.branch}</Text>
      <Text key="run:where" mono size="footnote" dimColor wrap="truncate-middle">{`${run.repo ?? 'unknown'} · ${run.branch}`}</Text>
    </Box>,
    <Box key="run:badges" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
      {prUrl !== undefined && prNumber !== undefined ? <Link href={prUrl} label={`PR #${prNumber}`} /> : null}
      <Box flexDirection="row" alignItems="center" gap={1}>
        {prUrl !== undefined
          ? <Button key="run:pipeline" plain label="Run pipeline on this PR" onPress={() => submitPrompt($, classifyTicket(prUrl, options.tracker).prompt)} />
          : null}
        <Button key="run:dismiss" plain dimColor label="Dismiss" onPress={() => void closeRun($, key).catch(err => $.ui.toast(String(err)))} />
      </Box>
    </Box>,
  ])
}

async function renderPane($: EngineInterface, e: PaneEvent, options: PipelineOptions) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link } = els
  const all = await read($, runs)
  const key = await pickedKeyFor($)
  const open = await read($, openStage)
  const now = await $.clock.now()
  const run = key === null ? undefined : all[key]
  const openTo = (id: StageId | null) => () => update($, openStage, () => id)
  const scope = await sessionScope($)
  const cwdRepo = (await read($, repos))[await $.session.cwd()]?.slug
  const openRuns = Object.values(all).filter(isOpenRun).sort((a, b) => b.updatedAt - a.updatedAt)
  const sessionRuns = openRuns.filter(one => isSessionKey(one.key, scope))
  const others = await otherRunsBlock($, els, openRuns.filter(one => !isSessionKey(one.key, scope)), key, cwdRepo)

  if (await isSettingsOpen($)) return settingsView($, e, options, run)
  if (key === null || run === undefined) {
    const last = Object.values(all)
      .filter(one => one.closedAt !== undefined && isSessionKey(one.key, scope))
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0]
    const lastLine = last === undefined ? '' : `${runName(last)}${last.mergedAt !== undefined ? ' merged ·' : ''} closed ${duration(now - (last.closedAt ?? now))} ago`
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
        {settingsGear($, e)}
        {card(els, 'empty', [
          <Text key="empty:title" size="heading" weight="bold">{last === undefined ? 'No pipeline run yet' : 'No open pipeline run'}</Text>,
          <Text key="empty:hint" dimColor wrap="wrap">Type /pipeline with a ticket key (ABC-123), a GitHub issue (#123), a PR URL, or the task in words.</Text>,
          last === undefined ? null : (
            <Box key="empty:last" flexDirection="row" justifyContent="space-between" gap={1}>
              <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{lastLine}</Text></Box>
              <Button key="empty:reopen" plain label="Reopen" onPress={() => void reopenRun($, last.key).catch(err => $.ui.toast(String(err)))} />
            </Box>
          ),
        ])}
        {others}
      </Box>
    )
  }
  const ctx: PaneContext = { key, run, now, options }
  const snapshot = (await read($, prStates))[key]?.snapshot
  const currentId = currentStageId(run)
  const confidence = runConfidence(run)
  const prNumber = prRefOf(run)?.number

  const switcher = sessionRuns.length < 2 ? null : card(els, 'runs', runRows($, els, sessionRuns, key, cwdRepo),
    { title: 'Runs', aside: chip(els, String(sessionRuns.length), 'muted'), gap: 0 })

  if (run.prOnly) {
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
        {settingsGear($, e)}
        {switcher}
        {others}
        {prOnlyHeader($, els, ctx)}
        {attentionStrip(els, prAttention($, run, snapshot))}
        {await prCard($, e, ctx)}
        {await threadsCard($, e, ctx)}
      </Box>
    )
  }

  const closesIn = run.mergedAt === undefined ? 0 : Math.max(0, Math.ceil((run.mergedAt + 5 * 60_000 - now) / 60_000))
  const closeNow = () => void closeRun($, key).catch(err => $.ui.toast(String(err)))
  const doneCount = run.stages.filter(stage => stage.status === 'done' || stage.status === 'skipped').length
  const confidenceLabel = confidence === undefined ? 'Confidence —' : `Confidence ${confidence}%`
  const confidenceBadge = isGraphic(els)
    ? (
      <Box key="run:confidence" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {gauge(els, 'run:gauge', confidence)}
        <Text weight="semibold" tabular color={confidence === undefined ? undefined : INK[confidenceTone(confidence)]} dimColor={confidence === undefined}>
          {confidenceLabel}
        </Text>
      </Box>
    )
    : chip(els, confidenceLabel, confidenceTone(confidence), { key: 'run:confidence' })
  const header = card(els, 'run', [
    <Box key="run:top" flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
        {run.ticket !== undefined ? <Box flexShrink={0}><Text key="run:ticket" mono size="footnote" weight="semibold" color={INK.info}>{run.ticket}</Text></Box> : null}
        {confidenceBadge}
      </Box>
      <Text key="run:title" size="title" weight="bold" wrap="wrap">{run.title ?? run.branch}</Text>
      <Text key="run:where" mono size="footnote" dimColor wrap="truncate-middle">{`${run.repo ?? 'unknown'} · ${run.tracker ?? 'no tracker'} · ${run.branch}`}</Text>
    </Box>,
    track(els, 'run:track', run.stages.map(stage => stage.status), `${doneCount} of ${STAGES.length} stages done`),
    <Box key="run:badges" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {run.risk ? chip(els, `Risk ${run.risk}`, RISK_TONE[run.risk], { key: 'run:risk' }) : chip(els, 'Risk —', 'muted', { key: 'run:risk' })}
        {run.tier ? chip(els, `Tier ${run.tier}`, 'info', { key: 'run:tier' }) : null}
        {run.prUrl && prNumber !== undefined ? <Link href={run.prUrl} label={`PR #${prNumber}`} /> : null}
      </Box>
      {run.mergedAt !== undefined
        ? (
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            <Text color={INK.merged} weight="semibold">{`Merged · closes in ${closesIn} min`}</Text>
            <Button key="run:close" plain label="Close now" onPress={closeNow} />
          </Box>
        )
        : <Button key="run:close" plain dimColor label="Close run" onPress={closeNow} />}
    </Box>,
  ], { tone: run.mergedAt !== undefined ? 'merged' : undefined })

  const running = run.stages.find(stage => stage.status === 'running')
  const quietFor = now - run.updatedAt
  const stalled: Attention[] = running !== undefined && quietFor > STALL_MS
    ? [{ key: 'attn:stalled', text: `Stalled at ${stageLabel(running.id)} · no update ${duration(quietFor)}`, tone: 'warn', onPress: openTo(running.id) }]
    : []
  const attention: Attention[] = [
    ...stalled,
    ...run.stages.flatMap((stage): Attention[] => {
      const unmet = unmetCount(stage)
      const parts = [
        stage.status === 'failed' ? 'failed' : null,
        requestsChanges(stage) ? 'changes requested' : null,
        unmet > 0 ? `✗${unmet} unmet` : null,
        stage.flags.length > 0 ? `⚠${stage.flags.length}` : null,
      ].filter((part): part is string => part !== null)
      if (parts.length === 0) return []
      const isSevere = stage.status === 'failed' || requestsChanges(stage) || unmet > 0
      return [{ key: `attn:${stage.id}`, text: `${stageLabel(stage.id)} ${parts.join(' ')}`, tone: isSevere ? 'bad' : 'warn', onPress: openTo(stage.id) }]
    }),
    ...prAttention($, run, snapshot),
  ]

  const isFinished = run.stages.every(stage => stage.status !== 'pending' && stage.status !== 'running')
  const lastFinish = Math.max(0, ...run.stages.map(stage => stage.finishedAt ?? 0))
  const stagesAside = [
    `${doneCount}/${STAGES.length} done`,
    run.startedAt !== undefined && isFinished && lastFinish > 0 ? `took ${duration(lastFinish - run.startedAt)}` : `updated ${duration(now - run.updatedAt)} ago`,
  ].join(' · ')

  const stageRow = (stage: Stage, at: number) => {
    const isCurrent = stage.id === currentId
    const isOpen = stage.id === open
    const isPending = stage.status === 'pending'
    const isQuiet = isPending && !isCurrent && !isOpen
    const unmet = unmetCount(stage)
    const time = stage.status === 'running' || stage.status === 'done' || stage.status === 'failed' ? elapsed(stage, now) : ''
    const verdict = stage.id === 'risk' ? run.risk : undefined
    const model = run.models?.[stage.id]
    const tone = STATUS_TONE[stage.status]
    const glyphInk = tone === 'muted' ? undefined : INK[tone]
    const rowFill = isOpen ? tint(els, 'info', 0.14) : stage.status === 'failed' ? tint(els, 'bad', 0.08) : isCurrent ? tint(els, tone, 0.08) : undefined
    const marker = stage.status === 'running' && isGraphic(els)
      ? pulse(els, `pulse:${stage.id}`, 'warn')
      : <Text key={`glyph:${stage.id}`} color={glyphInk} weight="bold" dimColor={isQuiet || glyphInk === undefined}>{STATUS_GLYPH[stage.status]}</Text>
    return (
      <Box key={`row:${stage.id}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2} paddingX={1}
        backgroundColor={rowFill} hover={{ backgroundColor: tint(els, 'info', 0.08) }}
        borderStyle={isGraphic(els) ? undefined : isOpen ? 'round' : undefined} borderColor={isOpen ? INK.info : undefined}>
        <Box flexDirection="row" alignItems="flex-start" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexShrink={0} width={2}>{marker}</Box>
          <Box flexShrink={1} minWidth={0}>
            <Button key={`stage:${stage.id}`} plain onPress={openTo(isOpen ? null : stage.id)}>
              <Text mono tabular dimColor>{`${at + 1} `}</Text>
              <Text weight={isCurrent || isOpen ? 'bold' : 'medium'} color={stage.status === 'failed' ? INK.bad : isOpen ? INK.info : undefined}
                dimColor={isQuiet}>
                {(STAGES[at]?.label ?? stage.id).padEnd(LABEL_WIDTH)}
              </Text>
              {stage.status === 'skipped' ? <Text dimColor italic>{'   skipped'}</Text> : null}
              {stage.summary ? <Text dimColor size="footnote" wrap="wrap">{`   ${stage.summary}`}</Text> : null}
            </Button>
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" flexShrink={0} gap={1}>
          {model !== undefined ? <Text dimColor mono size="footnote">{modelChip(model)}</Text> : null}
          {stage.flags.length > 0 ? <Text color={INK.warn} tabular>⚠ {stage.flags.length}</Text> : null}
          {unmet > 0 ? <Text color={INK.bad} tabular>✗ {unmet}</Text> : null}
          {(stage.attempt ?? 1) > 1 ? <Text dimColor size="footnote">{`attempt ${stage.attempt}`}</Text> : null}
          {time ? <Text color={stage.status === 'running' ? INK.warn : undefined} dimColor={stage.status !== 'running'} tabular size="footnote">{time}</Text> : null}
          {verdict ? chip(els, verdict, RISK_TONE[verdict]) : null}
          {stage.confidence !== undefined ? chip(els, `${stage.confidence}%`, confidenceTone(stage.confidence)) : null}
          <Text color={isOpen ? INK.info : undefined} dimColor={!isOpen} weight="bold">{isOpen ? '▾' : '›'}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
      {settingsGear($, e)}
      {switcher}
      {others}
      {header}
      {attentionStrip(els, attention)}
      {await prCard($, e, ctx)}
      {await threadsCard($, e, ctx)}
      {card(els, 'stages', run.stages.map(stageRow), {
        title: 'Stages',
        aside: <Text size="caption" dimColor tabular>{stagesAside}</Text>,
        gap: 0,
      })}
      {await stageDetail($, e, ctx)}
    </Box>
  )
}

export const register: Register = (on, rawOptions) => {
  const options = pipelineOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pipeline',
      description: 'Open the PR pipeline pane; with a ticket, issue, PR or task, start the pipeline on it',
      argumentHint: ARGUMENT_HINT,
    })
    await $.tool.register({ name: 'pipeline', description: TOOL_DESCRIPTION, isDeferred: true, inputSchema: INPUT_SCHEMA })
    await startSession($)
    return next(e)
  })

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (args === '') {
      await update($, openedByPerson, () => true)
      await $.ui.open({ id: PANE, title: 'PR pipeline', focus: true })
      return { text: 'PR pipeline pane opened.' }
    }
    const ticket = classifyTicket(args, (await liveOptions($, options)).tracker)
    await $.ui.open({ id: PANE, title: 'PR pipeline', focus: true })
    // The engine refuses prompt.submit inside a command.run hook: the submit goes out once the command has answered.
    $.clock.after(1, () => void $.prompt.submit({ text: ticket.prompt }).catch(err => $.ui.toast(String(err))))
    return { text: `Pipeline started for ${ticket.ticket}.` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => handleTool($, e as unknown as PipelineToolInput, await liveOptions($, options)))
    .catch((_$, _e, next) => ({ deny: `pr-pipeline: recording the stage failed: ${next.error.message ?? next.error.kind}` }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const move = await branchMoveBefore($, e.command).catch(() => null)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const stdout = typeof ran.result === 'object' && ran.result !== null && 'stdout' in ran.result
      ? String((ran.result as { stdout: unknown }).stdout)
      : ''
    await afterBash($, e.command, stdout, move).catch(err => $.ui.toast(String(err)))
    return ran
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    void refreshIfStale($).catch(err => $.ui.toast(String(err)))
    void lookAtCwd($, false).catch(err => $.ui.toast(String(err)))
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, openedByPerson, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e, await liveOptions($, options)))
}
