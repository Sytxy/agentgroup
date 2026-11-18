# AgentGroup 设计文档（暂名）

日期：2026-11-18
状态：待确认
类型：项目（完整设计）

---

## 1. 背景与目标

用户同时使用 Claude Code、Codex 等多个 AI 编程 CLI，目前需要在不同 App/终端之间切换、分别下达指令。希望有一个 **macOS 桌面应用**：

- 在一个"群"里添加多个 Agent（Claude Code、Codex、DeepSeek CLI 等）；
- 一条消息可以同时给多个 Agent 分派任务（例如：Claude 写前端、Codex 写后端、DeepSeek 写测试）；
- 多个 Agent **并行修改同一个代码仓库**，互不覆盖；
- 任务进度、结果、冲突、合并情况实时回到群里；
- 用户只在这个 App 里操作，不切换其他终端。

### 1.1 成功标准

1. 新建工作区并绑定一个本地 git 仓库后，能在群里添加至少 3 个 Agent。
2. 一条消息 `@claude 做登录页 @codex 做登录接口 @deepseek 写登录测试` 能拆成 3 个并行任务。
3. 3 个 Agent 同时工作时，各自的代码修改互不覆盖；过程中群里能看到每个任务的实时状态。
4. 任务完成后代码能合入集成分支；冲突会以任务卡片形式回到群里。
5. 测试 Agent 能针对**合并后的最新代码**运行测试，结果回到群里。
6. 关闭 App 再打开，历史消息、任务和未完成的工作不丢失（运行中的任务标记为已中断）。

### 1.2 失败定义（即使功能跑通也算失败）

- 需要用户逐个终端手动喂指令、手动复制粘贴结果；
- Agent 之间静默覆盖代码，或用户无法知道谁改了什么；
- 群消息刷屏到无法阅读，或关键信息（失败、冲突）被淹没；
- 为个人工具引入多用户、登录、云服务等不必要复杂度。

---

## 2. 非目标（v1 明确不做）

- 多用户、账号体系、权限管理、云端同步、计费；
- 云端沙箱（所有 Agent 在用户本机运行）；
- Web/移动端；
- 通用聊天机器人能力（本应用只服务于"集体开发一个仓库"）；
- 任务依赖 DAG（A 完成后再自动触发 B）——v1 只保留"合并后自动跑测试"这一种固定触发；
- 一个工作区绑定多个仓库（v1 一个工作区 = 一个仓库，仓库本身可以是 monorepo）；
- 多群/多频道（v1 一个工作区一个群）；
- 自动把 `agentgroup/integration` 合回你的 main/dev，或自动创建 PR（v1 只合到 integration，见 7.5）；
- integration 自动跟随你的主线分支更新（v1 创建时从当前 HEAD 固定）。

---

## 3. 约束

- 平台：macOS（Darwin），个人使用，本地运行。
- 本机已安装 `claude`、`codex` CLI；DeepSeek 由用户自行安装任意 CLI，本应用不内置 DeepSeek API 直连。
- 技术栈：TypeScript + Electron + React；终端进程管理用 `node-pty`；git 操作用 `simple-git` 或直接调用 `git`；本地存储用 SQLite（`better-sqlite3`）。
- 应用产出一个本机可运行的 `.app`（electron-builder 打包 dmg，个人使用可不签名/不公证，首次右键打开）。

---

## 4. 方案对比（已选定）

| 方案 | 说明 | 结论 |
|------|------|------|
| **A. TypeScript + Electron + React** | 打包为标准 macOS `.app`；`node-pty` 与 VS Code 同源，控制 CLI 最成熟；编排、UI、API 调用同一语言；复用用户现有 TS 经验 | **采用** |
| B. Swift + SwiftUI | 最原生、包最小，但 PTY、流式解析、git worktree、消息路由全部从头写，开发周期数倍 | 不采用 |
| C. Tauri（Rust + Web UI） | 包小，但进程编排要在 Rust 侧实现，迭代成本高于 A，收益不明显 | 不采用 |

