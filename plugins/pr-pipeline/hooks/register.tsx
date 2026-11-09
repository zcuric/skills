import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PipelineOptions, PipelineRun, PipelineToolInput, PrSnapshot, PrState, RepoRef, Runs, Stage, StageId } from '../types'
import { card, duration, elapsed, isHuman, pill, prCard, RISK_COLOR, settingsCard, stageDetail, STATUS_COLOR, STATUS_GLYPH, submitPrompt, threadsCard } from './pane-pr'
import type { PaneContext, PaneEvent } from './pane-pr'
import { failingRunIds, fixCiPrompt, prRefOf, refreshPr, syncPrompt, tick } from './pr'
import {
  STAGES, closeRun, confidenceColor, ensureHarnesses, followStoreOnce, isOpenRun, loadRuns, modelChip, pickedKey, pipelineOptions,
  reopenRun, runConfidence, stageLabel,
} from './runs'
import type { Color } from './runs'
import { ARGUMENT_HINT, classifyTicket } from './ticket'
import { afterBash, branchMoveBefore, handleTool, INPUT_SCHEMA, TOOL_DESCRIPTION } from './tool'

const runs = atom({ plugin: 'pr-pipeline', key: 'runs' } as const, {} as Runs)
const selectedKey = atom({ plugin: 'pr-pipeline', key: 'selectedKey' } as const, null as string | null)
const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)
const replying = atom({ plugin: 'pr-pipeline', key: 'replying' } as const, null as string | null)
const repos = atom({ plugin: 'pr-pipeline', key: 'repos' } as const, {} as Record<string, RepoRef | null>)

const PANE = 'pr-pipeline'
const TOOL = 'mcp__pr-pipeline__pipeline'
const LABEL_WIDTH = Math.max(...STAGES.map(stage => stage.label.length))
const CHANGES_REQUESTED = /changes[\s_-]*requested|request(ed|s)?[\s_-]+changes/i
const STALL_MS = 30 * 60_000

type Attention = { key: string; text: string; color: Color; onPress?: () => unknown }

const unmetCount = (stage: Stage): number => stage.criteria.filter(one => one.met !== 'yes').length

/** The latest outcome only: notes and flags keep earlier attempts' history. */
const requestsChanges = (stage: Stage): boolean => stage.id === 'review' && CHANGES_REQUESTED.test(stage.summary ?? '')

async function refreshIfStale($: EngineInterface): Promise<void> {
  const key = pickedKey(await read($, runs), await read($, selectedKey))
  if (key === null || (await read($, replying)) !== null) return
  const state = (await read($, prStates))[key]
  if (state !== undefined && (await $.clock.now()) - state.fetchedAt < 30_000) return
  await refreshPr($, key, { reason: 'turn' })
}

async function startSession($: EngineInterface): Promise<void> {
  await loadRuns($)
  $.clock.every(60_000, () => void tick($).catch(err => $.ui.toast(String(err))))
  $.clock.every(10_000, () => void followStoreOnce($).catch(err => $.ui.toast(String(err))))
  void ensureHarnesses($).catch(err => $.ui.toast(String(err)))
}

function prAttention($: EngineInterface, run: PipelineRun, snapshot: PrSnapshot | undefined): Attention[] {
  const ref = prRefOf(run)
  if (snapshot === undefined || ref === null || snapshot.state !== 'OPEN') return []
  const changesBy = [...new Set(snapshot.reviews.filter(review => review.state === 'CHANGES_REQUESTED' && isHuman(review.author)).map(review => review.author))]
  const humanThreads = snapshot.threads.filter(thread => !thread.isResolved && isHuman(thread.comments[0]?.author ?? 'bot'))
  const failed = snapshot.counts.checksFailed
  const items: Array<Attention | null> = [
    failed > 0 ? { key: 'attn:ci', text: `✗ ${failed} failing check${failed === 1 ? '' : 's'}`, color: 'red', onPress: () => submitPrompt($, fixCiPrompt(ref, failingRunIds(snapshot))) } : null,
    changesBy.length > 0 ? { key: 'attn:changes', text: `Changes requested by ${changesBy.join(', ')}`, color: 'red' } : null,
    humanThreads.length > 0 ? { key: 'attn:threads', text: `${humanThreads.length} open review thread${humanThreads.length === 1 ? '' : 's'}`, color: 'yellow' } : null,
    snapshot.mergeState === 'BEHIND' ? { key: 'attn:behind', text: 'behind base', color: 'yellow', onPress: () => submitPrompt($, syncPrompt(ref, snapshot)) } : null,
  ]
  return items.filter((item): item is Attention => item !== null)
}

