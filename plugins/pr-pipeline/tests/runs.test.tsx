import { expect, mock, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Runs } from '../types'
import { pruneRuns } from '../hooks/runs'
import { parseBranchMove } from '../hooks/tool'
import { boot, PANE, PR_URL, prRoutes, prView, ran, START, TOOL } from './kit'
import type { Route } from './kit'

const status = async ($: Engine, branch: string) => {
  const answer = await $.tool.call({ tool: TOOL, action: 'status', branch })
  return answer.deny !== undefined ? null : JSON.parse(String(answer.result))
}

const sharedStore = (on: On): Record<string, unknown> => {
  const shared: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: shared[e.key] }))
  on('store.set', (_$, e) => {
    shared[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return shared
}

test('a run is keyed by repo and branch', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const started = await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/keyed', ticket: 'HWEPD-1' })
  expect(started.result).toBe(
    'Pipeline run opened for o/r#feature/keyed (HWEPD-1). Run key: o/r#feature/keyed — pass it as "branch" from any other session, worktree or subagent.',
  )

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

const movingBranch = (state: { branch: string }): Route => [['git', 'branch', '--show-current'], () => ({ stdout: `${state.branch}\n` })]

const bashThatSwitches = (state: { branch: string }, to: string | null) => () => {
  if (to !== null) state.branch = to
  return { result: { stdout: '', stderr: '', interrupted: false } }
}

test('a run follows the branch that git checkout -b creates from its branch', async ($, on) => {
  const git = { branch: 'main' }
  boot(on, [movingBranch(git)])
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, bashThatSwitches(git, 'feature/hwepd-20-new'))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-20' })
  await $.tool.call({ tool: TOOL, action: 'stage', stage: 'enhance', status: 'done' })
  await $.tool.call({ tool: 'Bash', command: 'git fetch origin && git checkout -b feature/hwepd-20-new origin/main' })

  const moved = await status($, 'feature/hwepd-20-new')
  expect(moved.key).toBe('o/r#feature/hwepd-20-new')
  expect(moved.branch).toBe('feature/hwepd-20-new')
  expect(moved.ticket).toBe('HWEPD-20')
  expect(moved.stages[0].status).toBe('done')
  expect(await status($, 'main')).toBeNull()
})

test('a branch that was not created, or that already has a run, leaves the run where it is', async ($, on) => {
  const git = { branch: 'main' }
  let switchTo: string | null = null
  boot(on, [movingBranch(git)])
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, () => bashThatSwitches(git, switchTo)())
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-21' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/taken', ticket: 'HWEPD-99' })

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feature/failed' })
  switchTo = 'feature/taken'
  await $.tool.call({ tool: 'Bash', command: 'git switch -c feature/taken' })

  expect((await status($, 'main')).ticket).toBe('HWEPD-21')
  expect(await status($, 'feature/failed')).toBeNull()
  expect((await status($, 'feature/taken')).ticket).toBe('HWEPD-99')
})

test('git branch -m moves the run of the renamed branch, PR and all', async ($, on) => {
  const git = { branch: 'feature/old-name' }
  boot(on, [movingBranch(git)])
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, bashThatSwitches(git, 'feature/new-name'))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-22', prUrl: PR_URL })
  await $.tool.call({ tool: 'Bash', command: 'git branch -m feature/old-name feature/new-name' })

  const moved = await status($, 'feature/new-name')
  expect(moved.ticket).toBe('HWEPD-22')
  expect(moved.prUrl).toBe(PR_URL)
  expect(await status($, 'feature/old-name')).toBeNull()
})

test('starting a branch on a different ticket starts a fresh run', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/reused', ticket: 'HWEPD-23', prUrl: PR_URL, tier: 'M' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/reused', stage: 'risk', status: 'done', risk: 'high', backend: 'claude', model: 'opus' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/reused', ticket: 'HWEPD-24' })

  const run = await status($, 'feature/reused')
  expect(run.ticket).toBe('HWEPD-24')
  expect(run.prUrl).toBeUndefined()
  expect(run.tier).toBeUndefined()
  expect(run.risk).toBeUndefined()
  expect(run.models).toBeUndefined()
  expect(run.stages.every((stage: { status: string }) => stage.status === 'pending')).toBe(true)
})

