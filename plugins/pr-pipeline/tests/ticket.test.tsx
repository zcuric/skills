import { expect, test } from 'claude-code/testing'

import { classifyTicket } from '../hooks/ticket'

test('a ticket argument is classified by its shape', () => {
  const table: Array<[string, { tracker: string; ticket: string; url?: string }]> = [
    ['https://github.com/o/r/pull/7/files', { tracker: 'pr', ticket: '#7', url: 'https://github.com/o/r/pull/7' }],
    ['https://ghe.corp/o/r/pull/12#discussion_r1', { tracker: 'pr', ticket: '#12', url: 'https://ghe.corp/o/r/pull/12' }],
    ['https://github.com/o/r/issues/5', { tracker: 'github', ticket: 'o/r#5', url: 'https://github.com/o/r/issues/5' }],
    ['#123', { tracker: 'github', ticket: '#123' }],
    ['o/r#123', { tracker: 'github', ticket: 'o/r#123' }],
    ['https://linear.app/acme/issue/ENG-42/fix-login', { tracker: 'linear', ticket: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42/fix-login' }],
    ['https://acme.atlassian.net/browse/HWEPD-9', { tracker: 'jira', ticket: 'HWEPD-9', url: 'https://acme.atlassian.net/browse/HWEPD-9' }],
    ['  ABC-123 ', { tracker: 'jira', ticket: 'ABC-123' }],
    ['fix the login redirect', { tracker: 'text', ticket: 'fix the login redirect' }],
  ]
  for (const [arg, expected] of table) {
    const { prompt: _prompt, ...classified } = classifyTicket(arg, 'auto')
    expect(classified).toEqual(expected)
  }
})

test('the prompt names the ticket, the tracker and the url', () => {
  expect(classifyTicket('https://github.com/o/r/issues/5', 'auto').prompt).toBe(
    'Run the pr-pipeline:run skill for o/r#5 (tracker: github, url: https://github.com/o/r/issues/5).',
  )
  expect(classifyTicket('ABC-1', 'auto').prompt).toBe('Run the pr-pipeline:run skill for ABC-1 (tracker: jira).')
  expect(classifyTicket('make the export faster', 'auto').prompt).toBe(
    'Run the pr-pipeline:run skill for this task (tracker: text): make the export faster',
  )
})

test('the tracker setting overrides everything but a PR', () => {
  expect(classifyTicket('ENG-42', 'linear')).toMatchObject({ tracker: 'linear', ticket: 'ENG-42' })
  expect(classifyTicket('https://ghe.corp/o/r/issues/5', 'jira')).toMatchObject({ tracker: 'jira', url: 'https://ghe.corp/o/r/issues/5' })
  expect(classifyTicket('https://github.com/o/r/pull/7', 'jira').tracker).toBe('pr')
  expect(classifyTicket('ABC-1', 'text').prompt).toBe('Run the pr-pipeline:run skill for this task (tracker: text): ABC-1')
  expect(classifyTicket('tidy the settings page', 'linear').tracker).toBe('text')
})

test('an empty argument asks for the ticket', () => {
  expect(classifyTicket('   ', 'jira')).toEqual({ tracker: 'text', ticket: '', prompt: 'Run the pr-pipeline:run skill; ask which ticket or task to take.' })
})
