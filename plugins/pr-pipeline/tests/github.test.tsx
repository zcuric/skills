import { expect, test } from 'claude-code/testing'
import type { EngineInterface, ProcessRunInit } from 'claude-code'

import { fetchPr, gh, mergeGuard, mergePr, parsePrUrl, parseRemote, replyToThread, toSnapshot, toSummary } from '../hooks/github'
import type { PrCounts, PrSnapshot } from '../types'

type Answer = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean } | { reject: string }
type RunCall = { argv: readonly string[]; init?: ProcessRunInit }

function fakeEngine(variables: Record<string, string>, answer: (argv: readonly string[]) => Answer): { engine: EngineInterface; calls: RunCall[] } {
  const calls: RunCall[] = []
  const engine = {
    process: {
      run: async (argv: readonly string[], init?: ProcessRunInit) => {
        calls.push(init !== undefined ? { argv, init } : { argv })
        const answered = answer(argv)
        if ('reject' in answered) throw new Error(answered.reject)
        return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answered }
      },
    },
    env: { get: async (name: string) => variables[name] },
  }
  return { engine: engine as unknown as EngineInterface, calls }
}

const VIEW = {
  number: 42,
  title: 'Fix the thing',
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'CHANGES_REQUESTED',
  headRefName: 'feature/x',
  baseRefName: 'main',
  additions: 10,
  deletions: 3,
  changedFiles: 2,
  labels: [{ name: 'bug' }, { name: 'ai review' }],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/1' },
    { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/987654/job/2' },
    { __typename: 'StatusContext', context: 'ci/deploy', state: 'PENDING', targetUrl: 'https://ci.example/build/5' },
  ],
  reviews: [
    { author: { login: 'ana' }, state: 'COMMENTED', submittedAt: '2026-10-01T10:00:00Z' },
    { author: { login: 'ana' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T10:00:00Z' },
  ],
}

const THREADS = [
  { id: 'T1', isResolved: true, isOutdated: false, path: 'a.ts', line: 3, comments: { nodes: [{ id: 'C1', author: { login: 'ana' }, body: 'done?', diffHunk: '@@ -1 +1 @@', createdAt: '2026-10-01T10:00:00Z', url: 'u1' }] } },
  { id: 'T2', isResolved: false, isOutdated: false, path: 'b.ts', line: 9, comments: { nodes: [{ id: 'C2', author: { login: 'ana' }, body: 'x'.repeat(5000), diffHunk: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'), createdAt: '2026-10-01T10:00:00Z', url: 'u2' }] } },
  { id: 'T3', isResolved: false, isOutdated: true, path: 'c.ts', line: null, comments: { nodes: [] } },
]

function snapshot(overrides: Omit<Partial<PrSnapshot>, 'counts'> = {}, counts: Partial<PrCounts> = {}): PrSnapshot {
  const base = toSnapshot({ ...VIEW, statusCheckRollup: [], reviews: [], mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }, [], 0)
  return { ...base, ...overrides, counts: { ...base.counts, ...counts } }
}

test('parseRemote reads ssh, https and enterprise remotes', () => {
  expect(parseRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', slug: 'o/r' })
  expect(parseRemote('https://github.com/o/r.git')).toEqual({ host: 'github.com', slug: 'o/r' })
  expect(parseRemote('https://github.com/o/r')).toEqual({ host: 'github.com', slug: 'o/r' })
  expect(parseRemote('ssh://git@ghe.corp/o/r.git')).toEqual({ host: 'ghe.corp', slug: 'o/r' })
  expect(parseRemote('https://ghe.corp/o/r\n')).toEqual({ host: 'ghe.corp', slug: 'o/r' })
  expect(parseRemote('not a remote')).toBeNull()
  expect(parseRemote('https://github.com/only-owner')).toBeNull()
})

test('parsePrUrl reads page urls and refuses issue urls', () => {
  expect(parsePrUrl('https://github.com/o/r/pull/7')).toEqual({ host: 'github.com', slug: 'o/r', number: 7 })
  expect(parsePrUrl('https://github.com/o/r/pull/7/files')).toEqual({ host: 'github.com', slug: 'o/r', number: 7 })
  expect(parsePrUrl('https://ghe.corp/o/r/pull/12#discussion_r1')).toEqual({ host: 'ghe.corp', slug: 'o/r', number: 12 })
  expect(parsePrUrl('https://github.com/o/r/issues/7')).toBeNull()
  expect(parsePrUrl('https://github.com/o/r/pull/7/commits/abc')).toBeNull()
})

test('toSnapshot normalises checks, reviews and threads', () => {
  const pr = toSnapshot(VIEW, THREADS, 1234)
  expect(pr.checks).toEqual([
    { name: 'lint', status: 'completed', conclusion: 'success', url: 'https://github.com/o/r/actions/runs/111/job/1', runId: '111' },
    { name: 'tests', status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/987654/job/2', runId: '987654' },
    { name: 'ci/deploy', status: 'pending', url: 'https://ci.example/build/5' },
  ])
  expect(pr.counts).toEqual({ additions: 10, deletions: 3, changedFiles: 2, checksPassed: 1, checksFailed: 1, checksPending: 1, threadsOpen: 1, threadsTotal: 3 })
  expect(pr.reviews).toEqual([{ author: 'ana', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T10:00:00Z' }])
  expect(pr.labels).toEqual(['bug', 'ai review'])
  expect(pr.fetchedAt).toBe(1234)
  const open = pr.threads.find(thread => thread.id === 'T2')
  expect(open?.comments[0]?.body.length).toBe(4000)
  expect(open?.comments[0]?.diffHunk?.split('\n')).toHaveLength(60)
  expect(open?.comments[0]?.diffHunk?.endsWith('line 79')).toBe(true)
  expect(toSummary(pr).failing).toEqual(['tests'])
})

test('toSnapshot survives a view with nothing in it', () => {
  const pr = toSnapshot({}, undefined, 5)
  expect(pr.mergeable).toBe('UNKNOWN')
  expect(pr.mergeState).toBe('UNKNOWN')
  expect(pr.reviewDecision).toBe('')
  expect(pr.checks).toEqual([])
  expect(pr.threads).toEqual([])
})

test('mergeGuard passes an approved, clean PR', () => {
  expect(mergeGuard(snapshot(), { approvalRequired: true })).toEqual({ ok: true })
})

test('mergeGuard lets a low-risk run merge without approval', () => {
  const pending = snapshot({ reviewDecision: 'REVIEW_REQUIRED' })
  expect(mergeGuard(pending, { approvalRequired: false })).toEqual({ ok: true })
  expect(mergeGuard(pending, { approvalRequired: true, why: 'risk medium' })).toEqual({
    ok: false,
    reasons: ['needs a human approval (risk medium) — request one on GitHub'],
  })
})

test('mergeGuard lists reasons in order', () => {
  const blocked = snapshot({ isDraft: true }, { checksFailed: 2, checksPending: 1 })
  expect(mergeGuard(blocked, { approvalRequired: true })).toEqual({ ok: false, reasons: ['draft', '2 failing checks', '1 pending check'] })
})

test('mergeGuard blocks on changes requested even when approval is not required', () => {
  const changes = snapshot({ reviewDecision: 'CHANGES_REQUESTED' })
  expect(mergeGuard(changes, { approvalRequired: false })).toEqual({ ok: false, reasons: ['changes requested'] })
})

test('gh reports a missing binary', async () => {
  const { engine } = fakeEngine({ PATH: '/usr/bin', HOME: '/Users/me' }, () => ({ reject: 'spawn gh ENOENT' }))
  expect(await gh(engine, ['pr', 'view', '1'])).toEqual({ ok: false, error: 'gh not found on PATH' })
})

test('gh reports a missing login', async () => {
  const { engine } = fakeEngine({ PATH: '/usr/bin', HOME: '/Users/me' }, () => ({ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }))
  expect(await gh(engine, ['pr', 'view', '1'])).toEqual({ ok: false, error: 'gh: not logged in (run gh auth login)' })
})

test('gh reports the first stderr line and an unknown PR', async () => {
  const { engine } = fakeEngine({ PATH: '/usr/bin' }, argv =>
    argv.includes('view')
      ? { exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)' }
      : { exitCode: 1, stderr: '\nboom\nmore' },
  )
  expect(await gh(engine, ['pr', 'view', '99', '--repo', 'o/r'])).toEqual({ ok: false, error: 'PR #99 not found' })
  expect(await gh(engine, ['run', 'list'])).toEqual({ ok: false, error: 'boom' })
})

test('gh runs with a pager-free env and an augmented PATH', async () => {
  const { engine, calls } = fakeEngine({ PATH: '/usr/bin:/bin', HOME: '/Users/me' }, () => ({ stdout: 'ok' }))

  expect(await gh(engine, ['pr', 'list'], { cwd: '/repo' })).toEqual({ ok: true, stdout: 'ok' })
  await gh(engine, ['pr', 'list'], { host: 'github.com' })
  await gh(engine, ['pr', 'list'], { host: 'ghe.corp' })

  const [first, onGithub, onEnterprise] = calls.filter(call => call.argv.join(' ') === 'gh pr list')
  expect(first?.argv).toEqual(['gh', 'pr', 'list'])
  expect(first?.init?.cwd).toBe('/repo')
  expect(first?.init?.timeoutMs).toBe(20_000)
  expect(first?.init?.env).toEqual({
    PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin',
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  })
  expect(onGithub?.init?.env?.GH_HOST).toBeUndefined()
  expect(onEnterprise?.init?.env?.GH_HOST).toBe('ghe.corp')
})

test('fetchPr composes the view and the threads', async () => {
  const { engine, calls } = fakeEngine({ PATH: '/usr/bin' }, argv =>
    argv[1] === 'pr'
      ? { stdout: JSON.stringify(VIEW) }
      : { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: THREADS } } } } }) },
  )
  const fetched = await fetchPr(engine, { host: 'github.com', slug: 'o/r', number: 42 }, 99)
  expect(fetched.ok).toBe(true)
  if (!fetched.ok) return
  expect(fetched.snapshot.counts.threadsTotal).toBe(3)
  expect(fetched.snapshot.fetchedAt).toBe(99)
  const view = calls.find(call => call.argv[0] === 'gh' && call.argv[1] === 'pr')
  expect(view?.argv.slice(0, 7)).toEqual(['gh', 'pr', 'view', '42', '--repo', 'o/r', '--json'])
  const threads = calls.find(call => call.argv[0] === 'gh' && call.argv[1] === 'api')
  expect(threads?.argv).toContain('number=42')
  expect(threads?.argv).toContain('owner=o')
})

test('fetchPr survives a failing threads call', async () => {
  const { engine } = fakeEngine({ PATH: '/usr/bin' }, argv => (argv[1] === 'pr' ? { stdout: JSON.stringify(VIEW) } : { exitCode: 1, stderr: 'GraphQL: forbidden' }))
  const fetched = await fetchPr(engine, { host: 'github.com', slug: 'o/r', number: 42 }, 1)
  expect(fetched.ok).toBe(true)
  if (!fetched.ok) return
  expect(fetched.snapshot.threads).toEqual([])
  expect(fetched.snapshot.counts.threadsOpen).toBe(0)
  expect(fetched.snapshot.counts.checksFailed).toBe(1)
})

test('fetchPr fails when the view fails', async () => {
  const { engine } = fakeEngine({ PATH: '/usr/bin' }, () => ({ exitCode: 1, stderr: 'HTTP 502' }))
  expect(await fetchPr(engine, { host: 'github.com', slug: 'o/r', number: 42 }, 1)).toEqual({ ok: false, error: 'HTTP 502' })
})

test('replies, merges and reruns run the expected gh commands', async () => {
  const { engine, calls } = fakeEngine({ PATH: '/usr/bin' }, () => ({ stdout: '{}' }))
  const pr = { host: 'ghe.corp', slug: 'o/r', number: 7 }
  await replyToThread(engine, pr, 'PRRT_1', '@file looks fine')
  await mergePr(engine, pr, 'squash')
  expect(calls[0]?.argv).toContain('body=@file looks fine')
  expect(calls[0]?.argv).toContain('threadId=PRRT_1')
  expect(calls[0]?.init?.env?.GH_HOST).toBe('ghe.corp')
  expect(calls[1]?.argv).toEqual(['gh', 'pr', 'merge', '7', '--repo', 'o/r', '--squash'])
})
