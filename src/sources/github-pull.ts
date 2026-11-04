/** Pull request binding, lifecycle observation, and terminal IM notification helpers for the GitHub Source. */
import { z } from 'zod'
import { liveTicket, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { PullRequest, PullRequestKind } from './kind.ts'
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'
import { pullEndNoticesFor, pullRefs, ticketBranch } from './pull.ts'

export { ticketBranch } from './pull.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (commands: Commands, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** The GitHub pull request Threads a ticket follows, in order. */
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  pullRefs(ticket, open).filter(ref => ref.source === SOURCE).map(ref => ref.number)
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`github:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(pr.number) }, own)
    ctx.threads.patch(`github:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/** Normalizes a GitHub pull request for the shared pull request rules. */
export const toPullRequest = (pr: Pull, repository: string): PullRequest => ({ number: pr.number, state: pr.state, merged: !!pr.merged,
  ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}), ...(pr.closed_at ? { closedAt: pr.closed_at } : {}),
  htmlUrl: pr.html_url, head: pr.head.ref, author: pr.user.login, repository,
  ...(pr.head.repo ? { headRepository: pr.head.repo.full_name } : {}), headSha: pr.head.sha,
  ...(pr.auto_merge != null ? { autoMerge: true } : {}) })
/** Rebuilds the GitHub shape a binding or observation needs; the optional facts keep a fork and its commit distinguishable. */
export const fromPullRequest = (pr: PullRequest): Pull => ({ number: pr.number, state: pr.state, html_url: pr.htmlUrl, user: { login: pr.author },
  merged: pr.merged, merged_at: pr.mergedAt ?? null, closed_at: pr.closedAt ?? null,
  head: { ref: pr.head, sha: pr.headSha ?? '', repo: pr.headRepository ? { full_name: pr.headRepository } : null },
  ...(pr.autoMerge === undefined ? {} : { auto_merge: pr.autoMerge ? {} : null }) })
/** The GitHub Source's pull request capability: its Thread ids, reads, binding rules, and merged/closed notice. */
export const githubPullRequest: PullRequestKind = {
  number: thread => { const match = /^github:(\d+)$/.exec(thread); return match ? Number(match[1]) : undefined },
  read: async (commands, deployment, number, signal) => toPullRequest(await readPull(commands, number, signal), deployment.repository),
  claim: (ctx, ticketId, pr) => claimPull(ctx, ticketId, fromPullRequest(pr)),
  observe: (ctx, pr) => observePull(ctx, fromPullRequest(pr)),
  notices: (ticket, request, deployment) => pullEndNoticesFor(SOURCE, ticket, request,
    number => githubPage(deployment.repository, number, true)),
}
