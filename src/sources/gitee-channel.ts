/** Gitee outbound channel: posts top-level Issue and pull request comments under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { DEFAULT_HOST, GiteeCommentSchema } from './gitee-trigger.ts'
import { giteeApi, giteeDeployment, giteePages, giteeResource } from './gitee-read.ts'

/** Hidden marker appended to a reply, so a retry finds the comment it already sent. Gitee keeps HTML comments in comment bodies. */
export const markerOf = (id: string): string => `<!-- dsh-superagent:${id} -->`
/** True when the reply target is permanently gone: deleted (404/410) or locked (403). Gitee has no documented 410 yet. */
export const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 404 || error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
/** Posts an Issue or top-level pull request comment idempotently by scanning for the message marker first. */
export async function sendGitee(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitee = giteeDeployment(commands)
  const { kind, number } = message.channel.address
  if ((kind !== 'issue' && kind !== 'pr') || !number) throw new Error('Missing Gitee reply target')
  const path = giteeResource(commands, kind === 'pr' ? 'pulls' : 'issues', number, 'comments')
  const marker = markerOf(message.id)
  try {
    // Gitee has no idempotency key; the marker makes a repeated delivery find its own earlier comment.
    const existing = await giteePages(commands, GiteeCommentSchema, path, {}, undefined, 10)
    if (existing.items.some(comment => sameName(comment.user.login, gitee.login) && (comment.body ?? '').includes(marker))) return 'sent'
    await giteeApiPost(commands, path, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Posts a comment body; `-f` sends Gitee's form field, and the response body is not needed. */
async function giteeApiPost(commands: Pick<SourceContext, 'commands'>['commands'], path: string, body: string): Promise<void> {
  await giteeApi(commands, z.unknown(), path, '-X', 'POST', '-f', `body=${body}`)
}
/** Builds the label and page of a Gitee Issue or pull request from its address. */
export function giteeLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const kind = address.kind === 'pr' ? 'pr' : 'issue'
  const number = address.number ?? ''
  const hostname = address.hostname || DEFAULT_HOST
  const url = address.url ?? (address.repository ? `https://${hostname}/${address.repository}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}` : '')
  return { url, label: kind === 'pr' ? { zh: `Gitee PR #${number}`, en: `Gitee PR #${number}` }
    : { zh: `Gitee Issue ${number}`, en: `Gitee Issue ${number}` } }
}
