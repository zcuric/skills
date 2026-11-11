import { expect, mock, test } from 'claude-code/testing'

import { boot, fakeFs, ran, START, TOOL } from './kit'
import { branchPatternOf, matchLabels, pathSafeTicket } from '../hooks/profile'

const REPO_VIEW = { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, squashMergeAllowed: false, rebaseMergeAllowed: true, mergeCommitAllowed: true }
const LABELS = [':bug: Bug', 'enhancement', 'Code Review', 'Ready to merge', 'ai: lgtm', 'wontfix'].map(name => ({ name }))
const HEADS = ['feat/abc-1-a', 'feat/abc-2-b', 'feat/abc-3-c', 'fix/abc-4-d'].map(headRefName => ({ headRefName }))

test('profile reads .pr-pipeline.json, fills every default and creates the criteria directory', async ($, on) => {
  const { calls } = boot(on)
  mock.store(on)
  fakeFs(on, { '/repo/.pr-pipeline.json': JSON.stringify({ $schema: 'x', lint: 'make lint', test: 'make test', mergeMethod: 'merge', labels: { typeBug: 'bug' } }) })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/abc-123', ticket: 'ABC-123' })

  const answer = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/abc-123' })).result))
  expect(answer).toEqual({
    source: 'file',
    path: '/repo/.pr-pipeline.json',
    profile: {
      tracker: 'auto',
      branchPattern: '{type}/{key}-{slug}',
      titlePrefix: '[{key}]',
      linkLine: '[{key}]({url})',
      prBody: 'visual-pr',
      labels: {
        typeBug: 'bug', typeFeature: null, stateReview: null, aiChangesRequested: null, aiLgtm: null, aiVerified: null, readyToMerge: null, needsWork: null,
      },
      lint: 'make lint',
      test: 'make test',
      e2e: null,
      e2ePolicy: 'auto',
      securityAgent: null,
      siblings: [],
      rules: [],
      criteriaDir: '~/.claude/pipeline/{owner}-{repo}/{ticket}',
      mergeMethod: 'merge',
    },
    criteriaDir: '/home/dev/.claude/pipeline/o-r/ABC-123',
  })
  expect(ran(calls, 'mkdir')).toEqual([['mkdir', '-p', '/home/dev/.claude/pipeline/o-r/ABC-123']])
  expect(ran(calls, 'gh').map(argv => argv.slice(0, 3))).toEqual([['gh', 'repo', 'view']])
  const run = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'status', branch: 'feature/abc-123' })).result))
  expect(run.criteriaDir).toBe('/home/dev/.claude/pipeline/o-r/ABC-123')
  expect(run.mergeMethod).toBe('merge')
})

