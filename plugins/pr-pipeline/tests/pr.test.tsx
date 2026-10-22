import { expect, mock, test } from 'claude-code/testing'

import { boot, PANE, PR_URL, prRoutes, prThread, prView, ran, START, TOOL } from './kit'
import type { PrWorld } from './kit'

const failing = (name: string, runId: string) => ({
  __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/1`,
})

const blockedWorld = (): PrWorld => ({
  view: prView({
    reviewDecision: 'CHANGES_REQUESTED',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [failing('tests', '987')],
    reviews: [{ author: { login: 'ana' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T10:00:00Z' }],
  }),
  threads: [prThread('T1', 'Please rename this helper')],
})

test('the pane shows the PR checks, review decision and open threads', async ($, on) => {
  boot(on, prRoutes(blockedWorld()))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/show', ticket: 'HWEPD-10', prUrl: PR_URL })
  const fetched = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/show', fresh: true })).result))
  expect(fetched.number).toBe(42)
  expect(fetched.counts.threadsOpen).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^o\/r · no tracker · feature\/show$/ })).toBeDefined()
  expect((await ui.find({ key: 'pr:checks' }))?.text).toMatch(/✗ 1/)
  expect(await ui.find({ type: 'Text', text: /^\s*Changes requested\s*$/ })).toBeDefined()
  expect((await ui.find({ key: 'thread:T1' }))?.text).toMatch(/app\/a\.ts:9\s+ana · 0 replies/)
  expect((await ui.find({ key: 'body:T1' }))?.text).toMatch(/Please rename this helper/)
  expect((await ui.find({ key: 'attn:ci' }))?.text).toMatch(/1 failing check/)
  expect(await ui.find({ type: 'Text', text: /^Changes requested by ana$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1 open review thread$/ })).toBeDefined()
  expect(await ui.find({ key: 'pr:merge' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Merge: changes requested · 1 failing check · blocked by branch rules/ })).toBeDefined()
  await ui.unmount()
})

test('a reply is sent from the pane and the input clears', async ($, on) => {
  const { calls } = boot(on, prRoutes(blockedWorld()))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/reply', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/reply', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reply:T1' })
  await ui.input({ key: 'replyText:T1', text: 'Renamed in abc123', kind: 'change' })
  await ui.input({ key: 'replyText:T1', text: 'Renamed in abc123' })

  const reply = ran(calls, 'gh', 'api', 'graphql').find(argv => argv.includes('threadId=T1'))
  expect(reply).toContain('body=Renamed in abc123')
  expect(await ui.find({ key: 'replyText:T1' })).toBeUndefined()
  expect(await ui.find({ key: 'reply:T1' })).toBeDefined()
  await ui.unmount()
})

test('resolve runs the resolve mutation', async ($, on) => {
  const { calls } = boot(on, prRoutes(blockedWorld()))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/resolve', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/resolve', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'resolve:T1' })
  const resolve = ran(calls, 'gh', 'api', 'graphql').find(argv => argv.some(part => part.includes('resolveReviewThread')))
  expect(resolve).toContain('threadId=T1')
  await ui.unmount()
})

test('merge is offered without approval once risk is low and confidence is at least 80', async ($, on) => {
  boot(on, prRoutes({ view: prView({ reviewDecision: 'REVIEW_REQUIRED' }), threads: [] }))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/guard', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/guard', fresh: true })

  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await before.find({ key: 'pr:merge' })).toBeUndefined()
  expect(await before.find({ type: 'Text', text: /Merge: needs approval/ })).toBeDefined()
  await before.unmount()

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/guard', stage: 'acceptance', status: 'done', confidence: 85 })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/guard', stage: 'risk', status: 'done', risk: 'low' })

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ key: 'pr:merge' })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /no approval needed · risk low · confidence 85%/ })).toBeDefined()
  await after.unmount()
})

test('merge asks first, then runs gh pr merge with the configured method', async ($, on) => {
  const { calls } = boot(on, prRoutes({ view: prView(), threads: [] }))
  mock.store(on)
  const asked: unknown[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(e)
    return { result: { answers: { 'Merge #42 with squash?': 'Merge' } } }
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/merge', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/merge', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pr:merge' })
  expect(asked).toHaveLength(1)
  expect(ran(calls, 'gh', 'pr', 'merge')).toEqual([['gh', 'pr', 'merge', '42', '--repo', 'o/r', '--squash']])
  await ui.unmount()
})

test('failed CI runs are rerun once per run id', async ($, on) => {
  const { calls } = boot(on, prRoutes({
    view: prView({ statusCheckRollup: [failing('unit', '987'), failing('feature', '987'), failing('build', '555')] }),
    threads: [],
  }))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/rerun', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/rerun', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pr:rerun' })
  expect(ran(calls, 'gh', 'run', 'rerun')).toEqual([
    ['gh', 'run', 'rerun', '987', '--failed', '--repo', 'o/r'],
    ['gh', 'run', 'rerun', '555', '--failed', '--repo', 'o/r'],
  ])
  expect(await ui.find({ key: 'pr:rerun' })).toBeUndefined()
  expect(await ui.find({ key: 'fix:ci' })).toBeDefined()
  await ui.unmount()
})

test('without gh the PR card says why and stages still record', async ($, on) => {
  boot(on, [[['gh'], { reject: 'spawn gh ENOENT' }]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/nogh', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/nogh', fresh: true })
  const recorded = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/nogh', stage: 'review', status: 'done', summary: 'lgtm' })
  expect(recorded.result).toBe('Stage review done: lgtm.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /PR view unavailable: gh not found on PATH/ })).toBeDefined()
  await ui.unmount()
})

test('mobile shows threads without a reply box', async ($, on) => {
  boot(on, prRoutes(blockedWorld()))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/mobile', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/mobile', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /Reply from the desktop app/ })).toBeDefined()
  expect(await ui.find({ key: 'reply:T1' })).toBeUndefined()
  await ui.unmount()
})

test('polling pauses while a reply is open', async ($, on) => {
  const { calls, clock } = boot(on, prRoutes(blockedWorld()))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/poll', prUrl: PR_URL })
  await clock.advance(2_000)
  const views = () => ran(calls, 'gh', 'pr', 'view').length
  expect(views()).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reply:T1' })
  await clock.advance(120_000)
  expect(views()).toBe(1)

  await ui.press({ key: 'replyCancel:T1' })
  await clock.advance(60_000)
  expect(views()).toBe(2)
  await ui.unmount()
})

test('a review-stage transition schedules a PR refresh two seconds later', async ($, on) => {
  const { calls, clock } = boot(on, prRoutes({ view: prView(), threads: [] }))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/transition', prUrl: PR_URL })
  await clock.advance(2_000)
  const views = () => ran(calls, 'gh', 'pr', 'view').length
  expect(views()).toBe(1)

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/transition', stage: 'review', status: 'running' })
  await clock.advance(1_000)
  expect(views()).toBe(1)
  await clock.advance(1_000)
  expect(views()).toBe(2)

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/transition', stage: 'review', did: 'Posted 2 comments' })
  await clock.advance(2_000)
  expect(views()).toBe(2)
})

test('a skipped stage shows who skipped it and why', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/skip', ticket: 'HWEPD-11' })
  await $.tool.call({
    tool: TOOL, action: 'stage', branch: 'feature/skip', stage: 'verify', status: 'skipped',
    summary: 'no UI change in this diff', backend: 'claude', model: 'opus', effort: 'low',
  })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/skip', stage: 'review', status: 'done', backend: 'claude', model: 'opus', effort: 'high' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await ui.find({ key: 'stage:verify' }))?.text
  expect(row).toMatch(/skipped/)
  expect(row).toMatch(/no UI change in this diff/)
  expect(await ui.find({ type: 'Text', text: /^opus·low$/ })).toBeDefined()

  await ui.press({ key: 'stage:verify' })
  expect(await ui.find({ type: 'Text', text: /^Skipped by claude·opus·low: no UI change in this diff$/ })).toBeDefined()
  await ui.press({ key: 'stage:review' })
  expect(await ui.find({ type: 'Text', text: /^Ran on opus·high$/ })).toBeDefined()
  await ui.unmount()
})
