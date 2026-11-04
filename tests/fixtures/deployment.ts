/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, GithubDeployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/** A resolved deployment with GitHub by default; the cast keeps `github` non-optional for tests that read its account. */
export type TestDeployment = Deployment & { github: GithubDeployment }
export const testDeployment = (overrides: Partial<Deployment> = {}): TestDeployment => ({
  ...testMachine(),
  github: { repository: 'acme/widgets', cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
}) as TestDeployment