**Agent 接入方式**：v1 只支持**命令行 Agent**。Agent 注册时填写启动命令与参数模板，内置 Claude Code、Codex 两个预设；其他任何 CLI（包括用户将来安装的 DeepSeek CLI）通过"自定义 Agent"接入。不在 v1 内实现 API 直连的 Agent 循环。

---

## 5. 总体架构

```
┌──────────────────────────── Electron ────────────────────────────┐
│  Renderer (React)                                                │
│    群聊界面 / Agent 成员列表 / 任务卡片 / 设置                     │
│         ▲  typed IPC（contextBridge）                             │
│  Main process                                                    │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐  │
│  │ Chat/Router  │→ │ Task Manager  │→ │ Agent Runner          │  │
│  │ 消息解析/分派 │  │ 状态机/队列   │  │ adapter: claude/codex │  │
│  └──────────────┘  └───────┬───────┘  │ /custom（node-pty）   │  │
│                            │          └───────────┬───────────┘  │
│  ┌──────────────┐  ┌───────▼───────┐              │              │
│  │ SQLite       │  │ Git/Worktree  │←─────────────┘              │
│  │ 消息/任务/配置│  │ 分支/合并/冲突 │                             │
│  └──────────────┘  └───────────────┘                             │
└──────────────────────────────────────────────────────────────────┘
        │ 每个任务一个 git worktree（App Support 目录下）
        ▼
   用户指定的本地 git 仓库（integration 分支 + agent/* 任务分支）
```

单进程架构即可：所有编排在 Electron main process 内完成，renderer 只做展示与输入，通过 IPC 通信。群消息、任务状态、进度事件都由 main 进程内的 EventBus 广播给 renderer。

---

## 6. 核心概念与数据模型

### 6.1 概念

- **Workspace（工作区）**：一个本地 git 仓库 + 一个群 + 一组 Agent + 设置。仓库路径在创建时选择并校验是 git 仓库。
- **Agent**：持久化的成员配置。字段：名称、预设类型（claude / codex / custom）、启动命令与参数模板、角色说明（role prompt）、可修改路径范围（可选）、权限配置、启用状态。
- **Task（任务）**：一次 Agent 执行单元，对应一个分支和一个 worktree。状态机见 6.3。
- **Message（消息）**：群聊消息，类型包括：用户消息、Agent 回复、系统事件（任务进度/结果/冲突）、任务卡片。
- **Integration 分支**：集成分支（默认名 `agentgroup/integration`），从仓库当前 HEAD 创建；任务完成后合入此分支，测试 Agent 以此分支为基准。

### 6.2 数据表（SQLite）

- `workspaces(id, name, repo_path, integration_branch, target_branch, setup_command, setup_copy_json, setup_timeout_min, auto_merge, auto_test_after_merge, test_agent_id, last_verification, created_at)`
- `agents(id, workspace_id, name, preset, command, args_template, role_prompt, path_scope_json, permission_profile, can_delegate, enabled)`
- `tasks(id, workspace_id, agent_id, parent_task_id, task_type, title, prompt, branch, worktree_path, base_ref, status, exit_code, summary, created_at, started_at, finished_at)`
- `messages(id, workspace_id, kind, author_type, author_id, content, task_id, created_at)`

`task_type`：`code` / `test` / `resolve`；`base_ref` 记录 worktree 创建时所用的 integration 提交。
- 任务完整日志写文件：`<App Support>/AgentGroup/logs/<taskId>.log`，数据库只存摘要与路径。

### 6.3 任务状态机

```
queued → preparing → running → done → merging → merged
              ↘ failed              ↘ conflict（冲突卡片）
              ↘ cancelled           ↘ awaiting_approval（越界确认卡片）
App 重启时：preparing/running/merging → interrupted（可重试）
```

- `preparing`：worktree 已创建，正在执行环境准备（见 7.4）；不计入 Agent 超时。
- `awaiting_approval`：改动越出路径范围，等待你在合并确认卡片上决定。
- 放弃的任务标记 `abandoned`（冲突卡片的"放弃"动作）。

