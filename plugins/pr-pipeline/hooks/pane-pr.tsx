import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderChildren, RenderInput, RenderSurface } from 'claude-code'

import type { Harnesses, Met, PipelineOptions, PipelineRun, PrSnapshot, PrState, PrThread, Stage, StageId, StageStatus } from '../types'
import { mergeGuard } from './github'
import {
  failedChecks,
  failingRunIds,
  fixCiPrompt,
  fixThreadPrompt,
  mergeFromPane,
  prRefOf,
  refreshPr,
  replyFromPane,
  rerunFromPane,
  rerunnableIds,
  resolveFromPane,
  reviewPrompt,
  riskPrompt,
  syncPrompt,
} from './pr'
import {
  BACKENDS,
  EFFORTS,
  MERGE_METHODS,
  STAGES,
  TRACKER_SETTINGS,
  approvalReason,
  approvalRequired,
  modelChip,
  modelFull,
  runConfidence,
} from './runs'
import { bar, chip, confidenceTone, diffBlocks, gauge, INK, isGraphic, RISK_TONE, STATUS_TONE, tint } from './look'
import type { Tone } from './look'

const openStage = atom({ plugin: 'pr-pipeline', key: 'openStage' } as const, null as StageId | null)
const prStates = atom({ plugin: 'pr-pipeline', key: 'pr' } as const, {} as Record<string, PrState>)
const openThreads = atom({ plugin: 'pr-pipeline', key: 'openThreads' } as const, {} as Record<string, boolean>)
const replying = atom({ plugin: 'pr-pipeline', key: 'replying' } as const, null as string | null)
const drafts = atom({ plugin: 'pr-pipeline', key: 'drafts' } as const, {} as Record<string, string>)
const prBusy = atom({ plugin: 'pr-pipeline', key: 'prBusy' } as const, null as string | null)
const harnesses = atom({ plugin: 'pr-pipeline', key: 'harnesses' } as const, null as Harnesses | null)
const settingsOpen = atom({ plugin: 'pr-pipeline', key: 'settingsOpen' } as const, false)
const showResolved = atom({ plugin: 'pr-pipeline', key: 'showResolved' } as const, false)

export type PaneEvent = RenderInput<'Pane'>
type Els = Elements[RenderSurface]
export type PaneContext = { key: string; run: PipelineRun; now: number; options: PipelineOptions }

