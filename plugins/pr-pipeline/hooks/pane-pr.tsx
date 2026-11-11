import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderChildren, RenderInput, RenderSurface } from 'claude-code'

import type { Harnesses, Met, PendingSettings, PipelineOptions, PipelineRun, PrSnapshot, PrState, PrThread, ReplyBox, Stage, StageId, StageStatus } from '../types'
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
  CLAUDE_MODELS,
  EFFORTS,
  MERGE_METHODS,
  REVIEW_COMMAND_MAX,
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
const replying = atom({ plugin: 'pr-pipeline', key: 'replying' } as const, null as ReplyBox | null)
const drafts = atom({ plugin: 'pr-pipeline', key: 'drafts' } as const, {} as Record<string, string>)
const prBusy = atom({ plugin: 'pr-pipeline', key: 'prBusy' } as const, null as string | null)
const harnesses = atom({ plugin: 'pr-pipeline', key: 'harnesses' } as const, null as Harnesses | null)
const settingsOpen = atom({ plugin: 'pr-pipeline', key: 'settingsOpen' } as const, false)
const settingsPending = atom({ plugin: 'pr-pipeline', key: 'settingsPending' } as const, {} as PendingSettings)
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
    if (replyingTo?.threadId !== thread.id) {
      const openBox = async () => {
        const openedAt = await $.clock.now()
        await update($, replying, () => ({ key, threadId: thread.id, openedAt }))
      }
      return <Button key={`reply:${thread.id}`} plain label="Reply" onPress={openBox} />
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

/** The pane's only write path: the pick shows at once, through a pending entry, until the reloaded options carry it. */
export async function writeSetting($: EngineInterface, live: PipelineOptions, field: keyof PipelineOptions, value: string): Promise<void> {
  const at = await $.clock.now()
  await update($, settingsPending, all => ({ ...all, [field]: { value, from: String(live[field]), at } }))
  const written = await $.config.set({ key: `pr-pipeline.${field}`, value }).catch((err: unknown) => ({ deny: String(err) }))
  if (written.deny === undefined) return
  await update($, settingsPending, ({ [field]: _refused, ...rest }) => rest)
  await $.ui.toast(`Setting ${field} refused: ${written.deny}`)
}

/** The options as the person last picked them: a pending pick holds while the live value is still the one it replaced. */
async function shownOptions($: EngineInterface, live: PipelineOptions): Promise<PipelineOptions> {
  const pending = await read($, settingsPending)
  const now = await $.clock.now()
  const picked = Object.entries(pending)
    .filter(([field, entry]) => entry !== undefined && now - entry.at < PENDING_MS && String(live[field as keyof PipelineOptions]) === entry.from)
    .map(([field, entry]) => [field, entry?.value])
  return { ...live, ...Object.fromEntries(picked) } as PipelineOptions
}

const isMissing = (found: Harnesses | null, tool: keyof Omit<Harnesses, 'checkedAt'>): boolean =>
  found !== null && found[tool] === null

/** Why the chosen reviewer cannot run, as a full sentence; null when it can. */
function reviewerProblem(options: PipelineOptions, found: Harnesses | null): string | null {
  const { reviewer } = options
  if (reviewer === 'custom' && options.review_command === '') return 'No review command set. Reviews fall back to claude.'
  if ((reviewer === 'codex' || reviewer === 'opencode') && isMissing(found, reviewer)) return `${reviewer} is not installed. Reviews fall back to claude.`
  return null
}

type SettingsScope = { els: Els; live: PipelineOptions; shown: PipelineOptions; found: Harnesses | null; canEdit: boolean }

const PENDING_MS = 60_000
const PILL_NAME: Record<keyof PipelineOptions, string> = {
  reviewer: 'reviewer', review_model: 'model', review_command: 'command', review_effort: 'effort', tracker: 'tracker', merge_method: 'merge',
}

function pick($: EngineInterface, live: PipelineOptions, field: keyof PipelineOptions, value: string): () => void {
  return () => void writeSetting($, live, field, value).catch(err => $.ui.toast(String(err)))
}

function selectedPill(els: Els, key: string, value: string, tone: Tone) {
  const { Box, Text } = els
  const graphic = isGraphic(els)
  return (
    <Box key={`${key}:pill`} backgroundColor={tint(els, tone, 0.18)} paddingX={graphic ? 1 : 0}>
      <Text color={INK[tone]} inverse={!graphic} weight="bold">{graphic ? value : ` ${value} `}</Text>
    </Box>
  )
}

/** One pill per value: the chosen one lit, the others one press away, a missing tool named and inert. */
function optionPills($: EngineInterface, scope: SettingsScope, field: keyof PipelineOptions, values: readonly string[], options: { missing?: readonly string[]; tone?: Tone } = {}) {
  const { els } = scope
  const { Box, Text, Button } = els
  const name = PILL_NAME[field]
  const current = String(scope.shown[field])
  const pad = isGraphic(els) ? 1 : 0
  const label = (text: string) => (isGraphic(els) ? text : ` ${text} `)
  const pills = values.map(value => {
    const key = `set:${name}:${value}`
    if (value === current) return selectedPill(els, key, value, options.tone ?? 'info')
    if (options.missing?.includes(value)) {
      return <Box key={`${key}:pill`} paddingX={pad}><Text dimColor>{label(`${value} · not installed`)}</Text></Box>
    }
    return (
      <Box key={`${key}:pill`} paddingX={pad} backgroundColor={tint(els, 'muted', 0.12)} hover={{ backgroundColor: tint(els, 'info', 0.16) }}>
        <Button key={key} plain onPress={pick($, scope.live, field, value)}><Text dimColor>{label(value)}</Text></Button>
      </Box>
    )
  })
  return <Box key={`set:${name}:pills`} flexDirection="row" flexWrap="wrap" columnGap={1}>{pills}</Box>
}

function settingBlock(els: Els, key: string, label: string, description: string | null, body: RenderChildren[]) {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
        <Text weight="semibold">{label}</Text>
        {description === null ? null : <Text dimColor size="footnote">{description}</Text>}
      </Box>
      {body}
    </Box>
  )
}

