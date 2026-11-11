import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { boot, PANE, PR_URL, START, TOOL } from './kit'

const runOf = async ($: Engine, branch: string) => {
  const answer = await $.tool.call({ tool: TOOL, action: 'status', branch })
  return answer.deny !== undefined ? null : JSON.parse(String(answer.result))
}

const stageOf = async ($: Engine, branch: string, id: string) =>
  (await runOf($, branch)).stages.find((stage: { id: string }) => stage.id === id)

test('a run moves through stages and is written to the store', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)

  const started = await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/hwepd-1', ticket: 'HWEPD-1', title: 'Demo' })
  expect(started.deny).toBeUndefined()

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-1', stage: 'enhance', status: 'running', summary: 'reading Jira' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-1', stage: 'enhance', status: 'done', summary: '4 criteria', confidence: 90, note: 'AC derived from description', tier: 'M' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-1', stage: 'implement', did: 'Added failing test, then fixed validator', flag: 'Migration touches tasks table' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-1', stage: 'acceptance', criterion: 'Due date in the past is refused', met: 'yes', evidence: 'TaskDueDateTest::test_past_date_refused' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-1', stage: 'risk', status: 'done', summary: 'low', risk: 'low' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'feature/hwepd-1', stage: 'pr', label: 'Pull request', href: 'https://github.com/o/r/pull/7' })

  const status = await $.tool.call({ tool: TOOL, action: 'status', branch: 'feature/hwepd-1' })
  const run = JSON.parse(String(status.result))
  expect(run.ticket).toBe('HWEPD-1')
  expect(run.prUrl).toBe('https://github.com/o/r/pull/7')
  const enhance = run.stages.find((stage: { id: string }) => stage.id === 'enhance')
  expect(enhance.status).toBe('done')
  expect(enhance.confidence).toBe(90)
  expect(enhance.notes).toEqual(['AC derived from description'])
  expect(run.tier).toBe('M')
  expect(run.risk).toBe('low')
  const implement = run.stages.find((stage: { id: string }) => stage.id === 'implement')
  expect(implement.did).toEqual(['Added failing test, then fixed validator'])
  expect(implement.flags).toEqual(['Migration touches tasks table'])
  const acceptance = run.stages.find((stage: { id: string }) => stage.id === 'acceptance')
  expect(acceptance.criteria).toEqual([{ text: 'Due date in the past is refused', met: 'yes', evidence: 'TaskDueDateTest::test_past_date_refused' }])
})

test('a criterion without met is refused', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b' })
  const refused = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'acceptance', criterion: 'x' })
  expect(refused.deny).toMatch(/met/)
})

test('a stored run is shown again after a reload', async ($, on) => {
  boot(on)
  mock.store(on, {
    runs: {
      'feature/hwepd-9': {
        branch: 'feature/hwepd-9',
        ticket: 'HWEPD-9',
        updatedAt: 1,
        stages: [{ id: 'enhance', status: 'done', notes: [], links: [], summary: 'restored' }],
      },
    },
  })
  await $.session.start(START)
  const status = await $.tool.call({ tool: TOOL, action: 'status', branch: 'feature/hwepd-9' })
  const run = JSON.parse(String(status.result))
  expect(run.ticket).toBe('HWEPD-9')
  expect(run.stages).toHaveLength(9)
  expect(run.stages.find((stage: { id: string }) => stage.id === 'enhance').did).toEqual([])
  expect(run.stages.find((stage: { id: string }) => stage.id === 'risk').status).toBe('pending')
})

test('an unknown stage is refused', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b' })
  const refused = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'deploy', status: 'done' })
  expect(refused.deny).toMatch(/stage/)
})

test('the pane lists stages and opens one on press, on every surface', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/hwepd-2', ticket: 'HWEPD-2' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-2', stage: 'review', status: 'done', summary: 'lgtm · 2 findings', confidence: 88, flag: 'Unverified claim in description', did: 'Posted 2 line comments' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'stage:review' })).toBeDefined()
    expect((await ui.find({ key: 'stage:review' }))?.text).toMatch(/lgtm/)

    await ui.press({ key: 'stage:review' })
    expect((await ui.find({ type: 'Text', text: /Confidence: 88%/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Unverified claim/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Posted 2 line comments/ }))).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'stage:enhance' })).toBeDefined()
    await ui.unmount()
  }
})

