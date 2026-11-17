import { expect, mock, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { boot, PANE, PR_URL, prFetches, prRoutes, prView, sharedStore, START, TOOL } from './kit'
import type { Route } from './kit'

const status = async ($: Engine, branch: string) => {
  const answer = await $.tool.call({ tool: TOOL, action: 'status', branch })
  return answer.deny !== undefined ? null : JSON.parse(String(answer.result))
}

const THEIRS = 'o/r#feature/theirs'
const theirRun = (overrides: Record<string, unknown> = {}) => ({
  key: THEIRS, branch: 'feature/theirs', repo: 'o/r', ticket: 'THEIRS-1', updatedAt: 2_000_000, stages: [], ...overrides,
})

test('the pane shows the session\'s run when another session\'s run was updated later', async ($, on) => {
  boot(on)
  sharedStore(on, { [`run:${THEIRS}`]: theirRun() })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/mine', ticket: 'MINE-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^MINE-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^THEIRS-1$/ })).toBeUndefined()
  expect(await ui.find({ key: 'runs' })).toBeUndefined()
  await ui.unmount()
})

test('other sessions\' runs appear only after pressing the Other open runs row, and picking one selects it', async ($, on) => {
  boot(on)
  sharedStore(on, { [`run:${THEIRS}`]: theirRun() })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/mine', ticket: 'MINE-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'others:toggle' }))?.text).toMatch(/Other open runs · 1/)
  expect(await ui.find({ key: `run:${THEIRS}` })).toBeUndefined()
  await ui.press({ key: 'others:toggle' })
  await ui.press({ key: `run:${THEIRS}` })
  expect(await ui.find({ type: 'Text', text: /^THEIRS-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^MINE-1$/ })).toBeUndefined()
  await ui.unmount()
})

test('a session with no run of its own shows other sessions\' runs behind the row in the empty state', async ($, on) => {
  const { opened } = boot(on)
  sharedStore(on, { [`run:${THEIRS}`]: theirRun() })
  await $.session.start(START)
  expect(opened).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^No pipeline run yet$/ })).toBeDefined()
  expect((await ui.find({ key: 'others:toggle' }))?.text).toMatch(/Other open runs · 1/)
  await ui.unmount()
})

const checkoutPr = (): Route[] => prRoutes({ view: prView({ headRefName: 'feature/current', title: 'Checkout PR' }), threads: [] })

test('a PR-only entry draws the PR card and no Stages card', async ($, on) => {
  const { clock, opened, prompts } = boot(on, checkoutPr())
  mock.store(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start(START)
  await clock.settle()
  expect(opened).toEqual(['pr-pipeline'])
  const run = await status($, 'feature/current')
  expect(run.prOnly).toBe(true)
  expect(run.prUrl).toBe(PR_URL)

  await clock.advance(60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'pr' })).toBeDefined()
  expect(await ui.find({ key: 'stages' })).toBeUndefined()
  expect(await ui.find({ key: 'run:track' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Checkout PR$/ })).toBeDefined()
  await ui.press({ key: 'run:pipeline' })
  expect(prompts.at(-1)).toContain(PR_URL)
  await ui.press({ key: 'run:dismiss' })
  expect((await status($, 'feature/current')).closedAt).toBeDefined()
  await ui.unmount()

  await clock.advance(6 * 60_000)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect((await status($, 'feature/current')).closedAt).toBeDefined()
})

test('gh pr create whose head is another branch or repo follows that PR under its own key, not the cwd run', async ($, on) => {
  const heads: Record<string, string> = { [PR_URL]: 'feature/elsewhere', 'https://github.com/x/y/pull/9': 'feature/y' }
  const bash = { stdout: '' }
  boot(on, [[['gh', 'pr', 'view'], argv => ({ stdout: JSON.stringify(prView({ headRefName: heads[argv[3] ?? ''] ?? 'feature/none' })) })]])
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: bash.stdout, stderr: '', exitCode: 0 } }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-50' })

  bash.stdout = `${PR_URL}\n`
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --head feature/elsewhere --title t --body b' })
  bash.stdout = 'https://github.com/x/y/pull/9\n'
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --repo x/y --head feature/y --title t --body b' })

  expect((await status($, 'feature/current')).prUrl).toBeUndefined()
  const elsewhere = await status($, 'o/r#feature/elsewhere')
  expect(elsewhere.prOnly).toBe(true)
  expect(elsewhere.prUrl).toBe(PR_URL)
  expect((await status($, 'x/y#feature/y')).prUrl).toBe('https://github.com/x/y/pull/9')
})

test('stage on a PR-only entry is denied, and start turns it into a run', async ($, on) => {
  const { clock } = boot(on, checkoutPr())
  mock.store(on)
  await $.session.start(START)
  await clock.settle()

  const stage = await $.tool.call({ tool: TOOL, action: 'stage', stage: 'review', status: 'running' })
  expect(stage.deny).toBe('pr-pipeline: no run for o/r#feature/current. Open runs: none. Pass branch: "<run key>" or call start.')

  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-51' })
  const run = await status($, 'feature/current')
  expect(run.prOnly).toBeUndefined()
  expect(run.prUrl).toBe(PR_URL)
  expect((await $.tool.call({ tool: TOOL, action: 'stage', stage: 'review', status: 'running' })).deny).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'stages' })).toBeDefined()
  await ui.unmount()
})

