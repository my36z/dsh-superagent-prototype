/** Gitee pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { liveTicket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { PullRequest, PullRequestKind } from './kind.ts'
import { giteePage, SOURCE, type GiteePull } from './gitee-trigger.ts'
import { findPull, giteeDeployment } from './gitee-read.ts'
import { pullEndNoticesFor, pullRefs, ticketBranch } from './pull.ts'

/** Gitee names a pull request's head as a branch, usually a string; tolerate an object that carries `ref` as well. */
const headBranch = (head: unknown): string => {
  if (typeof head === 'string') return head
  const ref = head && typeof head === 'object' ? (head as { ref?: unknown }).ref : undefined
  return typeof ref === 'string' ? ref : ''
}
/** Normalizes a Gitee pull request; Gitee has no `head.sha` or `head.repo`, and reports a merge through `merged_at`. */
export function giteePull(pr: GiteePull, deployment: { hostname: string; repository: string }): PullRequest {
  const mergedAt = pr.merged_at ?? undefined
  const merged = !!mergedAt || pr.state === 'merged'
  return { number: pr.number, state: pr.state ?? (merged ? 'merged' : 'open'), merged,
    ...(mergedAt ? { mergedAt } : {}), ...(pr.closed_at ? { closedAt: pr.closed_at } : {}),
    htmlUrl: pr.html_url ?? giteePage(deployment.hostname, deployment.repository, 'pr', pr.number),
    head: headBranch(pr.head), author: pr.user.login, repository: deployment.repository }
}
/**
 * Binds an open pull request to a ticket when it is the ticket's source PR, or one the agent opened in the configured
 * repository from a branch whose last segment is the ticket's execution name. Gitee has no head repository or commit, so
 * author, repository, and branch decide.
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: PullRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const gitee = ctx.deployment.gitee
  if (!gitee) return 'The Gitee Source has no working gitee-cli'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const fromPr = source?.source === SOURCE && (source.meta.kind === 'pr' || source.meta.kind === 'comment' && source.meta.target === 'pr')
  const started = fromPr && String(source?.meta.number) === String(pr.number)
  const opened = sameName(pr.author, gitee.login) && sameName(pr.repository ?? '', gitee.repository) && ticketBranch(ticket, pr.head)
  if (!started && !opened) {
    return `PR does not belong to this ticket: use the source PR or a PR by ${gitee.login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owned = ctx.tickets.open().find(item => pullRefs(item, true).some(ref => ref.source === SOURCE && ref.number === pr.number))
  if (owned && owned.id !== ticketId) return 'PR already belongs to another active ticket'
  const thread = `gitee:pr:${pr.number}`
  const follow = ticket.follows?.find(item => item.thread === thread)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) {
    ctx.atomic(() => {
      ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `pr:${pr.number}` }, opened)
      ctx.threads.patch(thread, { number: pr.number, isPr: true, url: pr.htmlUrl, prAuthor: pr.author })
    })
  }
  return undefined
}
/**
 * Reconciles a polled pull request's open, merged, or closed state with the tickets that follow it. An open agent pull
 * request auto-binds to the single open ticket on its branch unless that ticket already follows another open pull request.
 * @returns whether the pull request has ended.
 */
export async function observePull(ctx: SourceContext, pr: PullRequest): Promise<boolean> {
  const ended = pr.state === 'closed' || pr.state === 'merged' || pr.merged
  if (ended) {
    if (ctx.tickets.open().some(ticket => pullRefs(ticket, true).some(ref => ref.source === SOURCE && ref.number === pr.number))) {
      ctx.tickets.threadClosed({ source: SOURCE, id: `pr:${pr.number}` }, pr.merged ? 'merged' : 'closed',
        pr.mergedAt ?? pr.closedAt ?? new Date().toISOString())
    }
  } else {
    const candidates = sameName(pr.author, ctx.deployment.gitee?.login ?? '') ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A pull request the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `gitee:pr:${pr.number}` && item.closed)
    const follows = ticket ? pullRefs(ticket, true).filter(ref => ref.source === SOURCE) : []
    if (ticket && (reopened || follows.every(ref => ref.number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  return ended
}
/** The Gitee Source's pull request capability: its Thread ids, reads, binding rules, and merged/closed notice. */
export const giteePullRequest: PullRequestKind = {
  number: thread => { const match = /^gitee:pr:(\d+)$/.exec(thread); return match ? Number(match[1]) : undefined },
  read: async (commands, deployment, number, signal) => {
    const gitee = deployment.gitee ?? giteeDeployment(commands)
    return giteePull(await findPull(commands.withSignal(signal), number), gitee)
  },
  claim: (ctx, ticketId, pr) => claimPull(ctx, ticketId, pr),
  observe: (ctx, pr) => observePull(ctx, pr),
  notices: (ticket, request, deployment) => {
    const gitee = deployment.gitee
    return gitee ? pullEndNoticesFor(SOURCE, ticket, request, number => giteePage(gitee.hostname, gitee.repository, 'pr', number)) : []
  },
}