export const STATUS_GLYPH: Record<StageStatus, string> = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–' }
const STATUS_WORD: Record<StageStatus, string> = { pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' }
const MET_GLYPH: Record<Met, string> = { yes: '✓', partial: '◐', no: '✗' }
const MET_TONE: Record<Met, Tone> = { yes: 'good', partial: 'warn', no: 'bad' }
const BOT_LOGIN = /\[bot\]$|bot$/i
const BODY_LIMIT = 1500

export const isHuman = (login: string): boolean => !BOT_LOGIN.test(login)

/** `45s`, `12m`, `1h12m`, `2d3h`. */
export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`
}

export const elapsed = (stage: Stage, now: number): string =>
  stage.startedAt === undefined ? '' : duration((stage.finishedAt ?? now) - stage.startedAt)

/** A section: a soft panel on graphical surfaces, a rounded frame on the terminal; `tone` tints it. */
export function card(
  els: Els,
  key: string,
  body: RenderChildren,
  options: { title?: string; aside?: RenderChildren; tone?: Tone; gap?: number } = {},
) {
  const { Box, Text } = els
  const { tone } = options
  const graphic = isGraphic(els)
  return (
    <Box
      key={key}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone !== undefined ? INK[tone] : undefined}
      borderDimColor={tone === undefined}
      backgroundColor={graphic ? tint(els, tone ?? 'muted', tone === undefined ? 0.04 : 0.07) : undefined}
      paddingX={2}
      paddingY={1}
      rowGap={options.gap ?? 1}
    >
      {options.title !== undefined ? (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="caption" weight="bold" color={tone !== undefined ? INK[tone] : undefined} dimColor={tone === undefined}>
            {options.title.toUpperCase()}
          </Text>
          {options.aside ?? null}
        </Box>
      ) : null}
      {body}
    </Box>
  )
}

const stateName = (snapshot: PrSnapshot): string => (snapshot.isDraft && snapshot.state === 'OPEN' ? 'DRAFT' : snapshot.state)
const STATE_TONE: Record<string, Tone> = { OPEN: 'good', MERGED: 'merged', CLOSED: 'bad', DRAFT: 'muted' }
const DECISION: Record<string, { text: string; tone: Tone }> = {
  APPROVED: { text: 'Approved', tone: 'good' },
  CHANGES_REQUESTED: { text: 'Changes requested', tone: 'bad' },
  REVIEW_REQUIRED: { text: 'Review required', tone: 'warn' },
}
const REVIEW_GLYPH: Record<string, string> = { APPROVED: '✓', CHANGES_REQUESTED: '✗' }

export function submitPrompt($: EngineInterface, text: string): void {
  void $.prompt.submit({ text }).catch(err => $.ui.toast(String(err)))
}

export async function prCard($: EngineInterface, e: PaneEvent, ctx: PaneContext): Promise<RenderChildren> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link } = els
  const { key, run, now, options } = ctx
  const ref = prRefOf(run)
  if (ref === null) return null
  const state = (await read($, prStates))[key]
  const busy = await read($, prBusy)
  const snapshot = state?.snapshot

  const footer = state?.isFetching
    ? 'Fetching…'
    : state?.error !== undefined
      ? `PR view unavailable: ${state.error}`
      : snapshot !== undefined
        ? `fetched ${Math.max(0, Math.round((now - snapshot.fetchedAt) / 1000))}s ago`
        : 'Fetching…'
  const refresh = (
    <Button key="pr:refresh" plain hotkey="r" label="↻ Refresh"
      onPress={() => void refreshPr($, key, { fresh: true, reason: 'pane' }).catch(err => $.ui.toast(String(err)))} />
  )
  const footerRow = (
    <Box key="pr:footer" flexDirection="row" justifyContent="space-between" gap={1}>
      <Text size="footnote" dimColor={state?.error === undefined} color={state?.error !== undefined ? INK.bad : undefined} wrap="truncate-end">{footer}</Text>
      {refresh}
    </Box>
  )
  if (snapshot === undefined) {
    return card(els, 'pr', [<Link key="pr:link" href={run.prUrl ?? ''} label={`PR #${ref.number}`} />, footerRow], { title: 'Pull request' })
  }

  const counts = snapshot.counts
  const failing = failedChecks(snapshot)
  const decision = DECISION[snapshot.reviewDecision] ?? { text: 'No review decision', tone: 'muted' as Tone }
  const reviewers = [...new Map(snapshot.reviews.map(review => [review.author, review.state])).entries()]
  const guard = mergeGuard(snapshot, { approvalRequired: approvalRequired(run), why: approvalReason(run) })
  const rerunIds = rerunnableIds(key, snapshot)
  const ciRunIds = failingRunIds(snapshot)
  const isOpen = snapshot.state === 'OPEN'
  const isBusy = busy !== null
  const confidence = runConfidence(run)

  const actions = isBusy
    ? [<Text key="pr:busy" dimColor>Working…</Text>]
    : [
      isOpen ? <Button key="pr:review" plain label="AI review" onPress={() => submitPrompt($, reviewPrompt(run, ref))} /> : null,
      isOpen ? <Button key="pr:risk" plain label="Merge risk" onPress={() => submitPrompt($, riskPrompt(run, ref))} /> : null,
      rerunIds.length > 0
        ? <Button key="pr:rerun" plain label="Rerun failed" onPress={() => void rerunFromPane($, key).catch(err => $.ui.toast(String(err)))} />
        : null,
      counts.checksFailed > 0
        ? <Button key="fix:ci" plain label="Fix CI" onPress={() => submitPrompt($, fixCiPrompt(ref, ciRunIds))} />
        : null,
      snapshot.mergeState === 'BEHIND'
        ? <Button key="pr:sync" plain label="Update branch" onPress={() => submitPrompt($, syncPrompt(ref, snapshot))} />
        : null,
    ]

  const mergeMethod = run.mergeMethod ?? options.merge_method
  const mergeRow = !isOpen
    ? null
    : (
      <Box key="pr:merge-row" flexDirection="column">
        {guard.ok && !isBusy
          ? <Button key="pr:merge" variant="primary" label={`Merge (${mergeMethod})`}
            onPress={() => void mergeFromPane($, key, mergeMethod).catch(err => $.ui.toast(String(err)))} />
          : null}
        {!guard.ok ? <Text color={INK.warn} wrap="wrap">{`Merge: ${guard.reasons.join(' · ')}`}</Text> : null}
        {!approvalRequired(run)
          ? <Text dimColor size="footnote">{`no approval needed · risk low · confidence ${confidence ?? 0}%`}</Text>
          : null}
      </Box>
    )

  const checksAlt = `${counts.checksPassed} passed, ${counts.checksFailed} failed, ${counts.checksPending} pending checks`
  return card(els, 'pr', [
    <Box key="pr:title" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
        {chip(els, stateName(snapshot), STATE_TONE[stateName(snapshot)] ?? 'muted', { key: 'pr:state' })}
        <Box flexShrink={1} minWidth={0}>
          <Text weight="semibold" wrap="truncate-end">
            <Text dimColor tabular>{`#${snapshot.number} `}</Text>
            {snapshot.title}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" alignItems="center" flexShrink={0} gap={1}>
        {diffBlocks(els, counts.additions, counts.deletions)}
        <Text dimColor size="footnote" tabular>{`${counts.changedFiles} files`}</Text>
      </Box>
    </Box>,
    <Box key="pr:checks-block" flexDirection="column" rowGap={0}>
      {bar(els, 'pr:checks-bar', [
        { value: counts.checksPassed, tone: 'good' },
        { value: counts.checksFailed, tone: 'bad' },
        { value: counts.checksPending, tone: 'warn' },
      ], checksAlt)}
      <Box key="pr:checks" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text tabular size="footnote">
          <Text color={INK.good}>{`✓ ${counts.checksPassed} passed`}</Text>
          <Text color={counts.checksFailed > 0 ? INK.bad : undefined} dimColor={counts.checksFailed === 0}>{`  ✗ ${counts.checksFailed} failed`}</Text>
          <Text color={counts.checksPending > 0 ? INK.warn : undefined} dimColor={counts.checksPending === 0}>{`  ● ${counts.checksPending} pending`}</Text>
        </Text>
        {failing.map(check => check.url !== undefined
          ? <Link key={`check:${check.name}`} href={check.url} label={check.name} />
          : <Text key={`check:${check.name}`} color={INK.bad}>{check.name}</Text>)}
      </Box>
    </Box>,
    <Box key="pr:reviews" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
      {chip(els, decision.text, decision.tone, { key: 'pr:decision' })}
      {reviewers.map(([login, reviewState]) => (
        <Text key={`reviewer:${login}`} size="footnote" dimColor={reviewState !== 'APPROVED' && reviewState !== 'CHANGES_REQUESTED'}
          color={reviewState === 'APPROVED' ? INK.good : reviewState === 'CHANGES_REQUESTED' ? INK.bad : undefined}>
          {`${REVIEW_GLYPH[reviewState] ?? '💬'} ${login}`}
        </Text>
      ))}
    </Box>,
    <Text key="pr:mergeable" dimColor size="footnote">
      {`${snapshot.mergeable.toLowerCase()} · ${snapshot.mergeState.toLowerCase().replace(/_/g, ' ')} · into ${snapshot.baseRefName}`}
    </Text>,
    mergeRow,
    <Box key="pr:actions" flexDirection="row" flexWrap="wrap" columnGap={2}>{actions}</Box>,
    footerRow,
  ], { title: 'Pull request', tone: snapshot.counts.checksFailed > 0 ? 'bad' : undefined })
}

