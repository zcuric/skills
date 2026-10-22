import { expect, mock, test } from 'claude-code/testing'

import { boot, PANE, START, TOOL } from './kit'

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