- `done`：Agent 进程正常退出且 worktree 内有可提交改动（或无改动但正常完成）。
- `failed`：进程非零退出、启动失败、超时。
- `merged` / `conflict`：合并结果。
- 状态变化都作为系统消息回到群里。

---

## 7. 关键机制

### 7.1 群内添加 Agent

- 右侧成员栏"＋添加 Agent"：选择预设（Claude Code / Codex / 自定义），填写名称、角色说明、启动命令。
- 内置预设的默认命令（具体参数由适配器封装）：
  - Claude Code：`claude -p <prompt> --output-format stream-json --verbose`，权限参数按下方"权限档位"注入。
  - Codex：`codex exec --json <prompt>`，按权限档位注入 sandbox 参数。
- **权限档位**（每个 Agent 单独选择，通过 CLI 参数生效，不只靠 prompt 约束）：
  - `只读`：只能读代码和输出结论，不能改文件、不能执行命令（Claude 用 plan 模式，Codex 用 read-only sandbox）。
  - `仅编辑`：可修改 worktree 内文件，不能执行命令（Claude 用 acceptEdits，Codex 只允许写文件）。
  - `可编辑并运行命令`（编码 / 测试 Agent 的默认档）：可修改文件并执行命令（构建、测试、安装依赖）。Claude 通过允许 Bash 工具实现，Codex 使用 workspace-write sandbox。命令只在任务 worktree 内以你的 macOS 账户权限运行，Agent 设置页会给出明确警示。
- 自定义 Agent：用户填写命令与参数模板，`{prompt}` 占位符由应用替换；应用在任务 worktree 目录下执行。
- Agent 可停用/删除；删除不影响历史任务记录。

### 7.2 一条消息分派多个任务

- 输入框支持 `@AgentName` 提及（自动补全）。
- 解析规则：
  1. 消息中每个 `@Agent` 到下一个 `@Agent` 之间的文本，是该 Agent 的独立任务说明；
  2. 第一个 `@Agent` 之前的文本作为**共享背景**，附加到每个任务说明前；
  3. 同一个 Agent 在一句话里被提及多次，合并为一个任务；
  4. 没有任何 `@` 的消息只作为群聊消息展示，不创建任务（v1 不猜测分配）。
- 发送后：为每个提及创建一条 `tasks` 记录（queued），群里立即出现对应任务卡片；随后按 Agent 并行启动。
- 分派结果以系统消息回群：`已分派 3 个任务：claude / codex / deepseek`。

### 7.3 任务执行与进度回群

- **Agent Runner** 统一接口：

```ts
interface AgentAdapter {
  start(input: { prompt: string; cwd: string; signal: AbortSignal }):
    AsyncIterable<AgentEvent>;
}
type AgentEvent =
  | { type: 'log'; text: string }        // 原始输出行，写入日志文件
  | { type: 'progress'; text: string }   // 可读进度（如"正在执行 Bash: pnpm test"）
  | { type: 'final'; summary: string };  // 最终摘要
```

- 实现：
  - `ClaudeAdapter`：解析 `stream-json` 事件，把工具调用转成 progress，把最终 assistant 文本作为 final。
  - `CodexAdapter`：解析 `codex exec --json` 输出，规则同上。
  - `GenericCliAdapter`：用 PTY 运行任意命令；每 2 秒取最后一行作为 progress；退出码判成败；输出尾部作为摘要。
- 进度回群策略（防刷屏）：任务卡片内实时滚动显示最近 N 行（默认 5 行），完整日志点击展开；群里只发**状态级**系统消息（开始、关键进度节流为每分钟最多一条、完成/失败/冲突）。
- 完成消息内容：状态、分支名、改动文件数与 `git diff --stat`、Agent 输出的最终摘要（截断）、操作按钮（查看 diff / 重试 / 取消）。
- 取消：终止整个进程组（SIGTERM，5 秒后 SIGKILL），worktree 与分支保留，状态 cancelled。
- 超时：可配置（默认 60 分钟），超时按 failed 处理并回群提示。