const threadWhere = (thread: PrThread): string => `${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`

const cut = (text: string): string => (text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text)

const MD_IMAGE = /!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g
const HTML_IMAGE = /<img\b[^>]*>/gi
const HTML_LINK = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
const attribute = (tag: string, name: string): string => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? ''

export type CommentImage = { alt: string; url: string }

/** Pulls images out of a comment, which the pane cannot draw inline, and turns HTML links into markdown ones. */
export function splitImages(body: string): { text: string; images: CommentImage[] } {
  const images: CommentImage[] = []
  const text = body
    .replace(MD_IMAGE, (_all, alt: string, url: string) => {
      images.push({ alt, url })
      return ''
    })
    .replace(HTML_IMAGE, tag => {
      const url = attribute(tag, 'src')
      if (url !== '') images.push({ alt: attribute(tag, 'alt'), url })
      return ''
    })
    .replace(HTML_LINK, (_all, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, '').trim()
      return plain === '' ? '' : `[${plain}](${href})`
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, images }
}

export async function threadsCard($: EngineInterface, e: PaneEvent, ctx: PaneContext): Promise<RenderChildren> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link, Markdown, Code } = els
  const { key } = ctx
  const snapshot = (await read($, prStates))[key]?.snapshot
  if (snapshot === undefined || snapshot.threads.length === 0) return null
  const opened = await read($, openThreads)
  const replyingTo = await read($, replying)
  const drafted = await read($, drafts)
  const withResolved = await read($, showResolved)
  const isBusy = (await read($, prBusy)) !== null
  const unresolved = snapshot.threads.filter(thread => !thread.isResolved)
  const resolved = snapshot.threads.filter(thread => thread.isResolved)
  const shown = withResolved ? [...unresolved, ...resolved] : unresolved

  const replyBox = (thread: PrThread): RenderChildren => {
    // The runtime table can carry Input on mobile, which draws no field yet.
    if (e.surface === 'mobile' || !('Input' in els)) return <Text key={`replyHint:${thread.id}`} dimColor>Reply from the desktop app</Text>
    const { Input } = els
    if (replyingTo !== thread.id) {
      return <Button key={`reply:${thread.id}`} plain label="Reply" onPress={() => update($, replying, () => thread.id)} />
    }
    return (
      <Box key={`replyBox:${thread.id}`} flexDirection="column" rowGap={0}>
        <Input
          key={`replyText:${thread.id}`}
          rows={3}
          placeholder="Reply to the thread"
          submitLabel="Send"
          value={drafted[thread.id] ?? ''}
          onInput={value => void update($, drafts, all => ({ ...all, [thread.id]: value })).catch(err => $.ui.toast(String(err)))}
          onSubmit={value => void replyFromPane($, key, thread.id, value).catch(err => $.ui.toast(String(err)))}
        />
        <Button key={`replyCancel:${thread.id}`} plain label="Cancel" onPress={() => update($, replying, () => null)} />
      </Box>
    )
  }

  const commentBody = (bodyKey: string, body: string, isDim: boolean) => {
    const { text, images } = splitImages(body)
    return (
      <Box key={`${bodyKey}:box`} flexDirection="column" rowGap={0}>
        {text !== '' ? <Markdown key={bodyKey} text={cut(text)} dimColor={isDim} /> : null}
        {images.length > 0 ? (
          <Box key={`${bodyKey}:images`} flexDirection="row" flexWrap="wrap" columnGap={2}>
            {images.map((image, at) => (
              <Link key={`${bodyKey}:image:${at}`} href={image.url} label={`🖼 ${image.alt.trim() || `Image ${at + 1}`}`} />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  }

  const threadRow = (thread: PrThread) => {
    const [first, ...rest] = thread.comments
    const isOpen = opened[thread.id] === true
    const replies = Math.max(0, thread.comments.length - 1)
    return (
      <Box key={`threadBox:${thread.id}`} flexDirection="column" rowGap={0} paddingX={1} paddingY={isGraphic(els) ? 1 : 0}
        borderStyle={isGraphic(els) ? undefined : 'round'} borderDimColor
        backgroundColor={tint(els, thread.isResolved ? 'muted' : 'warn', thread.isResolved ? 0.05 : 0.07)}>
        <Box key={`threadHead:${thread.id}`} flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
          <Box flexShrink={1} minWidth={0}>
            <Button key={`thread:${thread.id}`} plain onPress={() => update($, openThreads, all => ({ ...all, [thread.id]: !isOpen }))}>
              <Text mono weight="semibold" color={thread.isResolved ? undefined : INK.warn} dimColor={thread.isResolved}>{threadWhere(thread)}</Text>
              <Text dimColor>{`  ${first?.author ?? 'unknown'} · ${replies} ${replies === 1 ? 'reply' : 'replies'}`}</Text>
              {thread.isOutdated ? <Text dimColor inverse>{' outdated '}</Text> : null}
              {thread.isResolved ? <Text color={INK.good}>{'  ✓ resolved'}</Text> : null}
            </Button>
          </Box>
          {first?.url ? <Box flexShrink={0}><Link key={`link:${thread.id}`} href={first.url} label="GitHub ↗" /></Box> : null}
        </Box>
        {first !== undefined ? commentBody(`body:${thread.id}`, first.body, thread.isResolved) : null}
        {isOpen && first?.diffHunk ? <Code source={first.diffHunk} format="diff" path={thread.path} wrap="truncate-end" /> : null}
        {isOpen ? rest.map(comment => (
          <Box key={`comment:${comment.id}`} flexDirection="column" paddingLeft={2}>
            <Box flexDirection="row" gap={1}>
              <Text dimColor size="footnote">{comment.author}</Text>
              {comment.url ? <Link key={`commentLink:${comment.id}`} href={comment.url} label="↗" /> : null}
            </Box>
            {commentBody(`text:${comment.id}`, comment.body, false)}
          </Box>
        )) : null}
        {thread.isResolved || isBusy ? null : (
          <Box key={`threadActions:${thread.id}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
            {replyBox(thread)}
            <Button key={`resolve:${thread.id}`} plain label="Resolve"
              onPress={() => void resolveFromPane($, key, thread.id).catch(err => $.ui.toast(String(err)))} />
            <Button key={`fix:${thread.id}`} plain label="Fix it" onPress={() => submitPrompt($, fixThreadPrompt(thread))} />
          </Box>
        )}
      </Box>
    )
  }

  return card(els, 'threads', [
    ...shown.map(threadRow),
    resolved.length > 0
      ? <Button key="threads:all" plain dimColor label={withResolved ? 'Hide resolved' : `Show resolved (${resolved.length})`}
        onPress={() => update($, showResolved, value => !value)} />
      : null,
  ], {
    title: 'Threads',
    tone: unresolved.length > 0 ? 'warn' : undefined,
    aside: chip(els, `${unresolved.length} open / ${snapshot.threads.length}`, unresolved.length > 0 ? 'warn' : 'muted'),
  })
}

export async function writeSetting($: EngineInterface, field: keyof PipelineOptions, value: string): Promise<void> {
  const written = await $.config.set({ key: `pr-pipeline.${field}`, value })
  if ('deny' in written && written.deny !== undefined) $.ui.toast(`Setting ${field} refused: ${written.deny}`)
}

export async function settingsCard($: EngineInterface, e: PaneEvent, ctx: PaneContext): Promise<RenderChildren> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const isOpen = await read($, settingsOpen)
  const found = await read($, harnesses)
  const { options } = ctx
  const toggle = (
    <Button key="settings:toggle" plain dimColor={!isOpen} label={`${isOpen ? '▾' : '▸'} Settings`}
      onPress={() => update($, settingsOpen, value => !value)} />
  )
  if (!isOpen) return <Box key="settings" paddingX={1}>{toggle}</Box>

  const toolLine = found === null
    ? 'checking tools…'
    : (['gh', 'codex', 'opencode'] as const).map(tool => `${tool}: ${found[tool] ?? 'not found'}`).join(' · ')

  const fields: Array<{ key: string; field: keyof PipelineOptions; label: string; values: readonly string[] }> = [
    { key: 'set:reviewer', field: 'reviewer', label: 'Reviewer', values: BACKENDS },
    { key: 'set:effort', field: 'review_effort', label: 'Review effort', values: EFFORTS },
    { key: 'set:tracker', field: 'tracker', label: 'Tracker', values: TRACKER_SETTINGS },
    { key: 'set:merge', field: 'merge_method', label: 'Merge method', values: MERGE_METHODS },
  ]

  const controls = e.surface !== 'mobile' && 'Select' in els
    ? fields.map(one => {
      const { Select } = els
      return (
        <Select
          key={one.key}
          label={one.label}
          value={String(options[one.field])}
          options={one.values.map(value => ({ value }))}
          onSelect={value => void writeSetting($, one.field, value).catch(err => $.ui.toast(String(err)))}
        />
      )
    })
    : fields.map(one => <Text key={one.key}>{`${one.label}: ${String(options[one.field])}`}</Text>)

  return card(els, 'settings', [
    toggle,
    ...controls,
    <Text key="settings:model">
      {`Review model: ${options.review_model}`}
      <Text dimColor>{'  /config pr-pipeline.review_model'}</Text>
    </Text>,
    <Text key="settings:tools" dimColor size="footnote" wrap="wrap">{toolLine}</Text>,
  ], { gap: 0 })
}

export async function stageDetail($: EngineInterface, e: PaneEvent, ctx: PaneContext): Promise<RenderChildren> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link } = els
  const { run, now } = ctx
  const open = await read($, openStage)
  if (open === null) return null
  const index = STAGES.findIndex(one => one.id === open)
  const stage = run.stages.find(one => one.id === open)
  const meta = STAGES[index]
  if (stage === undefined || meta === undefined) return null

  const openTo = (id: StageId | null) => () => update($, openStage, () => id)
  const time = elapsed(stage, now)
  const timing = time === '' ? null : stage.status === 'running' ? `${time} so far` : `took ${time}`
  const metCount = stage.criteria.filter(one => one.met === 'yes').length
  const model = run.models?.[stage.id]
  const isSkipped = stage.status === 'skipped'
  const empty = !stage.summary && stage.did.length === 0 && stage.flags.length === 0 && stage.notes.length === 0 &&
    stage.criteria.length === 0 && stage.links.length === 0 && model === undefined
  const isRisk = stage.id === 'risk' && run.risk !== undefined
  const previous = STAGES[index - 1]
  const following = STAGES[index + 1]

  const tone = STATUS_TONE[stage.status]
  const accent = stage.status === 'pending' || stage.status === 'skipped' ? undefined : tone
  const listRow = (key: string, glyph: string, glyphTone: Tone | undefined, text: string, foot?: string) => (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={glyphTone !== undefined ? INK[glyphTone] : undefined} dimColor={glyphTone === undefined} weight="bold">{glyph}</Text>
        <Box flexShrink={1} minWidth={0}><Text wrap="wrap">{text}</Text></Box>
      </Box>
      {foot ? <Box paddingLeft={2}><Text size="footnote" dimColor wrap="wrap">{foot}</Text></Box> : null}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} gap={1}>
        <Box flexDirection="row" gap={2}>
          <Button key="back" plain label="× Close" onPress={openTo(null)} />
          {previous ? <Button key="prev" plain dimColor label={`‹ ${previous.label}`} onPress={openTo(previous.id)} /> : null}
          {following ? <Button key="next" plain dimColor label={`${following.label} ›`} onPress={openTo(following.id)} /> : null}
        </Box>
        <Text size="caption" dimColor tabular>{`STAGE ${index + 1} OF ${STAGES.length}`}</Text>
      </Box>
      {card(els, 'stage', [
        <Box key="stage:title" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexShrink={1} minWidth={0}>
            <Text size="title" weight="bold" wrap="truncate-end">
              <Text color={accent !== undefined ? INK[accent] : undefined} dimColor={accent === undefined}>{STATUS_GLYPH[stage.status]}</Text>
              {` ${meta.label}`}
            </Text>
          </Box>
          {chip(els, STATUS_WORD[stage.status], tone, { key: 'stage:status' })}
        </Box>,
        <Text key="stage:blurb" size="footnote" dimColor italic wrap="wrap">{meta.blurb}</Text>,
        isSkipped
          ? <Text key="stage:skipped" dimColor wrap="wrap">{`Skipped by ${model !== undefined ? modelFull(model) : 'unknown'}: ${stage.summary ?? 'no reason given'}`}</Text>
          : null,
        stage.confidence !== undefined || timing !== null || isRisk || (!isSkipped && model !== undefined) ? (
          <Box key="stage:meta" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            {isRisk && run.risk ? chip(els, `Risk ${run.risk}`, RISK_TONE[run.risk], { key: 'stage:risk' }) : null}
            {stage.confidence !== undefined ? (
              <Box key="stage:confidence" flexDirection="row" alignItems="center" gap={1}>
                {gauge(els, 'stage:gauge', stage.confidence, 16)}
                <Text color={INK[confidenceTone(stage.confidence)]} tabular weight="semibold">{`Confidence: ${stage.confidence}%`}</Text>
              </Box>
            ) : null}
            {timing !== null ? <Text dimColor tabular size="footnote">{`⏱ ${timing}`}</Text> : null}
            {!isSkipped && model !== undefined ? <Text key="stage:who" dimColor mono size="footnote">{`Ran on ${modelChip(model)}`}</Text> : null}
          </Box>
        ) : null,
      ], { tone: accent })}

      {stage.summary && !isSkipped ? card(els, 'summary', <Text wrap="wrap">{stage.summary}</Text>, { title: 'Summary' }) : null}

      {stage.flags.length > 0
        ? card(els, 'flags', stage.flags.map((flag, at) => listRow(`flag:${at}`, '⚠', 'warn', flag)), {
          title: 'Flags', tone: 'warn', aside: chip(els, String(stage.flags.length), 'warn'), gap: 0,
        })
        : null}

      {stage.did.length > 0
        ? card(els, 'did', stage.did.map((line, at) => listRow(`did:${at}`, '✓', 'good', line)), { title: 'Done', gap: 0 })
        : null}

      {stage.criteria.length > 0 ? card(els, 'criteria', stage.criteria.map((one, at) =>
        listRow(`criterion:${at}`, MET_GLYPH[one.met], MET_TONE[one.met], one.text, one.evidence)), {
        title: 'Criteria',
        aside: chip(els, `${metCount}/${stage.criteria.length} met`, metCount === stage.criteria.length ? 'good' : 'bad'),
      }) : null}

      {stage.notes.length > 0
        ? card(els, 'notes', stage.notes.map((note, at) => listRow(`note:${at}`, '•', undefined, note)), { title: 'Decisions', gap: 0 })
        : null}

      {stage.links.length > 0 ? card(els, 'links', stage.links.map(link => (
        <Link key={`link:${link.href}`} href={link.href} label={link.label} />
      )), { title: 'Links', gap: 0 }) : null}

      {empty ? card(els, 'nothing', <Text dimColor italic>Nothing recorded yet.</Text>) : null}
    </Box>
  )
}