test('the pane closes when the session\'s last run closes, and stays open when it was opened with /pipeline', async ($, on) => {
  const { closed } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/a', ticket: 'A-1' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/b', ticket: 'B-1' })
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/a' })
  expect(closed).toEqual([])
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/b' })
  expect(closed).toEqual(['pr-pipeline'])

  await $.command.run({ command: 'pipeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/c', ticket: 'C-1' })
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/c' })
  expect(closed).toEqual(['pr-pipeline'])
})

test('tick leaves another session\'s run alone while any session fetched it within six hours, and polls it after', async ($, on) => {
  const { calls, clock } = boot(on, prRoutes({ view: prView({ number: 43, url: 'https://github.com/o/r/pull/43' }), threads: [] }))
  sharedStore(on, {
    [`run:${THEIRS}`]: theirRun({ prUrl: 'https://github.com/o/r/pull/43', updatedAt: 1_000_000 }),
    [`poll:${THEIRS}`]: 1_000_000,
  })
  await $.session.start(START)
  const theirViews = () => prFetches(calls).filter(argv => argv.includes('43')).length

  await clock.advance(6 * 60 * 60_000 - 60_000)
  expect(theirViews()).toBe(0)
  await clock.advance(2 * 60_000)
  expect(theirViews()).toBe(1)
})

const closeInStore = (shared: Record<string, unknown>, key: string) => {
  const run = shared[`run:${key}`] as { savedAt?: number; updatedAt: number }
  shared[`run:${key}`] = { ...run, closedAt: 1_000_500, savedAt: (run.savedAt ?? run.updatedAt) + 1 }
}

test('a session\'s run another session closed moves the selection, toasts once and closes the idle pane', async ($, on) => {
  const { clock, closed, statuses, toasts } = boot(on)
  const shared = sharedStore(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/a', ticket: 'A-1' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/b', ticket: 'B-1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run:o/r#feature/a' })
  expect(await ui.find({ type: 'Text', text: /^A-1$/ })).toBeDefined()

  closeInStore(shared, 'o/r#feature/a')
  await clock.advance(10_000)
  expect(toasts.filter(text => text.endsWith('closed'))).toEqual(['Run A-1 closed'])
  expect(statuses.at(-1)).toBeUndefined()
  expect(closed).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^B-1$/ })).toBeDefined()

  closeInStore(shared, 'o/r#feature/b')
  await clock.advance(10_000)
  await clock.advance(10_000)
  expect(toasts.filter(text => text.endsWith('closed'))).toEqual(['Run A-1 closed', 'Run B-1 closed'])
  expect(closed).toEqual(['pr-pipeline'])
  expect(await ui.find({ type: 'Text', text: /^B-1$/ })).toBeUndefined()
  await ui.unmount()
})

test('a pane opened with /pipeline stays open when another session closes the session\'s run, and the session\'s own close does not toast', async ($, on) => {
  const { clock, closed, toasts } = boot(on)
  const shared = sharedStore(on)
  await $.session.start(START)
  await $.command.run({ command: 'pipeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/a', ticket: 'A-1' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/b', ticket: 'B-1' })

  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/a' })
  await clock.advance(10_000)
  expect(toasts.filter(text => text.endsWith('closed'))).toEqual([])

  closeInStore(shared, 'o/r#feature/b')
  await clock.advance(10_000)
  expect(toasts.filter(text => text.endsWith('closed'))).toEqual(['Run B-1 closed'])
  expect(closed).toEqual([])
})

test('a run tied to the session by its cwd branch stays the session\'s through git branch -m', async ($, on) => {
  const git = { branch: 'feature/old-name' }
  const { clock } = boot(on, [[['git', 'branch', '--show-current'], () => ({ stdout: `${git.branch}\n` })]])
  sharedStore(on, { 'run:o/r#feature/old-name': { key: 'o/r#feature/old-name', branch: 'feature/old-name', repo: 'o/r', ticket: 'OLD-1', updatedAt: 900_000, stages: [] } })
  on('tool.call', { tool: 'Bash' }, () => {
    git.branch = 'feature/new-name'
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'git branch -m feature/old-name feature/new-name' })

  expect((await status($, 'feature/new-name')).ticket).toBe('OLD-1')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^OLD-1$/ })).toBeDefined()
  expect(await ui.find({ key: 'others:toggle' })).toBeUndefined()
  await ui.unmount()
})

test('session start keeps the session\'s own entry fresh and drops month-old ones; the tick leaves them alone', async ($, on) => {
  const now = 40 * 86_400_000
  const { clock } = boot(on, [], { now })
  const shared = sharedStore(on, {
    'session:session-1': { keys: ['o/r#feature/mine'], at: 1 },
    'session:gone': { keys: ['o/r#feature/gone'], at: 1 },
    'session:recent': { keys: ['o/r#feature/recent'], at: now - 86_400_000 },
  })
  await $.session.start(START)
  expect(shared['session:session-1']).toEqual({ keys: ['o/r#feature/mine'], at: now })
  expect(shared['session:gone']).toBeUndefined()
  expect(shared['session:recent']).toBeDefined()

  shared['session:stale'] = { keys: [], at: 1 }
  await clock.advance(2 * 60_000)
  expect(shared['session:stale']).toBeDefined()
})