test('a link to a PR comment does not replace the PR url, and a repeated href is not duplicated', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-3' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'pr', label: 'Pull request', href: 'https://github.com/o/r/pull/7' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'pr', label: 'Pull request #7', href: 'https://github.com/o/r/pull/7' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'proof', label: 'Proof', href: 'https://github.com/o/r/pull/7#issuecomment-1' })

  const run = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch: 'b' })).result))
  expect(run.prUrl).toBe('https://github.com/o/r/pull/7')
  expect(run.stages.find((stage: { id: string }) => stage.id === 'pr').links).toEqual([{ label: 'Pull request #7', href: 'https://github.com/o/r/pull/7' }])
})

test('the header shows the run confidence, the merge-risk badge and what needs attention', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/hwepd-4', ticket: 'HWEPD-4', title: 'Header' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Confidence —/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Risk —/ })).toBeDefined()
    expect(await ui.find({ key: 'attn:review' })).toBeUndefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-4', stage: 'review', status: 'done', summary: 'changes requested', confidence: 72, flag: 'Missing test for the 404 path' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/hwepd-4', stage: 'risk', status: 'done', summary: 'one migration', risk: 'medium' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\s*Confidence 72%\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*Risk medium\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\s*medium\s*$/ })).toBeDefined()

    expect((await ui.find({ key: 'attn:review' }))?.text).toMatch(/changes requested/)
    await ui.press({ key: 'attn:review' })
    expect(await ui.find({ type: 'Text', text: /Missing test for the 404 path/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'stage:risk' })).toBeDefined()
    await ui.unmount()
  }
})

test('re-running a stage starts a new attempt, keeps its history and judges only the latest outcome', async ($, on) => {
  const { clock } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-40' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'running' })
  await clock.advance(60_000)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'done', summary: 'changes requested · 2 high', confidence: 60, flag: 'Unverified finding dropped', note: 'Second pass needed' })
  await clock.advance(60_000)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'running' })

  const rerun = await stageOf($, 'b', 'review')
  expect(rerun.attempt).toBe(2)
  expect(rerun.startedAt).toBe(1_120_000)
  expect(rerun.finishedAt).toBeUndefined()
  expect(rerun.summary).toBeUndefined()
  expect(rerun.confidence).toBeUndefined()
  expect(rerun.flags).toEqual(['Unverified finding dropped'])
  expect(rerun.notes).toEqual(['Second pass needed'])

  await clock.advance(30_000)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'done', summary: 'lgtm · 0 findings', confidence: 90 })
  await clock.advance(30_000)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', did: 'Swapped the AI label' })
  expect((await stageOf($, 'b', 'review')).finishedAt).toBe(1_150_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^attempt 2$/ })).toBeDefined()
  expect((await ui.find({ key: 'attn:review' }))?.text).not.toMatch(/changes requested/)
  await ui.unmount()
})

test('a criterion recorded again replaces its earlier verdict', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'acceptance', criterion: 'Past dates are refused', met: 'no' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'acceptance', criterion: 'Past dates are refused', met: 'yes', evidence: 'DueDateTest' })
  expect((await stageOf($, 'b', 'acceptance')).criteria).toEqual([{ text: 'Past dates are refused', met: 'yes', evidence: 'DueDateTest' }])
})

test('an unknown action, status or tracker and a fractional confidence are refused', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'stages', branch: 'b', stage: 'enhance', status: 'done' })).deny).toMatch(/"action" must be one of/)
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'finished' })).deny).toMatch(/"status" must be one of/)
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', confidence: 0.92 })).deny).toMatch(/92, not 0\.92/)
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', confidence: 140 })).deny).toMatch(/0 to 100/)
  expect((await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', tracker: 'trello' })).deny).toMatch(/"tracker" must be one of/)
  expect(await runOf($, 'b')).toBeNull()
})

