import type { EngineInterface } from 'claude-code'

import type { MergeMethod, PipelineRun, ProfileLabels, RepoProfile, Tracker } from '../types'
import { gh, git, runCommand } from './github'

export const PROFILE_FILES = ['.pr-pipeline.json', '.claude/pr-pipeline.json'] as const
const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', '.ai/rules/index.md']
const DEFAULT_BRANCH_PATTERN = '{type}/{key}-{slug}'
const DEFAULT_CRITERIA_DIR = '~/.claude/pipeline/{owner}-{repo}/{ticket}'
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/i
const ISSUE_TICKET = /(?:^#|#|\/issues\/)(\d+)\/?$/

const NO_LABELS: ProfileLabels = {
  typeBug: null,
  typeFeature: null,
  stateReview: null,
  aiChangesRequested: null,
  aiLgtm: null,
  aiVerified: null,
  readyToMerge: null,
  needsWork: null,
}

const LABEL_MATCH: ReadonlyArray<{ field: keyof ProfileLabels; names: readonly string[]; isExact?: boolean }> = [
  { field: 'typeBug', names: ['bug'] },
  { field: 'typeFeature', names: ['feature', 'enhancement'] },
  { field: 'stateReview', names: ['review'] },
  { field: 'readyToMerge', names: ['ready to merge'] },
  { field: 'needsWork', names: ['needs more work', 'needs work'] },
  { field: 'aiChangesRequested', names: ['ai: changes requested'], isExact: true },
  { field: 'aiLgtm', names: ['ai: lgtm'], isExact: true },
  { field: 'aiVerified', names: ['ai: verified'], isExact: true },
]

type Found = Partial<RepoProfile> & { base?: string }

export type ProfileResult = {
  source: 'file' | 'discovered'
  path?: string
  discovered?: string
  base?: string
  saved?: string
  profile: RepoProfile
  criteriaDir: string
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return $.fs.read(path).catch(() => null)
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

/** Lower case, emoji shortcodes and pictographs dropped, whitespace collapsed. */
export const normaliseLabel = (name: string): string =>
  name.toLowerCase().replace(/:[a-z0-9_+-]+:/g, ' ').replace(/\p{Extended_Pictographic}/gu, ' ').replace(/\s+/g, ' ').trim()

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An exact name first, else a whole-word match outside the `ai:` labels; never creates one. */
export function matchLabels(names: readonly string[]): ProfileLabels {
  const labels = { ...NO_LABELS }
  const normalised = names.map(name => ({ name, plain: normaliseLabel(name) }))
  for (const rule of LABEL_MATCH) {
    const exact = normalised.find(one => rule.names.includes(one.plain))
    const loose = rule.isExact
      ? undefined
      : normalised.find(one => !one.plain.startsWith('ai:') && rule.names.some(want => new RegExp(`\\b${escape(want)}\\b`).test(one.plain)))
    labels[rule.field] = (exact ?? loose)?.name ?? null
  }
  return labels
}

export const pickMergeMethod = (repo: Record<string, unknown>): MergeMethod | undefined => {
  if (repo.squashMergeAllowed === true) return 'squash'
  if (repo.rebaseMergeAllowed === true) return 'rebase'
  if (repo.mergeCommitAllowed === true) return 'merge'
  return undefined
}

/** The default unless more than half of the recent head refs share another first segment. */
export function branchPatternOf(refs: readonly string[]): string | undefined {
  const shapes = refs.map(ref => {
    const cut = ref.indexOf('/')
    if (cut < 0) return '{key}-{slug}'
    const prefix = ref.slice(0, cut)
    if (prefix === 'fix' || prefix === 'feature') return DEFAULT_BRANCH_PATTERN
    return TICKET_KEY.test(prefix) ? '{key}/{slug}' : `${prefix}/{key}-{slug}`
  })
  if (shapes.length < 3) return undefined
  const counts = new Map<string, number>()
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1)
  const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  return top !== DEFAULT_BRANCH_PATTERN && count * 2 > shapes.length ? top : undefined
}

async function packageRunner($: EngineInterface, root: string): Promise<{ run: (script: string) => string }> {
  if (await exists($, `${root}/yarn.lock`)) return { run: script => `yarn ${script}` }
  if (await exists($, `${root}/pnpm-lock.yaml`)) return { run: script => `pnpm ${script}` }
  if (await exists($, `${root}/bun.lockb`)) return { run: script => `bun run ${script}` }
  return { run: script => (script === 'test' ? 'npm test' : `npm run ${script}`) }
}

/** lint and test commands from every build file at the root, joined with ` && `; the sources found. */
async function discoverChecks($: EngineInterface, root: string): Promise<{ lint: string[]; test: string[]; sources: string[] }> {
  const lint: string[] = []
  const test: string[] = []
  const sources: string[] = []
  const add = (source: string, found: { lint?: string; test?: string }) => {
    if (found.lint === undefined && found.test === undefined) return
    if (found.lint !== undefined) lint.push(found.lint)
    if (found.test !== undefined) test.push(found.test)
    sources.push(source)
  }

  const pkg = await readText($, `${root}/package.json`)
  if (pkg !== null) {
    const scripts = asRecord(asRecord(parseJson(pkg)).scripts)
    const runner = await packageRunner($, root)
    add('package.json', {
      ...('lint' in scripts ? { lint: runner.run('lint') } : {}),
      ...('test' in scripts ? { test: runner.run('test') } : {}),
    })
  }
  const composer = await readText($, `${root}/composer.json`)
  if (composer !== null) {
    const scripts = asRecord(asRecord(parseJson(composer)).scripts)
    const compose = await readText($, `${root}/docker-compose.yml`)
    const prefix = compose !== null && /sail/i.test(compose) ? 'vendor/bin/sail ' : ''
    add('composer.json', {
      ...('lint' in scripts ? { lint: `${prefix}composer lint` } : {}),
      ...('test' in scripts ? { test: `${prefix}composer test` } : {}),
    })
  }
  const makefile = await readText($, `${root}/Makefile`)
  if (makefile !== null) {
    add('Makefile', {
      ...(/^lint\s*:/m.test(makefile) ? { lint: 'make lint' } : {}),
      ...(/^test\s*:/m.test(makefile) ? { test: 'make test' } : {}),
    })
  }
  if (await exists($, `${root}/pyproject.toml`)) add('pyproject.toml', { lint: 'ruff check .', test: 'pytest' })
  if (await exists($, `${root}/Cargo.toml`)) add('Cargo.toml', { lint: 'cargo clippy', test: 'cargo test' })
  if (await exists($, `${root}/go.mod`)) add('go.mod', { lint: 'go vet ./...', test: 'go test ./...' })
  return { lint, test, sources }
}

async function discoverRules($: EngineInterface, root: string): Promise<string[]> {
  const found: string[] = []
  for (const name of RULE_FILES) if (await exists($, `${root}/${name}`)) found.push(name)
  return found
}

type RepoTarget = { root: string; slug?: string; host?: string }

const repoArgs = (target: RepoTarget): string[] => (target.slug !== undefined ? ['--repo', target.slug] : [])

const ghOptions = (target: RepoTarget) => ({ cwd: target.root, ...(target.host !== undefined ? { host: target.host } : {}) })

async function discoverRepo($: EngineInterface, target: RepoTarget): Promise<{ base?: string; mergeMethod?: MergeMethod }> {
  const argv = ['repo', 'view', ...(target.slug !== undefined ? [target.slug] : []), '--json', 'nameWithOwner,defaultBranchRef,squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed']
  const viewed = await gh($, argv, ghOptions(target))
  if (!viewed.ok) return {}
  const repo = asRecord(parseJson(viewed.stdout))
  const base = asRecord(repo.defaultBranchRef).name
  const mergeMethod = pickMergeMethod(repo)
  return { ...(typeof base === 'string' && base !== '' ? { base } : {}), ...(mergeMethod !== undefined ? { mergeMethod } : {}) }
}

async function discoverLabels($: EngineInterface, target: RepoTarget): Promise<ProfileLabels> {
  const listed = await gh($, ['label', 'list', ...repoArgs(target), '--json', 'name', '--limit', '200'], ghOptions(target))
  if (!listed.ok) return { ...NO_LABELS }
  const parsed = parseJson(listed.stdout)
  const names = (Array.isArray(parsed) ? parsed : []).map(one => asRecord(one).name).filter((name): name is string => typeof name === 'string')
  return matchLabels(names)
}

async function discoverBranchPattern($: EngineInterface, target: RepoTarget): Promise<string | undefined> {
  const listed = await gh($, ['pr', 'list', ...repoArgs(target), '--state', 'all', '--limit', '20', '--json', 'headRefName'], ghOptions(target))
  if (!listed.ok) return undefined
  const parsed = parseJson(listed.stdout)
  const refs = (Array.isArray(parsed) ? parsed : []).map(one => asRecord(one).headRefName).filter((ref): ref is string => typeof ref === 'string' && ref !== '')
  return branchPatternOf(refs)
}

async function discover($: EngineInterface, target: RepoTarget): Promise<{ found: Found; summary: string }> {
  const [repo, labels, branchPattern, checks, rules, hasE2e, hasSecurity] = await Promise.all([
    discoverRepo($, target),
    discoverLabels($, target),
    discoverBranchPattern($, target),
    discoverChecks($, target.root),
    discoverRules($, target.root),
    exists($, `${target.root}/.claude/skills/e2e-verify/SKILL.md`),
    exists($, `${target.root}/.claude/agents/security-reviewer.md`),
  ])
  const matched = Object.values(labels).filter(label => label !== null).length
  const found: Found = {
    ...repo,
    labels,
    ...(branchPattern !== undefined ? { branchPattern } : {}),
    ...(checks.lint.length > 0 ? { lint: checks.lint.join(' && ') } : {}),
    ...(checks.test.length > 0 ? { test: checks.test.join(' && ') } : {}),
    ...(hasE2e ? { e2e: 'e2e-verify' } : {}),
    ...(hasSecurity ? { securityAgent: 'security-reviewer' } : {}),
    rules,
  }
  const summary = [
    repo.base !== undefined ? `base ${repo.base}` : 'base unknown',
    repo.mergeMethod ?? 'merge method unknown',
    `${matched} label${matched === 1 ? '' : 's'} matched`,
    checks.sources.length > 0 ? `checks from ${checks.sources.join(', ')}` : 'no lint or test found',
    branchPattern !== undefined ? `branches ${branchPattern}` : null,
    hasE2e ? 'e2e-verify' : null,
    hasSecurity ? 'security-reviewer' : null,
  ].filter((part): part is string => part !== null).join(', ')
  return { found, summary }
}

const trackerDefaults = (tracker: Tracker | 'auto' | undefined): Pick<RepoProfile, 'titlePrefix' | 'linkLine'> => {
  if (tracker === 'github') return { titlePrefix: '', linkLine: 'Closes #{n}' }
  if (tracker === 'text') return { titlePrefix: '', linkLine: '' }
  return { titlePrefix: '[{key}]', linkLine: '[{key}]({url})' }
}

/** Every schema field, the given ones first; `rest` fills what neither gives. */
function withDefaults(given: Found, rest: { tracker?: Tracker }): RepoProfile {
  const tracker = given.tracker ?? 'auto'
  const perTracker = trackerDefaults(tracker === 'auto' ? rest.tracker : tracker)
  return {
    tracker,
    branchPattern: given.branchPattern ?? DEFAULT_BRANCH_PATTERN,
    titlePrefix: given.titlePrefix ?? perTracker.titlePrefix,
    linkLine: given.linkLine ?? perTracker.linkLine,
    prBody: given.prBody ?? 'visual-pr',
    labels: { ...NO_LABELS, ...given.labels },
    lint: given.lint ?? '',
    test: given.test ?? '',
    e2e: given.e2e ?? null,
    e2ePolicy: given.e2ePolicy ?? 'auto',
    securityAgent: given.securityAgent ?? null,
    siblings: given.siblings ?? [],
    rules: given.rules ?? [],
    criteriaDir: given.criteriaDir ?? DEFAULT_CRITERIA_DIR,
    mergeMethod: given.mergeMethod ?? 'squash',
  }
}

/** What a saved profile keeps: what discovery found, not the defaults it fell back to. */
export function savedProfile(profile: RepoProfile, run: Pick<PipelineRun, 'tracker'>): Record<string, unknown> {
  const plain = withDefaults({}, { tracker: run.tracker })
  const labels = Object.fromEntries(Object.entries(profile.labels).filter(([, name]) => name !== null))
  const kept = Object.entries(profile).filter(([field, value]) => {
    if (field === 'labels') return false
    return JSON.stringify(value) !== JSON.stringify(plain[field as keyof RepoProfile])
  })
  return {
    $schema: 'https://github.com/zcuric/skills/plugins/pr-pipeline/profiles/pr-pipeline.schema.json',
    ...Object.fromEntries(kept),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  }
}

/** `ABC-123` stays; `#42`, `owner/repo#42` and issue URLs become `issue-42`; `text:slug` becomes `text-slug`. */
export function pathSafeTicket(ticket: string): string {
  const trimmed = ticket.trim()
  if (TICKET_KEY.test(trimmed)) return trimmed
  const issue = ISSUE_TICKET.exec(trimmed)
  if (issue?.[1] !== undefined) return `issue-${issue[1]}`
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|-+$/g, '')
  return safe === '' ? 'run' : safe
}

