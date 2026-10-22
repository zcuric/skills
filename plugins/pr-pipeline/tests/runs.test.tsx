import { expect, mock, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { boot, PANE, PR_URL, prRoutes, prView, START, TOOL } from './kit'

const status = async ($: Engine, branch: string) =>
  JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch })).result))

test('a run is keyed by repo and branch', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const started = await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/keyed', ticket: 'HWEPD-1' })
  expect(started.result).toBe('Pipeline run opened for o/r#feature/keyed (HWEPD-1).')

  const byBranch = await status($, 'feature/keyed')
  expect(byBranch.key).toBe('o/r#feature/keyed')
  expect(byBranch.repo).toBe('o/r')
  expect((await status($, 'o/r#feature/keyed')).ticket).toBe('HWEPD-1')
})

test('the checked-out branch is used when none is given', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-2' })
  expect((await status($, 'feature/current')).key).toBe('o/r#feature/current')
})

test('a legacy run keyed by branch alone is re-keyed on first touch', async ($, on) => {
  boot(on)
  mock.store(on, {
    runs: { 'feature/old': { branch: 'feature/old', ticket: 'HWEPD-3', updatedAt: 1, stages: [] } },
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/old', stage: 'enhance', status: 'done' })

  const run = await status($, 'feature/old')
  expect(run.key).toBe('o/r#feature/old')
  expect(run.repo).toBe('o/r')
  expect(run.ticket).toBe('HWEPD-3')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'run:feature/old' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^o\/r · no tracker · feature\/old$/ })).toBeDefined()
  await ui.unmount()
})

test('a checkout without an origin remote keys runs under unknown', async ($, on) => {
  boot(on, [[['git', 'remote'], { exitCode: 2, stderr: 'error: No such remote' }]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/local', ticket: 'HWEPD-4' })
  expect((await status($, 'feature/local')).key).toBe('unknown#feature/local')
})

test('the same branch in two repos is two runs', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'main', repo: 'o/api', ticket: 'API-1' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'main', repo: 'o/web', ticket: 'WEB-1' })

  expect((await status($, 'o/api#main')).ticket).toBe('API-1')
  expect((await status($, 'o/web#main')).ticket).toBe('WEB-1')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'run:o/api#main' }))?.text).toMatch(/o\/api · main/)
  expect(await ui.find({ key: 'run:o/web#main' })).toBeDefined()
  await ui.unmount()
})

test('a closed run leaves the switcher but status still returns it', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/one', ticket: 'HWEPD-5' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/two', ticket: 'HWEPD-6' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/three', ticket: 'HWEPD-7' })
  const closed = await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/one' })
  expect(closed.result).toBe('Run HWEPD-5 closed.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'run:o/r#feature/one' })).toBeUndefined()
  expect(await ui.find({ key: 'run:o/r#feature/two' })).toBeDefined()
  await ui.unmount()
  expect((await status($, 'feature/one')).closedAt).toBeDefined()
})

test('a merged PR closes its run five minutes later', async ($, on) => {
  const world = { view: prView({ state: 'MERGED' }), threads: [] }
  const { clock, toasts } = boot(on, prRoutes(world))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/merged', ticket: 'HWEPD-8', prUrl: PR_URL })
  await clock.advance(2_000)
  expect(toasts).toContain('PR #42 merged · run closes in 5 min')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Merged · closes in 5 min/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(6 * 60_000)
  expect(toasts).toContain('Run HWEPD-8 closed')
  expect((await status($, 'feature/merged')).closedAt).toBeDefined()
})

test('a PR created on another repo is not attached to the run', async ($, on) => {
  boot(on)
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'https://github.com/x/y/pull/9\n', stderr: '', exitCode: 0 } }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-5', prUrl: PR_URL })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --repo x/y --title t --body b' })
  expect((await status($, 'feature/current')).prUrl).toBe(PR_URL)

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body b' })
  expect((await status($, 'feature/current')).prUrl).toBe(PR_URL)
})

test('a closed run does not pick up a new PR from gh pr create', async ($, on) => {
  boot(on)
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'https://github.com/o/r/pull/9\n', stderr: '', exitCode: 0 } }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-6', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'close' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body b' })
  expect((await status($, 'feature/current')).prUrl).toBe(PR_URL)
})

test('starting a closed run reopens it', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/again', ticket: 'HWEPD-7' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/other', ticket: 'HWEPD-8' })
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/again' })
  expect((await status($, 'feature/again')).closedAt).toBeDefined()

  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/again' })
  const run = await status($, 'feature/again')
  expect(run.closedAt).toBeUndefined()
  expect(run.ticket).toBe('HWEPD-7')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'run:o/r#feature/again' })).toBeDefined()
  await ui.unmount()
})