test('a link adopts a PR only when the run has none or on the pr stage from its repo, and unlink clears it', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-41', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'review', label: 'Sibling', href: 'https://github.com/o/r/pull/50' })
  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'pr', label: 'Other repo', href: 'https://github.com/x/y/pull/3' })
  expect((await runOf($, 'b')).prUrl).toBe(PR_URL)

  await $.tool.call({ tool: TOOL, action: 'link', branch: 'b', stage: 'pr', label: 'Replacement', href: 'https://github.com/o/r/pull/43' })
  expect((await runOf($, 'b')).prUrl).toBe('https://github.com/o/r/pull/43')

  const unlinked = await $.tool.call({ tool: TOOL, action: 'unlink', branch: 'b', stage: 'pr', href: 'https://github.com/o/r/pull/43' })
  expect(unlinked.result).toMatch(/no PR now/)
  const run = await runOf($, 'b')
  expect(run.prUrl).toBeUndefined()
  expect(run.stages.find((stage: { id: string }) => stage.id === 'pr').links).toEqual([{ label: 'Other repo', href: 'https://github.com/x/y/pull/3' }])
  expect((await $.tool.call({ tool: TOOL, action: 'unlink', branch: 'b', stage: 'pr', href: 'https://example.com/nope' })).deny).toMatch(/no link/)
})

test('the pane shows last update, finished stage durations and a stalled stage', async ($, on) => {
  const { clock } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-42' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'running' })
  await clock.advance(150_000)
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'done' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'running' })

  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await fresh.find({ type: 'Text', text: /^1\/9 done · updated 0s ago$/ })).toBeDefined()
  expect(await fresh.find({ type: 'Text', text: /^2m$/ })).toBeDefined()
  expect(await fresh.find({ key: 'attn:stalled' })).toBeUndefined()
  await fresh.unmount()

  await clock.advance(72 * 60_000)
  const stale = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await stale.find({ key: 'attn:stalled' }))?.text).toBe('Stalled at Implement · no update 1h12m')
  await stale.unmount()
})

test('the header confidence comes from acceptance or review only', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-43' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'done', confidence: 95 })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Confidence —/ })).toBeDefined()
  await ui.unmount()
})

test('the status line clears when a stage fails or the run closes', async ($, on) => {
  const { statuses } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-44' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'running' })
  expect(statuses.at(-1)).toBe('pipeline: Implement')
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'failed' })
  expect(statuses.at(-1)).toBeUndefined()

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'running' })
  expect(statuses.at(-1)).toBe('pipeline: Implement')
  await $.tool.call({ tool: TOOL, action: 'close', branch: 'b' })
  expect(statuses.at(-1)).toBeUndefined()
})

test('proof cannot be done while another stage is still open', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-45' })
  for (const id of ['enhance', 'implement', 'pr', 'review', 'verify', 'acceptance']) {
    await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: id, status: 'skipped' })
  }
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'address', status: 'running' })

  const refused = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'proof', status: 'done' })
  expect(refused.deny).toBe('pr-pipeline: proof cannot be done while these are open: address (running), risk (pending). Close or skip them first.')
  expect((await stageOf($, 'b', 'proof')).status).toBe('pending')

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'address', status: 'done' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'risk', status: 'skipped' })
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'proof', status: 'done' })).deny).toBeUndefined()
})

test('starting a stage while an earlier one is open is recorded with a warning', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-46' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'skipped' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'pr', status: 'running' })

  const started = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'running' })
  expect(started.result).toBe('Stage review running. Still open before this: implement (pending), pr (running) — close or skip them.')
  expect((await stageOf($, 'b', 'review')).status).toBe('running')
})

test('ending a stage that was never started stamps its start and says so', async ($, on) => {
  const { clock } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-47' })
  await clock.advance(60_000)

  const ended = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'done', summary: '3 criteria' })
  expect(ended.result).toBe('Stage enhance done: 3 criteria. (no running call was recorded)')
  const enhance = await stageOf($, 'b', 'enhance')
  expect(enhance.startedAt).toBe(1_060_000)
  expect(enhance.finishedAt).toBe(1_060_000)

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'running' })
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'done' })).result).toBe('Stage implement done.')
})

test('a running call without a model records the session model by family name', async ($, on) => {
  boot(on)
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'b', ticket: 'HWEPD-48' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'enhance', status: 'running', effort: 'high' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'implement', status: 'running', backend: 'claude', model: 'claude-sonnet-4-6' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'b', stage: 'review', status: 'running', backend: 'codex', model: 'gpt-5-codex' })

  const run = await runOf($, 'b')
  expect(run.models.enhance).toEqual({ backend: 'claude', model: 'opus', effort: 'high' })
  expect(run.models.implement).toEqual({ backend: 'claude', model: 'sonnet' })
  expect(run.models.review).toEqual({ backend: 'codex', model: 'gpt-5-codex' })
})
