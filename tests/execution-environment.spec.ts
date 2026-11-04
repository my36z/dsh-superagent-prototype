import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import type { Deployment, GiteeDeployment } from '../src/deployment.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { giteeKind } from '../src/sources/gitee.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const GITEE: GiteeDeployment = { hostname: 'gitee.com', repository: 'acme/gitee-widgets', cli: '/bin/false', login: 'gitee-bot', id: 9 }
const settings = (sources: Record<string, unknown>): Settings => SettingsSchema.parse({ sources })
const registry = () => { const sources = new SourceRegistry(() => SettingsSchema.parse({})); sources.register(githubKind); sources.register(giteeKind); return sources }
const ticket = { id: 't1', name: 'fix-margin', directory: '/w/fix-margin' }
const trigger = (source: 'github' | 'gitee' | 'feishu', meta: Record<string, unknown> = {}): Trigger =>
  ({ id: 'trigger-1', source, human: true, at: '2026-11-04T00:00:00.000Z', text: 'fix it', actor: { source, id: 'alice' },
    threads: [{ source, id: source === 'gitee' ? 'issue:IKSRCD' : source === 'github' ? '7' : 'oc_1:om_1' }], meta }) as unknown as Trigger
const valuesOf = (deployment: Deployment, triggerValue: Trigger | undefined, sources: Settings) =>
  Object.fromEntries(environmentOf({ deployment, sources: registry(), settings: sources, ticket, ...triggerValue ? { trigger: triggerValue } : {} })
    .map(variable => [variable.key, variable.value]))
const keysFor = (deployment: Deployment, triggerValue: Trigger | undefined, sources: Settings, owner: string) =>
  environmentOf({ deployment, sources: registry(), settings: sources, ticket, ...triggerValue ? { trigger: triggerValue } : {} })
    .filter(variable => variable.owner === owner).map(variable => variable.key)

describe('execution environment by Source', () => {
  it('keeps a GitHub-only deployment exactly as before', () => {
    const deployment = testDeployment({ gitee: undefined })
    const settingsValue = settings({ github: { enabled: true, config: {} }, gitee: { enabled: false, config: {} } })
    const values = valuesOf(deployment, trigger('github', { number: 7, isPr: false }), settingsValue)
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot',
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '7+agent-bot@users.noreply.github.com', DSH_SUPERAGENT_GITHUB_NUMBER: '7', DSH_SUPERAGENT_GITHUB_PR_HEAD: '' })
    expect(keysFor(deployment, trigger('github', { number: 7 }), settingsValue, 'gitee')).toEqual([])
  })
  it('gives a Gitee-only deployment the Gitee repository and account, and no GitHub variables', () => {
    const deployment = testDeployment({ github: undefined, gitee: GITEE })
    // GitHub stays installed, so its declarations exist; being unresolved, its variables are not generated.
    const settingsValue = settings({ github: { enabled: true, config: {} }, gitee: { enabled: true, config: {} } })
    const values = valuesOf(deployment, trigger('gitee', { kind: 'issue', number: 'IKSRCD' }), settingsValue)
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITEE_HOST: 'gitee.com', DSH_SUPERAGENT_GITEE_REPOSITORY: 'acme/gitee-widgets',
      DSH_SUPERAGENT_GITEE_ACCOUNT: 'gitee-bot', DSH_SUPERAGENT_GITEE_KIND: 'issue', DSH_SUPERAGENT_GITEE_NUMBER: 'IKSRCD' })
    expect(keysFor(deployment, trigger('gitee', { kind: 'issue', number: 'IKSRCD' }), settingsValue, 'github')).toEqual([])
  })
  it('keeps two configured Sources from supplying each other\'s repository variables', () => {
    const deployment = testDeployment({ gitee: GITEE })
    const settingsValue = settings({ github: { enabled: true, config: {} }, gitee: { enabled: true, config: {} } })
    const github = valuesOf(deployment, trigger('github', { number: 7 }), settingsValue)
    expect(github.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('acme/widgets')
    expect(github).not.toHaveProperty('DSH_SUPERAGENT_GITEE_REPOSITORY')
    const gitee = valuesOf(deployment, trigger('gitee', { kind: 'issue', number: 'IKSRCD' }), settingsValue)
    expect(gitee.DSH_SUPERAGENT_GITEE_REPOSITORY).toBe('acme/gitee-widgets')
    expect(gitee).not.toHaveProperty('DSH_SUPERAGENT_GITHUB_REPOSITORY')
    // A Feishu Ticket has no repository of its own; it keeps using the configured GitHub delivery host.
    const feishu = valuesOf(deployment, trigger('feishu', { chatId: 'oc_1' }), settingsValue)
    expect(feishu.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('acme/widgets')
    expect(feishu).not.toHaveProperty('DSH_SUPERAGENT_GITEE_REPOSITORY')
  })
  it('lists both resolved repositories outside a Ticket, where no Source is the ticket\'s', () => {
    const deployment = testDeployment({ gitee: GITEE })
    const settingsValue = settings({ github: { enabled: true, config: {} }, gitee: { enabled: true, config: {} } })
    const values = Object.fromEntries(environmentOf({ deployment, sources: registry(), settings: settingsValue }).map(variable => [variable.key, variable.value]))
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITEE_REPOSITORY: 'acme/gitee-widgets' })
    expect(values).not.toHaveProperty('DSH_SUPERAGENT_DIR')
  })
})
