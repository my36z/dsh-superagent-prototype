/** Normalizes Gitee Issues, pull requests, and comments into domain Triggers; Issue numbers are strings and pull request numbers are integers. */
import { z } from 'zod'
import { key, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitee'
/** Gitee repository host; the configured `hostname` field may name a private deployment. */
export const DEFAULT_HOST = 'gitee.com'
/** Gitee Issue or pull request Thread: `issue:<number>` or `pr:<number>`, below the Source in `gitee:<kind>:<number>`. */
export const giteeThread = (kind: 'issue' | 'pr', number: string | number): ThreadRef => ({ source: SOURCE, id: `${kind}:${number}` })
export const giteeThreadKey = (kind: 'issue' | 'pr', number: string | number): string => `${SOURCE}:${kind}:${number}`
export const giteePage = (hostname: string, repository: string, kind: 'issue' | 'pr', number: string | number): string =>
  `https://${hostname}/${repository}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`
/** Reply address of an Issue or pull request, optionally naming the comment it answers; replies are always top-level Gitee comments. */
export const giteeChannel = (input: { hostname: string; repository: string; kind: 'issue' | 'pr'; number: string | number;
  url?: string | undefined; commentId?: string | number | undefined; path?: string | undefined; line?: number | undefined; commitId?: string | undefined }): ChannelRef =>
  ({ source: SOURCE, thread: giteeThreadKey(input.kind, input.number), address: { hostname: input.hostname, repository: input.repository,
    kind: input.kind, number: String(input.number), ...(input.url ? { url: input.url } : {}),
    ...(input.commentId === undefined ? {} : { commentId: String(input.commentId) }), ...(input.path ? { path: input.path } : {}),
    ...(input.line === undefined ? {} : { line: String(input.line) }), ...(input.commitId ? { commitId: input.commitId } : {}) } })

/** A Gitee account; Gitee has no confirmed bot marker, so the first version treats every account as a person. */
export const GiteeUserSchema = z.looseObject({ login: z.string() })
export type GiteeUser = z.infer<typeof GiteeUserSchema>
/**
 * A Gitee Issue comment. Gitee Issue comments have no `in_reply_to_id`; pull request comments may set it, and code comments carry
 * `comment_type`, `path`, `commit_id`, and `new_line`. The repository-wide comment stream adds `target`, which names the Issue or
 * pull request the comment belongs to.
 */
export const GiteeCommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: GiteeUserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  comment_type: z.string().nullish(), path: z.string().nullish(), position: z.union([z.number(), z.string()]).nullish(),
  commit_id: z.string().nullish(), in_reply_to_id: z.number().nullish(), new_line: z.number().nullish(),
  target: z.looseObject({ issue: z.looseObject({ number: z.string() }).nullish(),
    pull_request: z.looseObject({ number: z.union([z.number(), z.string()]).nullish() }).nullish() }).nullish(),
})
export type GiteeComment = z.infer<typeof GiteeCommentSchema>
/** An Issue as the Issues list or `issues/<number>` returns it; `number` is a string such as `IKSRCD`, never a number. */
export const GiteeIssueSchema = z.looseObject({
  number: z.string(), title: z.string(), body: z.string().nullish(), user: GiteeUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), html_url: z.string().nullish(), state: z.string().nullish(),
  pull_request: z.unknown().nullish(),
})
export type GiteeIssue = z.infer<typeof GiteeIssueSchema>
/** A pull request; `number` is an integer, and `head`/`base` name branches rather than GitHub's objects. */
export const GiteePullSchema = z.looseObject({
  number: z.number(), title: z.string(), body: z.string().nullish(), user: GiteeUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), html_url: z.string().nullish(), state: z.string().nullish(),
  merged_at: z.string().nullish(), head: z.unknown().nullish(), base: z.unknown().nullish(),
})
export type GiteePull = z.infer<typeof GiteePullSchema>
interface Opened {
  number: string | number; title: string; body?: string | null; user: GiteeUser; created_at: string; html_url?: string | null
}
export interface GiteeRef { hostname: string; repository: string; kind: 'issue' | 'pr'; number: string; url?: string | undefined; prAuthor?: string | undefined }
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
/** Gitee gives no reliable bot marker yet, so only the agent account is automated; every other account counts as a person. */
const author = (user: GiteeUser, agent: string) => ({ actor: { source: SOURCE, id: user.login }, human: !sameName(user.login, agent) })
const opened = (item: Opened, agent: string, hostname: string, repository: string, kind: 'issue' | 'pr'): Trigger => {
  const body = item.body ?? ''
  return { id: key(kind === 'pr' ? 'gitee-pr' : 'gitee-issue', String(item.number)), source: SOURCE,
    threads: [giteeThread(kind, item.number)], ...author(item.user, agent), at: item.created_at, text: `${item.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel({ hostname, repository, kind, number: item.number, ...(item.html_url ? { url: item.html_url } : {}) }),
    ...(item.html_url ? { url: item.html_url } : {}),
    meta: { number: String(item.number), kind, repository, ...(kind === 'pr' ? { prAuthor: item.user.login } : {}) } }
}
/** Builds the trigger for a newly opened Issue's title and body. */
export function issueTrigger(issue: Opened, agent: string, hostname: string, repository: string): Trigger {
  return opened(issue, agent, hostname, repository, 'issue')
}
/** Builds the trigger for a newly opened pull request's title and description. */
export function pullTrigger(pull: Opened, agent: string, hostname: string, repository: string): Trigger {
  return opened(pull, agent, hostname, repository, 'pr')
}
/** Builds the trigger for a comment on an Issue or pull request; editing a comment produces a new Trigger through its timestamp. */
export function commentTrigger(comment: GiteeComment, ref: GiteeRef, agent: string): Trigger {
  const at = comment.updated_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.created_at ?? ''
  const inline = comment.comment_type === 'diff_comment'
  const page = giteePage(ref.hostname, ref.repository, ref.kind, ref.number)
  // Gitee Issue comments have no documented `html_url`; their page link names the comment by anchor.
  const url = comment.html_url ?? (ref.kind === 'issue' ? `${page}#note_${comment.id}` : page)
  const line = comment.new_line ?? undefined
  return { id: key('gitee-comment', ref.kind, ref.number, String(comment.id), version), source: SOURCE,
    threads: [giteeThread(ref.kind, ref.number)], ...author(comment.user, agent), at,
    text: comment.body ?? '',
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: giteeChannel({ hostname: ref.hostname, repository: ref.repository, kind: ref.kind, number: ref.number, url,
      commentId: comment.id, ...(inline && comment.path ? { path: comment.path } : {}), ...(inline && line !== undefined ? { line } : {}),
      ...(inline && comment.commit_id ? { commitId: comment.commit_id } : {}) }),
    url,
    meta: { number: String(ref.number), kind: 'comment', target: ref.kind, repository: ref.repository, commentId: comment.id,
      ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), ...(inline && comment.path ? { path: comment.path } : {}),
      ...(inline && line !== undefined ? { line } : {}), ...(comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {}) } }
}
/**
 * Names the Thread of a Gitee link or a bare number. Issue numbers are strings (`IKSRCD`), so a bare number with no letters is a
 * pull request number; Gitee URLs say which one it is.
 */
export function giteeFind(query: string): { threads: string[]; terms: string[] } {
  const url = /gitee\.com\/[^/\s]+\/[^/\s]+\/(issues|pulls|pull)\/([A-Za-z0-9]+)/.exec(query)
  if (url) return { threads: [giteeThreadKey(url[1] === 'issues' ? 'issue' : 'pr', url[2]!)], terms: [] }
  const bare = query.trim().replace(/^#/, '')
  if (/^\d+$/.test(bare)) return { threads: [giteeThreadKey('pr', bare)], terms: [] }
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(bare)) return { threads: [giteeThreadKey('issue', bare)], terms: [] }
  return { threads: [], terms: [] }
}
