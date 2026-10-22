import type { Tracker } from '../types'
import { parsePrUrl, prPageUrl } from './github'

export const ARGUMENT_HINT = '[ABC-123 | #123 | owner/repo#123 | issue or PR url | "task in words"]'

export type TicketClass = { tracker: Tracker; ticket: string; url?: string; prompt: string }

type Classified = { tracker: Tracker; ticket: string; url?: string }

const ISSUE_URL = /^https?:\/\/([\w.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/
const ISSUE_REF = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/
const LINEAR_URL = /^https?:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^?#\s]*)?(?:[?#].*)?$/
const JIRA_URL = /^https?:\/\/[\w.-]+(?::\d+)?\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)\/?(?:[?#].*)?$/
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/

function classify(text: string): Classified {
  const pr = parsePrUrl(text)
  if (pr !== null) return { tracker: 'pr', ticket: `#${pr.number}`, url: prPageUrl(pr) }

  const issue = ISSUE_URL.exec(text)
  if (issue !== null) {
    const [, host, owner, repo, number] = issue
    return { tracker: 'github', ticket: `${owner}/${repo}#${number}`, url: `https://${host}/${owner}/${repo}/issues/${number}` }
  }

  const reference = ISSUE_REF.exec(text)
  if (reference !== null) {
    const [, slug, number] = reference
    return { tracker: 'github', ticket: slug !== undefined ? `${slug}#${number}` : `#${number}` }
  }

  const linear = LINEAR_URL.exec(text)
  if (linear?.[1] !== undefined) return { tracker: 'linear', ticket: linear[1].toUpperCase(), url: text }

  const jira = JIRA_URL.exec(text)
  if (jira?.[1] !== undefined) return { tracker: 'jira', ticket: jira[1].toUpperCase(), url: text }

  if (JIRA_KEY.test(text)) return { tracker: 'jira', ticket: text }

  return { tracker: 'text', ticket: text }
}

function withSetting(classified: Classified, trackerSetting: Tracker | 'auto'): Classified {
  if (trackerSetting === 'auto' || classified.tracker === 'pr') return classified
  if (classified.tracker === 'text' && trackerSetting !== 'text') return classified
  return { ...classified, tracker: trackerSetting }
}

export function classifyTicket(arg: string, trackerSetting: Tracker | 'auto'): TicketClass {
  const text = arg.trim()
  if (text === '') return { tracker: 'text', ticket: '', prompt: 'Run the pr-pipeline:run skill; ask which ticket or task to take.' }

  const { tracker, ticket, url } = withSetting(classify(text), trackerSetting)
  const prompt =
    tracker === 'text'
      ? `Run the pr-pipeline:run skill for this task (tracker: text): ${text}`
      : `Run the pr-pipeline:run skill for ${ticket} (tracker: ${tracker}${url !== undefined ? `, url: ${url}` : ''}).`
  return url !== undefined ? { tracker, ticket, url, prompt } : { tracker, ticket, prompt }
}