/** A bordered tinted block like the attention strip: a warning or a blocker. */
function notice(els: Els, key: string, tone: Tone, text: string) {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="row" gap={1} paddingX={2} paddingY={1}
      borderStyle="round" borderColor={INK[tone]} backgroundColor={tint(els, tone, 0.1)}>
      <Text color={INK[tone]} weight="bold">⚠</Text>
      <Text key={`${key}:text`} color={INK[tone]} wrap="wrap">{text}</Text>
    </Box>
  )
}

function reviewerBlock($: EngineInterface, scope: SettingsScope) {
  const { shown, found } = scope
  const missing = (['codex', 'opencode'] as const).filter(tool => isMissing(found, tool) && tool !== shown.reviewer)
  const tone: Tone = reviewerProblem(shown, found) === null ? 'info' : 'warn'
  return settingBlock(scope.els, 'settings:reviewer', 'Reviewer', 'Who reviews the pull request at stage 4.', [
    optionPills($, scope, 'reviewer', BACKENDS, { missing, tone }),
  ])
}

function modelBlock($: EngineInterface, scope: SettingsScope) {
  const { els, shown } = scope
  if (shown.reviewer === 'claude') {
    const models: readonly string[] = CLAUDE_MODELS
    const values = models.includes(shown.review_model) ? models : [...models, shown.review_model]
    return settingBlock(els, 'settings:model', 'Model', null, [optionPills($, scope, 'review_model', values)])
  }
  if (!scope.canEdit || !('Input' in els)) return <els.Text key="settings:model">{`Model: ${shown.review_model}`}</els.Text>
  const saveModel = (value: string) => {
    const model = value.trim()
    if (model === '') {
      void $.ui.toast('Review model cannot be empty')
      return
    }
    pick($, scope.live, 'review_model', model)()
  }
  return settingBlock(els, 'settings:model', 'Model', null, [
    <els.Input key="set:model" placeholder="model id the CLI accepts" submitLabel="Save" value={shown.review_model} onSubmit={saveModel} />,
  ])
}

function effortBlock($: EngineInterface, scope: SettingsScope) {
  const { els, shown } = scope
  const hint = shown.reviewer === 'claude'
    ? 'Defaults. A run\'s task class can route a different model and effort.'
    : 'Every review runs with this model and effort.'
  return settingBlock(els, 'settings:effort', 'Effort', null, [
    optionPills($, scope, 'review_effort', EFFORTS),
    <els.Text key="settings:hint" dimColor size="footnote" wrap="wrap">{hint}</els.Text>,
  ])
}

