import type { EngineInterface } from 'claude-code'
import type {
  Harnesses,
  Mergeable,
  MergeMethod,
  PrCheck,
  PrCheckStatus,
  PrComment,
  PrRef,
  PrReview,
  PrReviewState,
  PrSnapshot,
  PrStateName,
  PrSummary,
  PrThread,
  RepoRef,
  ReviewDecision,
} from '../types'

export type GhResult = { ok: true; stdout: string } | { ok: false; error: string }

type CommandOptions = { cwd?: string; host?: string; stdin?: string }

const TIMEOUT_MS = 20_000
const BODY_LIMIT = 4_000
const HUNK_LINES = 60
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']
const PASSED_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const FAILED_CONCLUSIONS = new Set(['failure', 'error', 'timed_out', 'action_required', 'cancelled', 'startup_failure'])
const REVIEW_STATES = new Set<PrReviewState>(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'])

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:20){nodes{id author{login} body diffHunk createdAt url}}}}}}}'
const REPLY_MUTATION =
  'mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id url}}}'
const RESOLVE_MUTATION = 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}'
const VIEW_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,labels,statusCheckRollup,reviews,headRefName,baseRefName,additions,deletions,changedFiles'

const OWNER_REPO = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
const SCP_REMOTE = /^[\w.-]+@([\w.-]+):\/?(.+)$/
const URL_REMOTE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([\w.-]+)(?::\d+)?\/(.+)$/
const PR_URL = /^https?:\/\/([\w.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/(?:files|checks|commits))?\/?(?:[?#].*)?$/
const RUN_ID = /\/actions\/runs\/(\d+)/

export function parseRemote(url: string): RepoRef | null {
  const trimmed = url.trim()
  const matched = URL_REMOTE.exec(trimmed) ?? SCP_REMOTE.exec(trimmed)
  if (matched === null) return null
  const [, host, path] = matched
  const slug = OWNER_REPO.exec(path ?? '')
  if (host === undefined || slug === null) return null
  return { host: host.toLowerCase(), slug: `${slug[1]}/${slug[2]}` }
}

export function parsePrUrl(url: string): PrRef | null {
  const matched = PR_URL.exec(url.trim())
  if (matched === null) return null
  const [, host, owner, repo, number] = matched
  const prNumber = Number(number)
  if (host === undefined || prNumber <= 0) return null
  return { host: host.toLowerCase(), slug: `${owner}/${repo}`, number: prNumber }
}

export function prPageUrl(pr: PrRef): string {
  return `https://${pr.host}/${pr.slug}/pull/${pr.number}`
}

export function runIdOf(detailsUrl: string | undefined): string | null {
  if (detailsUrl === undefined) return null
  return RUN_ID.exec(detailsUrl)?.[1] ?? null
}

async function readEnv($: EngineInterface): Promise<{ path: string | undefined; home: string | undefined }> {
  const [path, home] = await Promise.all([
    $.env.get('PATH').catch(() => undefined),
    $.env.get('HOME').catch(() => undefined),
  ])
  return { path, home }
}

async function commandEnv($: EngineInterface, host?: string): Promise<Record<string, string>> {
  const { path, home } = await readEnv($)
  const parts = [path ?? '', ...EXTRA_PATHS, home ? `${home}/.local/bin` : '']
    .flatMap(part => part.split(':'))
    .filter(part => part !== '')
  const env: Record<string, string> = {
    PATH: [...new Set(parts)].join(':'),
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  }
  if (host !== undefined && host !== '' && host.toLowerCase() !== 'github.com') env.GH_HOST = host
  return env
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const record = asRecord(error)
  return str(record.message) || str(record.deny) || String(error)
}

function prNumberFrom(argv: readonly string[]): string | null {
  for (const [index, part] of argv.entries()) {
    const typed = /^number=(\d+)$/.exec(part)
    if (typed) return typed[1] ?? null
    if ((part === 'view' || part === 'merge') && /^\d+$/.test(argv[index + 1] ?? '')) return argv[index + 1] ?? null
  }
  return null
}

function knownFailure(tool: string, argv: readonly string[], text: string): string | null {
  if (tool === 'gh' && /not logged in|auth login/i.test(text)) return 'gh: not logged in (run gh auth login)'
  if (/Could not resolve to a PullRequest/.test(text)) {
    const number = prNumberFrom(argv)
    return number === null ? 'PR not found' : `PR #${number} not found`
  }
  return null
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

function startFailure(tool: string, argv: readonly string[], error: unknown): string {
  const record = asRecord(error)
  const message = messageOf(error)
  const stderr = str(record.stderr)
  const known = knownFailure(tool, argv, `${stderr}\n${message}`)
  if (known !== null) return known
  if (str(record.code) === 'ENOENT' || /ENOENT|not found|no such file/i.test(message)) return `${tool} not found on PATH`
  if (/timed? ?out|timeout/i.test(message)) return `${tool} timed out after ${TIMEOUT_MS / 1000} s`
  return firstLine(stderr) || firstLine(message) || `${tool} failed`
}

async function runCommand($: EngineInterface, argv: readonly string[], options: CommandOptions): Promise<GhResult> {
  const tool = argv[0] ?? 'command'
  let ran: unknown
  try {
    const env = await commandEnv($, options.host)
    ran = await $.process.run(argv, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      env,
      timeoutMs: TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, error: startFailure(tool, argv, error) }
  }
  const result = asRecord(ran)
  const stdout = str(result.stdout)
  const stderr = str(result.stderr)
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0
  if (result.isStdoutTruncated === true) return { ok: false, error: `${tool} output over 4 MiB` }
  if (exitCode === 0) return { ok: true, stdout }
  return {
    ok: false,
    error: knownFailure(tool, argv, stderr) ?? (firstLine(stderr) || `${tool} exited with code ${exitCode}`),
  }
}

export async function git($: EngineInterface, argv: string[], cwd?: string): Promise<GhResult> {
  return runCommand($, ['git', ...argv], cwd !== undefined ? { cwd } : {})
}

export async function gh(
  $: EngineInterface,
  argv: string[],
  opts: { cwd?: string; host?: string; stdin?: string } = {},
): Promise<GhResult> {
  return runCommand($, ['gh', ...argv], opts)
}

export async function repoRef($: EngineInterface, cwd?: string): Promise<RepoRef | null> {
  const remote = await git($, ['remote', 'get-url', 'origin'], cwd)
  return remote.ok ? parseRemote(remote.stdout) : null
}

export async function currentBranch($: EngineInterface, cwd?: string): Promise<string | null> {
  const branch = await git($, ['branch', '--show-current'], cwd)
  if (!branch.ok) return null
  const name = branch.stdout.trim()
  return name === '' ? null : name
}

function ghOptions(pr: PrRef, cwd?: string): CommandOptions {
  return cwd !== undefined ? { host: pr.host, cwd } : { host: pr.host }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function fetchPr(
  $: EngineInterface,
  pr: PrRef,
  now: number,
  cwd?: string,
): Promise<{ ok: true; snapshot: PrSnapshot } | { ok: false; error: string }> {
  const [owner = '', name = ''] = pr.slug.split('/')
  const options = ghOptions(pr, cwd)
  const [view, threads] = await Promise.all([
    gh($, ['pr', 'view', String(pr.number), '--repo', pr.slug, '--json', VIEW_FIELDS], options),
    gh($, ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`, '-f', `query=${THREADS_QUERY}`], options),
  ])
  if (!view.ok) return { ok: false, error: view.error }
  const viewJson = parseJson(view.stdout)
  if (viewJson === undefined) return { ok: false, error: 'gh pr view returned unreadable JSON' }
  const threadNodes = threads.ok ? parseJson(threads.stdout) : []
  return { ok: true, snapshot: toSnapshot(viewJson, threadNodes, now) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nodesOf(connection: unknown): unknown[] {
  if (Array.isArray(connection)) return connection
  return asArray(asRecord(connection).nodes)
}

function lowerOrUndefined(value: unknown): string | undefined {
  const text = str(value).toLowerCase()
  return text === '' ? undefined : text
}

function checkStatus(value: unknown): PrCheckStatus {
  const status = str(value).toLowerCase()
  if (status === 'completed' || status === 'in_progress' || status === 'queued') return status
  return 'pending'
}

function toCheck(item: unknown): PrCheck {
  const record = asRecord(item)
  const isStatusContext = record.__typename === 'StatusContext' || (record.__typename === undefined && 'context' in record)
  if (isStatusContext) {
    const state = str(record.state).toUpperCase()
    const isPending = state === 'PENDING' || state === 'EXPECTED' || state === ''
    const url = str(record.targetUrl)
    return {
      name: str(record.context),
      status: isPending ? 'pending' : 'completed',
      ...(isPending ? {} : { conclusion: state.toLowerCase() }),
      ...(url !== '' ? { url } : {}),
    }
  }
  const url = str(record.detailsUrl)
  const conclusion = lowerOrUndefined(record.conclusion)
  const runId = runIdOf(url || undefined)
  return {
    name: str(record.name) || str(record.workflowName),
    status: checkStatus(record.status),
    ...(conclusion !== undefined ? { conclusion } : {}),
    ...(url !== '' ? { url } : {}),
    ...(runId !== null ? { runId } : {}),
  }
}

function isPassed(check: PrCheck): boolean {
  return check.status === 'completed' && PASSED_CONCLUSIONS.has(check.conclusion ?? '')
}

function isFailed(check: PrCheck): boolean {
  return FAILED_CONCLUSIONS.has(check.conclusion ?? '')
}

function latestReviews(items: unknown[]): PrReview[] {
  const byAuthor = new Map<string, PrReview>()
  for (const item of items) {
    const record = asRecord(item)
    const author = str(asRecord(record.author).login)
    const state = str(record.state) as PrReviewState
    if (author === '' || !REVIEW_STATES.has(state)) continue
    const submittedAt = str(record.submittedAt)
    const previous = byAuthor.get(author)
    if (previous?.submittedAt !== undefined && submittedAt !== '' && submittedAt < previous.submittedAt) continue
    byAuthor.set(author, { author, state, ...(submittedAt !== '' ? { submittedAt } : {}) })
  }
  return [...byAuthor.values()]
}

function cutBody(body: string): string {
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body
}

function cutHunk(hunk: string): string {
  const lines = hunk.split('\n')
  return lines.length > HUNK_LINES ? lines.slice(-HUNK_LINES).join('\n') : hunk
}

function toComment(item: unknown): PrComment {
  const record = asRecord(item)
  const diffHunk = str(record.diffHunk)
  return {
    id: str(record.id),
    author: str(asRecord(record.author).login, 'ghost'),
    body: cutBody(str(record.body)),
    createdAt: str(record.createdAt),
    url: str(record.url),
    ...(diffHunk !== '' ? { diffHunk: cutHunk(diffHunk) } : {}),
  }
}

function toThread(item: unknown): PrThread {
  const record = asRecord(item)
  return {
    id: str(record.id),
    path: str(record.path),
    line: typeof record.line === 'number' ? record.line : null,
    isResolved: record.isResolved === true,
    isOutdated: record.isOutdated === true,
    comments: nodesOf(record.comments).map(toComment),
  }
}

function threadNodesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const pullRequest = asRecord(asRecord(asRecord(asRecord(value).data).repository).pullRequest)
  return nodesOf(pullRequest.reviewThreads)
}

function prState(value: unknown): PrStateName {
  return value === 'CLOSED' || value === 'MERGED' ? value : 'OPEN'
}

function mergeable(value: unknown): Mergeable {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN'
}

function reviewDecision(value: unknown): ReviewDecision {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED' ? value : ''
}

export function toSnapshot(view: unknown, threadNodes: unknown, now: number): PrSnapshot {
  const record = asRecord(view)
  const checks = asArray(record.statusCheckRollup).map(toCheck)
  const threads = threadNodesOf(threadNodes).map(toThread)
  return {
    number: num(record.number),
    url: str(record.url),
    title: str(record.title),
    state: prState(record.state),
    isDraft: record.isDraft === true,
    baseRefName: str(record.baseRefName),
    headRefName: str(record.headRefName),
    mergeable: mergeable(record.mergeable),
    mergeState: str(record.mergeStateStatus, 'UNKNOWN') || 'UNKNOWN',
    reviewDecision: reviewDecision(record.reviewDecision),
    labels: asArray(record.labels).map(label => str(asRecord(label).name)).filter(name => name !== ''),
    checks,
    reviews: latestReviews(asArray(record.reviews)),
    threads,
    counts: {
      additions: num(record.additions),
      deletions: num(record.deletions),
      changedFiles: num(record.changedFiles),
      checksPassed: checks.filter(isPassed).length,
      checksFailed: checks.filter(isFailed).length,
      checksPending: checks.filter(check => check.status !== 'completed').length,
      threadsOpen: threads.filter(thread => !thread.isResolved && !thread.isOutdated).length,
      threadsTotal: threads.length,
    },
    fetchedAt: now,
  }
}

export function toSummary(snapshot: PrSnapshot): PrSummary {
  return {
    number: snapshot.number,
    url: snapshot.url,
    title: snapshot.title,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    mergeable: snapshot.mergeable,
    mergeState: snapshot.mergeState,
    reviewDecision: snapshot.reviewDecision,
    counts: snapshot.counts,
    fetchedAt: snapshot.fetchedAt,
    failing: snapshot.checks.filter(isFailed).map(check => check.name),
  }
}

export async function replyToThread($: EngineInterface, pr: PrRef, threadId: string, body: string, cwd?: string): Promise<GhResult> {
  return gh($, ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `threadId=${threadId}`, '-f', `body=${body}`], ghOptions(pr, cwd))
}

export async function resolveThread($: EngineInterface, pr: PrRef, threadId: string, cwd?: string): Promise<GhResult> {
  return gh($, ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${threadId}`], ghOptions(pr, cwd))
}

export async function mergePr($: EngineInterface, pr: PrRef, method: MergeMethod, cwd?: string): Promise<GhResult> {
  return gh($, ['pr', 'merge', String(pr.number), '--repo', pr.slug, `--${method}`], ghOptions(pr, cwd))
}

export async function rerunFailed($: EngineInterface, pr: PrRef, runId: string, cwd?: string): Promise<GhResult> {
  return gh($, ['run', 'rerun', runId, '--failed', '--repo', pr.slug], ghOptions(pr, cwd))
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function mergeGuard(snapshot: PrSnapshot, gate: { approvalRequired: boolean }): { ok: true } | { ok: false; reasons: string[] } {
  const { counts, mergeState, reviewDecision: decision } = snapshot
  const reasons: string[] = []
  if (snapshot.isDraft || mergeState === 'DRAFT') reasons.push('draft')
  if (snapshot.mergeable === 'CONFLICTING' || mergeState === 'DIRTY') reasons.push('merge conflicts')
  if (decision === 'CHANGES_REQUESTED') reasons.push('changes requested')
  if (decision !== 'CHANGES_REQUESTED' && decision !== 'APPROVED' && gate.approvalRequired) reasons.push('needs approval')
  if (counts.checksFailed > 0) reasons.push(plural(counts.checksFailed, 'failing check'))
  if (counts.checksPending > 0) reasons.push(plural(counts.checksPending, 'pending check'))
  if (mergeState === 'BEHIND') reasons.push('behind base')
  if (mergeState === 'BLOCKED') reasons.push('blocked by branch rules')
  if (snapshot.state === 'CLOSED') reasons.push('closed')
  if (snapshot.state === 'MERGED') reasons.push('merged')
  const isMergeStateClear = mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS'
  if (reasons.length === 0 && snapshot.mergeable !== 'MERGEABLE') reasons.push('mergeability unknown')
  if (reasons.length === 0 && !isMergeStateClear) reasons.push(`merge state ${mergeState.toLowerCase()}`)
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

async function whichPath($: EngineInterface, name: string): Promise<string | null> {
  const found = await runCommand($, ['which', name], {})
  if (!found.ok) return null
  return firstLine(found.stdout) || null
}

export async function detectHarnesses($: EngineInterface, now: number): Promise<Harnesses> {
  const [ghPath, codexPath, opencodePath] = await Promise.all([
    whichPath($, 'gh'),
    whichPath($, 'codex'),
    whichPath($, 'opencode'),
  ])
  return { gh: ghPath, codex: codexPath, opencode: opencodePath, checkedAt: now }
}
