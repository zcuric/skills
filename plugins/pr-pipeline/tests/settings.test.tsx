import { expect, mock, test } from 'claude-code/testing'

import { boot, PANE, START, TOOL } from './kit'

test('settings returns the review options and the tools found', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const settings = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'settings' })).result))
  expect(settings).toMatchObject({ reviewer: 'claude', review_model: 'opus', review_effort: 'low', tracker: 'auto', merge_method: 'squash' })
  expect(settings.harnesses).toMatchObject({ gh: '/opt/homebrew/bin/gh', codex: null, opencode: null })
  expect(settings.claudeModels).toContain('opus')
  expect(settings.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

test('settings writes valid fields to config and skips invalid ones', async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  const answer = await $.tool.call({ tool: TOOL, action: 'settings', set: { reviewer: 'codex', review_effort: 'high', merge_method: 'fast-forward' } })
  expect(configs).toEqual([
    { key: 'pr-pipeline.reviewer', value: 'codex' },
    { key: 'pr-pipeline.review_effort', value: 'high' },
  ])
  const settings = JSON.parse(String(answer.result))
  expect(settings.reviewer).toBe('codex')
  expect(settings.merge_method).toBe('squash')
})

test('a stage records who ran it and the row shows the chip', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/chip' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/chip', stage: 'review', status: 'running', backend: 'codex', model: 'gpt-5-codex' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/chip', stage: 'review', effort: 'high' })

  const run = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch: 'feature/chip' })).result))
  expect(run.models.review).toEqual({ backend: 'codex', model: 'gpt-5-codex', effort: 'high' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^codex·gpt-5-codex$/ })).toBeDefined()
  await ui.unmount()
})

test('an unknown effort or backend is refused', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const effort = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/bad', stage: 'review', effort: 'extreme' })
  expect(effort.deny).toBe('pr-pipeline: "effort" must be one of low, medium, high, xhigh, max.')
  const backend = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/bad', stage: 'review', backend: 'gemini' })
  expect(backend.deny).toMatch(/"backend" must be one of claude, codex, opencode/)
})

test('the settings card writes a picked option to config', async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  await ui.select({ key: 'set:reviewer', value: 'codex' })
  expect(configs).toEqual([{ key: 'pr-pipeline.reviewer', value: 'codex' }])
  expect(await ui.find({ type: 'Text', text: /gh: \/opt\/homebrew\/bin\/gh · codex: not found · opencode: not found/ })).toBeDefined()
  await ui.unmount()

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await mobile.find({ type: 'Text', text: /^Reviewer: claude$/ })).toBeDefined()
  await mobile.unmount()
})
