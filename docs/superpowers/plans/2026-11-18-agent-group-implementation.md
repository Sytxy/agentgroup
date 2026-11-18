# AgentGroup 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 macOS 桌面应用：在一个群聊里添加多个 AI 编程 CLI（Claude Code、Codex、自定义 Agent），一条消息分派多个任务，各任务在独立 git worktree 中并行开发同一个仓库，进度与结果实时回群。

**Architecture:** Electron 应用。所有编排逻辑放在 main 进程的纯 Node 服务层（可脱离 Electron 在 Vitest 中测试），renderer 只负责展示，通过类型化 IPC 通信。每个任务从 `agentgroup/integration` 创建独立分支与 worktree；完成后串行合入 integration；冲突和越界改动以任务卡片回到群里。

**Tech Stack:** TypeScript（strict）、Electron（最新稳定版）、React 19、electron-vite、sql.js（SQLite WASM）、node-pty（仅自定义 Agent 需要 TTY 时使用，默认用 child_process）、picomatch、Vitest、@testing-library/react、electron-builder、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-18-agent-group-design.md`

## Global Constraints

- 仅支持 macOS 13+；纯本地应用，不监听外部端口，不上传任何数据。
- Node 22、pnpm；TypeScript `strict: true`；UI 文案中文，代码标识符英文。
- `src/main/services/**`、`src/main/db/**`、`src/shared/**` 禁止 import `electron`，保证可在 Node + Vitest 中直接测试；Electron 相关代码只出现在 `src/main/index.ts`、`src/main/ipc-handlers.ts`、`src/main/notifications.ts`、`src/preload/**`。
- 数据库使用 sql.js（SQLite WASM），文件位于 `app.getPath('userData')/agentgroup.db`；每次写操作后立即落盘。
- 所有 worktree 位于 `app.getPath('userData')/worktrees/<workspaceId>/<taskId>`，绝不放进用户仓库目录。
- 任务分支命名 `agent/<taskId>-<slug>`；集成分支固定 `agentgroup/integration`；App 不触碰用户的当前分支、工作区和远程仓库。
- Agent prompt 只通过 argv/stdin 传递，禁止拼接进 shell；唯一通过 `/bin/sh -c` 执行的是用户在设置里显式填写的 `setup_command`。
- v1 只支持 CLI Agent，不做 API 直连；无 @ 的消息不分派任务。
- 同一个 Agent 同时最多运行一个任务；默认任务超时 60 分钟，setup 超时 10 分钟。
- 关键业务逻辑（git 生命周期、合并、状态流转、冲突处理）写中文注释，说明为什么这样做和边界条件。
- 每个任务结束时提交一次，commit message 使用 `feat:` / `test:` / `chore:` 前缀。

## Review Focus

1. **CLI 输出格式漂移**：新版 `claude` / `codex` 可能输出未知事件或非 JSON 行。解析器必须忽略未知内容并继续，不能抛异常导致任务失败。由 Task 9、10 的解析测试覆盖。
2. **合并冲突后队列卡死**：冲突必须 `git merge --abort` 恢复 integration worktree 干净状态，队列继续处理后续任务。由 Task 5、12 覆盖。
3. **App 重启重复派发或永久卡住**：启动时把 `preparing/running/merging` 标为 `interrupted`，调度器不得自动重跑。由 Task 13 覆盖。
4. **setup 失败留下半成品 worktree**：失败任务要保留现场但可重试，重试必须从干净分支/worktree 重新开始。由 Task 11、13 覆盖。
5. **@ 提及解析边界**：未知名字、同名、中文名、重复提及、代码块中的 @。解析必须按已知 Agent 名单匹配并去重。由 Task 6 覆盖。

---

### Task 1: 项目脚手架与测试基线

**Files:**
- Create: `package.json`、`pnpm-lock.yaml`（生成）、`electron.vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`vitest.config.ts`、`.gitignore`、`electron-builder.yml`
- Create: `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html`、`src/renderer/src/main.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`、`src/shared/constants.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `APP_NAME = 'AgentGroup'`（`src/shared/constants.ts`）；可用的 `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck`；Electron 主窗口骨架与 preload 桥。

- [ ] **Step 1: 写 `package.json` 与构建配置**

dependencies：`react`、`react-dom`、`better-sqlite3` 不使用；使用 `sql.js`、`picomatch`、`node-pty`。devDependencies：`electron`、`electron-vite`、`vite`、`@vitejs/plugin-react`、`typescript`、`vitest`、`jsdom`、`@testing-library/react`、`@testing-library/jest-dom`、`electron-builder`、`@types/node`、`@types/react`、`@types/react-dom`、`@types/sql.js`、`@types/picomatch`。scripts：`dev: electron-vite dev`、`build: electron-vite build`、`test: vitest run`、`typecheck: tsc --noEmit -p tsconfig.json`、`build:mac: electron-vite build && electron-builder --mac dmg`、`postinstall: electron-builder install-app-deps`。

- [ ] **Step 2: 写 electron-vite / TS / Vitest 配置**

`electron.vite.config.ts` 配置 main、preload、renderer（React 插件）。`tsconfig.json` 引用 node/web 两个子配置，`strict: true`、`noUncheckedIndexedAccess: true`。`vitest.config.ts`：默认 environment `node`，`include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']`，`environmentMatchGlobs: [['tests/renderer/**', 'jsdom']]`，setupFiles 引入 jest-dom。

- [ ] **Step 3: 最小可运行窗口**

`src/main/index.ts` 创建 1200×800 窗口，加载 renderer；`src/preload/index.ts` 通过 `contextBridge` 暴露空的 `api` 占位对象；`App.tsx` 渲染标题「AgentGroup」。`constants.ts` 导出 `APP_NAME`。

- [ ] **Step 4: 写冒烟测试并确认失败**

```ts
// tests/smoke.test.ts
import { expect, test } from 'vitest'
import { APP_NAME } from '../src/shared/constants'
test('app name', () => { expect(APP_NAME).toBe('AgentGroup') })
```

- [ ] **Step 5: 安装、测试、类型检查、构建**

Run: `pnpm install && pnpm test && pnpm typecheck && pnpm build`
Expected: 全部通过；`pnpm dev` 手动打开窗口可见标题（记录实际结果，不要假设）。

- [ ] **Step 6: 初始化仓库并提交**

Run: `git init && git add -A && git commit -m "chore: scaffold electron app with test baseline"`

---

### Task 2: 共享类型、SQLite 与仓储层

**Files:**
- Create: `src/shared/types.ts`、`src/shared/ipc.ts`（仅类型与通道常量，Task 16 完善）
- Create: `src/main/db/database.ts`、`src/main/db/schema.ts`、`src/main/db/workspace-repo.ts`、`src/main/db/agent-repo.ts`、`src/main/db/task-repo.ts`、`src/main/db/message-repo.ts`
- Test: `tests/db/repositories.test.ts`、`tests/helpers/db.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - 类型 `Workspace`、`AgentConfig`、`Task`、`ChatMessage`、`AppEvent`、`TaskStatus`、`TaskType`、`PermissionProfile`
  - `openDatabase(filePath: string, wasmPath?: string): Promise<Db>`；`class Db { persist(): void; close(): void; raw: SqlJs.Database }`
  - `WorkspaceRepo` / `AgentRepo` / `TaskRepo` / `MessageRepo`，构造参数均为 `Db`，方法：`insert`、`get`、`list` / `listByWorkspace`、`update(id, patch)`

- [ ] **Step 1: 定义共享类型**

```ts
export type PermissionProfile = 'read-only' | 'edit-only' | 'edit-and-run'
export type TaskType = 'code' | 'test' | 'resolve'
export type TaskStatus =
  | 'queued' | 'preparing' | 'running' | 'done' | 'merging'
  | 'merged' | 'conflict' | 'awaiting_approval'
  | 'failed' | 'cancelled' | 'abandoned' | 'interrupted'
export type VerificationStatus = 'unknown' | 'passed' | 'failed'

export interface Workspace {
  id: string; name: string; repoPath: string
  integrationBranch: string; targetBranch: string | null
  setupCommand: string | null; setupCopy: string[]
  setupTimeoutMin: number; taskTimeoutMin: number
  autoMerge: boolean; autoTestAfterMerge: boolean
  testAgentId: string | null; testTaskTemplate: string
  lastVerification: VerificationStatus; createdAt: string
}
export interface AgentConfig {
  id: string; workspaceId: string; name: string
  preset: 'claude' | 'codex' | 'custom'
  command: string; argsTemplate: string | null
  rolePrompt: string; pathScope: string[]
  permissionProfile: PermissionProfile
  canDelegate: boolean; enabled: boolean
}
export interface Task {
  id: string; workspaceId: string; agentId: string
  parentTaskId: string | null; taskType: TaskType
  title: string; prompt: string
  branch: string | null; worktreePath: string | null; baseRef: string | null
  status: TaskStatus; exitCode: number | null; summary: string | null
  createdAt: string; startedAt: string | null; finishedAt: string | null
}
export interface ChatMessage {
  id: string; workspaceId: string
  kind: 'user' | 'agent' | 'system' | 'task-card'
  authorType: 'user' | 'agent' | 'system'; authorId: string | null
  content: string; taskId: string | null; createdAt: string
}
export type AppEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'task-updated'; task: Task }
  | { type: 'task-progress'; taskId: string; lines: string[] }
  | { type: 'agent-status'; agentId: string; status: 'idle' | 'busy' }
```

- [ ] **Step 2: 写失败测试**

```ts
// tests/db/repositories.test.ts
test('workspace insert/get/list roundtrip', ...)
test('task update status and list newest first', ...)
test('messages list ascending by createdAt', ...)
test('reopening the database file preserves rows', ...)
```

断言：写入后读回的字段逐一相等（含 `setupCopy` 数组 JSON 往返、布尔值转 0/1）；`listByWorkspace` 按 `createdAt DESC`；messages 按 `createdAt ASC`。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test tests/db/repositories.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 db 与四个仓储**

`database.ts` 用 `initSqlJs` 加载 wasm，`openDatabase` 读取已有文件或新建；`schema.ts` 用 `CREATE TABLE IF NOT EXISTS` 建四张表（列与类型一一对应，JSON 列存 TEXT）；`Db.persist()` 导出并写文件。仓储负责 JSON 序列化/反序列化与布尔转换。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test tests/db/repositories.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add src tests && git commit -m "feat: add shared types and sqlite repositories"`

---

### Task 3: Git 服务与 worktree 生命周期

**Files:**
- Create: `src/main/services/git/git.ts`
- Test: `tests/git/git-service.test.ts`、`tests/helpers/temp-repo.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type RunGit = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>`
  - `class GitService`：`assertRepo(path): Promise<string>`（返回仓库根）、`head(repo): Promise<string>`、`branchExists(repo, branch)`、`createBranch(repo, branch, fromRef)`、`worktreeAdd(repo, worktreePath, newBranch, fromRef)`、`worktreeAddExisting(repo, worktreePath, branch)`、`worktreeRemove(repo, worktreePath)`、`commitAll(cwd, message): Promise<string | null>`、`changedFiles(cwd, baseRef): Promise<string[]>`、`diffStat(cwd, baseRef): Promise<{files:number;insertions:number;deletions:number}>`、`merge(cwd, branch): Promise<{status:'merged'} | {status:'conflict';conflicts:string[]}>`、`mergeAbort(cwd)`

- [ ] **Step 1: 写失败测试**

用 `createTempRepo()`（`git init`、配置 user.name/email、提交一个 `README.md`）覆盖：

```ts
test('assertRepo returns the repository root', ...)
test('worktreeAdd creates branch and directory', ...)
test('commitAll returns null when nothing changed', ...)
test('changedFiles and diffStat reflect committed changes', ...)
test('merge reports conflict files and mergeAbort leaves clean status', ...)
```

冲突测试：两个分支各改 `README.md` 同一行，`git merge` 后断言 `status === 'conflict'` 且 `conflicts` 包含 `README.md`；`mergeAbort` 后 `git status --porcelain` 为空。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/git/git-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `RunGit` 与 `GitService`**

默认 `RunGit` 用 `execFile('git', args, { cwd })`（不经过 shell）。`worktreeAdd` 执行 `git worktree add -b <newBranch> <path> <fromRef>`；`worktreeRemove` 加 `--force`；`merge` 执行 `git merge --no-ff <branch>`，失败时从 `git diff --name-only --diff-filter=U` 取冲突文件，不自动 abort（由调用方决定）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/git/git-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add git service and worktree operations"`

---

### Task 4: 工作区服务

**Files:**
- Create: `src/main/services/workspace-service.ts`
- Test: `tests/services/workspace-service.test.ts`
- Modify: `src/main/db/workspace-repo.ts`（如需 `update` 支持设置项）

**Interfaces:**
- Consumes: `GitService`（Task 3）、`WorkspaceRepo`（Task 2）
- Produces:
  - `const INTEGRATION_BRANCH = 'agentgroup/integration'`
  - `class WorkspaceService { constructor(deps: { repo: WorkspaceRepo; git: GitService; worktreesRoot: string }); create(input: { name: string; repoPath: string; targetBranch?: string | null }): Promise<Workspace>; list(): Workspace[]; integrationWorktreePath(workspaceId: string): string; diffStat(workspace: Workspace): Promise<{files:number;insertions:number;deletions:number}> }`

- [ ] **Step 1: 写失败测试**

```ts
test('create validates a git repo and creates integration branch + worktree', ...)
test('create rejects a non-git directory with a readable error', ...)
test('create reuses an existing integration branch', ...)
test('diffStat compares integration with target branch', ...)
```

断言：`branchExists(repo, INTEGRATION_BRANCH) === true`；`integrationWorktreePath(id)` 目录存在；返回的 `Workspace.repoPath` 是仓库根（`git rev-parse --show-toplevel` 结果）；非 git 目录 reject 且消息包含路径。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/workspace-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `WorkspaceService`**

`create`：解析仓库根 → 若 integration 分支不存在则从 `HEAD` 创建 → 在 `<worktreesRoot>/<id>/integration` 添加该分支的 worktree（已存在则跳过）→ 写入 Workspace 记录（默认 `autoMerge: true`、`autoTestAfterMerge: false`、`setupTimeoutMin: 10`、`taskTimeoutMin: 60`、`testTaskTemplate: '运行全部测试并汇总失败用例'`）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/workspace-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add workspace service with integration worktree"`

---

### Task 5: 串行队列与路径范围检查

**Files:**
- Create: `src/main/services/git/serial-queue.ts`、`src/main/services/git/path-scope.ts`
- Test: `tests/git/serial-queue.test.ts`、`tests/git/path-scope.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class SerialQueue { run<T>(job: () => Promise<T>): Promise<T> }`
  - `function outOfScopeFiles(files: string[], scope: string[]): string[]`（`scope` 为空表示全部允许；用 picomatch，`dot: true`）

- [ ] **Step 1: 写失败测试**

```ts
test('serial queue runs jobs one at a time in order', ...)
test('a rejected job does not block the next one', ...)
test('outOfScopeFiles returns files outside web/** and tests/**', ...)
test('empty scope allows every file', ...)
```

队列测试用两个手动 resolve 的 Promise，断言第二个 job 在第一个完成前未开始。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/git/serial-queue.test.ts tests/git/path-scope.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`SerialQueue` 用 Promise 链实现，捕获失败但继续；`outOfScopeFiles` 对每个文件判断是否匹配任一 pattern。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/git/serial-queue.test.ts tests/git/path-scope.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add serial merge queue and path scope check"`

---

### Task 6: 群消息 @ 提及解析

**Files:**
- Create: `src/main/services/chat/message-parser.ts`
- Test: `tests/services/message-parser.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `class MessageParser { constructor(agents: Array<{ id: string; name: string }>); parse(text: string): { sharedContext: string; assignments: Array<{ agentId: string; prompt: string }> } }`

- [ ] **Step 1: 写失败测试**

```ts
test('splits one message into three assignments', ...)
test('prepends shared context before the first mention to every prompt', ...)
test('merges repeated mentions of the same agent into one assignment', ...)
test('ignores unknown mentions and reports nothing when no known agent is mentioned', ...)
test('matches Chinese and case-insensitive agent names', ...)
```

示例输入：`'做登录功能 @claude 前端页面 @codex 后端接口 @deepseek 测试'` → 3 个 assignment，`sharedContext === '做登录功能'`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/message-parser.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现解析器**

按 Agent 名单构造 `@name` 匹配（名字按长度降序，大小写不敏感）；取第一个提及前为 `sharedContext`；每个提及到下一个提及之间为 prompt；重复 Agent 的 prompt 用 `\n\n` 连接；未知提及忽略。`prompt` 去首尾空白；空 prompt 的 assignment 丢弃。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/message-parser.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: parse group message mentions into task assignments"`

---

### Task 7: 消息分派服务

**Files:**
- Create: `src/main/services/chat/dispatcher.ts`、`src/main/events.ts`
- Test: `tests/services/dispatcher.test.ts`

**Interfaces:**
- Consumes: `MessageParser`（Task 6）、`AgentRepo` / `TaskRepo` / `MessageRepo`（Task 2）
- Produces:
  - `class EventBus { emit(e: AppEvent): void; on(fn: (e: AppEvent) => void): () => void }`
  - `class Dispatcher { constructor(deps: { agents: AgentRepo; tasks: TaskRepo; messages: MessageRepo; events: EventBus; enqueue: (taskId: string) => void; newId?: () => string; now?: () => Date }); send(workspaceId: string, text: string): Promise<{ message: ChatMessage; tasks: Task[] }> }`

- [ ] **Step 1: 写失败测试**

```ts
test('creates one queued task per mentioned agent and a system dispatch message', ...)
test('shared context is prepended to every task prompt', ...)
test('message without mentions creates no tasks', ...)
test('all-unknown mentions create a system warning and no tasks', ...)
test('task title is the first 40 characters of the prompt', ...)
```

断言：3 个 task 的 `status === 'queued'`、`taskType === 'code'`；`enqueue` 被调用 3 次；系统消息内容包含三个 Agent 名。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/dispatcher.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

保存用户消息 → 用当前工作区启用的 Agent 构造 `MessageParser` → 无 assignment 时只发系统提示（若存在未知 @）→ 有 assignment 时插入 tasks 与任务卡片消息、系统分派消息，逐个 `enqueue`。所有消息通过 `EventBus` 广播。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/dispatcher.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: dispatch mentions into queued tasks"`

---

### Task 8: 进程运行器、行解析与通用 CLI Adapter

**Files:**
- Create: `src/main/services/agents/adapter.ts`、`src/main/services/agents/process-runner.ts`、`src/main/services/agents/line-splitter.ts`、`src/main/services/agents/generic-cli-adapter.ts`
- Test: `tests/agents/line-splitter.test.ts`、`tests/agents/generic-cli-adapter.test.ts`
- Create fixture: `tests/fixtures/fake-agent.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface AgentAdapter { start(input: { prompt: string; cwd: string; signal: AbortSignal }): AsyncIterable<AgentEvent> }`
  - `type AgentEvent = { type:'log'; text:string } | { type:'progress'; text:string } | { type:'final'; summary:string }`
  - `class AgentRunError extends Error { constructor(message: string, readonly exitCode: number | null) }`
  - `interface ProcessRunner { spawn(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ProcessHandle }`；`ChildProcessRunner` 通过 `child_process.spawn` 实现；`PtyRunner` 通过 node-pty 实现（仅在默认导出之外引用，测试不加载）
  - `class LineSplitter { push(chunk: string): string[]; flush(): string[] }`（处理 `\n`、`\r\n`、半行、剥离 ANSI 转义）
  - `class GenericCliAdapter implements AgentAdapter`：`constructor(runner: ProcessRunner, opts: { command: string; argsTemplate: string })`

- [ ] **Step 1: 写失败测试**

```ts
test('line splitter handles partial lines, CRLF and ANSI codes', ...)
test('generic adapter streams logs and emits the final summary', ...)
test('generic adapter throws AgentRunError on non-zero exit', ...)
test('aborting the signal kills the process', ...)
```

fixture `fake-agent.js`：向 stdout 打印两行后以 0 退出；参数 `--fail` 时打印错误并非零退出；参数 `--slow` 时每 100ms 输出一行。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/agents/line-splitter.test.ts tests/agents/generic-cli-adapter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`GenericCliAdapter` 替换 `argsTemplate` 中的 `{prompt}`，用 runner 启动；每行产出 `log`；`progress` 取最近一个非空行（节流交由 Task 11）；进程结束后取最后 20 行作为 `final.summary`；非零退出抛 `AgentRunError`；`AbortSignal` 触发 `handle.kill()`。`ChildProcessRunner` 以 `detached: true` 启动子进程，kill 时向进程组 `-pid` 发 SIGTERM，5 秒后 SIGKILL。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/agents/line-splitter.test.ts tests/agents/generic-cli-adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add process runner and generic cli adapter"`

---

### Task 9: Claude Code Adapter

**Files:**
- Create: `src/main/services/agents/claude-adapter.ts`、`src/main/services/agents/claude-stream-parser.ts`
- Test: `tests/agents/claude-adapter.test.ts`、`tests/fixtures/claude-stream.jsonl`

**Interfaces:**
- Consumes: `ProcessRunner`、`AgentAdapter`、`AgentRunError`（Task 8）、`PermissionProfile`（Task 2）
- Produces:
  - `class ClaudeStreamParser { pushLine(line: string): AgentEvent[] }`
  - `function buildClaudeArgs(input: { prompt: string; permission: PermissionProfile }): string[]`
  - `class ClaudeAdapter implements AgentAdapter { constructor(runner: ProcessRunner) }`

- [ ] **Step 1: 写失败测试**

```ts
test('buildClaudeArgs uses plan mode for read-only', ...)
test('buildClaudeArgs uses acceptEdits for edit-only', ...)
test('buildClaudeArgs uses bypassPermissions for edit-and-run', ...)
test('parser maps tool_use to progress and result to final', ...)
test('parser ignores unknown event types and malformed JSON', ...)
```

fixture 包含：`system` 初始化事件、一条带 `tool_use` 的 assistant 事件、一条 `result` 事件、一行非 JSON 文本、一条未知 `type`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/agents/claude-adapter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`buildClaudeArgs` 返回 `['-p', prompt, '--output-format','stream-json','--verbose','--permission-mode', mode]`，mode 映射：read-only→`plan`、edit-only→`acceptEdits`、edit-and-run→`bypassPermissions`。解析器逐行 `JSON.parse`，失败则产出 `log`；`assistant.message.content[].type === 'tool_use'` → `progress: 执行 <name>`；`type === 'result'` → `final: result`；其余忽略。Adapter 用 runner 启动 `claude`，把 stdout 交给解析器，stderr 转为 log；退出码非 0 抛 `AgentRunError`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/agents/claude-adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add claude code adapter"`

---

### Task 10: Codex Adapter

**Files:**
- Create: `src/main/services/agents/codex-adapter.ts`、`src/main/services/agents/codex-stream-parser.ts`
- Test: `tests/agents/codex-adapter.test.ts`、`tests/fixtures/codex-stream.jsonl`

**Interfaces:**
- Consumes: 同 Task 9
- Produces:
  - `class CodexStreamParser { pushLine(line: string): AgentEvent[] }`
  - `function buildCodexArgs(input: { prompt: string; permission: PermissionProfile }): string[]`
  - `class CodexAdapter implements AgentAdapter { constructor(runner: ProcessRunner) }`

- [ ] **Step 1: 写失败测试**

```ts
test('buildCodexArgs uses read-only sandbox for read-only', ...)
test('buildCodexArgs uses workspace-write for edit-only and edit-and-run', ...)
test('parser emits progress for command/tool items and final for completed text', ...)
test('parser tolerates unknown JSON shapes and plain text lines', ...)
```

注意：Codex 没有"仅编辑不可执行命令"的 sandbox 档位，`edit-only` 与 `edit-and-run` 都使用 `workspace-write`，差异通过角色 prompt 表达（在 Task 11 中拼入）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/agents/codex-adapter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`buildCodexArgs` 返回 `['exec','--json','--sandbox', sandbox, prompt]`，sandbox 映射：read-only→`read-only`、其余→`workspace-write`。解析器对每行 `JSON.parse`；对象中 `type` 含 `command`/`tool` 时产出 progress；含最终文本字段（`item.text` 或 `message`）时产出 final；无法识别的内容一律忽略或作为 log，不抛异常。

- [ ] **Step 4: 实现后核对真实 CLI 参数**

Run: `codex --version && codex exec --help`
Expected：确认 `exec`、`--json`、`--sandbox` 仍存在；若版本改名，只调整 `buildCodexArgs` 并同步测试，不改解析器契约。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test tests/agents/codex-adapter.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add src tests && git commit -m "feat: add codex adapter"`

---

### Task 11: Setup 执行与 TaskManager 核心

**Files:**
- Create: `src/main/services/tasks/setup-runner.ts`、`src/main/services/tasks/task-manager.ts`、`src/main/services/tasks/log-writer.ts`、`src/main/services/agents/adapter-factory.ts`
- Test: `tests/services/setup-runner.test.ts`、`tests/services/task-manager.test.ts`、`tests/helpers/fake-adapter.ts`

**Interfaces:**
- Consumes: `GitService`、`WorkspaceRepo`、`AgentRepo`、`TaskRepo`、`MessageRepo`、`EventBus`、`AgentAdapter`、`outOfScopeFiles`
- Produces:
  - `class SetupRunner { run(input: { worktreePath: string; repoPath: string; command: string | null; copy: string[]; timeoutMin: number }): Promise<{ ok: true } | { ok: false; error: string }> }`
  - `interface AdapterFactory { create(agent: AgentConfig): AgentAdapter }`
  - `class TaskManager { constructor(deps: TaskManagerDeps); start(): void; enqueue(taskId: string): void; cancel(taskId: string): Promise<void>; retry(taskId: string): Promise<void> }`
  - `TaskManagerDeps = { tasks; agents; workspaces; messages; git; setup; adapters: AdapterFactory; events: EventBus; worktreesRoot: string; logsRoot: string; now?: () => Date }`

- [ ] **Step 1: 写 SetupRunner 失败测试**

```ts
test('setup copies files and runs the command in the worktree', ...)
test('missing copy source fails with a readable error', ...)
test('failing setup command returns ok:false', ...)
```

- [ ] **Step 2: 写 TaskManager 失败测试**

用 `FakeAdapter`（按预设顺序产出 events，可配置等待时长/失败）与临时仓库：

```ts
test('task goes queued -> preparing -> running -> done and commits changes', ...)
test('setup files are present before the adapter starts', ...)
test('only one task per agent runs at a time', ...)
test('timeout marks the task failed and kills the adapter', ...)
test('cancel marks the task cancelled', ...)
test('adapter failure marks the task failed with its message', ...)
test('prompt includes role, path scope and task text', ...)
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm test tests/services/setup-runner.test.ts tests/services/task-manager.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现**

`SetupRunner`：按顺序 `fs.cp` 复制（源不存在 → `ok:false`），再 `sh -c <command>`（cwd=worktree、超时 `timeoutMin`）。`TaskManager`：调度器只在 Agent 空闲时启动队首任务；启动时创建 worktree（分支、baseRef 记录）、执行 setup、拼 prompt（角色说明 + 路径范围约束 + 任务文本）、运行 adapter、写日志文件、收集进度（节流为每 60 秒一条系统消息，任务卡片通过 `task-progress` 实时更新）、结束后 `commitAll` 并置 `done`。**任务成功后保留 worktree 直到合并结束**（合并成功由 Task 12 删除）；失败、取消、冲突保留现场。`taskType === 'resolve'` 且 `task.worktreePath` 已设置时，复用该 worktree、跳过 worktree 创建与 setup。失败保留 worktree，取消杀进程。每个任务结束释放 Agent 占用。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test tests/services/setup-runner.test.ts tests/services/task-manager.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

Run: `git add src tests && git commit -m "feat: add task manager with worktree, setup and progress"`

---

### Task 12: 合并、冲突、越界确认与解决任务

**Files:**
- Modify: `src/main/services/tasks/task-manager.ts`
- Create: `src/main/services/tasks/merge-coordinator.ts`
- Test: `tests/services/merge-coordinator.test.ts`

**Interfaces:**
- Consumes: `SerialQueue`、`outOfScopeFiles`、`GitService`、`TaskManager` 状态更新
- Produces:
  - `class MergeCoordinator { constructor(deps: { queue: SerialQueue; git: GitService; tasks: TaskRepo; agents: AgentRepo; workspaces: WorkspaceRepo; events: EventBus; enqueue: (taskId: string) => void; integrationWorktreePath: (workspaceId: string) => string }); mergeTask(taskId: string): Promise<void>; approve(taskId: string): Promise<void>; createResolveTask(taskId: string, agentId: string): Task; prepareResolveWorktree(taskId: string): Promise<string>; markManuallyResolved(taskId: string): Promise<void> }`
  - `TaskManager` 新增 `approveMerge(taskId)`、`abandon(taskId)`，并在任务 `done` 后调用 `mergeTask`

- [ ] **Step 1: 写失败测试**

```ts
test('clean in-scope task is merged automatically into integration', ...)
test('conflict marks task conflict, aborts merge and later tasks still merge', ...)
test('out-of-scope changes pause at awaiting_approval until approved', ...)
test('approve merges an out-of-scope task', ...)
test('createResolveTask produces a resolve task on the agent branch', ...)
test('resolve task commit makes the retry merge succeed', ...)
test('prepareResolveWorktree creates a worktree on the conflicting agent branch', ...)
test('markManuallyResolved commits the fix and re-merges', ...)
test('merged task worktree is removed after merge', ...)
test('task with no changes is marked merged without a merge commit', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/merge-coordinator.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

在 integration worktree 内串行合并。若 `changedFiles` 为空，直接把任务置 `merged` 并注明"无代码改动"，不产生 merge commit。合并前用 `changedFiles` + `outOfScopeFiles` 判断：范围内→直接 `merge`；越界→`awaiting_approval`（不合并）；冲突→收集文件后 `mergeAbort`，置 `conflict`，群里发冲突卡片消息。合并成功后删除任务 worktree。`approve` 跳过越界检查执行合并。`createResolveTask`：以冲突任务保留的 worktree 为 `worktreePath`、同一 Agent 分支创建 `resolve` 任务，prompt 指示把 integration 合入当前分支并解决冲突；其完成后的合并走同一队列。`prepareResolveWorktree` 供"手动解决"使用：返回冲突任务保留的 worktree 路径（若已被清理则用 `worktreeAddExisting` 重建）；`markManuallyResolved` 检查该 worktree 无未解决冲突、提交残余修改，然后把任务重新置为 `merging` 并发起合并。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/merge-coordinator.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: merge coordinator with conflict and scope gates"`

---

### Task 13: 崩溃恢复与重试

**Files:**
- Modify: `src/main/services/tasks/task-manager.ts`
- Test: `tests/services/recovery.test.ts`

**Interfaces:**
- Consumes: `TaskRepo`、`EventBus`
- Produces: `TaskManager.recoverInterrupted(): void`；`TaskManager.retry(taskId): Promise<void>`（`interrupted`/`failed`/`cancelled` 可重试）；恢复时对 `done` 且尚未合并的任务重新调用 `onTaskDone`（若已配置），让重启后补上合并

- [ ] **Step 1: 写失败测试**

```ts
test('startup marks preparing/running/merging tasks as interrupted', ...)
test('interrupted tasks are not dispatched automatically', ...)
test('retry resets a task to queued with a fresh branch and worktree', ...)
test('retry on a non-retryable status rejects', ...)
test('recovery re-drives the merge callback for done tasks', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/recovery.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`recoverInterrupted` 批量更新状态并广播。`retry`：删除旧分支（若存在）、清理旧 worktree 目录、清空 branch/worktreePath/baseRef、置 `queued`、重新入队；原始 prompt 保留。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/recovery.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add crash recovery and retry"`

---

### Task 14: 合并后自动测试任务

**Files:**
- Modify: `src/main/services/tasks/merge-coordinator.ts`、`src/main/services/tasks/task-manager.ts`
- Test: `tests/services/auto-test.test.ts`

**Interfaces:**
- Consumes: `Workspace`、`TaskRepo`、`AgentRepo`
- Produces: `MergeCoordinator.maybeCreateTestTask(workspace: Workspace, mergedTask: Task): Task | null`

- [ ] **Step 1: 写失败测试**

```ts
test('code task merge creates a test task when enabled', ...)
test('disabled setting creates no test task', ...)
test('test and resolve tasks do not trigger another test task', ...)
test('test task uses testAgentId, taskType test and the template prompt', ...)
test('test task result updates workspace.lastVerification to passed or failed', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/auto-test.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

仅在 `mergedTask.taskType === 'code'` 且工作区开关开启且 `testAgentId` 存在时创建；`taskType: 'test'`，`parentTaskId: mergedTask.id`，标题「验证：<合并任务标题>」，入队。任何 `test` 类型任务结束时，按其最终状态（`merged` 或 `done` 为 passed，其余为 failed）更新 `workspace.lastVerification`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/auto-test.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: trigger test task after code merge"`

---

### Task 15: Agent 间委派

**Files:**
- Create: `src/main/services/chat/mentions.ts`
- Modify: `src/main/services/tasks/task-manager.ts`
- Test: `tests/services/delegation.test.ts`

**Interfaces:**
- Consumes: `AgentConfig[]`、`TaskRepo`、`Task.parentTaskId`
- Produces:
  - `function extractMentionIds(text: string, agents: Array<{ id: string; name: string }>): string[]`
  - `TaskManager` 在任务成功结束后调用内部 `maybeDelegate(task, summary)`

- [ ] **Step 1: 写失败测试**

```ts
test('agent summary mentioning another agent creates a delegated task', ...)
test('delegation is skipped when canDelegate is false', ...)
test('delegation depth over 3 is rejected', ...)
test('self mention and direct A->B->A cycles are rejected', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/services/delegation.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

沿 `parentTaskId` 链计算深度与祖先 Agent 集合；仅允许深度 < 3、目标 ≠ 自己、目标不在祖先链；新任务 `taskType: 'code'`，prompt 为 summary 原文，标题「委派：<目标 Agent>」。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/services/delegation.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: add bounded agent delegation"`

---

### Task 16: IPC 契约、主进程处理器与 preload

**Files:**
- Modify: `src/shared/ipc.ts`
- Create: `src/main/ipc-handlers.ts`、`src/main/app-context.ts`
- Modify: `src/main/index.ts`、`src/preload/index.ts`
- Test: `tests/ipc/handlers.test.ts`

**Interfaces:**
- Consumes: 所有服务
- Produces:
  - `IPC` 通道常量：`workspace:create|list|update|diff`、`agents:list|add|update|remove`、`chat:send|history`、`tasks:list|cancel|retry|approve-merge|abandon|open-worktree|prepare-resolve|mark-resolved|create-resolve|log`、`events`（主→渲染）
  - `createIpcHandlers(ctx: AppContext): Record<string, (payload: unknown) => Promise<unknown>>`；`AppContext` 包含 `openPath: (p: string) => Promise<void>`（生产环境接 Electron `shell.openPath`，测试注入假实现）
  - preload 暴露 `window.api`：`invoke(channel, payload)` 与 `onEvent(cb)`

- [ ] **Step 1: 写失败测试**

```ts
test('chat:send delegates to Dispatcher and returns created tasks', ...)
test('tasks:cancel delegates to TaskManager', ...)
test('workspace:create returns the workspace', ...)
test('unknown channel rejects with a readable error', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/ipc/handlers.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`AppContext` 组装 db、repos、services、EventBus；`ipc-handlers.ts` 只做参数转发与错误包装，不写业务逻辑。`main/index.ts` 在 `app.whenReady` 后初始化上下文、注册 `ipcMain.handle`、创建窗口，并把 `EventBus` 事件通过 `webContents.send(IPC.events, e)` 推给 renderer。preload 用 `contextBridge.exposeInMainWorld('api', ...)`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/ipc/handlers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: typed ipc bridge between main and renderer"`

---

### Task 17: 渲染进程外壳与工作区创建

**Files:**
- Create: `src/renderer/src/api.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/components/WorkspaceSetup.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/renderer/workspace-setup.test.tsx`

**Interfaces:**
- Consumes: `window.api`（Task 16）
- Produces: 应用外壳（左侧工作区列表、中间占位、右侧占位）；顶部显示工作区名、仓库路径、integration 分支名与相对目标分支的 diff 统计；`WorkspaceSetup` 表单（名称、仓库路径、目标分支）；创建成功后刷新列表。

- [ ] **Step 1: 写失败测试**

```ts
test('empty state shows workspace setup form', ...)
test('submitting the form calls workspace:create and renders the workspace', ...)
test('create error is shown without crashing', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/renderer/workspace-setup.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`api.ts` 封装 IPC 调用；`App` 加载工作区列表；`WorkspaceSetup` 受控表单；样式用 CSS 变量实现三栏布局，不含组件库。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/renderer/workspace-setup.test.tsx && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: renderer shell and workspace setup"`

---

### Task 18: 群聊时间线与输入框

**Files:**
- Create: `src/renderer/src/components/ChatTimeline.tsx`、`src/renderer/src/components/Composer.tsx`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/renderer/composer.test.tsx`、`tests/renderer/chat-timeline.test.tsx`

**Interfaces:**
- Consumes: `window.api`、`AppEvent`
- Produces: 时间线渲染 `user / agent / system / task-card` 四类消息；Composer 支持 `@` 触发成员补全、发送后清空、Enter 发送 / Shift+Enter 换行。

- [ ] **Step 1: 写失败测试**

```ts
test('timeline renders user, system and task-card messages differently', ...)
test('typing @ shows enabled agents and inserts the selected name', ...)
test('send calls chat:send with the text and clears the input', ...)
test('empty input is not sent', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/renderer/composer.test.tsx tests/renderer/chat-timeline.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`App` 订阅 `onEvent` 更新消息和任务；Composer 用受控 textarea 与简单浮层补全；时间线按 `kind` 渲染不同样式。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/renderer/composer.test.tsx tests/renderer/chat-timeline.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: chat timeline and composer with mentions"`

---

### Task 19: 任务卡片、成员面板、设置与通知

**Files:**
- Create: `src/renderer/src/components/TaskCard.tsx`、`src/renderer/src/components/AgentPanel.tsx`、`src/renderer/src/components/AddAgentDialog.tsx`、`src/renderer/src/components/SettingsDialog.tsx`
- Create: `src/main/notifications.ts`
- Modify: `src/main/app-context.ts`、`src/renderer/src/App.tsx`
- Test: `tests/renderer/task-card.test.tsx`、`tests/renderer/add-agent.test.tsx`、`tests/notifications.test.ts`

**Interfaces:**
- Consumes: `window.api`、`Task`、`AgentConfig`
- Produces: 任务卡片（状态、耗时、最近进度、展开日志、取消/重试/合并确认/放弃/打开 worktree）；成员面板（状态点、添加/停用）；顶部显示 `lastVerification` 与"复制合入命令"按钮（`git merge agentgroup/integration`）；设置对话框（autoMerge、autoTestAfterMerge、testAgent、setup 命令/复制、目标分支）；`notifyTaskFinished(task)` 在 merged/failed/conflict 时弹 macOS 通知。

- [ ] **Step 1: 写失败测试**

```ts
test('task card shows status-specific actions for conflict and awaiting_approval', ...)
test('add agent dialog warns for edit-and-run profile', ...)
test('notification helper fires for failed and merged only', ...)
test('header shows lastVerification and copies the integration merge command', ...)
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/renderer/task-card.test.tsx tests/renderer/add-agent.test.tsx tests/notifications.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

卡片按状态渲染按钮并调用对应 IPC（冲突卡片包含"指派 Agent 解决 / 打开 worktree 手动解决 / 标记已解决并重新合并 / 放弃"）；AddAgentDialog 三个预设、权限档位、路径范围输入；设置写回 `workspace:update`；通知模块注入 `Notification` 构造器便于测试。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/renderer/task-card.test.tsx tests/renderer/add-agent.test.tsx tests/notifications.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

Run: `git add src tests && git commit -m "feat: task cards, agent panel, settings and notifications"`

---

### Task 20: 全流程集成测试

**Files:**
- Create: `tests/e2e/full-flow.test.ts`、`tests/helpers/test-context.ts`（用真实服务 + FakeAdapter 组装，不启动 Electron）
- Modify: 无业务代码（发现缺陷时按缺陷归属任务修复）

**Interfaces:**
- Consumes: Task 2–16 全部服务
- Produces: 三条端到端场景的回归测试。

- [ ] **Step 1: 写场景测试**

```ts
test('three agents edit disjoint files in parallel and all merge', ...)
test('two agents editing the same file produce a conflict then resolve task merges', ...)
test('out-of-scope change waits for approval and merges after approve', ...)
```

第一条断言 integration worktree 最终同时包含三个文件；第二条用 `FakeAdapter` 在 resolve 任务中写入解决后的内容；第三条断言 approve 前 integration 无该文件。

- [ ] **Step 2: 运行确认失败（若直接通过，说明前序测试有遗漏，补测后重跑）**

Run: `pnpm test tests/e2e/full-flow.test.ts`
Expected: FAIL。

- [ ] **Step 3: 修复并运行至通过**

Run: `pnpm test tests/e2e/full-flow.test.ts`
Expected: PASS。

- [ ] **Step 4: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过。

- [ ] **Step 5: 提交**

Run: `git add tests && git commit -m "test: end-to-end multi-agent merge flows"`

---

### Task 21: 打包与首次运行验证

**Files:**
- Modify: `electron-builder.yml`、`package.json`、`README.md`
- Test: 手动验证清单

**Interfaces:**
- Consumes: 全部
- Produces: 可安装的 `AgentGroup-*.dmg`；README 快速开始。

- [ ] **Step 1: 补全 electron-builder 配置**

appId `com.local.agentgroup`，productName `AgentGroup`，mac target `dmg`，`files` 包含 `out/**`，`extraResources` 包含 `sql-wasm.wasm` 与 `node-pty` 原生模块，`asarUnpack` 原生模块。

- [ ] **Step 2: 打包**

Run: `pnpm build:mac`
Expected: 生成 dmg，无打包错误。

- [ ] **Step 3: 手动首次运行验证**

清单：打开 App → 创建指向一个测试仓库的工作区 → 添加 Claude/Codex 两个 Agent（权限选"可编辑并运行命令"）→ 发送一条含两个 @ 的消息 → 两个任务并行出现 → 完成后合入 integration → `git log agentgroup/integration` 可见两次合并 → 关闭并重开 App，历史仍在。逐项记录实际结果；真实 CLI 需要登录态，若缺失则记录为未验证。

- [ ] **Step 4: 写 README 快速开始**

包含：安装、如何创建第一个工作区、Agent 命令示例、DeepSeek CLI 以"自定义 Agent"接入的说明、integration 分支如何合回主线。

- [ ] **Step 5: 提交**

Run: `git add -A && git commit -m "chore: packaging config and quickstart"`

---

## Self-Review 记录

- **Spec 覆盖**：7.1→Task 19；7.2→Task 6/7；7.3→Task 8–12/19；7.4→Task 3/4/11；7.5→Task 5/12；7.6→Task 5/12；7.7→Task 14；7.8→Task 15；7.9→Task 17–19；7.10→Task 13；7.11→全局约束与 Task 16。无遗漏。
- **Review Focus 对应**：1→Task 9/10；2→Task 5/12；3→Task 13；4→Task 11/13；5→Task 6。
- **类型一致性**：`AgentConfig`、`Task.taskType`、`TaskStatus`、`workspace.autoMerge`、`task.worktreePath/branch/baseRef` 在 Task 2 定义，后续任务均按此引用。
- **已知偏差**：数据库用 sql.js 而非 better-sqlite3（避免原生模块在 Electron/Node 间的 ABI 重建问题）；默认进程运行器用 child_process，node-pty 仅作为自定义 Agent 的 TTY 选项保留。两者都不改变设计文档的行为契约。
- **密钥存储**：v1 不自建密钥管理，Agent 登录态由各自 CLI 负责；如需环境变量，使用用户 shell 环境或自定义 Agent 命令里的显式前缀，App 不存储 API Key（设计文档 7.11 的"若需要"在 v1 按不启用处理）。
