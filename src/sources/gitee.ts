/** Gitee source kind definition, repository polling of Issues, pull requests and their comments, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Thread } from '../core/index.ts'
import { GiteeAccountsSchema } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { commentTrigger, giteeFind, giteeThreadKey, issueTrigger, pullTrigger, SOURCE,
  GiteeCommentSchema, GiteeIssueSchema, GiteePullSchema } from './gitee-trigger.ts'
import { giteePages, giteeResource, giteeThreadContext, parseThread } from './gitee-read.ts'
import { giteeLink, sendGitee } from './gitee-channel.ts'

export const GiteeConfigSchema = GiteeAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
export type GiteeConfig = z.infer<typeof GiteeConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
/** The admission row a Trigger belongs to: a new Issue, a new pull request, or a comment. */
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pr') return 'pulls'
  return meta.kind === 'comment' ? 'comments' : undefined
}
/** The Gitee host and the verified account, which every read needs. */
const account = (ctx: SourceContext) => {
  const gitee = ctx.deployment.gitee
  if (!gitee) throw new Error('The Gitee Source has no working gitee-cli')
  return gitee
}
export const giteeKind: SourceKind<GiteeConfig> = {
  kind: SOURCE,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '智能体的 Gitee 账号；接收仓库里发给它的新 Issue、新 PR 和评论，以及已订阅 Issue 与 PR 的讨论。', en: 'The agent\'s Gitee account; receives new Issues, pull requests and comments in the repository, and discussion on subscribed Issues and pull requests.' },
  schema: GiteeConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源接收这个仓库的 Issue、PR 和评论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name. This Source receives the repository\'s Issues, pull requests and comments; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 Gitee CLI', en: 'Agent Gitee CLI' },
      hint: { zh: '命令名或绝对路径，指向为智能体账号隔离配置的 gitee-cli 包装脚本；执行器以 gitee-cli 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path of a gitee-cli wrapper configured for the agent account; the Executor calls it as gitee-cli. Saving checks that this account can push to the repository, then restarts dsh-superagent.' } },
    { key: 'hostname', type: 'text', advanced: true, label: { zh: 'Gitee 主机', en: 'Gitee host' },
      hint: { zh: '默认 gitee.com；私有 Gitee 部署时改这里。首版只在 gitee.com 上验证。', en: 'gitee.com by default; change it for a private Gitee deployment. The first version is verified on gitee.com only.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的评论和代码行评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and code comments that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } }],
  // Receiving scope only; the three streams are always read so a mention outside the observed scope still reaches the gate.
  scope: ({ meta }, config) => {
    // The repository is configuration; a Trigger from elsewhere is outside this Source even if its event kind is known.
    if (!config.repository || typeof meta.repository === 'string' && !sameName(meta.repository, config.repository)) {
      return { listened: false, reason: 'repository_not_configured' }
    }
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...(row ? { row } : {}) }
  },
  health: ['gitee'],
  channel: {
    allowed: (address, config) => !!address.repository && sameName(address.repository, config.repository)
      && (address.kind === 'issue' || address.kind === 'pr') && !!address.number,
    send: sendGitee,
    link: giteeLink,
  },
  threadContext: giteeThreadContext,
  find: giteeFind,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(list => new Set(list.map(item => item.id)).size === list.length, 'Duplicate Gitee accounts').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        hint: { zh: 'Gitee 没有确认的机器人标记，首版把账号都当人处理；这个名单在能标出机器人之前不生效。', en: 'Gitee has no confirmed bot marker, so the first version treats every account as a person; this list has no effect until a marker exists.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、PR 或评论里 @ 智能体。', en: 'An account on the list mentions the agent in an Issue, pull request or comment.' },
    rows(stored) {
      const config = GiteeConfigSchema.parse(stored)
      const note = (on: boolean) => on ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEE_HOST', description: { zh: 'Gitee 主机，默认 gitee.com', en: 'The Gitee host, gitee.com by default' } },
      { key: 'DSH_SUPERAGENT_GITEE_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name', en: 'The repository this Source watches, as owner/name' } },
      { key: 'DSH_SUPERAGENT_GITEE_ACCOUNT', description: { zh: '智能体的 Gitee 账号；gitee-cli 以它登录', en: 'The agent\'s Gitee account; gitee-cli is signed in to it' } },
      { key: 'DSH_SUPERAGENT_GITEE_KIND', description: { zh: '工单来自 Gitee 的 issue 还是 pr；不是 Gitee 工单时为空', en: 'Whether the ticket came from a Gitee issue or pr; empty when it did not' } },
      { key: 'DSH_SUPERAGENT_GITEE_NUMBER', description: { zh: '工单所在的 Issue 或 PR 编号；不是 Gitee 工单时为空', en: 'Number of the Issue or pull request the ticket came from; empty when it did not' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitee = deployment.gitee
      const kind = !trigger || trigger.source !== SOURCE ? '' : trigger.meta.kind === 'comment' ? trigger.meta.target : trigger.meta.kind
      const ticketKind = kind === 'issue' || kind === 'pr' ? kind : ''
      return { DSH_SUPERAGENT_GITEE_HOST: gitee?.hostname ?? '', DSH_SUPERAGENT_GITEE_REPOSITORY: gitee?.repository ?? '',
        DSH_SUPERAGENT_GITEE_ACCOUNT: gitee?.login ?? '', DSH_SUPERAGENT_GITEE_KIND: ticketKind,
        DSH_SUPERAGENT_GITEE_NUMBER: ticketKind ? String(trigger?.meta.number ?? '') : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitee ? {
    cli: { zh: `当前账号 @${deployment.gitee.login}`, en: `Current account @${deployment.gitee.login}` },
    repository: deployment.gitee.repository,
  } : {},
}
export const name = 'dsh-superagent-gitee'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteeKind), 'gitee: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteeKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitee', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** True once setup resolved the Gitee repository and account, and the Source is still on. */
const ready = (ctx: SourceContext, config: GiteeConfig): boolean =>
  ctx.configured() && !ctx.problem && !!ctx.deployment.gitee && !!config.repository && !!config.cli
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitee', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteeConfig>(SOURCE)
    try {
      if (!config) { ctx.report('gitee', health('paused', 'sourceOff')); failures = 0 }
      // A missing repository, CLI, or a failed setup check waits for the save or fix that restarts dsh-superagent.
      else if (!ready(ctx, config)) { ctx.report('gitee', health('paused', 'setupPending')); return }
      else { await pollRound(ctx, signal); failures = 0 }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitee', failed)
    }
    await pause(Math.max(60, ctx.config<GiteeConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Set<number>; read: Set<string>; failures: string[]; tally: { skipped: number }
  counts: { issues: number; pulls: number; comments: number }
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Set(), read: new Set(),
  failures: [], tally: { skipped: 0 }, counts: { issues: 0, pulls: 0, comments: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const note = (ctx: SourceContext, kind: 'issue' | 'pr', number: string | number, title: string): void => {
  const key = giteeThreadKey(kind, number)
  ctx.threads.patch(key, { title })
  const label = kind === 'pr' ? `Gitee PR #${number} ${title}` : `Gitee Issue ${number} ${title}`
  ctx.threads.describe(key, { label, facts: { number: { value: kind === 'pr' ? `#${number}` : String(number) } } })
}
interface Stream { id: string; path: string; query: Record<string, string> }
/** The three repository-wide streams; the `observe*` switches only decide admission, not whether a stream is read. */
const STREAMS: readonly Stream[] = [
  { id: 'issues', path: 'issues', query: { state: 'open', sort: 'updated', direction: 'asc' } },
  { id: 'pulls', path: 'pulls', query: { state: 'all', sort: 'updated', direction: 'asc' } },
  { id: 'issue-comments', path: 'issues/comments', query: { sort: 'updated', direction: 'asc' } },
]
/**
 * One polling round: the repository streams, then pull request comments of the pull requests this round returned or of open
 * Tickets, then subscribed Threads. A failed stream or Thread is recorded and the others still run; the round then fails so
 * consecutive failures reach the health threshold. Cursors move only after every Trigger of a stream was received.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    try { await readStream(ctx, round, stream) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  await pollPullComments(ctx, round)
  await pollThreads(ctx, signal, round)
  if (round.failures.length) throw new Error(`${round.failures.length} Gitee reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  if (stopped(ctx, round)) return
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  const interval = Math.max(60, ctx.config<GiteeConfig>(SOURCE)?.pollSeconds ?? 60)
  ctx.report('gitee', { state: 'ready', detail: `${round.counts.issues} new Issues, ${round.counts.pulls} new pull requests, ${round.counts.comments} comments; next poll ≥ ${interval}s${skipped}`, at: round.started })
}
/**
 * Reads one repository-wide stream from its cursor, oldest first, and advances the cursor only after every item was received.
 * Items created before the first read are not historical work: Issues and pull requests are filtered by `created_at`, while
 * comments are filtered by `updated_at`, so editing an old comment is a new event.
 */
async function readStream(ctx: SourceContext, round: Round, stream: Stream): Promise<void> {
  const gitee = account(ctx)
  const commands = ctx.commands.withSignal(round.signal)
  const name = KV.gitee.stream(stream.id)
  const stored = ctx.state.get(name)
  const since = stored?.since ?? cursorAt(round.started)
  // Persist the first read position before reading so an interrupted first round resumes from it rather than skipping ahead.
  if (!stored) ctx.state.set(name, { since, started: { [stream.id]: round.started } })
  const path = giteeResource(commands, ...stream.path.split('/'))
  const { items, truncated } = await giteePages(commands, z.unknown(), path, { ...stream.query, since }, round.tally)
  let last = ''
  const touch = (at: string | null | undefined): void => { if (at && (!last || Date.parse(at) > Date.parse(last))) last = at }
  for (const raw of items) {
    if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
    if (stream.id === 'issues') {
      const issue = GiteeIssueSchema.safeParse(raw)
      if (!issue.success) { round.tally.skipped += 1; continue }
      touch(issue.data.updated_at ?? issue.data.created_at)
      if (sameName(issue.data.user.login, gitee.login)) continue
      const born = Date.parse(issue.data.created_at)
      if (!Number.isFinite(born) || born < Date.parse(since)) continue
      if (await ctx.receive(issueTrigger(issue.data, gitee.login, gitee.hostname, gitee.repository)) === 'stored') round.counts.issues += 1
      note(ctx, 'issue', issue.data.number, issue.data.title)
      continue
    }
    if (stream.id === 'pulls') {
      const pull = GiteePullSchema.safeParse(raw)
      if (!pull.success) { round.tally.skipped += 1; continue }
      touch(pull.data.updated_at ?? pull.data.created_at)
      // Every pull request this round reports is read for comments, including one older than the cursor that just changed.
      round.pulls.add(pull.data.number)
      if (sameName(pull.data.user.login, gitee.login)) continue
      const born = Date.parse(pull.data.created_at)
      if (!Number.isFinite(born) || born < Date.parse(since)) continue
      if (await ctx.receive(pullTrigger(pull.data, gitee.login, gitee.hostname, gitee.repository)) === 'stored') round.counts.pulls += 1
      note(ctx, 'pr', pull.data.number, pull.data.title)
      continue
    }
    const comment = GiteeCommentSchema.safeParse(raw)
    if (!comment.success) { round.tally.skipped += 1; continue }
    touch(comment.data.updated_at ?? comment.data.created_at)
    if (sameName(comment.data.user.login, gitee.login)) continue
    const at = comment.data.updated_at ?? comment.data.created_at
    if (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(since)) continue
    const pr = comment.data.target?.pull_request?.number
    if (comment.data.target?.pull_request) {
      // A comment the repository stream reports on a pull request must stay on the pull request's Thread.
      if (pr === undefined || pr === null) continue
      const ref = { hostname: gitee.hostname, repository: gitee.repository, kind: 'pr' as const, number: String(pr) }
      if (await ctx.receive(commentTrigger(comment.data, ref, gitee.login)) === 'stored') round.counts.comments += 1
      continue
    }
    const number = comment.data.target?.issue?.number
    if (!number) continue
    const ref = { hostname: gitee.hostname, repository: gitee.repository, kind: 'issue' as const, number }
    if (await ctx.receive(commentTrigger(comment.data, ref, gitee.login)) === 'stored') round.counts.comments += 1
  }
  // Hitting the page limit stops at the last item read, so the next round continues after it instead of skipping unread items.
  const next = truncated && last ? cursorAt(last) : cursorAt(round.started)
  ctx.state.set(name, { since: Date.parse(next) > Date.parse(since) ? next : since, started: stored?.started ?? { [stream.id]: round.started } })
}
/** Reads the comments of the pull requests this round reported and of pull requests open Tickets follow, each after its own cursor. */
async function pollPullComments(ctx: SourceContext, round: Round): Promise<void> {
  const numbers = new Set(round.pulls)
  for (const ticket of ctx.tickets.open()) for (const follow of ticket.follows ?? []) {
    const parsed = parseThread(follow.thread)
    if (parsed?.kind === 'pr') numbers.add(Number(parsed.number))
  }
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    if (round.read.has(`pr:${number}`)) continue
    try { await readPullComments(ctx, round, number) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`pulls/${number}/comments: ${String(error)}`) }
  }
}
/** Reads one pull request's comments; Gitee has no `since` here, so the stored time cursor filters the oldest-first pages. */
async function readPullComments(ctx: SourceContext, round: Round, number: number): Promise<void> {
  const gitee = account(ctx)
  const commands = ctx.commands.withSignal(round.signal)
  const name = KV.gitee.prComments(String(number))
  const stored = ctx.state.get(name)
  const since = stored ?? cursorAt(round.started)
  if (stored === undefined) ctx.state.set(name, since)
  const path = giteeResource(commands, 'pulls', String(number), 'comments')
  const { items, truncated } = await giteePages(commands, GiteeCommentSchema, path, { direction: 'asc' }, round.tally)
  let last = ''
  for (const comment of items) {
    if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
    const at = comment.updated_at ?? comment.created_at
    if (at && (!last || Date.parse(at) > Date.parse(last))) last = at
    if (sameName(comment.user.login, gitee.login)) continue
    if (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(since)) continue
    const ref = { hostname: gitee.hostname, repository: gitee.repository, kind: 'pr' as const, number: String(number) }
    if (await ctx.receive(commentTrigger(comment, ref, gitee.login)) === 'stored') round.counts.comments += 1
  }
  const next = truncated && last ? cursorAt(last) : cursorAt(round.started)
  ctx.state.set(name, Date.parse(next) > Date.parse(since) ? next : since)
  round.read.add(`pr:${number}`)
}
/** Polls subscribed Issue and pull request Threads not already read in this round; each keeps its own comment cursor. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const gitee = account(ctx)
  const parsed = parseThread(thread.ref.id)
  if (!parsed) throw new Error('Subscribed Gitee thread is not an Issue or pull request')
  round.read.add(thread.ref.id)
  const commands = ctx.commands.withSignal(round.signal)
  const checkpoint = KV.gitee.cursor(parsed.kind, parsed.number)
  const stored = ctx.state.get(checkpoint)
  const since = stored ?? cursorAt(round.started)
  if (stored === undefined) ctx.state.set(checkpoint, since)
  const path = giteeResource(commands, parsed.kind === 'pr' ? 'pulls' : 'issues', parsed.number, 'comments')
  const { items, truncated } = await giteePages(commands, GiteeCommentSchema, path, { direction: 'asc' }, round.tally)
  let last = ''
  for (const comment of items) {
    if (stopped(ctx, round)) throw new Error('The Gitee Source stopped during the poll')
    const at = comment.updated_at ?? comment.created_at
    if (at && (!last || Date.parse(at) > Date.parse(last))) last = at
    if (sameName(comment.user.login, gitee.login)) continue
    if (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(since)) continue
    const ref = { hostname: gitee.hostname, repository: gitee.repository, kind: parsed.kind, number: parsed.number }
    if (await ctx.receive(commentTrigger(comment, ref, gitee.login)) === 'stored') round.counts.comments += 1
  }
  const next = truncated && last ? cursorAt(last) : cursorAt(round.started)
  ctx.state.set(checkpoint, Date.parse(next) > Date.parse(since) ? next : since)
}