test('without a profile file, discovery fills base, merge method, labels, checks, rules and branches', async ($, on) => {
  boot(on, [
    [['gh', 'repo', 'view'], { stdout: JSON.stringify(REPO_VIEW) }],
    [['gh', 'label', 'list'], { stdout: JSON.stringify(LABELS) }],
    [['gh', 'pr', 'list'], { stdout: JSON.stringify(HEADS) }],
  ])
  mock.store(on)
  fakeFs(on, {
    '/repo/package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }),
    '/repo/yarn.lock': '',
    '/repo/CLAUDE.md': '# rules',
    '/repo/.ai/rules/index.md': '# index',
    '/repo/.claude/agents/security-reviewer.md': '---',
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/disc', ticket: '#42', tracker: 'github' })

  const answer = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/disc' })).result))
  expect(answer.source).toBe('discovered')
  expect(answer.path).toBeUndefined()
  expect(answer.base).toBe('main')
  expect(answer.discovered).toBe('base main, rebase, 5 labels matched, checks from package.json, branches feat/{key}-{slug}, security-reviewer')
  expect(answer.profile).toMatchObject({
    mergeMethod: 'rebase',
    lint: 'yarn lint',
    test: 'yarn test',
    rules: ['CLAUDE.md', '.ai/rules/index.md'],
    securityAgent: 'security-reviewer',
    e2e: null,
    branchPattern: 'feat/{key}-{slug}',
    titlePrefix: '',
    linkLine: 'Closes #{n}',
    labels: { typeBug: ':bug: Bug', typeFeature: 'enhancement', stateReview: 'Code Review', readyToMerge: 'Ready to merge', aiLgtm: 'ai: lgtm', needsWork: null },
  })
  expect(answer.criteriaDir).toBe('/home/dev/.claude/pipeline/o-r/issue-42')
})

test('lint and test from several build files are joined, composer prefixed with sail', async ($, on) => {
  boot(on)
  mock.store(on)
  fakeFs(on, {
    '/repo/package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
    '/repo/composer.json': JSON.stringify({ scripts: { lint: 'pint', test: 'phpunit' } }),
    '/repo/docker-compose.yml': 'services:\n  laravel.test:\n    image: sail-8.4/app\n',
    '/repo/go.mod': 'module x',
  })
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/many', ticket: 'text:fix the login page' })
  const answer = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/many' })).result))
  expect(answer.profile.lint).toBe('npm run lint && vendor/bin/sail composer lint && go vet ./...')
  expect(answer.profile.test).toBe('vendor/bin/sail composer test && go test ./...')
  expect(answer.profile.mergeMethod).toBe('squash')
  expect(answer.discovered).toBe('base unknown, merge method unknown, 0 labels matched, checks from package.json, composer.json, go.mod')
  expect(answer.criteriaDir).toBe('/home/dev/.claude/pipeline/o-r/text-fix-the-login-page')
})

test('save writes a discovered profile untracked, and is refused once a profile file exists', async ($, on) => {
  const { calls } = boot(on, [[['gh', 'repo', 'view'], { stdout: JSON.stringify(REPO_VIEW) }]])
  mock.store(on)
  const files: Record<string, string> = { '/repo/package.json': JSON.stringify({ scripts: { test: 'jest' } }), '/repo/AGENTS.md': '' }
  const { writes } = fakeFs(on, files)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, action: 'start', branch: 'feature/save', ticket: 'ABC-9' })

  const answer = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/save', save: true })).result))
  expect(answer.saved).toBe('/repo/.pr-pipeline.json written, untracked: never git add it')
  expect(writes.map(write => write.path)).toEqual(['/repo/.pr-pipeline.json'])
  expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({
    $schema: 'https://github.com/zcuric/skills/plugins/pr-pipeline/profiles/pr-pipeline.schema.json',
    test: 'npm test',
    rules: ['AGENTS.md'],
    mergeMethod: 'rebase',
  })
  expect(ran(calls, 'git', 'add')).toEqual([])

  const refused = await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/save', save: true })
  expect(refused.deny).toBe('pr-pipeline: /repo/.pr-pipeline.json already exists; save is refused.')
  const again = JSON.parse(String((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/save' })).result))
  expect(again.source).toBe('file')
  expect(again.profile.test).toBe('npm test')
})

test('profile needs a run', async ($, on) => {
  boot(on)
  mock.store(on)
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, action: 'profile', branch: 'feature/none' })).deny).toMatch(/no run for/)
})

test('tickets become path-safe criteria directory names', () => {
  expect(pathSafeTicket('ABC-123')).toBe('ABC-123')
  expect(pathSafeTicket('#42')).toBe('issue-42')
  expect(pathSafeTicket('o/r#42')).toBe('issue-42')
  expect(pathSafeTicket('https://github.com/o/r/issues/42')).toBe('issue-42')
  expect(pathSafeTicket('text:fix-login')).toBe('text-fix-login')
  expect(pathSafeTicket('a b/../c')).toBe('a-b-..-c')
})

test('labels match by name with shortcodes stripped; ai labels only exactly', () => {
  expect(matchLabels([':sparkles: Feature', 'needs  work', 'AI: Changes Requested', 'ai: verified please', 'reviewed'])).toEqual({
    typeBug: null,
    typeFeature: ':sparkles: Feature',
    stateReview: null,
    aiChangesRequested: 'AI: Changes Requested',
    aiLgtm: null,
    aiVerified: null,
    readyToMerge: null,
    needsWork: 'needs  work',
  })
})

test('branch pattern changes only when most recent heads share another shape', () => {
  expect(branchPatternOf(['feature/a-1-x', 'fix/a-2-y', 'feat/a-3-z'])).toBeUndefined()
  expect(branchPatternOf(['ABC-1/x', 'ABC-2/y', 'feature/abc-3-z'])).toBe('{key}/{slug}')
  expect(branchPatternOf(['feat/a'])).toBeUndefined()
})