test('an update starts from what another session wrote to the store', async ($, on) => {
  boot(on)
  const shared: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: shared[e.key] }))
  on('store.set', (_$, e) => {
    shared[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/shared', ticket: 'HWEPD-25' })

  const stored = JSON.parse(JSON.stringify(shared.runs)) as Runs
  const theirs = stored['o/r#feature/shared']
  if (theirs === undefined) throw new Error('run not stored')
  shared.runs = { ...stored, 'o/r#feature/shared': { ...theirs, title: 'Written by the other session' } }

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/shared', stage: 'enhance', status: 'done' })
  const run = await status($, 'feature/shared')
  expect(run.title).toBe('Written by the other session')
  expect(run.stages[0].status).toBe('done')
})

test('a running stage keeps a run from pruning only while it was updated this week', () => {
  const day = 86_400_000
  const now = 60 * day
  const running = (key: string, updatedAt: number) => ({
    key, branch: key, updatedAt, stages: [{ id: 'review' as const, status: 'running' as const, did: [], flags: [], notes: [], criteria: [], links: [] }],
  })
  const pruned = pruneRuns({ stale: running('stale', now - 31 * day), recent: running('recent', now - 2 * day) }, now, null)
  expect(Object.keys(pruned)).toEqual(['recent'])
})

test('the poll also refreshes the other run fetched longest ago, at most every ten minutes, so its merge closes it', async ($, on) => {
  let otherState = 'OPEN'
  const { calls, clock } = boot(on, [
    [['gh', 'pr', 'view'], argv => ({
      stdout: JSON.stringify(argv.includes('43')
        ? prView({ number: 43, url: 'https://github.com/o/r/pull/43', state: otherState })
        : prView()),
    })],
    ...prRoutes({ view: prView(), threads: [] }).slice(1),
  ])
  mock.store(on, {
    runs: { 'o/r#feature/other': { key: 'o/r#feature/other', branch: 'feature/other', repo: 'o/r', ticket: 'HWEPD-26', prUrl: 'https://github.com/o/r/pull/43', updatedAt: 1, stages: [] } },
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/selected', ticket: 'HWEPD-27', prUrl: PR_URL })
  const otherViews = () => ran(calls, 'gh', 'pr', 'view').filter(argv => argv.includes('43')).length

  await clock.advance(60_000)
  expect(otherViews()).toBe(1)
  await clock.advance(5 * 60_000)
  expect(otherViews()).toBe(1)

  otherState = 'MERGED'
  await clock.advance(5 * 60_000)
  expect(otherViews()).toBe(2)
  expect((await status($, 'feature/other')).mergedAt).toBeDefined()
  await clock.advance(6 * 60_000)
  expect((await status($, 'feature/other')).closedAt).toBeDefined()
})

test('each Runs switcher row shows where its run stands', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/a', ticket: 'HWEPD-28' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/a', stage: 'review', status: 'running' })
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/b', ticket: 'HWEPD-29' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/b', stage: 'address', status: 'failed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'run:o/r#feature/a' }))?.text).toMatch(/◐ AI review/)
  expect((await ui.find({ key: 'run:o/r#feature/b' }))?.text).toMatch(/✕ Address/)
  await ui.unmount()
})

test('with no open run the pane offers to reopen the last closed one', async ($, on) => {
  const { clock } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/done', ticket: 'HWEPD-30' })
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'feature/done' })
  await clock.advance(3 * 60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^HWEPD-30 closed 3m ago$/ })).toBeDefined()
  await ui.press({ key: 'empty:reopen' })
  expect((await status($, 'feature/done')).closedAt).toBeUndefined()
  expect(await ui.find({ key: 'stage:enhance' })).toBeDefined()
  await ui.unmount()
})

test('a PR closed without merge closes its run', async ($, on) => {
  const { clock, toasts } = boot(on, prRoutes({ view: prView({ state: 'CLOSED' }), threads: [] }))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/dropped', ticket: 'HWEPD-31', prUrl: PR_URL })
  await clock.advance(61_000)
  expect(toasts).toContain('Run HWEPD-31 closed · PR closed without merge')
  expect((await status($, 'feature/dropped')).closedAt).toBeDefined()
})

test('an idle run closes: 3 days without a PR, 14 days with one', async ($, on) => {
  const day = 86_400_000
  const now = 30 * day
  const { clock, toasts } = boot(on, prRoutes({ view: prView(), threads: [] }), { now })
  const stored = (key: string, updatedAt: number, prUrl?: string) => ({ key: `o/r#${key}`, branch: key, repo: 'o/r', ticket: key, updatedAt, prUrl, stages: [] })
  mock.store(on, {
    runs: {
      'o/r#no-pr-old': stored('no-pr-old', now - 3 * day),
      'o/r#no-pr-new': stored('no-pr-new', now - 2 * day),
      'o/r#pr-old': stored('pr-old', now - 14 * day, 'https://github.com/o/r/pull/43'),
      'o/r#pr-new': stored('pr-new', now - 13 * day, PR_URL),
    },
  })
  await $.session.start(START)
  await clock.advance(60_000)
  expect(toasts).toEqual(expect.arrayContaining(['Run no-pr-old closed · no PR, idle 3 days', 'Run pr-old closed · idle 14 days']))
  expect((await status($, 'no-pr-new')).closedAt).toBeUndefined()
  expect((await status($, 'pr-new')).closedAt).toBeUndefined()
})