### 7.4 Worktree 与并行隔离

- 每个任务在**真正启动时**（消息发送只入队）：
  1. 从当前 `integration` 分支最新提交创建分支 `agent/<taskId>-<slug>`；
  2. worktree 路径：`~/Library/Application Support/AgentGroup/worktrees/<workspaceId>/<taskId>`（放在仓库外，避免被项目工具扫描/误提交）；
  3. Agent 进程的 cwd 设为该 worktree。
- **运行环境准备**（解决 worktree 没有 `node_modules`、`.env` 等未提交文件的问题）：
  - 工作区设置 `setup_command`（如 `pnpm install`）和 `setup_copy`（如 `.env`、本地配置，相对仓库根路径）；
  - worktree 创建后，先在 worktree 内执行 setup 命令、复制指定文件，再启动 Agent；任务状态为此增加 `preparing`；
  - setup 失败 → 任务 failed，回群展示 stderr 摘要；setup 时间不计入 Agent 60 分钟超时；
  - v1 每个任务独立执行 setup（简单、可靠），依赖缓存/共享留到后续版本。
- 因此多个 Agent 不会共享工作区、不会抢 `git index.lock`、不会把别人的未提交改动带进自己的提交。
- 同一 Agent 的多个任务也各自一个 worktree，天然隔离。
- 任务结束后提交（`git add -A && git commit`），随后进入合并流程；合并成功后删除 worktree，保留分支一段时间（可配置）。

### 7.5 合并策略与冲突

- 合并串行执行（全局合入队列，一次只合一个），避免同时操作 integration 分支。
- 合并方式：`git merge --no-ff <agent 分支>`；成功则任务 → merged，并更新 integration 分支。
- **合并前检查**改动路径是否超出该 Agent 的 `path_scope`：
  - 无冲突且在范围内 → 自动合并（默认策略）；
  - 有冲突 → 任务 → conflict，回群冲突卡片；
  - 无冲突但有越界文件 → 任务 → awaiting_approval，回群"合并确认"卡片，列出越界文件与 diff 统计，按钮：继续合并 / 指派修改 / 放弃。**未确认前不会合并。**
- 工作区可切换为"需我确认后合并"：所有任务完成后先出确认卡片，再合并。
- **冲突卡片的三个动作**：
  1. **指派 Agent 解决**：保留冲突任务的 worktree，创建 `resolve` 类型任务，在同一个 worktree 中让指定 Agent 执行"把 integration 合入当前分支并解决冲突"；提交后重新进入合并队列。
  2. **手动解决**：提供"在 Finder / 默认编辑器中打开 worktree"按钮；你在 worktree 内解决并提交后，点"重新合并"，应用检查索引无未解决冲突后继续。App 内不内置代码编辑器。
  3. **放弃**：删除 worktree，任务标记 abandoned；分支默认保留，可在设置中改为自动删除。
- **integration 的最终去向（已确定）**：App 只负责把任务合入 `agentgroup/integration`，**不自动合回你的 main/dev，也不创建 PR**。App 内展示集成分支名、与目标分支的差异统计，并提供可复制的命令（如 `git merge agentgroup/integration`），由你自行在终端完成最终合入。integration 在工作区创建时从仓库当前 HEAD 建立，v1 不自动跟随你的主线更新。

### 7.6 共享文件与路径所有权

- 每个 Agent 可配置 `path_scope`（如 `web/**`、`server/**`、`tests/**`）。作用：
  1. 写进该 Agent 的任务 prompt（"你只应修改这些路径"）；
  2. 合并前用 `git diff --name-only` 校验，越界时回群告警，由用户决定是否继续。
