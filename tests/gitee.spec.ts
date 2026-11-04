import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { GiteeAccountsSchema, resolveGitee, SETUP_FIELDS } from '../src/deployment.ts'
import { SetupError } from '../src/setup.ts'
import { GiteeConfigSchema, apply as applyGitee, giteeKind, pollFailure, pollRound } from '../src/sources/gitee.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { commentTrigger, giteeFind, issueTrigger, type GiteeComment, type GiteeIssue } from '../src/sources/gitee-trigger.ts'
import { giteeLink, markerOf, sendGitee } from '../src/sources/gitee-channel.ts'
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
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
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