function commandBlock($: EngineInterface, scope: SettingsScope) {
  const { els, shown } = scope
  const { Text } = els
  if (shown.reviewer !== 'custom') return null
  if (!scope.canEdit || !('Input' in els)) {
    return (
      <Text key="settings:command" wrap="wrap">
        {`Review command: ${shown.review_command || 'not set'}`}
        <Text dimColor>{'  /config pr-pipeline.review_command'}</Text>
      </Text>
    )
  }
  const saveCommand = (value: string) => {
    const command = value.trim()
    if (command.length > REVIEW_COMMAND_MAX) {
      void $.ui.toast(`Review command is longer than ${REVIEW_COMMAND_MAX} characters`)
      return
    }
    pick($, scope.live, 'review_command', command)()
  }
  return settingBlock(els, 'settings:command', 'Command', null, [
    <els.Input key="set:review_command" placeholder="agent-cli --model {model}" submitLabel="Save" value={shown.review_command} onSubmit={saveCommand} />,
    <Text key="settings:command:hint" dimColor size="footnote" wrap="wrap">{'Prompt on stdin, answer on stdout. {model} becomes the model above.'}</Text>,
  ])
}

function reviewCard($: EngineInterface, scope: SettingsScope) {
  const problem = reviewerProblem(scope.shown, scope.found)
  return card(scope.els, 'settings:review', [
    reviewerBlock($, scope),
    modelBlock($, scope),
    effortBlock($, scope),
    commandBlock($, scope),
    problem === null ? null : notice(scope.els, 'settings:warning', 'warn', problem),
  ], { title: 'AI review' })
}

function pullRequestCard($: EngineInterface, scope: SettingsScope, run: PipelineRun | undefined) {
  const { els, shown } = scope
  const runMethod = run?.mergeMethod
  const override = runMethod !== undefined && runMethod !== shown.merge_method
    ? <els.Text key="settings:merge:run" dimColor size="footnote" wrap="wrap">{`This run merges with ${runMethod}, set by the repo profile.`}</els.Text>
    : null
  return card(els, 'settings:pr', [
    settingBlock(els, 'settings:tracker', 'Tracker', 'Where tickets live. auto works it out from the ticket.', [optionPills($, scope, 'tracker', TRACKER_SETTINGS)]),
    settingBlock(els, 'settings:merge', 'Merge', 'What the Merge button does.', [optionPills($, scope, 'merge_method', MERGE_METHODS), override]),
  ], { title: 'Pull request' })
}

function showSettings($: EngineInterface, isOpen: boolean): () => Promise<unknown> {
  return () => update($, settingsOpen, () => isOpen)
}

/** The pane's top row: the way into Settings, always drawn. */
export function settingsGear($: EngineInterface, e: PaneEvent) {
  const { Box, Button } = $.ui.resolve(e)
  return (
    <Box key="top" flexDirection="row" justifyContent="flex-end">
      <Button key="settings:toggle" plain dimColor label="⚙ Settings" onPress={showSettings($, true)} />
    </Box>
  )
}

export async function isSettingsOpen($: EngineInterface): Promise<boolean> {
  return read($, settingsOpen)
}

/** Settings as its own view, drawn instead of the run. */
export async function settingsView($: EngineInterface, e: PaneEvent, live: PipelineOptions, run: PipelineRun | undefined) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const found = await read($, harnesses)
  const scope: SettingsScope = { els, live, shown: await shownOptions($, live), found, canEdit: e.surface !== 'mobile' }
  return (
    <Box flexDirection="column" rowGap={1} paddingX={1} paddingY={1}>
      <Box key="settings:top" flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Button key="settings:back" plain dimColor label="‹ Back" onPress={showSettings($, false)} />
          <Text size="title" weight="bold">Settings</Text>
        </Box>
        <Text dimColor size="footnote">Apply to every run. Saved in /config under pr-pipeline.</Text>
      </Box>
      {isMissing(found, 'gh') ? notice(els, 'settings:gh', 'bad', 'gh is not installed. The pipeline cannot open or read pull requests.') : null}
      {reviewCard($, scope)}
      {pullRequestCard($, scope, run)}
    </Box>
  )
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