- 共享文件（根目录 `package.json`、lockfile、`tsconfig`、`docker-compose`、CI 配置、API 契约/共享类型）建议不写入任何 Agent 的 scope；需要修改时由用户在群里发起，或显式指派给某一个 Agent。
- 不在 v1 做硬性文件锁；越界改动会暂停合并等待你确认（见 7.5），并发写同一文件由 worktree + 合并冲突机制兜底。

### 7.7 测试任务与验证

- 所有任务的 worktree 都在**任务真正启动时**基于当时的 integration 最新提交创建（消息发送只入队，见 7.4），不存在"排队期间基于过期代码"的问题；运行期间 integration 若继续前进，合并时按正常冲突流程处理。
- `task_type` 区分 `code` / `test` / `resolve`。
- 工作区设置项"每次代码任务成功合并后自动创建测试任务"（默认关闭）：选择固定的测试 Agent 和任务模板（如"运行全部测试并汇总失败用例"）。自动测试任务完成或合并时**不会再次触发**自动测试，避免连锁。
- 测试失败（v1）：不回滚 integration、不阻断后续合并；群里发失败卡片并记录"最近一次验证失败"（顶部状态显示），是否回滚由你在终端决定。后续版本再考虑"测试闸门"。
- 测试 Agent 默认使用"可编辑并运行命令"权限（否则无法跑测试），路径范围默认 `tests/**`；其改动同样走分支与合并流程。

### 7.8 Agent 之间接力（可选能力）

- Agent 的输出中如果出现 `@其他Agent`，且该 Agent 被标记为"允许委派"，则编排器为对方创建一个后续任务（任务卡片的来源标记为"由 claude 委派"）。
- 防循环：最大链深 3；禁止自己委派自己；检测 A→B→A 的直接循环。
- 用户可在设置中全局关闭委派。

### 7.9 UI 结构

```
┌──────────────┬────────────────────────────────────────┬────────────────┐
│ 工作区/群     │ 群聊                                    │ Agent 成员      │
│ ● 商城项目    │ 你: @claude 登录页 @codex 登录接口      │ ● claude 空闲   │
│               │     @deepseek 登录测试                  │ ● codex 运行中  │
│               │ ┌ claude · 登录页 ───────────────────┐  │ ○ deepseek 空闲 │
│               │ │ 运行中 2m · 最近: 编辑 Login.tsx    │  │ + 添加 Agent    │
│               │ │ [展开日志] [取消]                   │  │                │
│               │ └─────────────────────────────────────┘  │                │
│               │ 系统: 3 个任务已分派                     │                │
│               │ @codex 已提交 5 files (+120 −30)        │                │
│               │ @deepseek 测试通过 42/42                │                │
│               │ [输入框，@ 提及 Agent]                   │                │
└──────────────┴────────────────────────────────────────┴────────────────┘
```

- 左侧：工作区列表（v1 通常一个）。
- 中间：群聊时间线（用户消息 / Agent 消息 / 系统事件 / 任务卡片）。
- 右侧：Agent 成员与状态。
- 顶部：仓库路径、integration 分支、合并策略开关。
- 系统通知：任务完成/失败/冲突时发 macOS 通知（可关闭）。

### 7.10 错误处理与恢复

- Agent 启动失败（命令不存在、权限不足）：任务 failed，回群展示 stderr 摘要。
- 非交互 CLI 因权限提示卡住：超时机制兜底；Agent 配置提供权限说明与"完全放行"开关（显式警示）。
- 合并冲突：见 7.5。
- App 崩溃/重启：启动时把 running/merging 任务标记 interrupted，worktree 与分支保留，任务卡片提供"重试/放弃/检查现场"。
- 磁盘/权限问题（worktree 创建失败）：任务 failed，提示原因。

### 7.11 安全与密钥

- 纯本地应用，不监听外部网络端口（Electron 渲染进程加载本地文件/本地资源）。
- 用户 API Key 若需要（自定义 CLI 的环境变量）存放在 Electron `safeStorage`（macOS Keychain 加密）；Agent 的 CLI 自身登录态由其自己管理。
- 所有执行的命令均为用户显式配置的 Agent CLI；应用不拼接用户输入进 shell 字符串（prompt 通过参数/标准输入传递，避免命令注入）。

