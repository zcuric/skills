import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export type Answer = { exitCode?: number; stdout?: string; stderr?: string } | { reject: string }
export type Route = readonly [prefix: readonly string[], answer: Answer | ((argv: readonly string[]) => Answer)]

export const TOOL = 'mcp__pr-pipeline__pipeline'
export const START = { cwd: '/repo', surface: 'desktop', isInteractive: true } as const
export const PANE = {
  plugin: 'pr-pipeline',
  component: 'Pane',
  requestId: 'pr-pipeline',
  props: { title: 'PR pipeline', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const

export const REPO_ROUTES: readonly Route[] = [
  [['git', 'remote', 'get-url', 'origin'], { stdout: 'git@github.com:o/r.git\n' }],
  [['git', 'branch', '--show-current'], { stdout: 'feature/current\n' }],
  [['which', 'gh'], { stdout: '/opt/homebrew/bin/gh\n' }],
  [['which'], { exitCode: 1 }],
]

/** Answers `$.process.run` from the first route whose argv prefix matches; unmatched commands exit 1. */
export function fakeProcess(on: On, table: readonly Route[]): string[][] {
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const route = table.find(([prefix]) => prefix.every((part, at) => argv[at] === part))
    const answer: Answer = route === undefined
      ? { exitCode: 1, stderr: `no fake for ${argv.join(' ')}` }
      : typeof route[1] === 'function' ? route[1](argv) : route[1]
    if ('reject' in answer) return { deny: answer.reject }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer } }
  })
  return calls
}

export type Booted = { clock: MockClock; calls: string[][]; prompts: string[]; configs: Array<{ key: string; value: unknown }>; toasts: string[] }

export function boot(on: On, routes: readonly Route[] = [], options: { now?: number; cwd?: string } = {}): Booted {
  const clock = mock.clock(on, { now: options.now ?? 1_000_000 })
  mock.env(on, { PATH: '/usr/bin', HOME: '/home/dev' })
  const prompts: string[] = []
  const configs: Array<{ key: string; value: unknown }> = []
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: options.cwd ?? '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__pr-pipeline__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('config.set', (_$, e) => {
    configs.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  const calls = fakeProcess(on, [...routes, ...REPO_ROUTES])
  return { clock, calls, prompts, configs, toasts }
}

export const ran = (calls: string[][], ...prefix: string[]): string[][] =>
  calls.filter(argv => prefix.every((part, at) => argv[at] === part))

export const PR_URL = 'https://github.com/o/r/pull/42'

export const prView = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 42,
  title: 'Fix the thing',
  url: PR_URL,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  headRefName: 'feature/x',
  baseRefName: 'main',
  additions: 10,
  deletions: 3,
  changedFiles: 2,
  labels: [],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/1' },
  ],
  reviews: [{ author: { login: 'ana' }, state: 'APPROVED', submittedAt: '2026-10-02T10:00:00Z' }],
  ...overrides,
})

export const prThread = (id: string, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'app/a.ts',
  line: 9,
  comments: {
    nodes: [{ id: `C${id}`, author: { login: 'ana' }, body, diffHunk: '@@ -1 +1 @@\n-old\n+new', createdAt: '2026-10-01T10:00:00Z', url: `${PR_URL}#discussion_${id}` }],
  },
  ...overrides,
})

export type PrWorld = { view: Record<string, unknown>; threads: unknown[] }

/** `gh pr view` and the threads query read `world` at call time, so a test can change the PR between fetches. */
export const prRoutes = (world: PrWorld): Route[] => [
  [['gh', 'pr', 'view'], () => ({ stdout: JSON.stringify(world.view) })],
  [['gh', 'api', 'graphql'], argv => argv.some(part => part.startsWith('query=mutation'))
    ? { stdout: '{}' }
    : { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: world.threads } } } } }) }],
]