function runState(run: PipelineRun, now: number): { text: string; color: Color; aside?: string; currentId?: StageId } {
  const failed = run.stages.find(stage => stage.status === 'failed')
  if (failed) return { text: `${STATUS_GLYPH.failed} Failed at ${stageLabel(failed.id)}`, color: 'red', currentId: failed.id }
  const running = run.stages.find(stage => stage.status === 'running')
  if (running) return { text: `${STATUS_GLYPH.running} Running: ${stageLabel(running.id)}`, color: 'yellow', aside: elapsed(running, now), currentId: running.id }
  const next = run.stages.find(stage => stage.status === 'pending')
  if (next === undefined) return { text: `${STATUS_GLYPH.done} Ready for human review`, color: 'green' }
  if (run.stages.every(stage => stage.status === 'pending')) return { text: `${STATUS_GLYPH.pending} Not started`, color: undefined, currentId: next.id }
  return { text: `${STATUS_GLYPH.pending} Next: ${stageLabel(next.id)}`, color: undefined, currentId: next.id }
}

/** `◐ AI review`, `✕ Address`, `● done` for a Runs switcher row. */
function runBrief(run: PipelineRun, now: number): { text: string; color: Color } {
  const state = runState(run, now)
  const current = run.stages.find(stage => stage.id === state.currentId)
  if (current === undefined) return { text: `${STATUS_GLYPH.done} done`, color: 'green' }
  return { text: `${STATUS_GLYPH[current.status]} ${stageLabel(current.id)}`, color: STATUS_COLOR[current.status] }
}

const runName = (run: PipelineRun): string => run.ticket ?? run.title ?? run.branch