test('a run key passed as branch is not wrapped in the current repo', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'x/contracts#feature/shape', ticket: 'HWEPD-32' })
  const run = await status($, 'x/contracts#feature/shape')
  expect(run.key).toBe('x/contracts#feature/shape')
  expect(run.repo).toBe('x/contracts')
  expect(run.branch).toBe('feature/shape')
})

test('a linked PR from another repo is not adopted as the run PR', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/linked', ticket: 'HWEPD-33' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'feature/linked', stage: 'implement', label: 'Contracts PR', href: 'https://github.com/x/contracts/pull/22' })
  expect((await status($, 'feature/linked')).prUrl).toBeUndefined()
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'feature/linked', stage: 'pr', label: 'PR', href: 'https://github.com/O/R/pull/7' })
  expect((await status($, 'feature/linked')).prUrl).toBe('https://github.com/O/R/pull/7')
})

test('the pane has no progress card; the Stages header carries the count', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/count', ticket: 'HWEPD-34' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/count', stage: 'enhance', status: 'done' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/count', stage: 'implement', status: 'running' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Running: Implement/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1\/9 done · updated/ })).toBeDefined()
  await ui.unmount()
})

test('stage, link and status on a branch with no run are refused and create nothing', async ($, on) => {
  boot(on)
  const shared = sharedStore(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/a', ticket: 'HWEPD-35' })

  const expected = 'pr-pipeline: no run for o/r#feature/none. Open runs: o/r#feature/a. Pass branch: "<run key>" or call start.'
  const stage = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'O/r#feature/none', stage: 'review', status: 'running' })
  expect(stage.deny).toBe(expected)
  const link = await $.tool.call({ tool: TOOL, action: 'link', branch: 'O/r#feature/none', stage: 'pr', href: PR_URL })
  expect(link.deny).toBe(expected)
  expect((await $.tool.call({ tool: TOOL, action: 'status', branch: 'O/r#feature/none' })).deny).toBe(expected)
  expect(Object.keys(shared.runs as Runs)).toEqual(['o/r#feature/a'])
})

test('gh pr create in a session with no run creates none', async ($, on) => {
  boot(on)
  const shared = sharedStore(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: `${PR_URL}\n`, stderr: '', exitCode: 0 } }))
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body b' })

  expect(shared.runs ?? {}).toEqual({})
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).deny).toMatch(/^pr-pipeline: no run for o\/r#feature\/current\. Open runs: none\./)
})

test('a repo that differs only by case resolves to the run or the remote it names', async ($, on) => {
  boot(on)
  const shared = sharedStore(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'main', repo: 'Org/Api', ticket: 'API-2' })

  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'main', repo: 'org/api', stage: 'enhance', status: 'running' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'ORG/API#main', stage: 'enhance', status: 'done' })).deny).toBeUndefined()
  const started = await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/cased', repo: 'O/R', ticket: 'HWEPD-36' })
  expect(started.result).toMatch(/^Pipeline run opened for o\/r#feature\/cased /)

  expect(Object.keys(shared.runs as Runs).sort()).toEqual(['Org/Api#main', 'o/r#feature/cased'])
  const api = await status($, 'Org/Api#main')
  expect(api.repo).toBe('Org/Api')
  expect(api.stages[0].status).toBe('done')
  expect((await status($, 'feature/cased')).repo).toBe('o/r')
})

test('git worktree add -b moves the run onto the branch it creates', async ($, on) => {
  const git = { branch: 'main' }
  boot(on, [movingBranch(git), [['git', 'rev-parse'], { stdout: '' }]])
  mock.store(on)
  on('tool.call', { tool: 'Bash' }, bashThatSwitches(git, null))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', ticket: 'HWEPD-37' })
  await $.tool.call({ tool: 'Bash', command: 'git worktree add -b feature/hwepd-37 ../wt origin/main' })

  const moved = await status($, 'feature/hwepd-37')
  expect(moved.key).toBe('o/r#feature/hwepd-37')
  expect(moved.ticket).toBe('HWEPD-37')
  expect(await status($, 'main')).toBeNull()
  expect(parseBranchMove('git worktree add ../wt -B feature/x origin/main')).toEqual({ kind: 'worktree', to: 'feature/x' })
})
