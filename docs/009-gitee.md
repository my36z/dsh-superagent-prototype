# 009 Gitee Source

本文设计 `gitee` 这个来源（Source）类型：在 Gitee 上接收 Issue、Pull Request（PR）和评论，把它们翻译成触发（Trigger），按 [002 Authorization](002-authorization.md) 的准入规则评估，在 Gitee 上回复，并让工单以 Gitee PR 交付。

范围：只写设计，不改 `src/` 下的代码、`scripts/`、`profile` 配置或依赖。实现顺序见第 8 节。API 结论以 [Gitee OpenAPI v5 的 swagger](https://gitee.com/api/v5/swagger_doc)（版本 5.4.93）和官方 [Gitee CLI](https://gitee.com/oschina/gitee-cli) 为准；没有核对的接口、字段或行为都标为「待确认」，并写进第 9 节，不按 GitHub 的形状猜测。

本文沿用 [001 Domain model](001-domain.md)、[002 Authorization](002-authorization.md) 和 [007 Architecture](007-architecture.md) 的术语，并按 [008 Cookbook](008-cookbook.md) 的「Add a Source」四件事展开：事件映射、配置与面板、回复与线程上下文、轮询循环。

## 0. 结论

- **轮询，不依赖公网回调。** Gitee 有 WebHook（`issue_hooks`、`merge_request_hooks`、`note_hooks`、`push_hooks`），但当前部署的面板只在本机监听，没有公网入口；GitHub 来源也是纯轮询。Gitee 首版同样用轮询，WebHook 留作阶段 6 的可选加速通道，不改变领域模型。
- **走 Gitee REST API v5，经一个 `gitee-cli` 包装命令。** Gitee 没有像 `gh` 那样由平台长期维护、被现有流程默认使用的对等 CLI；不过官方 Gitee CLI 已经提供了 `api`、`--json`、非交互参数和诊断走 stderr 的能力。来源只依赖一个薄包装的 `gitee-cli` 契约，用它隔离凭据、固定输出和错误码，不把来源绑死在第三方 CLI 的具体版本上。
- **Issue 与 PR 使用不同的线程前缀。** Gitee 的 Issue 编号是字符串，PR 编号是整数；线程因此写成 `gitee:issue:<number>` 和 `gitee:pr:<number>`，不依赖两者是否共享序列，也不能像 GitHub 那样只用一个编号。
- **先作为与 GitHub 并存的第二个来源，再拆单来源部署。** 当前 `Deployment` 强制要求一个 GitHub 仓库和账号，执行环境、git 凭据和交付提示也都以 GitHub 为默认。阶段 1–4 让 Gitee 来源在现有部署里工作；阶段 5 再把“一个 GitHub 仓库”抽象成“每个来源各自的仓库”，让只配置 Gitee 的部署成立。这个顺序避免在来源骨架尚未验证时同时改部署核心。

## 1. CLI 等式：为什么 Gitee 也能用命令行干活

### 1.1 现有设计依赖 CLI 的四个位置

| 位置 | 现在做什么 | 对 Gitee 的要求 |
| --- | --- | --- |
| `Commands.run(program, args)`（`src/infra/commands.ts`） | 通用子进程执行：超时、`AbortSignal`、隔离环境、`GH_PROMPT_DISABLED` | 只需要一个可执行文件；Gitee CLI 走同一个入口 |
| `Commands.api` / `pages` / `gh` / `lark` | GitHub 与飞书专用：限制在配置的仓库内、解析 JSON、翻页、把 stderr 或 `error.code` 变成 `CliError.code` | Gitee 需要一个等价的读取函数，但可以放在 `src/sources/gitee-read.ts`，不改通用 `Commands` |
| `workerProbe` 与 `SETUP_FIELDS`（`src/deployment.ts`） | 用执行器同样的方式探测 CLI；账号字段变化触发重启 | Gitee 的 `repository`、`cli`、`hostname` 加入 `SETUP_FIELDS`，由 `resolveGitee` 探测 |
| `writeEnvironment`（`src/infra/environment.ts`） | 在 `worker-bin` 写 `gh`、`lark-cli` 的 shim，并写只对 github.com 生效的 git 凭据配置 | 增加 `gitee-cli` shim、gitee.com 的凭据 helper，并清掉 `GITEE_TOKEN` |

等式成立的关键不是“Gitee 也有一个像 gh 的命令”，而是四个契约同时成立：命令的 stdout 是稳定 JSON、诊断只走 stderr、HTTP 错误码能保留、凭据只在 CLI 自己的配置里。包装层只要守住这四点，来源代码就和 GitHub 来源同构。

### 1.2 选择：官方 Gitee CLI + 薄包装

官方 Gitee CLI（命令名 `gitee`，仓库 [`oschina/gitee-cli`](https://gitee.com/oschina/gitee-cli)）已经具备：

- `gitee auth login` / `auth status`，PAT 存在 `~/.config/gitee/credentials.yml`；
- `gitee api <endpoint>` 直接调用任意 v5 接口（`-X`、`-f`、`--body`、`-H`）；
- `gitee pr create`、`pr view`、`pr comment`、`issue comment` 等交付动作；
- `--json` 结构化输出、`--repo`/`--hostname` 显式指定目标、诊断走 stderr、非交互参数。

因此实现阶段提供 `gitee-cli` 包装命令（可以是一个 shell 或 Node 脚本，放在 `scripts/` 或独立安装，本设计不规定位置），把官方 CLI 包在固定的账号配置和固定的输出契约里。来源配置里保存的是这个包装命令的路径，不是 token。

选择它的理由：

1. **与现有 `gh-agent` 同构。** `gh`/`lark-cli` 的配置字段保存的是包装脚本路径；`gitee-cli` 也一样。执行器仍然通过 `PATH` 上的 shim 以智能体账号行事，setup 仍用 `workerProbe` 探测。
2. **凭据隔离。** 包装层把官方 CLI 的配置目录（如 `XDG_CONFIG_HOME` 或 `~/.config/gitee`）指向智能体专用目录，token 不进入 settings、来源配置、argv 或日志。
3. **固定错误与输出。** 官方 CLI 的退出码和错误文本没有在文档里冻结；包装层把非 2xx 统一成可解析的 stderr JSON，保留 HTTP 状态码，避免来源直接依赖 CLI 的实现细节。
4. **补上 git 凭据。** 官方 CLI 没有文档化的 `auth git-credential`；包装层的 `auth git-credential` 子命令让 `https://gitee.com` 的 fetch/push 使用智能体 PAT，作用和 `gh auth git-credential` 相同。

不选“在 Node 里直接 `fetch` REST”的理由：那会同时存在两条凭据路径（来源自己读 token、worker 仍要 CLI 开 PR），还要自己实现重试、分页、错误码和代理；而且 setup 的账号探测会与来源内的 HTTP 客户端分裂。若包装层被证明不可维护，再退回“来源内 REST 客户端 + worker 用同一 CLI”的方案，但那是备选，不是首选。

### 1.3 `gitee-cli` 契约

来源只调用 `auth status`、`api`；worker 还会调用 `pr create`、`pr comment`、`issue comment`。所有子命令都必须支持非交互运行。

| 子命令 | 参数 | stdout | 说明 |
| --- | --- | --- | --- |
| `auth status --json` | — | `{"login":"…","id":123}` | 未登录时退出 1，stderr 给原因 |
| `auth git-credential` | 按 git credential 协议从 stdin 读 `get`/`store`/`erase` | `username=…`、`password=…` | 只对配置的 Gitee 主机返回凭据 |
| `api <METHOD> <path>` | `--include`、`-f key=value`（可重复）、`--body <json>`、`-H` | Gitee 响应体 JSON | `path` 相对 `/api/v5`，以 `/` 开头；失败见下 |
| `pr create` | `--repo owner/name`、`--head`、`--base`、`--title`、`--body`、`--draft` | `{"number":42,"html_url":"…"}` | 供 worker 开 PR |
| `pr view <n>` | `--repo owner/name`、`--json` | PR JSON | 供 worker 读取状态 |
| `pr comment <n>` | `--repo owner/name`、`--body` | `{"id":…,"html_url":"…"}` | 供 worker 回复；来源自身也用它或 `api` |
| `issue comment <number>` | `--repo owner/name`、`--body` | `{"id":…,"html_url":"…"}` | 同上 |

输出与错误契约：

- **stdout 只放数据。** 进度、重试、限流、警告一律写 stderr；JSON 的顶层就是 Gitee 的响应体，不额外包一层。
- **HTTP 失败。** 非 2xx 在 stderr 打印 `{"error":{"code":<HTTP 状态>,"message":"…"}}`，退出码 1；`404`/`410`/`403`/`429` 必须原样保留，来源靠它区分“目标永久消失”和“稍后重试”。
- **`--include`。** 官方 CLI 没有这个 flag（实测 `unknown flag`），包装层也不提供响应头；来源不依赖限流或分页响应头，改用“每轮最多 N 页 + 失败阈值”，见第 9 节。
- **路径限制。** 包装层不限制仓库；来源层只构造 `/repos/{owner}/{repo}/…` 下的路径，和 `Commands.api` 的 `path()` 限制等价。
- **凭据不出现。** 包装层不得把 token 放进 argv；`auth status` 不打印 token；日志里不出现 token。Gitee 的 v5 接口把 `access_token` 放在查询参数或表单里，调试日志和错误信息也必须对它脱敏。

## 2. 事件映射

### 2.1 Trigger、Thread、Actor、Channel、接收范围

| 概念 | Gitee 的映射 |
| --- | --- |
| Trigger | 一条新 Issue、一条新 PR、一条 Issue 评论、一条 PR 普通评论或代码行评论。PR 的审查通过、CI 状态首版不产生 Trigger |
| Thread | 一个 Issue 或一个 PR 的整个讨论：`gitee:issue:<number>` 或 `gitee:pr:<number>`。评论与它所属的 Issue/PR 同线程 |
| Actor | Gitee 的 `user.login`；比较时按现有 `sameName` 规则忽略大小写 |
| Channel 地址 | Issue/PR 编号、评论类型、评论 id、可选的代码位置和 commit；回复发到 Issue 或 PR 的评论接口 |
| 接收范围 | 一个配置的仓库；准入表的行是“新 Issue”“新 PR”“评论”，与配置里的 `observeIssues`、`observePulls`、`observeComments` 对应 |
| 回复目的地 | Issue 评论或 PR 评论（顶层）；代码行评论目前也只能发成 PR 顶层评论，见 4.1 |

`meta.kind` 固定为 `issue`、`pr` 或 `comment`；评论另带 `meta.target`（`issue` 或 `pr`）和 `meta.number`，`scope` 据此选 `issues`、`pulls` 或 `comments` 行。`scope` 只按仓库配置判断：配置的仓库总是 `listened: true`，对应的 `observe*` 开关决定 `observed` 和 `row`。仓库未配置或来源关闭时，`SourceRegistry` 已经返回 `listened: false`，kind 内不再重复判断。可选的 `find(query)` 识别 `gitee.com/{owner}/{repo}/(issues|pulls)/<number>` 和纯 PR 编号，返回 `gitee:issue:<number>` / `gitee:pr:<number>`；Issue 编号的字符集按 Gitee 实际编号校准。

### 2.2 稳定 id

Gitee 的 Issue 编号在 API 里是字符串，PR 编号是整数。线程、触发 id、Channel 地址都必须把类型写进去，这样即使两者共享序列也不会相撞。

```ts
// 线程由来源和类型组成；Issue 的 number 不能安全地转成数字。
thread = { source: 'gitee', id: `issue:${issue.number}` }   // 或 `pr:${pr.number}`
trigger.id = key('gitee-issue', issue.number)               // 新 Issue
trigger.id = key('gitee-pr', String(pr.number))             // 新 PR
trigger.id = key('gitee-comment', kind, String(number), String(comment.id), comment.updated_at ?? comment.created_at)
```

- 新 Issue/PR 的 id 用对象本身的稳定编号；重复轮询同一个对象只生成同一个 id，`Engine.receive` 返回 `duplicate`。
- 评论的 id 带 `updated_at`，因此编辑评论会产生新 Trigger，与 GitHub 来源的评论一致；只改标题或正文的 Issue/PR 不重新产生 Trigger，避免每次 push 都重复。
- 智能体自己发的 Issue、PR、评论不生成 Trigger；用 `deployment.gitee.login` 比较作者。

### 2.3 每种事件读什么

下表除通知接口外，路径都省略 `/repos/{owner}/{repo}` 前缀。

Issue 评论的 `Note` 定义里没有文档化的 `html_url`；评论的页面链接先用 `https://{hostname}/{repository}/issues/{number}#note_{id}` 构造，锚点格式待确认。PR 评论有 `html_url`。

| 事件 | 读取接口 | 文本 | 关键字段 | 备注 |
| --- | --- | --- | --- | --- |
| 新 Issue | `GET /repos/{owner}/{repo}/issues`，`state=open`、`sort=updated`、`direction=asc`、`since` | 标题 + 正文 | `number`、`title`、`body`、`user`、`created_at`、`updated_at`、`html_url` | 只读 `open` 状态；`progressing`、`rejected` 或在两次轮询之间创建又关闭的 Issue 会漏掉，可接受 |
| 新 PR | `GET /repos/{owner}/{repo}/pulls`，`state=all`、`sort=updated`、`direction=asc`、`since` | 标题 + 正文 | `number`、`title`、`body`、`user`、`created_at`、`updated_at`、`merged_at`、`head`、`base`、`html_url` | `state=all` 在 gitee.com 的 v5 实测可用并包含 `merged`；私有部署若不接受，改为分别读 `open` 与 `closed` |
| Issue 评论 | `GET /repos/{owner}/{repo}/issues/comments`，`sort=updated`、`direction=asc`、`since` | 评论正文 | `id`、`user`、`body`、`updated_at`、`target.issue.number` | gitee.com 的 v5 实测返回 `target.issue.number`（见第 9 节）；缺失时退回按 Issue 轮询 |
| PR 评论 | `GET /repos/{owner}/{repo}/pulls/{number}/comments` | 评论正文 | `id`、`user`、`body`、`updated_at`、`comment_type`、`path`、`position`、`commit_id`、`in_reply_to_id` | 接口没有 `since`；只对“本轮更新过的 PR”和“已订阅线程的 PR”逐 PR 读；仓库级 Issue 评论流的样本中只含 Issue 评论，若 `target.pull_request` 非空则按 PR 处理 |
| PR 审查 | `POST /pulls/{n}/review` 只有写接口，没有列出审查的读接口 | — | — | 首版不产生 Trigger；审查接口只表达通过（管理员可强制通过），没有可读的审查正文 |
| CI | `GET /commits/{ref}/check-runs` 等接口存在 | — | — | Gitee Go 是否写 check-runs 待确认；首版不接收 CI |

`addressed` 只在正文里真正 @ 智能体账号时设为 `mention`；Gitee 有私信接口，但本来源不把私信当作工作入口，因此不产生 `direct`。`human` 按账号类型判断；Gitee 的机器人标记待确认。如果确认不了，首版把所有账号当人处理：策略的 `bots` 名单只对已经标成 `human:false` 的 Trigger 有意义，不能补救这一点，所以不要把自动化账号加入 `allowed`。Gitee 账号的 `type`、`bot_info` 是否足以区分机器人，见第 9 节。

## 3. 配置与面板字段

### 3.1 schema

```ts
export const GiteeAccountsSchema = z.object({
  hostname: z.string().trim().regex(/^[a-z0-9.-]+$/).default('gitee.com'),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/).default(''),
  cli: z.string().trim().default(''),
})
const GiteeConfigSchema = GiteeAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
}).strict()
```

`hostname` 默认 `gitee.com`，为私有 Gitee 部署保留；首版只在公开 gitee.com 上验证。默认值必须让来源“收不到东西”：`repository` 为空、三个 `observe` 开关都关闭。

### 3.2 面板字段

| key | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `repository` | text | 监听的仓库 / Repository | `owner/name`；保存时检查智能体账号能否读到并推送，然后重启 |
| `cli` | text | 智能体的 Gitee CLI / Agent Gitee CLI | 命令名或绝对路径，指向 `gitee-cli` 包装；执行器以 `gitee-cli` 调用它 |
| `hostname` | text（Advanced） | Gitee 主机 / Gitee host | 默认 `gitee.com`；私有部署时改这里 |
| `pollSeconds` | number（Advanced） | 轮询间隔 / 秒 | 最小 60 秒 |
| `failuresBeforeError` | number（Advanced） | 连续失败几次后报告异常 | 单次网络中断不报告 |
| `observeIssues` | switch | 接收仓库里的新 Issue | 打开后，未 @ 智能体的新 Issue 也进入准入表；关闭时仍接收 @ 智能体的新 Issue |
| `observePulls` | switch | 接收仓库里的新 PR | 同上 |
| `observeComments` | switch | 接收仓库里的评论 | 打开后，未 @ 智能体的评论和代码行评论也进入准入表；关闭时仍接收 @ 智能体的评论和已订阅线程的评论 |

`facts` 与 `health`：

| 项 | 内容 |
| --- | --- |
| `facts` | `cli`：当前账号 `@login`；`repository`：当前仓库 `owner/name`。两者都由 setup 解析，setup 未完成时为空 |
| `health` | 只声明 `gitee`。注册时 `starting`；一轮成功后 `ready` 并带计数；来源关闭时 `paused/sourceOff`；setup 未完成时 `paused/setupPending`；连续失败达到 `failuresBeforeError` 时 `error/pollFailures` |

如果 Gitee 来源已启用却缺仓库或 CLI，setup 给出 `giteeRepositoryUnset` / `giteeCliUnset`，面板显示在 Gitee 卡片上，循环等待 setup。

### 3.3 setup 与部署

`SETUP_FIELDS` 增加 `gitee: ['hostname', 'repository', 'cli']`；字段变化时 `setupChanged` 触发重启，`Settings.checkAccounts` 对 `source:gitee` 走 `resolveGitee` 而不是 GitHub 的探测。

`resolveGitee` 的顺序：

1. 解析 `GiteeAccountsSchema`；`repository` 为空抛 `giteeRepositoryUnset`，`cli` 为空抛 `giteeCliUnset`。
2. 用 `workerProbe` 运行 `gitee-cli auth status --json`，取 `login` 和 `id`；失败分别映射到 `giteeCliMissing`、`giteeCliSignedOut`、`giteeCliNoAccount`。
3. 运行 `gitee-cli api /repos/{repository}`，确认仓库可读；运行 `gitee-cli api /repos/{repository}/collaborators/{login}/permission`，确认权限包含写（Gitee 返回的权限值待确认）；失败映射到 `giteeRepositoryUnreadable` / `giteeRepositoryReadOnly`。
4. 把 `{ hostname, repository, cli, login, id, commitEmail? }` 放进 `Deployment.gitee`。`commitEmail` 只有确认 Gitee 提供可用的提交邮箱后才加，否则不提供，由提示词指定作者。

与飞书一样，Gitee 的 setup 失败只记录 `giteeProblem`，不让整个 dsh-superagent 停止：GitHub 来源仍可工作。`SourceContext.problem` 按 `place === 'gitee'` 取到它。若以后允许只配置 Gitee（阶段 5），则必须把 GitHub 的 `resolveDeployment` 也改成可选，并把规则改为“没有任何来源可用时 setup 失败；还有 GitHub 时只记录 Gitee 问题”。

执行环境变量（只在来源启用时提供）：

| 变量 | 值 |
| --- | --- |
| `DSH_SUPERAGENT_GITEE_HOST` | `gitee.com` 或私有主机 |
| `DSH_SUPERAGENT_GITEE_REPOSITORY` | `owner/name` |
| `DSH_SUPERAGENT_GITEE_ACCOUNT` | 智能体的 Gitee `login` |
| `DSH_SUPERAGENT_GITEE_KIND` | `issue` 或 `pr`；工单不是从 Gitee 来时为空 |
| `DSH_SUPERAGENT_GITEE_NUMBER` | 触发所在的 Issue 或 PR 编号；不是 Gitee 工单时为空 |

`DSH_SUPERAGENT_GITEE_COMMIT_EMAIL` 在确认 Gitee 的可用提交邮箱之前不声明；首版由提示词指定提交作者。`DSH_SUPERAGENT_GITEE_PR_HEAD` 不需要：Gitee 的 PR 以分支名表示 head，worker 从自己的分支推送，不需要 GitHub 那种 `refs/pull/<n>/head`。

### 3.4 策略部分与准入表

```ts
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(list => new Set(list.map(item => item.id)).size === list.length, 'Duplicate Gitee accounts').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] },
      { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] },
    ],
    explicit: { zh: '名单里的账号在 Issue、PR 或评论里 @ 智能体。', en: 'An account on the list mentions the agent in an Issue, pull request or comment.' },
    rows(stored) {
      const config = GiteeConfigSchema.parse(stored)
      const note = (on: boolean) => on ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: string, label: { zh: string; en: string }, on: boolean) => ({ id, label, note: note(on),
        cells: { listedUnaddressed: on, unlistedAddressed: true, unlistedUnaddressed: on } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }, config.observeIssues),
        row('pulls', { zh: '新 PR', en: 'New pull requests' }, config.observePulls),
        row('comments', { zh: '评论', en: 'Comments' }, config.observeComments)]
    },
  },
```

- 首版没有 CI 行；等确认 Gitee Go / check-runs 的读法后再加。
- `allowed` 只保存 Gitee 的 `login`；Gitee 账号 id 是数字，但策略比较用 login，和现有 GitHub 部分一致。
- `bots` 只有在翻译阶段能把该账号标成 `human:false` 时才生效；如果 Gitee 没有可靠的机器人标记，这个字段保留但不生效，见第 9 节。
- 首版不做成员同步（`sync`）：`allowed` 先手工维护；Gitee 的仓库协作者、企业成员与“谁能发起工作”的对应关系还需要单独设计，留到以后。
- `docs/002-authorization.md` 的「Admission」一节在 `GitHub` 行后增加一行：**Gitee：新 Issue、新 PR、评论和代码行评论。**

## 4. 回复与线程上下文

### 4.1 Channel

```ts
  channel: {
    allowed: (address, config) => address.repository === config.repository
      && (address.kind === 'issue' || address.kind === 'pr') && !!address.number,
    send: sendGitee,
    link: giteeLink,
  },
```

地址至少包含：

```ts
{ source: 'gitee', address: { repository: 'owner/name', kind: 'issue' | 'pr', number: '<issue 或 PR 编号>',
  commentId?: '123', url?: 'https://gitee.com/…', path?: 'src/a.ts', line?: '10', commitId?: '…' } }
```

- **发送。** Issue 回复 `POST /repos/{owner}/{repo}/issues/{number}/comments`，只接受 `body`；PR 回复 `POST /repos/{owner}/{repo}/pulls/{number}/comments`，接口还接受 `commit_id`、`path`、`position`，但顶层回复只传 `body`。两者都没有“回复到某条评论”的参数；创建接口没有 `in_reply_to_id`，读取时才有这个字段。
- **幂等。** Gitee 没有文档化的幂等键；在正文末尾放 `<!-- dsh-superagent:<message.id> -->`，发送前翻页查找同一账号、同一标记的评论，找到就返回 `sent`，与 GitHub Channel 的做法一致。Gitee 是否把 HTML 注释渲染出来待确认；如果会显示，退回一个不可见的零宽标记或一个固定短标记，但标记必须仍能被搜索到。
- **`gone`。** 只在目标确定永久不可用时返回：Issue/PR 已删除、锁定（403 且信息可判定为 locked）、或源不再监听该仓库。Gitee 删除对象返回 404 还是 410 待确认；若只有 404，第一次 404 先抛出重试，只有此前成功读过该对象或响应明确表示不存在时才返回 `gone`，避免把权限临时丢失当成永久消失。权限不足、网络错误、5xx、429 都抛出，让 Outbox 退避重试。
- **`link`。** 优先用地址里的 `url`；否则拼 `https://{hostname}/{repository}/{kind === 'pr' ? 'pulls' : 'issues'}/{number}`。标签用 `Gitee Issue <number>` 或 `Gitee PR #<number>`。
- **回复顺序。** `channel.thread` 与线程键一致：`gitee:issue:<n>` 或 `gitee:pr:<n>`；同一线程的回复按 Outbox 的既有规则排序。

### 4.2 线程上下文

`threadContext` 给评估读 Issue/PR 的讨论：

- `messageId(trigger)` 返回 `meta.commentId`，正文触发的 Trigger 返回空字符串。
- `read(commands, trigger, part, cursor, config)`：
  - `thread`：按页读评论。Issue 用 `GET /repos/{owner}/{repo}/issues/{number}/comments?per_page=100&page=n`（可选 `since`）；PR 用 `GET /repos/{owner}/{repo}/pulls/{number}/comments?per_page=100&page=n`。不传 `comment_type` 时是否同时返回普通评论和代码行评论待确认；若只返回一种，就分别以 `pr_comment` 和 `diff_comment` 读。`per_page` 最大 100。
  - `root`：Issue/PR 的标题和正文，作为一条 `ContextMessage`，`id` 为 `issue:<number>` 或 `pr:<number>`，`at` 为 `created_at`。
  - `parent`：当 `meta.inReplyTo` 存在时，读 `GET /repos/{owner}/{repo}/issues/comments/{id}` 或 `GET /repos/{owner}/{repo}/pulls/comments/{id}`，找不到时返回空页而不是让整个评估失败。
  - 消息字段：`{ id, from: user.login, at: updated_at ?? created_at, text: body, url?, path?, line?, reply_to? }`；代码行评论带 `path`；行号优先用 `new_line`，没有就留空。Gitee 的 `position` 是 diff 位置，不能直接当行号；`new_line` 的格式和可靠性待确认。
  - `next`：本页满 100 条时给下一页页码，否则省略。Gitee 的列表接口返回数组，没有统一的总数；可能出现最后一页为空，调用方要容忍。
  - `body` 与 `messages` 相同，供评估的 Session 直接读。
- 首版不实现 `repliesTo`，与 GitHub 相同：评论 Trigger id 带 `updated_at`，无法只凭父评论 id 重建父 Trigger 的 id。评估仍可从 `threadContext` 的 `reply_to` 看到父评论。
- 首版不支持图片；`images`/`image` 不实现。

## 5. 轮询循环

### 5.1 KV 记录

```ts
gitee: {
  since: record<string>('gitee-since'),                         // 通知游标（阶段 6）
  retries: record<Record<string, Retry>>('gitee-retry'),        // 失败的通知重试（阶段 6）
  cursor: family<string, [kind: string, number: string]>('gitee-cursor:'),
  stream: family<{ since: string; started: Record<string, string> }, [stream: string]>('gitee-stream:'),
  prComments: family<string, [pr: string]>('gitee-pr-comments:'),
}
```

`Retry` 目前定义在 `src/sources/github.ts` 并被 `src/kv.ts` 引用；实现 Gitee 时把它移到 `src/sources/poll.ts`（或定义同样的结构）再复用，避免 `kv.ts` 继续依赖 GitHub 模块。

### 5.2 端点、参数与游标（阶段 2 固定）

所有调用都经 `gitee-cli api`；`per_page` 最大 100，`page` 从 1 开始。下表端点除特别说明外省略 `/repos/{owner}/{repo}` 前缀。一轮按 1→5 执行，单个流失败只记入本轮失败，不阻断其他流。

| # | 读什么 | 端点 | 查询参数 | 游标（KV） | 每轮页数 | 取数与过滤 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 新 Issue | `GET /repos/{owner}/{repo}/issues` | `state=open`、`sort=updated`、`direction=asc`、`since=<issues.since>`、`per_page=100`、`page=n` | `KV.gitee.stream('issues').since` | 10 页 × 100 | 只保留 `created_at >= since` 的对象；编号是字符串，线程 `gitee:issue:<number>` |
| 2 | 新 PR 和本轮更新过的 PR | `GET /repos/{owner}/{repo}/pulls` | `state=all`、`sort=updated`、`direction=asc`、`since=<pulls.since>`、`per_page=100`、`page=n` | `KV.gitee.stream('pulls').since` | 10 页 × 100 | 只对 `created_at >= since` 的对象产生 Trigger；所有返回的 PR 编号放进 `round.pulls`，供第 4 步读评论 |
| 3 | Issue 评论 | `GET /repos/{owner}/{repo}/issues/comments` | `sort=updated`、`direction=asc`、`since=<issue-comments.since>`、`per_page=100`、`page=n` | `KV.gitee.stream('issue-comments').since` | 10 页 × 100 | 按 `updated_at >= since` 过滤，不用 `created_at`；从 `target.issue.number` 取 Issue 编号 |
| 4 | PR 评论 | `GET /repos/{owner}/{repo}/pulls/{number}/comments` | `per_page=100`、`page=n`、`direction=asc`（`comment_type` 可省略） | `KV.gitee.prComments(String(number))` | 每个 PR 10 页 × 100 | 没有 `since`，按 `updated_at >= cursor` 过滤；对象来自第 2 步的 `round.pulls`、`ctx.tickets.open()` 和订阅线程 |
| 5 | 订阅线程的增量 | `/issues/{number}/comments` 或 `/pulls/{number}/comments` | 与第 3/4 步相同，`direction=asc` | `KV.gitee.cursor('issue'\|'pr', number)` | 每线程 10 页 × 100 | 按 `updated_at >= cursor` 过滤；复用 `pollThreads` 和 14 天窗口 |

游标规则：

1. **第一次运行不读历史。** 每个流、每个 PR、每个线程的游标第一次设为 `cursorAt(now)`（当前时间减 5 秒）。新 Issue/PR 再用 `created_at >= since` 过滤；Issue 评论和 PR 评论不再按 `created_at` 过滤，因为 Gitee 的 `since` 和 `updated_at` 表达“更新时间”，编辑旧评论也应作为新事件读取。
2. **整条流成功结束才推进。** 一条流的所有页都处理完、所有 Trigger 都 `receive` 成功后，才把流游标设为 `cursorAt(round.started)`；任意一页失败就保持旧游标，下一轮重读，稳定 Trigger id 让重放成为 `duplicate`。
3. **触到页数上限就停在最后一条。** 因为按 `updated_at` 升序读，10 页后若还有数据，游标取第 10 页最后一条已处理对象的 `updated_at`（再经 `cursorAt`），下一轮从它之后继续；不要用 `round.started`，否则会跳过未读项。
4. **页数不持久化。** 每轮都从 `page=1` 开始；跨轮只保存时间游标。`per_page` 最大 100，所以单轮上限是每流 1000 条、每 PR/线程 1000 条。
5. **PR 评论的游标是每个 PR 的 `updated_at`**，不是页码；正常读完设为 `cursorAt(round.started)`，被页数截断则设为最后一条已处理评论的 `updated_at`。

**`/issues` 会不会混入 PR：不会。** GitHub 的 `/issues` 会把 PR 当 Issue 返回（带 `pull_request` 字段），但 Gitee v5 把两者分开：

- `Issue` 模型没有 `pull_request` 字段，`Issue.number` 是字符串；`PullRequest.number` 是整数。
- 在 gitee.com 的 v5 上实测，`/repos/oschina/git-osc/issues` 返回的是 `IKSFS5` 这类 Issue 编号，没有 `pull_request` 字段；对应仓库的 PR 在 `/pulls` 里，编号是整数。
- 因此映射层不需要像 GitHub 那样剔除。仍保留一条防御：若某对象带 `pull_request` 字段，或它的编号与 `/pulls` 返回的编号相同，就按 PR 处理或跳过 Issue 映射；这条只为兼容意外响应，不改变主路径。

其余取数细节：

- **Issue 评论的所属对象。** 仓库级 `/issues/comments` 的 swagger 没有展开 `target`，但 gitee.com 的实际 v5 响应里有 `target.issue.number`；实现直接读它。若某个部署没有这个字段，退回对第 1 步和订阅 Issue 逐个读 `/issues/{number}/comments`，仍保证一条评论只对应一个线程。若 `target.pull_request` 非空，说明这条评论实际属于 PR，按 PR 评论映射或跳过，不能挂到 Issue 线程。
- **PR 评论没有 `since`。** 这是与 GitHub 最大的实现差异；只对 `round.pulls`、开放工单的 PR 和订阅线程的 PR 逐 PR 读，按 `updated_at` 过滤，每个 PR 独立游标。评论多的大 PR 只读前 10 页，下一轮继续。
- **`state=all`。** gitee.com 的 v5 实测接受 `state=all`，并返回 `open` 和 `merged`；私有部署若不接受，改为 `state=open` 与 `state=closed` 两路，各自维护 `since`，合并仍以 `merged_at` 为准。
- **开关只控制观察范围，不控制是否读。** 三个流始终读；`observe*` 关闭时仍把 @ 智能体的消息交给 `receive`，否则未订阅 Issue 的评论 @ 会丢；未 @ 的消息由 `scope.observed=false` 拦在准入表之外，而不是在轮询里静默丢弃。
- **通知。** 阶段 6 才启用。`/notifications/threads?since=…&per_page=100&page=n` 返回 `{ total_count, list }`，不是 GitHub 的裸数组；按 `repository.full_name` 过滤仓库。通知只用来决定“下一轮优先读哪些对象”，不直接生成 Trigger，避免和陈旧通知重复。是否要 `PATCH` 标记已读在阶段 6 再决定；首版不修改用户的未读状态。
- **setup 等待。** 循环开始时等 `ctx.ready`；若 `ctx.problem` 是这个来源的 setup 问题，报告 `paused/setupPending` 后退出本轮，由修复后的重启再次进入。
- **健康。** 只有 `gitee` 一个入口；连续失败达到 `failuresBeforeError` 才报 `error`。失败的读记录在 Thread 的 `pollError`；目标永久消失的消息在 `GET sources` 里显示为 `dropped`，不把整轮拖成失败。
- **中止。** `commands.withSignal(signal)`、`pause(ms, signal)`、每页和每条之间检查 `signal.aborted`；插件 dispose 时 abort 并等循环退出。

### 5.3 为什么首版不用 WebHook

Gitee 的 WebHook 能推 `issue_hooks`、`merge_request_hooks`、`note_hooks`，请求带 `X-Gitee-Event`、`X-Gitee-Timestamp`、`X-Gitee-Token`，并可用签名密钥校验。但当前应用没有公网回调入口，注册 WebHook 需要用户暴露一个地址；WebHook 还会带来重放、签名、重试和“本地开发没有公网地址”的一组问题。轮询已经能覆盖同一组事件，因此 WebHook 只作为阶段 6 的可选加速通道；若启用，事件仍要经过同一套 `receive` 和稳定 id，不能绕过线程与准入。

## 6. 要动的现有代码位置

| 文件 | 改动 |
| --- | --- |
| `src/sources/gitee.ts` | **新增。** `giteeKind`、schema、fields、facts、health、policy、environment 和插件入口；`apply` 里调用 `ctx.orchestrator.sources.register(giteeKind)` |
| `src/sources/gitee-trigger.ts` | **新增。** Issue、PR、评论的 zod schema，Trigger 构造，线程 id、Channel 地址、链接 |
| `src/sources/gitee-channel.ts` | **新增。** `sendGitee`、`giteeLink`，幂等标记与 `gone` 判定 |
| `src/sources/gitee-read.ts` | **新增。** `giteeApi`、分页、`threadContext`、读 Issue/PR/评论的原对象 |
| `src/sources/gitee-pull.ts` | **新增（阶段 4）。** Gitee PR 的读取、绑定、合并/关闭观察和结束通知 |
| `src/sources/registry.ts` | **注册本身不需要改**：新 kind 由插件的 `apply` 注册，`register` 已经是通用的。只有阶段 4 增加“按来源取 PR 能力”的访问器时才改这里 |
| `src/sources/kind.ts` | 阶段 4 增加可选的 `pullRequest` 能力接口（见 6.1）；首版不加 |
| `src/deployment.ts` | 增加 `GiteeAccountsSchema`、`GiteeConfigSchema`、`SETUP_FIELDS.gitee`、`Deployment.gitee`、`resolveGitee`；阶段 5 把单仓库改成按来源的仓库 |
| `src/setup.ts` | 增加 `gitee` 的 place 与错误码：`giteeRepositoryUnset`、`giteeCliUnset`、`giteeCliMissing`、`giteeCliSignedOut`、`giteeCliNoAccount`、`giteeRepositoryUnreadable`、`giteeRepositoryReadOnly` |
| `src/app/setup.ts` | `resolve` 调用 `resolveGitee`，把失败记到 `giteeProblem`；`checkAccounts` 对 `source:gitee` 分支；`setupChanged` 自动覆盖新字段 |
| `src/app/source-context.ts` | `SourceContextDeps` 增加 `giteeProblem`，`problem` 的查找范围加上它 |
| `src/infra/environment.ts` | `WORKER_COMMANDS` 加 `gitee-cli`；`writeEnvironment` 写 `gitee-cli` shim；git 配置为 `https://{hostname}` 写 `gitee-cli auth git-credential`，并按主机写 `insteadOf`（如 `git@{hostname}:`）；`agentVariables` 清掉 `GITEE_TOKEN`；`verifyEnvironment` 按主机逐个验证；shim 的阻断提示不再只说 `gh` |
| `src/kv.ts` | 加 `KV.gitee`；把 `Retry` 从 GitHub 模块移走后不再引用 `src/sources/github.ts` |
| `src/sources/host.ts` | 若 setup 不走 `problem`，增加 `giteeUnset` 等固定健康文案；走 setup 则只需沿用 `setupPending`、`sourceOff`、`pollFailures` |
| `src/app/tools/executor.ts` | **阶段 4。** `orchestrator_report` 不再直接 `readPull(host.github, …)`，改为按工单来源解析 PR 能力；Gitee 工单用 Gitee 的读取与 claim |
| `src/app/cards.ts` | **阶段 4。** `pullOf` 返回 `{ source, number }`，不再假设 `github:` 前缀 |
| `src/app/runtime.ts` | **阶段 4。** `pullEndNotices` 改为按来源生成链接和文案；`toolHost.github` 改成按来源取 `SourceContext`；阶段 5 的部署摘要一起改 |
| `src/app/links.ts`、`src/app/resources.ts` | **阶段 6（可选）。** `resources.ts` 增加 `gitee/…` 资源读取（Issue、PR、评论），`links.ts` 的搜索仍通过 `SourceRegistry.find`；是否加 `gitee` 的内置 skill 在阶段 6 决定 |
| `docs/002-authorization.md` | 准入表增加 Gitee 一行（见 3.4） |
| `docs/007-architecture.md` | 模块表加 `src/sources/gitee*.ts`，测试表加 `tests/gitee.spec.ts`；`tests/docs.spec.ts` 会检查这两张表完整 |
| `prompts/team/delivery.md`、`prompts/team/work.md`、`prompts/cli.md` | 阶段 4 增加 Gitee 分支：用 `gitee-cli pr create` 开 PR、用 `gitee-cli pr view` 读状态、不再假设 `gh`、`DSH_SUPERAGENT_GITHUB_*` 和 `refs/pull/<n>/head` |
| `tsdown.config.ts`、`package.json`、`cordis.patch.yml` | 阶段 1 增加 `gitee-watch` 构建入口、`exports` 和默认禁用的插件 insert；与 `github-watch` 相同 |
| `tests/gitee.spec.ts` | **新增。** 阶段 1 起逐步补齐翻译、轮询、Channel、上下文、策略和插件测试 |

关于 `src/sources/registry.ts`：新来源的注册点不在注册表内部，而在插件的 `apply` 中；`SourceRegistry.register` 已经是按 kind 通用的。把“注册 Gitee”写进 `registry.ts` 会重复注册，正确的是新增 `src/sources/gitee.ts` 并在 `apply` 里注册。

### 6.1 投递（开 PR）如何抽象

现在 GitHub 的 PR 逻辑散在来源之外的几处：`orchestrator_report` 里的 `readPull`/`claimPull`、`ticketCard` 里的 `pullOf`、Runtime 里的 `pullEndNotices`、以及提示词里的 `gh` 和 `refs/pull/<n>/head`。Gitee 要交付 PR，不能把这些再复制一份 GitHub 分支，应该在 `SourceKind` 上加一个可选的 PR 能力：

```ts
export interface PullRequestKind {
  /** `github:12` / `gitee:pr:12` 里的编号；不是本来源的线程返回 undefined。 */
  number(thread: string): number | undefined
  /** 归一化的 PR：状态、合并时间、head 分支、作者、页面 URL。 */
  read(commands: Commands, deployment: Deployment, number: number, signal?: AbortSignal): Promise<PullRequest>
  /** 工单的来源 PR，或作者是智能体、head 分支最后一段等于 DSH_SUPERAGENT_NAME 的 PR。 */
  claim(ctx: SourceContext, ticketId: string, pr: PullRequest): string | undefined
  /** 观察 open/merged/closed，并把关闭报告给 Engine。 */
  observe(ctx: SourceContext, pr: PullRequest): Promise<boolean>
  /** 工单以 PR 结束时的 IM 通知（非本来源的渠道）。 */
  notices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[]
}
```

- `SourceRegistry` 暴露 `pullRequests(source)`；`cards.ts` 用 `pullOf(ticket)` 得到 `{ source, number }` 后查对应能力。
- `orchestrator_report` 的 `pr_number` 先按工单的来源（`ticket.origin.triggerId` 的 `source`）选择能力；来源没有 PR 能力或编号不在该来源时，返回明确错误，不回退到 GitHub。
- Gitee 的 `claim` 不能照抄 GitHub 的 `head.repo` 判断：Gitee 的 PR 对象只有 `head`/`base` 分支名字符串，没有 `head.sha`/`head.repo`。绑定条件改为“PR 作者是智能体账号、PR 在配置的仓库内、`head` 的分支名最后一段等于工单的执行名”。来源 PR 仍按 Trigger 的 `meta.number` 直接匹配。
- Gitee 的 `observe` 用 `state` 和 `merged_at`：`merged_at` 非空即合并，`state === 'closed'` 且未合并即关闭；`GET /pulls/{number}` 的字段是否与列表一致待确认。关闭时调用 `threadClosed`，和 GitHub 的 `closePull` 相同。
- 工单用 `gitee-cli pr create` 开 PR，开完在 `orchestrator_report` 里报 `pr_number`；worker 的提示词读取 `DSH_SUPERAGENT_GITEE_*`，不再假设 GitHub 变量。提示词先写明“当 `DSH_SUPERAGENT_GITEE_REPOSITORY` 非空时走 Gitee 流程”，不改造成按来源拼提示词；如果以后要支持更多来源，再考虑 `SourceKind` 提供交付段落。

Gitee 没有 GitHub 那样的自动合并：`gitee-cli pr merge` 可以合并，但本安装没有指定合并 CLI，因此 Gitee 工单的 PR 由人合并；`prompts/team/delivery.md` 中自动合并、reviewer credit 和 `gh pr merge` 的步骤对 Gitee 工单不适用，提示词要明确这一点。

阶段 4 完成后，GitHub 仍然是现有行为，Gitee 的 PR 也能被同一套工单生命周期管理；阶段 5 再把 `Deployment` 从“一个 GitHub 仓库”改成“每个来源各自的仓库”，让只配置 Gitee 的部署成立。

## 7. 与 GitHub Source 的关键差异

Gitee 有与 GitHub 通知对等的接口：`/notifications/threads` 列出授权用户的通知，`/repos/{owner}/{repo}/notifications` 限定到仓库；两者都接受 `since`、`unread` 和 `type=event|referer`。差别在返回结构（`{total_count, list}`）、`subject` 的字段语义没有枚举，以及没有文档化的 `x-poll-interval` 头。首版仍以仓库级时间流为准，通知只在阶段 6 作为线索。

| 维度 | GitHub Source | Gitee Source |
| --- | --- | --- |
| 事件来源 | 通知 + 仓库级 Issue/PR/评论流 + 订阅线程轮询 | 通知（以后）+ Issue/PR/Issue 评论的时间流 + 逐 PR 读评论 + 订阅线程轮询 |
| 编号 | Issue 与 PR 共用整数序列，线程 `github:<n>` | Issue 是字符串、PR 是整数，线程 `gitee:issue:<n>` / `gitee:pr:<n>` |
| 通知接口 | `notifications?all=true&since=…`，裸数组，带 `x-poll-interval` | `/notifications/threads` 与 `/repos/{owner}/{repo}/notifications`，返回 `{total_count,list}`，有 `since`、`unread`、`type=event\|referer`；`subject.type`/`subject.url` 的取值未枚举 |
| 评论读取 | Issue 评论和 PR 评论都有时间过滤；另有 review 列表 | Issue 评论有 `since`；PR 评论没有 `since`；没有列出 review 的接口 |
| 评论回复 | Issue 评论顶层；review 评论可在线程内回复 | 只有顶层评论；创建接口没有 `in_reply_to_id`，读取有该字段 |
| PR 模型 | `head.sha`、`head.ref`、`head.repo`、`auto_merge`、合并状态 | `head`/`base` 是分支字符串，没有 head 仓库；用 `merged_at`/`state`；没有自动合并字段 |
| CI | Actions check-runs，默认分支和 PR 的 CI 都能读 | 有 check-runs 读接口；Gitee Go 是否写入、默认分支怎么表示待确认 |
| 权限粒度 | PAT/`gh` 的 repo scope；setup 检查 push | PAT 的 `projects`、`issues`、`pull_requests` 等 scope；`collaborators/{user}/permission` 可查仓库权限，权限值待确认 |
| 机器人识别 | GitHub App、`[bot]` 后缀、`type` | 没有确认的 `[bot]` 约定；`type`/`bot_info` 是否可用待确认。确认不了时全部按人处理，策略 `bots` 名单只对已标成 `human:false` 的 Trigger 生效 |
| WebHook | 存在，当前来源不用 | 存在（`issue_hooks`、`merge_request_hooks`、`note_hooks`、`push_hooks`），当前来源也不用；有 `X-Gitee-Token` 和签名机制 |
| 分页/限流 | Link 头、ETag/304、`x-poll-interval` | 页码 + `per_page`（最大 100）；是否有限流头、ETag 待确认；首版不依赖条件请求 |

## 8. 分阶段落地与验证

| 阶段 | 内容 | 验证方式 |
| --- | --- | --- |
| 0 设计 | 本文；只新增 `docs/009-gitee.md` | `pnpm vitest run tests/docs.spec.ts`；`git diff --stat` 只显示这一个文件；人工核对第 9 节待确认项 |
| 1 骨架 | `GiteeAccountsSchema`/`GiteeConfigSchema`、fields、facts、health、policy、environment、`GiteeAccountsSchema` 的 setup 探测、KV、`gitee-watch` 构建与插件 insert；不轮询 | `pnpm typecheck`、`pnpm build`、`pnpm test`；面板里出现 Gitee 卡片，保存仓库/CLI 触发重启，错误 setup 显示在卡片上；`tests/gitee.spec.ts` 覆盖 schema 默认值、字段、准入行和 setup 错误 |
| 2 轮询与 Trigger | Issue/PR/Issue 评论流、逐 PR 评论、`scope`、稳定 id、游标、健康、`pollThreads` | 用假的 `gitee-cli` 输出跑 `tests/gitee.spec.ts`：同一对象只 `receive` 一次、范围外 `filtered`、游标在全部 `receive` 后才前进、中断的一轮不前进、失败阈值；在测试仓库建 Issue/评论，确认面板的 Source/Trigger 页面 |
| 3 回复与上下文 | `sendGitee`、幂等标记、`gone`、`link`、`threadContext`（thread/root/parent） | 单测：`sent`、重复发送只发一次、删除/锁定按 `gone` 规则、权限错误抛出；上下文分页、root、parent、代码行评论的降级；手工在 Issue/PR 各回复一次，评估能读到线程 |
| 4 PR 与投递 | `pullRequest` 能力、Gitee `claim`/`observe`/`notices`、`orchestrator_report` 的来源解析、worker 环境变量和提示词 | 单测：来源 PR 绑定、智能体分支绑定、其他工单的 PR 拒绝、合并/关闭结束工单、结束通知只发给非 Gitee 渠道；手工用 `gitee-cli pr create` 开 PR，报告 `pr_number`，合并后工单为 `merged`，关闭未合并为 `closed` |
| 5 `Deployment` 按来源存仓库（必须） | `Deployment` 按来源保存仓库：GitHub 可选、Gitee 单来源可启动、git 凭据按主机、执行环境变量按来源。不包含提示词交付（阶段 4）、通知、WebHook、CI | 只配 Gitee 的部署完成 setup、开 PR、合并的端到端演练；GitHub 既有测试全绿；Gitee 工单不再依赖 `DSH_SUPERAGENT_GITHUB_*` |
| 6 可选增强（不做也能工作） | 通知作为线索、WebHook 回调、CI/check-runs、`gitee/…` 原对象资源与内置 skill | 阶段 2–4 的轮询测试继续通过；通知去重与限流退避；没有公开地址时 WebHook 保持关闭；CI 关闭时没有 CI Trigger 与准入行 |

阶段 5 不做时，Gitee 只能作为 GitHub 部署的第二个来源，不能单独安装。阶段 6 不做时，轮询仍以仓库时间流加订阅线程为准，延迟上限是 `pollSeconds`；通知不启用时，未进入时间流或订阅线程的通知型事件不会被读取（例如没有更新 PR `updated_at` 的评论），这是已知覆盖缺口；WebHook 不接收，CI/check-runs 不产生 Trigger，也没有 CI 的准入行；`gitee/…` 资源和 skill 缺失只影响模型读原对象，不影响接收、回复和 PR 交付。

每个阶段都要同步更新 `docs/007-architecture.md` 的模块表和测试表；`tests/docs.spec.ts` 要求模块和测试文件都在表里。阶段 2 起在 `tests/gitee.spec.ts` 里使用真实临时 Store 和 `SourceRegistry`，按 `tests/sources.spec.ts` 的模式，只把 CLI 调用替换成 spy。

## 9. 已确认与待确认

阶段 1–3 的实现以本节为准。2026-11-04 用 `mail36z` 的 PAT 对真实 Gitee API（仓库 `mail36z/gitee-lab`）实测的结论列在 9.1，优先于前文的推测；前文与 9.1 冲突的地方按 9.1 执行。仍未核对的项列在 9.2 和 9.3，并写明当前实现的默认行为。

### 9.1 已确认（2026-11-04 实测）

除第 12 条外，来源均为 `mail36z` 的 PAT 对 `mail36z/gitee-lab` 的真实 v5 API 请求。

| # | 已确认的事实 | 对实现的影响 |
| --- | --- | --- |
| 1 | Issue 编号是字符串，真实值是 `IKSRCD` 这种，不是整数 | Thread 写成 `gitee:issue:<number>`；不 `Number()`、不按编号排序 |
| 2 | 创建 Issue 是 owner 级端点 `POST /repos/{owner}/issues`，仓库名放在 formData 的 `repo` 字段；`POST /repos/{owner}/{repo}/issues` 返回 `404 {"message":"project or enterprise"}` | 读取仍用 `GET /repos/{owner}/{repo}/issues`；本阶段不创建 Issue |
| 3 | 仓库级 `GET /repos/{owner}/{repo}/issues/comments` 的每条评论带 `target.issue.number`；`target.pull_request` 非空表示属于 PR | 不需要“逐 Issue 读评论”的兜底；PR 评论不挂到 Issue 线程 |
| 4 | Issue 评论对象没有 `in_reply_to_id`，字段是 `body`、`created_at`、`id`、`source`、`target`、`updated_at`、`user` | Gitee 只有顶层评论，不发线程内回复 |
| 5 | PR 评论 `GET/POST /repos/{owner}/{repo}/pulls/{number}/comments` 没有 `since`，有 `comment_type`、`direction` 和分页 | 逐 PR 读评论，用每 PR 的 `updated_at` 游标过滤 |
| 6 | `GET /notifications/threads` 返回 `{"total_count":0,"list":[]}`，支持 `unread`、`participating`、`type`、`since`、`before`、`ids` 和分页 | 阶段 6 才使用通知；阶段 1–3 不读 |
| 7 | `GET /repos/{owner}/{repo}/collaborators/{username}/permission` 返回**用户对象 + `permission` 字符串**（实测 `write`，仓库属主为 `admin`），不是 `{"permission":{...}}` | setup 读取这个字符串；`write`/`admin` 视为可写，其余视为只读 |
| 8 | `gitee api` 没有 `--include`（实测 `unknown flag`）；flag 只有 `--body`、`-f`、`-H`、`-X`、`--page`、`--limit`、`--search`、`--hostname`、`-p` | 来源不读限流/分页响应头；每轮最多 10 页，连续失败达到阈值才报错 |
| 9 | 官方 CLI 的配置隔离只认 `HOME`，`XDG_CONFIG_HOME` 无效；包装脚本 `/home/zoe/.local/bin/gitee-cli`（内部 `HOME=<agent home>` + 代理）已存在 | 来源配置的 `cli` 填这个包装脚本路径；token 不进入 settings、argv 或日志 |
| 10 | 新建 Gitee 仓库的默认分支是 `master`，不是 `main` | 任何地方都从仓库对象读 `default_branch`，不假设分支名 |
| 11 | 评论 body 里的 HTML 注释标记 `<!-- dsh-superagent:… -->` 在 API 返回值中原样保留；页面是否隐藏待人工确认 | 幂等标记先按 HTML 注释实现；网页若显示，改成仍可搜索的不可见标记 |
| 12 | 官方 CLI v0.3.3 的 `auth status --json` 返回 `{"host","name","status","user"}`（没有数字 id）；`GET /user` 可取 `id`；HTTP 错误写 stderr `HTTP 404: {"message":"…"}`，退出码 1 | setup 从 `auth status` 取登录名，状态没给 id 时从 `/user` 取 id；CLI 错误保留 HTTP 状态码，`gone` 与重试据此区分 |

### 9.2 仍需确认（不阻塞阶段 1–3）

| 问题 | 需要的信息 | 当前默认行为 |
| --- | --- | --- |
| PAT 的 scope 名称 | Gitee 个人令牌页面的 scope 列表；至少确认 `projects`、`issues`、`pull_requests`，以及评论所需的 scope（是否为 `notes`） | setup 只验证仓库可读和可写；文档写明所需权限，不按 scope 名称判定 |
| 403 中 locked、无权限和限流的区分；删除对象返回 404 还是 410 | 已删除/锁定 Issue/PR 的真实响应，以及 429 的形态 | 404/410 和 403+locked 视为 `gone`；其他 403、429、5xx 与网络错误抛出重试 |
| PR 评论的 `comment_type` 筛选与排序 | 不传 `comment_type` 时是否同时返回 `pr_comment` 和 `diff_comment`；`direction` 按创建还是更新时间排序；发评论是否更新 PR 的 `updated_at` | 先不传；若只返回一种，按两种类型分别读；按 `updated_at` 过滤，阶段 6 用通知补漏 |
| 私有部署的 Issue 评论 `target`、`state=all` | 私有 Gitee 是否同样返回 `target.issue.number`，`/pulls` 是否接受 `state=all` 并返回 merged | 缺失 `target` 时该条评论跳过；`state=all` 不接受时分别读 `open` 和 `closed`，合并以 `merged_at` 为准 |
| PR 评论能否在线程内回复 | 用 `POST /pulls/{n}/comments` 试 `in_reply_to_id`、`commit_id`、`path`、`position` 的组合，看网页效果 | 只发顶层 PR 评论；行内评论降级为 PR 顶层评论 |
| 代码行评论的 `new_line` | `new_line` 的格式和可靠性；没有它时哪些字段可还原行号 | 有 `new_line` 就用；没有就只给 `path`，不给 `line` |

### 9.3 留到阶段 4 以后

| 问题 | 需要的信息 | 当前默认行为 |
| --- | --- | --- |
| Gitee 的机器人标记 | `GET /user` 的 `type`/`bot_info`、Gitee Go 等自动账号的登录名规则 | 全部按人处理；策略的 `bots` 名单保留但暂不生效，不要把自动化账号加入 `allowed` |
| 提交邮箱 | Gitee 账号是否有 noreply/隐私邮箱，是否允许 API 读取 | 不声明 `DSH_SUPERAGENT_GITEE_COMMIT_EMAIL`，由提示词或工单指定作者 |
| PR 详情与列表的字段一致性 | `GET /pulls/{n}` 是否与列表一样给出 `merged_at`、`state`、`head`、`base` | 阶段 4 用详情读取 `orchestrator_report` 的 PR，轮询观察则直接用列表对象；详情缺字段时的列表回退尚未实现，需真实响应确认 |
| 通知的 `subject.type`/`subject.url` 取值 | 一条真实的 `/notifications/threads` 响应，看 `url` 指向 API 还是网页 | 阶段 6 前不读通知；阶段 6 只把通知当线索，不解析 URL 造 Trigger |
| Gitee 的限流/分页头 | 正常与超限响应里的 `X-RateLimit-*`、`Retry-After`、`Link` 头 | 不依赖条件请求；每轮最多 10 页；失败按 `failuresBeforeError` 报错 |
| check-runs 与 Gitee Go | Gitee Go 是否写 check-runs；默认分支的 CI 怎么读；是否有审查/测试状态 | 阶段 6 前不接 CI，不加 CI 的准入行 |
| 私有 Gitee 部署 | 私有主机是否同样提供 v5 API、通知、check-runs，PAT scope 是否一致 | 首版只验证 gitee.com；`hostname` 字段保留并在面板标注 |

### 9.4 阶段 4（PR 投递）的实现约定

- `SourceKind.pullRequest` 是可选的 PR 能力（`PullRequestKind`）：`number(thread)`、`read(commands, deployment, number, signal)`、`claim(ctx, ticketId, pr)`、`observe(ctx, pr)`、`notices(ticket, request, deployment)`。`SourceRegistry.pullRequests(source)` 是唯一的取用入口。
- `PullRequest` 是跨来源的归一化对象：`number`、`state`、`merged`、`mergedAt`、`closedAt`、`htmlUrl`、`head`、`author`、`repository`，以及 GitHub 才有的 `headRepository`、`headSha`、`autoMerge`。Gitee 的 `head` 按分支名读取（也容忍带 `ref` 的对象）。
- `orchestrator_report` 先用工单跟随的 PR 的来源，否则用触发工单的来源；Feishu 工单沿用本版部署的 GitHub 交付主机，Gitee 工单没有 PR 能力时返回明确错误，不回退到 GitHub。
- Gitee 的 `claim` 按「作者是智能体账号 + `repository` 是配置的仓库 + `head` 最后一段等于 `DSH_SUPERAGENT_NAME`」绑定；来源 PR 仍按 Trigger 的 `meta.kind`/`meta.target` 与 `meta.number` 匹配。`observe` 以 `merged_at` 判合并、`state === 'closed'` 且未合并判关闭；结束时调用 `threadClosed`。
- 轮询每轮观察 `/pulls` 返回的 PR，并逐个读取开放工单跟随的 PR；`notices` 复用 `pullEndNotices` 的文案与稳定 id，只发给非 Gitee 渠道。
- worker 提示词以 `DSH_SUPERAGENT_GITEE_REPOSITORY` 非空作为 Gitee 分支：`gitee-cli pr create` 开 PR、`gitee-cli pr view` 读状态，Gitee PR 由人合并，不假设 `gh`、GitHub 变量或 `refs/pull/<n>/head`。

## 10. 验收

本设计稿满足 [issue #2](https://github.com/my36z/dsh-superagent-prototype/issues/2) 的约束：只新增 `docs/009-gitee.md`，不改 `src/`、`scripts/`、`profile` 配置或依赖；按 008 的四件事展开；说明 Gitee 用 REST API v5 还是 CLI，并给出 CLI 契约；列出要动的代码位置；给出分阶段顺序与每阶段验证；列出与 GitHub 的差异；未确认项都写明需要什么信息，并按 9.1/9.2/9.3 标出优先级。实现阶段从第 8 节的阶段 1 开始，阶段 0 本身不产生代码。