export function expandCriteriaDir(template: string, values: { home: string | undefined; root: string; slug: string | undefined; ticket: string }): string {
  const [owner = 'unknown', repo = 'unknown'] = (values.slug ?? 'unknown/unknown').split('/')
  const filled = template
    .replace(/\{owner\}/g, owner)
    .replace(/\{repo\}/g, repo)
    .replace(/\{ticket\}/g, pathSafeTicket(values.ticket))
  const homed = values.home !== undefined && (filled === '~' || filled.startsWith('~/')) ? `${values.home}${filled.slice(1)}` : filled
  const absolute = homed.startsWith('/') ? homed : `${values.root}/${homed}`
  return absolute.replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string> {
  const top = await git($, ['rev-parse', '--show-toplevel'], cwd)
  const root = top.ok ? top.stdout.trim() : ''
  return root === '' ? cwd : root
}

async function readProfileFile($: EngineInterface, root: string): Promise<{ path: string; given: Found } | { path: string; error: string } | null> {
  for (const name of PROFILE_FILES) {
    const path = `${root}/${name}`
    const text = await readText($, path)
    if (text === null) continue
    const parsed = parseJson(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { path, error: `${name} is not a JSON object` }
    const { $schema: _schema, ...given } = parsed as Found & { $schema?: string }
    return { path, given }
  }
  return null
}

/** The base branch, and the fields a profile file left out whose default is the repo's own: lint, test, rules, merge method. */
async function fillFromRepo($: EngineInterface, given: Found, target: RepoTarget): Promise<Found> {
  const needsChecks = given.lint === undefined || given.test === undefined
  const checks = needsChecks ? await discoverChecks($, target.root) : { lint: [], test: [], sources: [] }
  const rules = given.rules === undefined ? await discoverRules($, target.root) : given.rules
  const repo = await discoverRepo($, target)
  const mergeMethod = given.mergeMethod ?? repo.mergeMethod
  return {
    ...given,
    ...(repo.base !== undefined ? { base: repo.base } : {}),
    ...(given.lint === undefined && checks.lint.length > 0 ? { lint: checks.lint.join(' && ') } : {}),
    ...(given.test === undefined && checks.test.length > 0 ? { test: checks.test.join(' && ') } : {}),
    rules,
    ...(mergeMethod !== undefined ? { mergeMethod } : {}),
  }
}

export type ProfileOutcome = { ok: true; result: ProfileResult } | { ok: false; error: string }

/** Resolves the repo profile of a run: a profile file, else discovery; defaults fill the rest; creates the criteria dir. */
export async function resolveProfile($: EngineInterface, run: PipelineRun, options: { save?: boolean } = {}): Promise<ProfileOutcome> {
  const cwd = run.cwd ?? (await $.session.cwd())
  const root = await repoRoot($, cwd)
  const target: RepoTarget = { root, ...(run.repo !== undefined ? { slug: run.repo } : {}), ...(run.host !== undefined ? { host: run.host } : {}) }
  const file = await readProfileFile($, root)
  if (file !== null && 'error' in file) return { ok: false, error: `${file.path}: ${file.error}` }
  if (file !== null && options.save === true) return { ok: false, error: `${file.path} already exists; save is refused.` }

  const discovery = file === null ? await discover($, target) : null
  const given = file !== null ? await fillFromRepo($, file.given, target) : discovery?.found ?? {}
  const profile = withDefaults(given, { ...(run.tracker !== undefined && run.tracker !== 'pr' ? { tracker: run.tracker } : {}) })
  const home = await $.env.get('HOME').catch(() => undefined)
  const criteriaDir = expandCriteriaDir(profile.criteriaDir, { home, root, slug: run.repo, ticket: run.ticket ?? run.branch })
  await runCommand($, ['mkdir', '-p', criteriaDir], {})

  let saved: string | undefined
  if (options.save === true) {
    const path = `${root}/${PROFILE_FILES[0]}`
    await $.fs.write(path, `${JSON.stringify(savedProfile(profile, run), null, 2)}\n`)
    saved = `${path} written, untracked: never git add it`
  }
  return {
    ok: true,
    result: {
      source: file !== null ? 'file' : 'discovered',
      ...(file !== null ? { path: file.path } : {}),
      ...(discovery !== null ? { discovered: discovery.summary } : {}),
      ...(given.base !== undefined ? { base: given.base } : {}),
      ...(saved !== undefined ? { saved } : {}),
      profile,
      criteriaDir,
    },
  }
}
