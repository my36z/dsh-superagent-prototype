/** Pull request Thread references shared by Sources, and the notice a ticket's pull request end sends to its IM conversations. */
import { key, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { PullRequestKind } from './kind.ts'

/** A followed pull request Thread: its Source and numeric number. */
export interface PullRef { source: string; number: number }

/**
 * Reads a followed pull request Thread. GitHub numbers a pull request as the Thread id (`github:12`); Gitee writes
 * `gitee:pr:12`, because its Issue numbers are strings and share no sequence with pull requests.
 */
const PULL_THREAD = /^([^:]+):(?:pr:)?(\d+)$/
export const pullRef = (thread: string): PullRef | undefined => {
  const match = PULL_THREAD.exec(thread)
  return match ? { source: match[1]!, number: Number(match[2]) } : undefined
}
/** The pull requests a ticket follows, newest last; with `open`, only those still open. */
export const pullRefs = (ticket: Pick<Ticket, 'follows'>, open = false): PullRef[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullRef(item.thread) ?? [])
/** The pull request a ticket follows most recently, preferring one it still has open. */
export const pullOf = (ticket: Pick<Ticket, 'follows'>): PullRef | undefined => pullRefs(ticket, true).at(-1) ?? pullRefs(ticket).at(-1)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/** A followed pull request that closed, as its end notice needs it. */
export interface PullEnd extends PullRef { at: string; outcome: 'merged' | 'closed' }
/** The latest closed followed pull request, preferring one the ticket opened, with the source that must build its notice. */
export function latestPullEnd(ticket: Pick<Ticket, 'follows'>): PullEnd | undefined {
  const ended = (ticket.follows ?? []).flatMap(follow => {
    const ref = follow.closed ? pullRef(follow.thread) : undefined
    return ref && follow.closed ? [{ ...ref, ...follow.closed, own: follow.own }] : []
  })
  const own = ended.filter(item => item.own)
  const latest = (items: typeof ended) => items.sort((a, b) => b.at.localeCompare(a.at))[0]
  const chosen = latest(own.length ? own : ended)
  return chosen ? { source: chosen.source, number: chosen.number, at: chosen.at, outcome: chosen.outcome } : undefined
}
/**
 * Builds the idempotent notices of a ticket that ended merged or closed for the IM conversations of its channels other
 * than `source`. The notice language follows the ticket's source request: Chinese when it contains Han characters and no
 * kana, otherwise English. The latest pull request the ticket opened, else the latest it followed, names the number.
 */
export function pullEndNoticesFor(source: string, ticket: Ticket, request: string,
  url: (number: number) => string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullRef(item.thread)?.source === source)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullRef(follow.thread)!.number
  const href = url(number)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${href}) 已合并。` : `[PR #${number}](${href}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${href}) has merged.` : `[PR #${number}](${href}) was closed without merging.`
  // The delivery host's timeline already shows the merge or closure, so its channels are skipped.
  return ticket.channels.filter(channel => channel.source !== source).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
/** Dispatches the end notice to the Source of the pull request that ended, whose URL and wording it knows. */
export function pullEndNotices(sources: { pullRequests(source: string): PullRequestKind | undefined },
  ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  const ended = latestPullEnd(ticket)
  return ended ? sources.pullRequests(ended.source)?.notices(ticket, request, deployment) ?? [] : []
}
