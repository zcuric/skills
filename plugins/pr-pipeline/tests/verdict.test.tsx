import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { boot, fakeFs, PANE, PR_URL, prRoutes, prView, ran, START, TOOL } from './kit'
import type { PrWorld } from './kit'

const sha = (digit: string): string => digit.repeat(40)
const commits = (...oids: string[]) => oids.map(oid => ({ oid, messageHeadline: 'x' }))

const stageOf = async ($: Engine, branch: string, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch })).result)).stages.find((stage: { id: string }) => stage.id === id)

test('a done review records the PR head it judged', async ($, on) => {
  const world: PrWorld = { view: prView({ headRefOid: sha('a'), commits: commits(sha('a')) }), threads: [] }
  const { calls } = boot(on, prRoutes(world))
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/sha', prUrl: PR_URL })

  const done = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/sha', stage: 'review', status: 'done', summary: 'lgtm' })
  expect(done.result).toBe('Stage review done: lgtm (at aaaaaaa). (no running call was recorded)')
  expect((await stageOf($, 'feature/sha', 'review')).headSha).toBe(sha('a'))
  expect(ran(calls, 'gh', 'pr', 'view').some(argv => argv.join(' ').endsWith('--json headRefOid'))).toBe(true)

  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/sha', stage: 'acceptance', status: 'done', sha: 'bbbbbbb' })
  expect((await stageOf($, 'feature/sha', 'acceptance')).headSha).toBe('bbbbbbb')
  expect((await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/sha', stage: 'proof', sha: 'not-a-sha' })).deny).toMatch(/"sha" must be a commit sha/)
})

test('without a PR the verdict takes HEAD of the checkout, and an unknown head leaves it unset', async ($, on) => {
  let head: { stdout?: string; exitCode?: number } = { stdout: `${sha('c')}\n` }
  boot(on, [[['git', 'rev-parse', 'HEAD'], () => head]])
  mock.store(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/local' })
  await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/local', stage: 'review', status: 'done' })
  expect((await stageOf($, 'feature/local', 'review')).headSha).toBe(sha('c'))

  head = { exitCode: 128 }
  const ended = await $.tool.call({ tool: TOOL, action: 'stage', branch: 'feature/local', stage: 'acceptance', status: 'done' })
  expect(ended.result).toBe('Stage acceptance done. (no running call was recorded)')
  expect((await stageOf($, 'feature/local', 'acceptance')).headSha).toBeUndefined()
})

test('commits after the AI review raise a stale row whose press asks for a delta review', async ($, on) => {
  const world: PrWorld = { view: prView({ headRefOid: sha('2'), commits: commits(sha('1'), sha('2')) }), threads: [] }
  const { prompts } = boot(on, prRoutes(world))
  mock.store(on)
  await $.session.start(START)
  const branch = 'feature/stale'
  await $.tool.call({ tool: TOOL, action: 'start', branch, prUrl: PR_URL })
  for (const stage of ['enhance', 'implement', 'pr', 'review', 'address', 'verify', 'acceptance', 'risk', 'proof']) {
    await $.tool.call({ tool: TOOL, action: 'stage', branch, stage, status: 'done' })
  }
  await $.tool.call({ tool: TOOL, action: 'pr', branch, fresh: true })

  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await fresh.find({ key: 'attn:stale' })).toBeUndefined()
  await fresh.unmount()

  world.view = prView({ headRefOid: sha('4'), commits: commits(sha('1'), sha('2'), sha('3'), sha('4')) })
  await $.tool.call({ tool: TOOL, action: 'pr', branch, fresh: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'attn:stale' }))?.text).toBe('2 commits since AI review · proof stale')
  await ui.press({ key: 'attn:stale' })
  expect(prompts.at(-1)).toBe(
    `Run the pr-pipeline:review skill on PR #42 for the commits after ${sha('2')} only (git diff ${sha('2')}..${sha('4')}), ` +
    `passing branch "o/r#${branch}". Then re-run the acceptance check and the proof if they were done.`,
  )
  await ui.unmount()

  world.view = prView({ headRefOid: sha('9'), commits: commits(sha('8'), sha('9')) })
  await $.tool.call({ tool: TOOL, action: 'pr', branch, fresh: true })
  const pushed = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pushed.find({ key: 'attn:stale' }))?.text).toBe('AI review predates a force-push · proof stale')
  await pushed.unmount()

  world.view = prView({ state: 'MERGED', headRefOid: sha('9'), commits: commits(sha('8'), sha('9')) })
  await $.tool.call({ tool: TOOL, action: 'pr', branch, fresh: true })
  const merged = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await merged.find({ key: 'attn:stale' })).toBeUndefined()
  await merged.unmount()
})

test("the Merge button uses the run's profile merge method over the setting", async ($, on) => {
  const { calls } = boot(on, prRoutes({ view: prView(), threads: [] }))
  mock.store(on)
  fakeFs(on, { '/repo/.pr-pipeline.json': JSON.stringify({ mergeMethod: 'rebase', lint: 'make lint', test: 'make test' }) })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: { 'Merge #42 with rebase?': 'Merge' } } }))
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/method', prUrl: PR_URL })
  await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/method' })
  await $.tool.call({ tool: TOOL, action: 'pr', branch: 'feature/method', fresh: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'pr:merge' }))?.props.label).toBe('Merge (rebase)')
  await ui.press({ key: 'pr:merge' })
  expect(ran(calls, 'gh', 'pr', 'merge')).toEqual([['gh', 'pr', 'merge', '42', '--repo', 'o/r', '--rebase']])
  await ui.unmount()
})