---

## 8. v1 范围与后续

**v1 必做**：工作区绑定仓库、添加/删除 Agent（claude/codex/自定义，含权限档位）、@ 多任务分派、worktree 并行、运行环境准备（setup 命令 / 文件复制）、任务卡片与进度、自动合并与冲突卡片、越界合并确认、测试任务基于 integration、SQLite 持久化、崩溃恢复、macOS 通知、dmg 打包。

**后续（不在本次）**：API 直连 Agent、任务依赖编排、多仓库工作区、多群、Agent 间自由对话、代码 diff 内嵌审阅、模板任务、用量统计。

---

## 9. 验证方式（项目自身的）

- 单元测试：@ 解析与任务拆分（含共享背景、重复提及、无提及）、状态机流转、worktree/分支命名与清理、合并队列串行性。
- 集成测试：用假的 Agent CLI（一个输出固定 stream 的脚本）跑通"分派 → 并行 → 提交 → 合并 → 回群"全流程；用两个假 Agent 故意改同一文件验证冲突卡片；验证 setup 失败、越界合并确认、冲突解决后重新合并。
- 手动验证：绑定一个真实小仓库，用 claude + codex 各做一个独立小任务，确认并行无覆盖、群消息正确；DeepSeek CLI 由用户安装后接入验证。
- 打包验证：`electron-builder` 产出 dmg，安装后首次启动可用。

---

## 10. 我替你做的决定（请检查）

1. **Agent 只走 CLI**：v1 不做 API 直连；DeepSeek 由你安装 CLI 后以"自定义 Agent"接入。
2. **一个工作区一个群**，v1 不做多群。
3. **integration 是终点**（你已确认）：App 不合回 main/dev、不建 PR，只提供命令供你在终端合入。
4. **任务完成默认自动合入 integration**；改动越出路径范围或有冲突时暂停，等你确认。
5. **worktree 放在 App Support 目录**，任务启动时才创建（发送消息只入队），不在仓库内建目录。
6. **运行环境准备**：工作区级 `setup_command` + `setup_copy`，每个 worktree 执行一次；失败即任务失败。
7. **权限分三档**，编码/测试 Agent 默认"可编辑并运行命令"（否则无法构建和跑测试），设置页明确警示。
8. **路径所有权为提示 + 合并前检查**：越界时暂停合并等你确认，不做硬性文件锁。
9. **无 @ 的消息不自动分派**，只作为群聊显示（避免猜错任务）。
10. **Agent 间委派默认开启但限制链深 3**，可在设置关闭。
11. **测试失败不回滚 integration**，只记录"最近一次验证失败"并提示；自动测试不会连锁触发。
12. **不做任务依赖 DAG**，v1 只有"合并后自动测试"这一种固定触发。
13. **日志完整落盘、群里节流**，避免刷屏。
14. 应用暂定名 **AgentGroup**，目录 `work/project/ai-agent-group`，可随时改名。

---

## 11. 审阅问题处理记录

builder 审阅提出的 7 个问题已全部处理：

| 问题 | 结论 |
|------|------|
| 集成分支最终去向 | 你已确认：v1 只到 integration，App 不合回主线、不建 PR（7.5） |
| worktree 运行环境 | 工作区级 setup 命令 + 文件复制，任务增加 `preparing` 状态（7.4） |
| 冲突卡片动作 | 三种动作的 git 流程已定义（7.5） |
| 默认权限 / 测试如何跑 | 三档权限，编码/测试默认"可编辑并运行命令"（7.1） |
| 测试失败后 integration 怎么办 | v1 不回滚、不阻断，仅记录并提示（7.7） |
| 任务基于哪个提交 | 任务启动时基于当时 integration 最新提交，不自动 rebase（7.4 / 7.7） |
| 越界与自动合并冲突 | 越界时暂停合并，等你确认（7.5） |
