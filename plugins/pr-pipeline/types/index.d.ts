export type StageId =
  | 'enhance'
  | 'implement'
  | 'pr'
  | 'review'
  | 'address'
  | 'verify'
  | 'acceptance'
  | 'risk'
  | 'proof'

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type Tier = 'S' | 'M' | 'L'

export type Risk = 'low' | 'medium' | 'high'

export type Met = 'yes' | 'partial' | 'no'

export type Backend = 'claude' | 'codex' | 'opencode'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Tracker = 'jira' | 'github' | 'linear' | 'text' | 'pr'

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export type StageModel = { backend: Backend; model?: string; effort?: Effort }

export type StageLink = { label: string; href: string }

export type Criterion = { text: string; met: Met; evidence?: string }

export type Stage = {
  id: StageId
  status: StageStatus
  startedAt?: number
  finishedAt?: number
  summary?: string
  /** What the stage did, one line each, for a developer skimming the pane */
  did: string[]
  /** Warnings a developer should see before trusting the stage */
  flags: string[]
  /** Decisions and findings */
  notes: string[]
  criteria: Criterion[]
  links: StageLink[]
  confidence?: number
  /** Counts restarts: 2 after the stage ran once and was started again; absent means 1 */
  attempt?: number
}

export type PrCheckStatus = 'queued' | 'in_progress' | 'completed' | 'pending'

export type PrCheck = {
  name: string
  status: PrCheckStatus
  /** success, failure, cancelled, skipped, neutral, timed_out, action_required, error (lower case) */
  conclusion?: string
  url?: string
  /** GitHub Actions run id parsed from the details url, when the check is a workflow run */
  runId?: string
}

export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

export type PrReview = { author: string; state: PrReviewState; submittedAt?: string }

export type PrComment = {
  id: string
  author: string
  body: string
  createdAt: string
  url: string
  diffHunk?: string
}

export type PrThread = {
  id: string
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: PrComment[]
}

export type PrCounts = {
  additions: number
  deletions: number
  changedFiles: number
  checksPassed: number
  checksFailed: number
  checksPending: number
  threadsOpen: number
  threadsTotal: number
}

export type PrStateName = 'OPEN' | 'CLOSED' | 'MERGED'

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''

export type PrSnapshot = {
  number: number
  url: string
  title: string
  state: PrStateName
  isDraft: boolean
  baseRefName: string
  headRefName: string
  mergeable: Mergeable
  /** gh's mergeStateStatus: CLEAN, HAS_HOOKS, BLOCKED, BEHIND, DIRTY, UNSTABLE, UNKNOWN, DRAFT */
  mergeState: string
  reviewDecision: ReviewDecision
  labels: string[]
  checks: PrCheck[]
  reviews: PrReview[]
  threads: PrThread[]
  counts: PrCounts
  fetchedAt: number
}

/** What a run keeps of the PR in the store: no threads, no hunks */
export type PrSummary = Pick<
  PrSnapshot,
  'number' | 'url' | 'title' | 'state' | 'isDraft' | 'mergeable' | 'mergeState' | 'reviewDecision' | 'counts' | 'fetchedAt'
> & { failing: string[] }

export type PrState = { snapshot?: PrSnapshot; error?: string; fetchedAt: number; isFetching?: boolean }

export type Harnesses = { gh: string | null; codex: string | null; opencode: string | null; checkedAt: number }

/** A repository as parsed from `git remote get-url origin` */
export type RepoRef = { host: string; slug: string }

export type PrRef = RepoRef & { number: number }

export type PipelineRun = {
  /** `${slug}#${branch}`, or `unknown#${branch}` when the checkout has no origin */
  key: string
  branch: string
  /** owner/name */
  repo?: string
  host?: string
  cwd?: string
  ticket?: string
  ticketUrl?: string
  tracker?: Tracker
  title?: string
  prUrl?: string
  tier?: Tier
  risk?: Risk
  models?: Partial<Record<StageId, StageModel>>
  pr?: PrSummary
  /** Set when the PR was first seen MERGED; the run closes itself five minutes later */
  mergedAt?: number
  /** Closed runs leave the Runs switcher; status still returns them */
  closedAt?: number
  stages: Stage[]
  /** Set by the first start or stage write */
  startedAt?: number
  updatedAt: number
}

export type Runs = Record<string, PipelineRun>

/** The plugin's userConfig, as `register(on, options)` receives it */
export type PipelineOptions = {
  reviewer: Backend
  review_model: string
  review_effort: Effort
  tracker: Tracker | 'auto'
  merge_method: MergeMethod
}

export type PipelineSettingsPatch = Partial<PipelineOptions>

declare module 'claude-code' {
  interface PluginState {
    'pr-pipeline': {
      runs: Runs
      selectedKey: string | null
      openStage: StageId | null
      pr: Record<string, PrState>
      openThreads: Record<string, boolean>
      /** Thread id whose reply box is open; polling pauses while set */
      replying: string | null
      /** Reply drafts by thread id */
      drafts: Record<string, string>
      /** Run key of the PR action in flight (merge, rerun, reply, resolve) */
      prBusy: string | null
      harnesses: Harnesses | null
      repos: Record<string, RepoRef | null>
      settingsOpen: boolean
      showResolved: boolean
    }
  }
}

export type PipelineAction = 'start' | 'stage' | 'link' | 'unlink' | 'status' | 'pr' | 'pr-reply' | 'pr-resolve' | 'settings' | 'close'

/** The pipeline tool this mod registers, so `e.tool === "mcp__pr-pipeline__pipeline"` narrows. */
export type PipelineToolInput = {
  action: PipelineAction
  branch?: string
  repo?: string
  ticket?: string
  ticketUrl?: string
  tracker?: Tracker
  title?: string
  prUrl?: string
  tier?: Tier
  risk?: Risk
  stage?: StageId
  status?: StageStatus
  summary?: string
  did?: string
  flag?: string
  note?: string
  criterion?: string
  met?: Met
  evidence?: string
  confidence?: number
  label?: string
  href?: string
  backend?: Backend
  model?: string
  effort?: Effort
  /** pr: bypass the 15 s debounce */
  fresh?: boolean
  /** pr-reply, pr-resolve */
  threadId?: string
  body?: string
  /** settings: fields to write through $.config.set */
  set?: PipelineSettingsPatch
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__pr-pipeline__pipeline': PipelineToolInput
  }
}
