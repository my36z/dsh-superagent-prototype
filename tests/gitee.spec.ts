import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { GiteeAccountsSchema, resolveGitee, SETUP_FIELDS } from '../src/deployment.ts'
import { SetupError } from '../src/setup.ts'
import { GiteeConfigSchema, apply as applyGitee, giteeKind, pollFailure, pollRound } from '../src/sources/gitee.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { commentTrigger, giteeFind, issueTrigger, pullTrigger, type GiteeComment, type GiteeIssue, type GiteePull } from '../src/sources/gitee-trigger.ts'
import { giteeLink, markerOf, sendGitee } from '../src/sources/gitee-channel.ts'
import { giteePull, giteePullRequest } from '../src/sources/gitee-pull.ts'
import { pullEndNotices, pullOf } from '../src/sources/pull.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const boards = new WeakMap<SourceRegistry, HealthBoard>()
const stores: Store[] = []
const directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})
/** A registry with the Gitee kind; `register` is false when the plugin's own effect must register it. */
function registry(settings: Settings, register = true) {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => settings, board)
  boards.set(sources, board)
  if (register) sources.register(giteeKind)
  return { sources, board }
}
const defaults = { repository: 'acme/widgets', cli: 'gitee-agent', observeIssues: true, observePulls: true, observeComments: true }
/** A Gitee Source context on a real Store, Engine and Commands; `receive` records each result and can be made to fail once. */
function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gitee-'))
  directories.push(directory)
  const store = new Store(join(directory, 'db.sqlite'))
  stores.push(store)
  const settings = SettingsSchema.parse({ sources: { gitee: { enabled: true, config: { ...defaults, ...config } } },
    policy: { sources: { gitee: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' } })
  store.saveSettings(settings)
  const { sources, board } = overrides.sources ? { sources: overrides.sources, board: boards.get(overrides.sources)! } : registry(settings)
  const deployment = testDeployment({ gitee: { hostname: 'gitee.com', repository: 'acme/widgets', cli: 'gitee-agent', login: 'agent-bot', id: 7 } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const results: string[] = []
  let failure: Error | undefined
  const delivery = async (trigger: Trigger) => {
    if (failure) throw failure
    const result = engine.receive(trigger)
    engine.evaluateDue()
    results.push(result)
    return result
  }
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive: delivery, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, giteeKind)
  return { ...value, ...context, store, engine, commands, results, health: board.all,
    failWith: (error?: Error) => { failure = error } }
}
const refused = (status: number, text: string) => commandError({ stderr: `HTTP ${status}: {"message":"${text}"}`, code: 1 })
/** Stubs `gitee-cli api` reads against `acme/widgets` and records the requested paths and posted bodies. */
function gitee(h: ReturnType<typeof host>, routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: string }[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    const method = args.includes('POST') ? 'POST' : 'GET'
    const path = args[1]!
    const body = args.find(item => item.startsWith('body='))?.slice(5)
    calls.push({ method, path, ...body ? { body } : {} })
    if (method !== 'GET') return JSON.stringify({ id: 9, body })
    const key = path.replace(/^\/repos\/acme\/widgets\//, '').split('?')[0]!
    const route = routes[key]
    if (route === undefined) throw refused(404, 'Not Found')
    const value = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return calls
}
const at = (): string => new Date().toISOString()
const issue = (number: string, fields: Partial<GiteeIssue> = {}, created = at()): GiteeIssue => ({ number, title: `Issue ${number}`,
  body: 'details', state: 'open', created_at: created, updated_at: created, user: { login: 'alice' },
  html_url: `https://gitee.com/acme/widgets/issues/${number}`, ...fields })
const comment = (id: number, fields: Partial<GiteeComment> = {}): GiteeComment => ({ id, body: `comment ${id}`,
  user: { login: 'alice' }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', ...fields })
const message = (id = 'm1'): OutboundMessage => ({ id, text: 'Done', kind: 'reply',
  channel: { source: 'gitee', thread: 'gitee:issue:IKSRCD', address: { hostname: 'gitee.com', repository: 'acme/widgets',
    kind: 'issue', number: 'IKSRCD' } } })
const pr = (number: number, fields: Partial<GiteePull> = {}): GiteePull => ({ number, title: `PR ${number}`, body: '',
  user: { login: 'alice' }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  html_url: `https://gitee.com/acme/widgets/pulls/${number}`, state: 'open', head: `agent/pr-${number}`, ...fields })
const openTicket = (id: string, name: string, origin = `source-${id}`, fields: Partial<Ticket> = {}): Ticket => ({ id, title: id,
  decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitee', id: 'alice' }, scope: '' },
  channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', origin: { triggerId: origin, triggerIds: [origin] },
  execution: { name, directory: `/w/${name}`, assignment: '' }, ...fields })

describe('gitee configuration', () => {
  it('fills defaults that receive nothing, and lists the fields and admission rows', () => {
    expect(GiteeConfigSchema.parse({})).toEqual({ hostname: 'gitee.com', repository: '', cli: '', pollSeconds: 60,
      failuresBeforeError: 3, observeIssues: false, observePulls: false, observeComments: false })
    expect(GiteeAccountsSchema.parse({})).toEqual({ hostname: 'gitee.com', repository: '', cli: '' })
    expect(giteeKind.fields.map(field => field.key)).toEqual(['repository', 'cli', 'hostname', 'pollSeconds',
      'failuresBeforeError', 'observeIssues', 'observePulls', 'observeComments'])
    expect(SETUP_FIELDS.gitee).toEqual(['hostname', 'repository', 'cli'])
    const rows = giteeKind.policy!.rows!(GiteeConfigSchema.parse({ observeIssues: true }))
    expect(rows.map(row => row.id)).toEqual(['issues', 'pulls', 'comments'])
    expect(rows[0]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
    expect(rows[1]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    // A configured repository is always in scope; the switch only decides what the admission table observes.
    const configured = GiteeConfigSchema.parse({ repository: 'acme/widgets' })
    expect(giteeKind.scope!({ meta: { kind: 'issue', repository: 'acme/widgets' } }, configured))
      .toEqual({ listened: true, observed: false, row: 'issues' })
    expect(giteeKind.scope!({ meta: { kind: 'comment', target: 'pr', repository: 'acme/widgets' } },
      GiteeConfigSchema.parse({ repository: 'acme/widgets', observeComments: true })))
      .toEqual({ listened: true, observed: true, row: 'comments' })
    expect(giteeKind.scope!({ meta: { kind: 'issue', repository: 'other/widgets' } }, configured))
      .toEqual({ listened: false, reason: 'repository_not_configured' })
  })
  it('gives the Sources settings the Gitee card data the panel renders', () => {
    const h = host()
    const view = settingsView(h.store, h.sources, h.health, { deployment: h.deployment }, h.deployment.stateDir)
    const card = view.sources.find(source => source.id === 'gitee')!
    expect(card).toMatchObject({ kind: 'gitee', installed: true, title: { zh: 'Gitee', en: 'Gitee' } })
    expect(card.fields.map(field => field.key)).toContain('repository')
    expect(card.facts).toMatchObject({ repository: 'acme/widgets' })
    expect(card.policy?.rows?.[0]).toMatchObject({ id: 'issues' })
  })
  it('reads Gitee links and numbers into Issue and pull request Threads', () => {
    expect(giteeFind('https://gitee.com/acme/widgets/issues/IKSRCD')).toEqual({ threads: ['gitee:issue:IKSRCD'], terms: [] })
    expect(giteeFind('https://gitee.com/acme/widgets/pulls/12')).toEqual({ threads: ['gitee:pr:12'], terms: [] })
    expect(giteeFind('12')).toEqual({ threads: ['gitee:pr:12'], terms: [] })
    expect(giteeFind('IKSRCD')).toEqual({ threads: ['gitee:issue:IKSRCD'], terms: [] })
    expect(giteeFind('https://github.com/acme/widgets/issues/1')).toEqual({ threads: [], terms: [] })
  })
})

describe('gitee setup', () => {
  const machine = testMachine()
  const cli = process.execPath
  const config = { repository: 'acme/widgets', cli }
  const success: Record<string, string> = {
    'auth status --json': JSON.stringify({ status: 'logged in', user: 'mail36z' }),
    'api /user': JSON.stringify({ id: 17805818, login: 'mail36z' }),
    'api /repos/acme/widgets': JSON.stringify({ full_name: 'acme/widgets' }),
    'api /repos/acme/widgets/collaborators/mail36z/permission': JSON.stringify({ permission: 'write' }),
  }
  const probe = (routes: Record<string, string | Error>) => vi.fn(async (argv: string[]) => {
    const command = argv.slice(1).join(' ')
    const value = routes[command]
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`unexpected command: ${command}`)
    return value
  })
  it('verifies the Gitee account and repository, and returns the canonical names', async () => {
    await expect(resolveGitee(machine, config, probe(success))).resolves.toEqual({ hostname: 'gitee.com',
      repository: 'acme/widgets', cli, login: 'mail36z', id: 17805818 })
  })
  it('names a missing repository or CLI before running the CLI', async () => {
    await expect(resolveGitee(machine, { repository: '', cli }, probe({}))).rejects.toMatchObject({ code: 'giteeRepositoryUnset' })
    await expect(resolveGitee(machine, { repository: 'acme/widgets', cli: '' }, probe({}))).rejects.toMatchObject({ code: 'giteeCliUnset' })
  })
  it('maps a missing CLI, a signed-out CLI and an unreported account to their setup problems', async () => {
    await expect(resolveGitee(machine, { repository: 'acme/widgets', cli: '/nonexistent/gitee-cli' }, probe({}))).rejects
      .toMatchObject({ code: 'giteeCliMissing' })
    await expect(resolveGitee(machine, config, probe({ 'auth status --json': new Error('not logged in') }))).rejects
      .toMatchObject({ code: 'giteeCliSignedOut' })
    await expect(resolveGitee(machine, config, probe({ 'auth status --json': JSON.stringify({ status: 'logged in' }) }))).rejects
      .toMatchObject({ code: 'giteeCliNoAccount' })
    await expect(resolveGitee(machine, config, probe({ ...success, 'api /user': JSON.stringify({ login: 'mail36z' }) }))).rejects
      .toMatchObject({ code: 'giteeCliNoAccount' })
  })
  it('maps an unreadable repository and a read-only permission to their setup problems', async () => {
    await expect(resolveGitee(machine, config, probe({ ...success, 'api /repos/acme/widgets': new Error('HTTP 404: Not Found') })))
      .rejects.toMatchObject({ code: 'giteeRepositoryUnreadable' })
    await expect(resolveGitee(machine, config, probe({ ...success,
      'api /repos/acme/widgets/collaborators/mail36z/permission': JSON.stringify({ permission: 'read' }) })))
      .rejects.toMatchObject({ code: 'giteeRepositoryReadOnly' })
    await expect(resolveGitee(machine, config, probe({ ...success,
      'api /repos/acme/widgets/collaborators/mail36z/permission': JSON.stringify({ permission: 'admin' }) })))
      .resolves.toMatchObject({ repository: 'acme/widgets' })
  })
  it('takes the account id from auth status when the CLI reports one, without another read', async () => {
    const reportsId = probe({ 'auth status --json': JSON.stringify({ login: 'mail36z', id: 17805818 }),
      'api /repos/acme/widgets': JSON.stringify({ full_name: 'acme/widgets' }),
      'api /repos/acme/widgets/collaborators/mail36z/permission': JSON.stringify({ permission: 'write' }) })
    await expect(resolveGitee(machine, config, reportsId)).resolves.toMatchObject({ login: 'mail36z', id: 17805818 })
  })
  it('keeps the Gitee problem apart from the deployment and reports it on the Gitee Source only', () => {
    const problem = new SetupError('giteeRepositoryReadOnly', { account: 'mail36z', repository: 'acme/widgets' }).problem
    const sources = registry(SettingsSchema.parse({ sources: { gitee: { enabled: true, config: defaults } } }), false).sources
    sources.register(giteeKind)
    const parts: SourceContextDeps = { store: {} as never, engine: {} as never, outbox: {} as never, commands: {} as never,
      sources, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive: vi.fn(), giteeProblem: problem }
    expect(sourceContextOf(parts, giteeKind).problem).toEqual(problem)
    expect(sourceContextOf(parts, { kind: 'github', health: ['github'] }).problem).toBeUndefined()
  })
})

describe('gitee polling', () => {
  it('receives a new Issue once, and names its Thread', async () => {
    const h = host()
    const created = issue('IKSRCD')
    gitee(h, { issues: [created], pulls: [], 'issues/comments': [] })
    await pollRound(h)
    await pollRound(h)
    expect(h.store.read.triggers({ source: 'gitee' }, 0, 10).items).toHaveLength(1)
    expect(h.results).toContain('stored')
    expect(h.results).toContain('duplicate')
    expect(h.store.threads.get('gitee:issue:IKSRCD')?.meta.title).toBe('Issue IKSRCD')
  })
  it('filters a trigger from a repository this Source does not watch', async () => {
    const h = host()
    const foreign = issueTrigger(issue('IKSRCX'), 'agent-bot', 'gitee.com', 'other/widgets')
    await expect(h.receive(foreign)).resolves.toBe('filtered')
    expect(h.store.triggers.disposition(foreign.id)?.filtered).toMatchObject({ code: 'repository_not_configured' })
  })
  it('advances a stream cursor only after every receive of the round succeeded', async () => {
    const h = host({}, { observeIssues: false })
    const first = issue('IKSRCA', { created_at: at(), updated_at: at() })
    gitee(h, { issues: [first], pulls: [], 'issues/comments': [] })
    await pollRound(h)
    const before = h.store.get(KV.gitee.stream('issues'))!.since
    const second = issue('IKSRCB', { created_at: at(), updated_at: at() })
    gitee(h, { issues: [second], pulls: [], 'issues/comments': [] })
    h.failWith(new Error('engine unavailable'))
    await expect(pollRound(h)).rejects.toThrow('Gitee reads failed')
    expect(h.store.get(KV.gitee.stream('issues'))!.since).toBe(before)
    h.failWith(undefined)
    await pollRound(h)
    expect(h.store.get(KV.gitee.stream('issues'))!.since > before).toBe(true)
  })
  it('counts consecutive failures towards the health error', () => {
    expect(pollFailure(1, 3, new Error('x'))).toBeUndefined()
    expect(pollFailure(3, 3, new Error('x'))).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } })
  })
  it('reports the Gitee health error only after the configured number of failed polls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const settings = SettingsSchema.parse({ sources: { gitee: { enabled: true, config: { ...defaults, failuresBeforeError: 2 } } } })
      const reg = registry(settings, false)
      const h = host({ sources: reg.sources }, { failuresBeforeError: 2 })
      const disposers: (() => unknown)[] = []
      let runs = 0
      const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async () => { runs += 1; throw refused(502, 'Bad Gateway') })
      applyGitee({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      // Each round reads three streams; after two rounds, health reports the second consecutive failure.
      while (runs < 6) {
        await vi.waitFor(() => expect(runs).toBeGreaterThan(0))
        if (runs < 6) await vi.advanceTimersByTimeAsync(60_000)
      }
      await vi.waitFor(() => expect(reg.board.all.gitee).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      for (const dispose of disposers) await dispose()
      run.mockRestore()
    } finally { vi.useRealTimers() }
  })
})

describe('gitee pull requests', () => {
  const normalized = (h: ReturnType<typeof host>, item: GiteePull) => giteePull(item, h.deployment.gitee!)
  it('binds the source PR and an agent PR on the ticket branch, and refuses another ticket\'s PR', () => {
    const h = host()
    expect(h.sources.pullRequests('gitee')).toBe(giteePullRequest)
    expect(giteePullRequest.number('gitee:pr:30')).toBe(30)
    expect(giteePullRequest.number('gitee:issue:IKSRCD')).toBeUndefined()
    const source = pullTrigger(pr(30), 'agent-bot', 'gitee.com', 'acme/widgets')
    h.store.triggers.save(source)
    h.store.tickets.save(openTicket('t1', 'fix-1', source.id))
    expect(giteePullRequest.claim(h, 't1', normalized(h, pr(30)))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitee:pr:30', own: false }])
    expect(h.store.threads.get('gitee:pr:30')).toMatchObject({ subscriptions: ['t1'], meta: { number: 30, isPr: true, prAuthor: 'alice' } })
    // Only a PR by the agent account, in the configured repository, from the ticket's branch binds.
    expect(giteePullRequest.claim(h, 't1', normalized(h, pr(31, { head: 'agent/fix-1' })))).toContain('PR does not belong to this ticket')
    expect(giteePullRequest.claim(h, 't1', normalized(h, pr(32, { user: { login: 'agent-bot' }, head: 'agent/fix-1' })))).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toEqual({ source: 'gitee', number: 32 })
    // A closed PR is not bound, but that is no refusal.
    expect(giteePullRequest.claim(h, 't1', normalized(h, pr(33, { user: { login: 'agent-bot' }, head: 'agent/fix-1', state: 'closed' })))).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toEqual({ source: 'gitee', number: 32 })
    // Another ticket already follows #34.
    h.store.tickets.save(openTicket('t2', 'fix-2', 'source-t2', { follows: [{ thread: 'gitee:pr:34', own: true }] }))
    h.store.tickets.save(openTicket('t3', 'fix-3'))
    expect(giteePullRequest.claim(h, 't3', normalized(h, pr(34, { user: { login: 'agent-bot' }, head: 'agent/fix-3' }))))
      .toBe('PR already belongs to another active ticket')
  })
  it('ends a ticket when the PR it follows merges or closes without merging', async () => {
    const h = host()
    const mergedAt = '2026-09-09T01:00:00Z'
    h.store.tickets.save(openTicket('t1', 'fix-1', 'source-t1', { follows: [{ thread: 'gitee:pr:50', own: true }] }))
    expect(await giteePullRequest.observe(h, normalized(h, pr(50, { state: 'closed', merged_at: mergedAt })))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged', at: new Date(mergedAt).toISOString() } })
    expect(h.store.threads.get('gitee:pr:50')).toBeUndefined()
    const closedAt = '2026-09-09T02:00:00Z'
    h.store.tickets.save(openTicket('t2', 'fix-2', 'source-t2', { follows: [{ thread: 'gitee:pr:51', own: true }] }))
    expect(await giteePullRequest.observe(h, normalized(h, pr(51, { state: 'closed', closed_at: closedAt })))).toBe(true)
    expect(h.store.tickets.get('t2')).toMatchObject({ ended: { outcome: 'closed', at: new Date(closedAt).toISOString() } })
  })
  it('sends an ended ticket\'s notice only to channels other than Gitee, with the Gitee page', () => {
    const h = host()
    const at = '2026-09-09T01:00:00Z'
    const giteeChannel = { source: 'gitee', thread: 'gitee:pr:60', address: { hostname: 'gitee.com',
      repository: 'acme/widgets', kind: 'pr', number: '60' } }
    const feishuChannel = { source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_1' } }
    const ticket = openTicket('t1', 'fix-1', 'source-t1', { ended: { at, by: 'executor', outcome: 'merged' }, channels: [giteeChannel, feishuChannel],
      follows: [{ thread: 'gitee:pr:60', own: true, closed: { at, outcome: 'merged' } }] })
    h.store.tickets.save(ticket)
    const notices = pullEndNotices(h.sources, ticket, '请修一下标题', h.deployment)
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: feishuChannel,
      text: '[PR #60](https://gitee.com/acme/widgets/pulls/60) 已合并。' })])
    // A ticket whose only channel is Gitee gets no terminal notice.
    h.store.tickets.save({ ...ticket, channels: [giteeChannel] })
    expect(pullEndNotices(h.sources, h.store.tickets.get('t1')!, '请修一下标题', h.deployment)).toEqual([])
  })
  it('reports a Gitee ticket\'s PR on Gitee and refuses instead of falling back to GitHub', async () => {
    const h = host()
    const calls = gitee(h, { 'pulls/42': pr(42) })
    const source = pullTrigger(pr(42), 'agent-bot', 'gitee.com', 'acme/widgets')
    h.store.triggers.save(source)
    h.store.tickets.save(openTicket('t1', 'fix-1', source.id))
    const context = (source: string) => source === 'gitee' ? h : undefined
    const base = { engine: h.engine, store: h.store, sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as never,
      sources: h.sources, sourceContext: context, sendReplies: async () => {} }
    const report = (host: typeof base, ticket: Ticket) => executorTools(host as never, ticket).find(tool => tool.name === 'orchestrator_report')!
    await report(base, h.store.tickets.get('t1')!).execute({ state: 'progress', summary: 'pr open', pr_number: 42 } as never, new AbortController().signal)
    expect(calls).toContainEqual(expect.objectContaining({ path: '/repos/acme/widgets/pulls/42' }))
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitee:pr:42', own: false }])
    // Without Gitee's pull request rules the ticket fails; it never reads the same number on GitHub.
    const other = pullTrigger(pr(43), 'agent-bot', 'gitee.com', 'acme/widgets')
    h.store.triggers.save(other)
    h.store.tickets.save(openTicket('t2', 'fix-2', other.id))
    const missing = { ...base, sources: { pullRequests: () => undefined }, sourceContext: () => undefined } as unknown as typeof base
    await expect(report(missing, h.store.tickets.get('t2')!).execute({ state: 'progress', summary: 'pr open', pr_number: 43 } as never,
      new AbortController().signal)).rejects.toThrow('The gitee Source has no pull request support')
    expect(calls.some(call => call.path.includes('/pulls/43'))).toBe(false)
  })
  it('delivers a Feishu ticket on Gitee when the deployment has no GitHub Source', async () => {
    const h = host()
    const calls = gitee(h, { 'pulls/44': pr(44, { user: { login: 'agent-bot' }, head: 'agent/fix-4' }) })
    const origin = { id: 'feishu-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_alice' },
      human: true, at: new Date().toISOString(), text: '请修一下标题', meta: {} } as Trigger
    h.store.triggers.save(origin)
    h.store.tickets.save(openTicket('t4', 'fix-4', origin.id))
    const giteeContext = h
    const githubContext = { deployment: testDeployment({ github: undefined,
      gitee: { hostname: 'gitee.com', repository: 'acme/widgets', cli: 'gitee-agent', login: 'agent-bot', id: 7 } }) } as never
    const context = (source: string) => source === 'gitee' ? giteeContext : source === 'github' ? githubContext : undefined
    const base = { engine: h.engine, store: h.store, sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as never,
      sources: h.sources, sourceContext: context, sendReplies: async () => {} }
    const report = executorTools(base as never, h.store.tickets.get('t4')!).find(tool => tool.name === 'orchestrator_report')!
    await report.execute({ state: 'progress', summary: 'pr open', pr_number: 44 } as never, new AbortController().signal)
    expect(calls).toContainEqual(expect.objectContaining({ path: '/repos/acme/widgets/pulls/44' }))
    expect(h.store.tickets.get('t4')!.follows).toEqual([{ thread: 'gitee:pr:44', own: true }])
  })
})

describe('gitee replies', () => {
  it('posts one comment though the same message is delivered twice, and keeps the marker', async () => {
    const h = host()
    const comments: unknown[] = []
    const posts: string[] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args.includes('POST')) {
        const body = args.find(item => item.startsWith('body='))!.slice(5)
        posts.push(body)
        const value = { id: posts.length, body, user: { login: 'agent-bot' } }
        comments.push(value)
        return JSON.stringify(value)
      }
      return JSON.stringify(comments)
    })
    await expect(sendGitee(h, message())).resolves.toBe('sent')
    await expect(sendGitee(h, message())).resolves.toBe('sent')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(markerOf('m1'))
  })
  it('treats a 404 as gone and builds the Gitee page link', async () => {
    const h = host()
    vi.spyOn(h.commands, 'run').mockRejectedValue(refused(404, 'Not Found'))
    await expect(sendGitee(h, message())).resolves.toBe('gone')
    expect(giteeLink({ hostname: 'gitee.com', repository: 'acme/widgets', kind: 'pr', number: '12' }, {}))
      .toEqual({ url: 'https://gitee.com/acme/widgets/pulls/12', label: { zh: 'Gitee PR #12', en: 'Gitee PR #12' } })
  })
})

