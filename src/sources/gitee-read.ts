/** Read-only Gitee REST API access through the configured `gitee-cli`, pagination, and the Thread context assessments read. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { CliError } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { GiteeCommentSchema, GiteeIssueSchema, GiteePullSchema, giteePage,
  type GiteeComment, type GiteeIssue, type GiteePull } from './gitee-trigger.ts'
import type { GiteeConfig } from './gitee.ts'

/** The resolved Gitee account and CLI; a Gitee read is impossible before setup resolves them. */
export function giteeDeployment(commands: Commands) {
  const gitee = commands.deployment.gitee
  if (!gitee) throw new Error('The Gitee Source has no working gitee-cli')
  return gitee
}
/** Builds a path below the configured repository, encoding every segment, so a read cannot escape the repository. */
export function giteeResource(commands: Commands, ...segments: string[]): string {
  const { repository } = giteeDeployment(commands)
  const [owner, name] = repository.split('/')
  return ['/repos', encodeURIComponent(owner!), encodeURIComponent(name!), ...segments.map(segment => encodeURIComponent(segment))].join('/')
}
/** Calls the Gitee API and parses its JSON body; CLI failures carry Gitee's HTTP status as `CliError.code`. */
export async function giteeApi<T>(commands: Commands, schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> {
  const { cli } = giteeDeployment(commands)
  return schema.parse(JSON.parse(await commands.run(cli, ['api', path, ...flags])))
}
/** One page of a Gitee list; `full` is true when the page may have a successor. Gitee lists have no total count. */
export async function giteePageOf<T>(commands: Commands, item: z.ZodType<T>, path: string,
  query: Record<string, string | number | undefined>, page: number, tally?: Tally, perPage = 100): Promise<{ items: T[]; full: boolean }> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  params.set('per_page', String(perPage))
  params.set('page', String(page))
  const listed = await giteeApi(commands, z.array(z.unknown()), `${path}?${params.toString()}`)
  return { items: validItems(item, listed, tally), full: listed.length >= perPage }
}
/**
 * Reads at most `maxPages` pages of a Gitee list, oldest first. `truncated` means the last allowed page was full, so more items
 * may follow; callers then advance their cursor only to the last item they read rather than past the round's start.
 */
export async function giteePages<T>(commands: Commands, item: z.ZodType<T>, path: string,
  query: Record<string, string | number | undefined> = {}, tally?: Tally, maxPages = 10): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const result = await giteePageOf(commands, item, path, query, page, tally)
    items.push(...result.items)
    if (!result.full) return { items, truncated: false }
  }
  return { items, truncated: true }
}
export const findIssue = (commands: Commands, number: string | number): Promise<GiteeIssue> =>
  giteeApi(commands, GiteeIssueSchema, giteeResource(commands, 'issues', String(number)))
export const findPull = (commands: Commands, number: string | number): Promise<GiteePull> =>
  giteeApi(commands, GiteePullSchema, giteeResource(commands, 'pulls', String(number)))
/** Reads one comment by id; `undefined` when Gitee no longer has it. */
export async function findComment(commands: Commands, kind: 'issue' | 'pr', id: string | number): Promise<GiteeComment | undefined> {
  const path = kind === 'pr' ? giteeResource(commands, 'pulls', 'comments', String(id)) : giteeResource(commands, 'issues', 'comments', String(id))
  return giteeApi(commands, GiteeCommentSchema, path).catch((error: unknown) => {
    if (error instanceof CliError && (error.code === 404 || error.code === 410)) return undefined
    throw error
  })
}
/** Formats a Gitee comment as a model-facing ContextMessage; Gitee has no confirmed bot marker, so none is marked. */
export function commentMessage(comment: GiteeComment, hostname: string, repository: string, kind: 'issue' | 'pr', number: string): ContextMessage {
  const at = comment.updated_at ?? comment.created_at ?? ''
  const url = comment.html_url ?? (kind === 'issue' ? `${giteePage(hostname, repository, kind, number)}#note_${comment.id}` : '')
  return { id: String(comment.id), from: comment.user.login, at, text: comment.body ?? '',
    ...(url ? { url } : {}), ...(comment.path ? { path: comment.path, ...(comment.new_line === undefined || comment.new_line === null
      ? {} : { line: comment.new_line }) } : {}), ...(comment.in_reply_to_id ? { reply_to: String(comment.in_reply_to_id) } : {}) }
}
/** The Thread a Trigger belongs to, as `issue` or `pr` and its number; comments name their target in `meta`. */
function threadOf(trigger: { meta: Record<string, unknown> }): { kind: 'issue' | 'pr'; number: string } | undefined {
  const kind = trigger.meta.kind === 'pr' ? 'pr' : trigger.meta.kind === 'comment' && trigger.meta.target === 'pr' ? 'pr'
    : trigger.meta.kind === 'issue' || trigger.meta.kind === 'comment' && trigger.meta.target === 'issue' ? 'issue' : undefined
  const number = trigger.meta.number
  return kind && (typeof number === 'string' || typeof number === 'number') ? { kind, number: String(number) } : undefined
}
/**
 * Reads a Gitee Thread for assessments: its comments by page, the Issue or pull request title and body as the root, and the
 * comment a comment answers as the parent. Gitee has only top-level comments, so `thread` lists comments alone.
 */
export const giteeThreadContext: ThreadContext<GiteeConfig> = {
  messageId: trigger => typeof trigger.meta.commentId === 'number' || typeof trigger.meta.commentId === 'string'
    ? String(trigger.meta.commentId) : '',
  async read(commands, trigger, part, cursor) {
    const gitee = giteeDeployment(commands)
    const thread = threadOf(trigger)
    if (!thread) return { messages: [], body: { messages: [] } }
    if (part === 'root') {
      const item = thread.kind === 'pr' ? await findPull(commands, thread.number) : await findIssue(commands, thread.number)
      const message: ContextMessage = { id: `${thread.kind}:${thread.number}`, from: item.user.login, at: item.created_at,
        text: `${item.title}\n\n${item.body ?? ''}`, ...(item.html_url ? { url: item.html_url } : {}) }
      return { messages: [message], body: { status: 'root', messages: [message] } }
    }
    if (part === 'parent') {
      const parentId = trigger.meta.inReplyTo
      if (typeof parentId !== 'number' && typeof parentId !== 'string') return { messages: [], body: { status: 'parent', messages: [] } }
      const comment = await findComment(commands, thread.kind, parentId)
      const messages = comment ? [commentMessage(comment, gitee.hostname, gitee.repository, thread.kind, thread.number)] : []
      return { messages, body: { status: 'parent', messages } }
    }
    const page = Math.max(1, Number(cursor ?? '1') || 1)
    const path = giteeResource(commands, thread.kind === 'pr' ? 'pulls' : 'issues', thread.number, 'comments')
    const result = await giteePageOf(commands, GiteeCommentSchema, path, {}, page)
    const messages = result.items.map(comment => commentMessage(comment, gitee.hostname, gitee.repository, thread.kind, thread.number))
    const next = result.full ? String(page + 1) : undefined
    return { messages, ...(next ? { next } : {}), body: { messages, ...(next ? { next } : {}) } }
  },
}
/** A Gitee Thread reference as the polling loop needs it. */
export const parseThread = (key: string): { kind: 'issue' | 'pr'; number: string } | undefined => {
  const match = /^gitee:(issue|pr):(.+)$/.exec(key)
  return match ? { kind: match[1] as 'issue' | 'pr', number: match[2]! } : undefined
}