async function renderPane($: EngineInterface, e: PaneEvent, options: PipelineOptions) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link } = els
  const all = await read($, runs)
  const key = pickedKey(all, await read($, selectedKey))
  const open = await read($, openStage)
  const now = await $.clock.now()
  const run = key === null ? undefined : all[key]
  const openTo = (id: StageId | null) => () => update($, openStage, () => id)

  if (key === null || run === undefined) {
    const last = Object.values(all)
      .filter(one => one.closedAt !== undefined)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0]
    const lastLine = last === undefined ? '' : `${runName(last)}${last.mergedAt !== undefined ? ' merged ·' : ''} closed ${duration(now - (last.closedAt ?? now))} ago`
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
        {card(els, 'empty', [
          <Text key="empty:title" weight="bold">{last === undefined ? 'No pipeline run yet' : 'No open pipeline run'}</Text>,
          <Text key="empty:hint" dimColor>Type /pipeline with a ticket key (ABC-123), a GitHub issue (#123), a PR URL, or the task in words.</Text>,
          last === undefined ? null : (
            <Box key="empty:last" flexDirection="row" justifyContent="space-between" gap={1}>
              <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{lastLine}</Text></Box>
              <Button key="empty:reopen" plain label="Reopen" onPress={() => void reopenRun($, last.key).catch(err => $.ui.toast(String(err)))} />
            </Box>
          ),
        ])}
      </Box>
    )
  }
  const ctx: PaneContext = { key, run, now, options }
  const cwdRepo = (await read($, repos))[await $.session.cwd()]?.slug
  const snapshot = (await read($, prStates))[key]?.snapshot
  const state = runState(run, now)
  const confidence = runConfidence(run)
  const openRuns = Object.values(all).filter(isOpenRun).sort((a, b) => b.updatedAt - a.updatedAt)
  const prNumber = prRefOf(run)?.number

  const switcher = openRuns.length < 2 ? null : card(els, 'runs', openRuns.map(one => {
    const brief = runBrief(one, now)
    return (
      <Button key={`run:${one.key}`} plain onPress={() => update($, selectedKey, () => one.key).then(openTo(null))}>
        <Text weight={one.repo !== undefined && one.repo === cwdRepo ? 'bold' : 'regular'} dimColor={one.key !== key}>
          {`${one.key === key ? '●' : '○'} ${one.repo ?? 'unknown'} · ${one.branch}`}
        </Text>
        <Text dimColor>{one.ticket ? `  ${one.ticket}` : ''}</Text>
        <Text color={brief.color} dimColor={brief.color === undefined}>{`  ${brief.text}`}</Text>
      </Button>
    )
  }), { title: 'Runs', aside: <Text size="caption" dimColor tabular>{openRuns.length}</Text>, gap: 0 })

  const closesIn = run.mergedAt === undefined ? 0 : Math.max(0, Math.ceil((run.mergedAt + 5 * 60_000 - now) / 60_000))
  const closeNow = () => void closeRun($, key).catch(err => $.ui.toast(String(err)))
  const header = card(els, 'run', [
    <Box key="run:title" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Box flexShrink={1} minWidth={0}>
        <Text size="heading" wrap="truncate-end">
          <Text weight="bold">{run.ticket ?? run.title ?? run.branch}</Text>
          {run.ticket !== undefined && run.title ? <Text>{`  ${run.title}`}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        {pill(els, confidence === undefined ? 'Confidence —' : `Confidence ${confidence}%`, confidenceColor(confidence), 'heading')}
      </Box>
    </Box>,
    <Text key="run:where" dimColor wrap="truncate-middle">{`${run.repo ?? 'unknown'} · ${run.tracker ?? 'no tracker'} · ${run.branch}`}</Text>,
    <Box key="run:badges" flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="row" gap={1}>
        {run.risk ? pill(els, `Risk ${run.risk}`, RISK_COLOR[run.risk]) : pill(els, 'Risk —', 'gray')}
        {run.tier ? pill(els, `Tier ${run.tier}`, 'cyan') : null}
        {run.prUrl && prNumber !== undefined ? <Link href={run.prUrl} label={`PR #${prNumber}`} /> : null}
      </Box>
      {run.mergedAt !== undefined
        ? (
          <Box flexDirection="row" gap={1}>
            <Text color="cyan">{`Merged · closes in ${closesIn} min`}</Text>
            <Button key="run:close" plain label="Close now" onPress={closeNow} />
          </Box>
        )
        : <Button key="run:close" plain dimColor label="Close run" onPress={closeNow} />}
    </Box>,
  ])

  const running = run.stages.find(stage => stage.status === 'running')
  const quietFor = now - run.updatedAt
  const stalled: Attention[] = running !== undefined && quietFor > STALL_MS
    ? [{ key: 'attn:stalled', text: `Stalled at ${stageLabel(running.id)} · no update ${duration(quietFor)}`, color: 'yellow', onPress: openTo(running.id) }]
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
      return [{ key: `attn:${stage.id}`, text: `${stageLabel(stage.id)} ${parts.join(' ')}`, color: isSevere ? 'red' : 'yellow', onPress: openTo(stage.id) }]
    }),
    ...prAttention($, run, snapshot),
  ]
  const attentionColor: Color = attention.some(item => item.color === 'red') ? 'red' : 'yellow'
  const attentionStrip = attention.length === 0 ? null : card(els, 'attention', (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text weight="bold" color={attentionColor}>Needs attention</Text>
      {attention.map(item => item.onPress !== undefined
        ? <Button key={item.key} plain onPress={item.onPress}><Text color={item.color}>{item.text}</Text></Button>
        : <Text key={item.key} color={item.color}>{item.text}</Text>)}
    </Box>
  ), { color: attentionColor })

  const doneCount = run.stages.filter(stage => stage.status === 'done' || stage.status === 'skipped').length
  const isFinished = run.stages.every(stage => stage.status !== 'pending' && stage.status !== 'running')
  const lastFinish = Math.max(0, ...run.stages.map(stage => stage.finishedAt ?? 0))
  const times = [
    run.startedAt !== undefined ? `started ${duration(now - run.startedAt)} ago` : null,
    `updated ${duration(now - run.updatedAt)} ago`,
    run.startedAt !== undefined && isFinished && lastFinish > 0 ? `took ${duration(lastFinish - run.startedAt)}` : null,
  ].filter((part): part is string => part !== null).join(' · ')
  const segment = Math.max(1, Math.min(4, Math.floor((e.props.bodyColumns - 4 - (STAGES.length - 1)) / STAGES.length)))
  const progress = card(els, 'progress', [
    <Box key="progress:state" flexDirection="row" justifyContent="space-between" gap={1}>
      <Text color={state.color} dimColor={state.color === undefined} weight="semibold" wrap="truncate-end">
        {state.text}{state.aside ? <Text tabular weight="regular">{` · ${state.aside}`}</Text> : null}
      </Text>
      <Text tabular><Text weight="semibold">{doneCount}</Text><Text dimColor>/{STAGES.length} done</Text></Text>
    </Box>,
    <Text key="progress:bar">
      {run.stages.map((stage, at) => {
        const isCurrent = stage.id === state.currentId
        const isQuiet = (stage.status === 'pending' && !isCurrent) || stage.status === 'skipped'
        return (
          <Text key={`bar:${stage.id}`} color={STATUS_COLOR[stage.status]} dimColor={isQuiet} weight={isCurrent ? 'bold' : 'regular'}>
            {`${at > 0 ? ' ' : ''}${(isCurrent ? '█' : '━').repeat(segment)}`}
          </Text>
        )
      })}
    </Text>,
    <Text key="progress:times" size="footnote" dimColor tabular>{times}</Text>,
  ])

  const stageRow = (stage: Stage, at: number) => {
    const isCurrent = stage.id === state.currentId
    const isOpen = stage.id === open
    const isPending = stage.status === 'pending'
    const unmet = unmetCount(stage)
    const time = stage.status === 'running' || stage.status === 'done' || stage.status === 'failed' ? elapsed(stage, now) : ''
    const verdict = stage.id === 'risk' ? run.risk : undefined
    const model = run.models?.[stage.id]
    const frame: Color = isOpen ? 'cyan' : stage.status === 'failed' ? 'red' : stage.status === 'running' ? 'yellow' : undefined
    return (
      <Box key={`row:${stage.id}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2}
        borderStyle="round" borderColor={frame} borderDimColor={frame === undefined} paddingX={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button key={`stage:${stage.id}`} plain onPress={openTo(isOpen ? null : stage.id)}>
            <Text color={STATUS_COLOR[stage.status]} weight="bold" dimColor={isPending && !isCurrent}>{STATUS_GLYPH[stage.status]}</Text>
            <Text mono tabular dimColor>{`  ${at + 1}  `}</Text>
            <Text mono weight={isCurrent || isOpen ? 'bold' : 'regular'} color={stage.status === 'failed' ? 'red' : isOpen ? 'cyan' : undefined}
              dimColor={isPending && !isCurrent && !isOpen}>
              {(STAGES[at]?.label ?? stage.id).padEnd(LABEL_WIDTH)}
            </Text>
            {stage.status === 'skipped' ? <Text dimColor>{'   skipped'}</Text> : null}
            {stage.summary ? <Text dimColor wrap="wrap">{`   ${stage.summary}`}</Text> : null}
          </Button>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={2}>
          {model !== undefined ? <Text dimColor>{modelChip(model)}</Text> : null}
          {stage.flags.length > 0 ? <Text color="yellow" tabular>⚠ {stage.flags.length}</Text> : null}
          {unmet > 0 ? <Text color="red" tabular>✗ {unmet}</Text> : null}
          {(stage.attempt ?? 1) > 1 ? <Text dimColor>{`attempt ${stage.attempt}`}</Text> : null}
          {time ? <Text color={stage.status === 'running' ? 'yellow' : undefined} dimColor={stage.status !== 'running'} tabular>{time}</Text> : null}
          {verdict ? pill(els, verdict, RISK_COLOR[verdict]) : null}
          {stage.confidence !== undefined ? pill(els, `${stage.confidence}%`, confidenceColor(stage.confidence)) : null}
          <Text color={isOpen ? 'cyan' : undefined} dimColor={!isOpen} weight="bold">{isOpen ? '▾' : '▸'}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
      {switcher}
      {header}
      {attentionStrip}
      {await prCard($, e, ctx)}
      {await threadsCard($, e, ctx)}
      {progress}
      {card(els, 'stages', run.stages.map(stageRow), {
        title: 'Stages',
        aside: <Text size="caption" dimColor>{open === null ? 'select for details' : 'select again to close'}</Text>,
        gap: 0,
      })}
      {await stageDetail($, e, ctx)}
      {await settingsCard($, e, ctx)}
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
    await $.tool.register({ name: 'pipeline', description: TOOL_DESCRIPTION, isDeferred: false, inputSchema: INPUT_SCHEMA })
    await startSession($)
    void $.ui.open({ id: PANE, title: 'PR pipeline' })
    return next(e)
  })

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (args === '') {
      await $.ui.open({ id: PANE, title: 'PR pipeline', focus: true })
      return { text: 'PR pipeline pane opened.' }
    }
    const ticket = classifyTicket(args, options.tracker)
    await $.prompt.submit({ text: ticket.prompt })
    await $.ui.open({ id: PANE, title: 'PR pipeline', focus: true })
    return { text: `Pipeline started for ${ticket.ticket}.` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => handleTool($, e as unknown as PipelineToolInput, options))
    .catch(() => ({ deny: 'pr-pipeline: recording the stage failed.' }))

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
    if (e.agentId === undefined) void refreshIfStale($).catch(err => $.ui.toast(String(err)))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e, options))
}