describe('gitee thread context', () => {
  it('reads the comments, the Issue root and the comment it answers', async () => {
    const h = host()
    const first = comment(6, { body: 'Please fix the login', in_reply_to_id: 5 })
    const second = comment(7, { body: 'And the title' })
    gitee(h, {
      'issues/IKSRCD': { number: 'IKSRCD', title: 'Login fails', body: 'details', created_at: '2026-09-09T00:00:00Z',
        user: { login: 'alice' }, html_url: 'https://gitee.com/acme/widgets/issues/IKSRCD' },
      'issues/IKSRCD/comments': [first, second],
      'issues/comments/5': comment(5, { body: 'Earlier' }),
    })
    const trigger = commentTrigger(first, { hostname: 'gitee.com', repository: 'acme/widgets', kind: 'issue', number: 'IKSRCD' }, 'agent-bot')
    const context = h.sources.threadContext(trigger)!
    const thread = await context.read(h.commands, 'thread')
    expect(thread.messages.map(item => item.id)).toEqual(['6', '7'])
    expect(context.messageId).toBe('6')
    const root = await context.read(h.commands, 'root')
    expect(root.messages[0]).toMatchObject({ id: 'issue:IKSRCD', from: 'alice', text: 'Login fails\n\ndetails' })
    const parent = await context.read(h.commands, 'parent')
    expect(parent.messages.map(item => item.id)).toEqual(['5'])
  })
})
