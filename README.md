# AgentGroup

把多个 AI 编程 CLI 拉进同一个「群聊」的 macOS 桌面应用：你在一个输入框里用 `@` 给 Claude Code、Codex、DeepSeek CLI 等成员分派任务，每个任务在独立的 git worktree 中并行执行，完成后按顺序合入集成分支。

v1 的边界：

- 只支持 macOS，只接入命令行 Agent（不内置任何 API Key，也不直连模型 API）。
- App 只负责把任务合入 `agentgroup/integration`，**不会自动合回你的 main/dev，也不会创建 PR 或推送远程**。
- 每个仓库只能建立一个工作区；App 不会改动你的当前分支、当前工作区和远程仓库。

## 环境要求

- macOS 13 或更高版本
- Node.js 22、pnpm（从源码构建时需要）
- git
- 已安装并登录的 Agent CLI：
  - Claude Code：`claude`（例如 `npm install -g @anthropic-ai/claude-code`，然后按提示登录）
  - Codex：`codex`（例如 `npm install -g @openai/codex`，然后完成登录）
- 可选：任意 DeepSeek CLI，按「自定义 Agent」方式接入（见下文）

先在终端里直接运行 `claude`、`codex` 各一次，确认能正常对话。AgentGroup 只是以非交互模式启动这些命令，登录态由 CLI 自己维护。

## 安装与构建

从源码构建：

```bash
pnpm install
pnpm dev        # 开发模式
pnpm build      # 只构建到 out/
pnpm build:mac  # 构建并打包 dmg
```

打包完成后产物位于 `dist/`：

- Apple Silicon：`dist/AgentGroup-0.1.0-arm64.dmg`
- Intel：在 Intel 机器上构建会生成对应的 x64 dmg

打开 dmg，把 `AgentGroup.app` 拖到「应用程序」即可。当前为本地未签名构建，首次打开的提示见「常见问题」。

## 创建第一个工作区

1. 启动 AgentGroup，在「新建工作区」表单填写：
   - **工作区名称**：任意可读名称。
   - **仓库路径**：本地 git 仓库的绝对路径，例如 `/Users/me/work/my-repo`。
   - **目标分支（可选）**：留空则使用仓库当前分支；这个分支只用于展示 integration 的差异统计，App 不会修改它。
2. 点击「创建工作区」。App 会：
   - 在仓库中创建（或复用）`agentgroup/integration` 分支；
   - 在 App 数据目录下为该分支创建长期 worktree；
   - 把工作区记录保存到本地数据库。
3. 之后每个任务都会从 integration 的当前提交创建独立分支和 worktree，互不覆盖。

App 数据位于 `~/Library/Application Support/agentgroup/`（数据库、worktree、任务日志）。v1 不支持在 App 内删除工作区，创建前请确认仓库路径。

## 添加 Agent

在右侧「Agent 成员」面板点击「+ 添加 Agent」，填写名称、角色说明，并选择预设：

| 预设 | 实际执行的命令 | 说明 |
| --- | --- | --- |
| Claude Code | `claude` | 以无头模式运行，输出用 stream-json 解析 |
| Codex | `codex` | 以 `codex exec --json` 非交互模式运行 |
| 自定义 | 你填写的命令 | 通过参数模板把任务提示传给任意 CLI |

通用字段：

- **角色说明**：会拼进每个任务的提示词，例如「负责前端页面与样式」。
- **路径范围**：逗号分隔的 glob，例如 `web/**, server/**`；为空表示不限。Agent 的改动超出范围时，任务会停在「等待确认」而不是自动合并。
- **权限档位**：
  - `只读`：Claude 使用 plan 模式，Codex 使用 read-only sandbox；
  - `仅编辑`：Claude 使用 acceptEdits，Codex 使用 workspace-write sandbox；
  - `可编辑并运行命令`：允许修改文件并执行任意命令（构建、测试、安装依赖），命令以你的 macOS 账户权限运行，只对可信 CLI 使用。
  - 权限档位只作用于 Claude/Codex 预设；**自定义 Agent 始终以当前用户权限运行**，接入前请自行确认该 CLI 的行为。
- **允许委派**：开启后，Agent 输出中的 `@成员` 提及会继续创建后续任务。

### 自定义 Agent 示例

自定义 Agent 需要填写「命令」和可选的「参数模板」：

- 参数模板按空白切分后作为 argv；其中 `{prompt}` 会替换成任务提示（含空格也只占一个参数）。
- 模板里没有 `{prompt}` 时，任务提示会作为最后一个参数追加。
- Agent 的工作目录是任务的 worktree，因此命令必须能在任意仓库路径下运行，并在结束后以退出码 0 表示成功。

例如接入一个假想的 DeepSeek CLI：

1. 按该 CLI 的文档安装并完成登录/配置（如果它需要 API Key，请在 CLI 自己的配置或 shell 环境变量里提供，AgentGroup 不保存密钥）。
2. 先在终端验证：

   ```bash
   cd /path/to/some/repo
   deepseek --prompt "列出当前目录的文件"
   ```

3. 在 AgentGroup 中添加：
   - 预设：`自定义`
   - 名称：`deepseek`
   - 命令：`deepseek`（或 CLI 的绝对路径，见「常见问题」中的 PATH 说明）
   - 参数模板：`--prompt {prompt}`（按 CLI 实际参数调整；留空则提示追加在末尾）
   - 权限档位：任选，但自定义 Agent 实际不受其限制

只要 CLI 能非交互地接收提示并输出结果，就可以用同样方式接入。

## 任务、worktree 与 integration

1. 在底部输入框发送一条消息，用 `@成员名` 分派任务：

   ```
   @claude 实现登录页  @codex 实现登录接口  @deepseek 补登录测试
   ```

   每个 `@成员` 到下一个 `@成员` 之间的文字，就是这个成员收到的任务提示。输入 `@` 会弹出成员补全；Enter 发送、Shift+Enter 换行。
2. 消息中的每个成员会并行创建一个任务：
   - 从 integration 的当前提交创建分支 `agent/<taskId>-<slug>`；
   - 在 App 数据目录下创建独立 worktree；
   - 先执行工作区设置里的 **setup 复制**（把 `.env` 等未提交文件从仓库根复制进 worktree），再执行 **setup 命令**（例如 `pnpm install`）；
   - 在该 worktree 内启动 Agent CLI，并把进度、结果和日志回传到群里。
3. Agent 成功后，任务按顺序合入 `agentgroup/integration`（默认开启「任务完成后自动合并」）：
   - 关闭自动合并后，任务会停在卡片上等待你点确认；
   - 改动超出 Agent 的路径范围时，同样等待确认；
   - 合并冲突时任务变为「合并冲突」，可以在卡片上让 Agent 继续解决冲突。
4. 工作区设置里可以开启「每次代码任务合并后自动创建测试任务」，并指定测试 Agent；测试任务以 integration 为基准运行。
5. 关闭并重新打开 App，工作区、成员、消息和任务历史仍从本地数据库恢复；重启时仍在运行或合并中的任务会被标记为中断，已完成但未来得及合并的任务会重新进入合并流程。

## 把 integration 合回主线

AgentGroup 不碰你的 main/dev。确认 integration 上的改动后，在终端里自行合并：

```bash
cd /path/to/my-repo
git checkout main
git pull                      # 如需同步远程
git merge agentgroup/integration
# 解决冲突、运行测试
git push
```

App 顶部会显示集成分支名和相对目标分支的差异统计，并提供「复制合入命令」按钮（内容为 `git merge agentgroup/integration`）。

注意：

- integration 在工作区创建时从仓库当前 HEAD 建立，v1 不会自动跟随你的主线更新。主线前进后再合并可能产生冲突，按普通 git 冲突处理即可。
- integration 分支已被 App 的 worktree 检出，不要在主仓库里再次 checkout 这个分支；直接 `git merge agentgroup/integration` 即可。
- App 不会删除或改写你的分支和远程仓库，但任务 worktree 会占用磁盘；不要在任务运行时手动删除 App 数据目录。

## 常见问题

**首次打开提示「无法打开，因为无法验证开发者」**

当前 dmg 未签名、未公证。可以右键 `AgentGroup.app` 选择「打开」，或在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/AgentGroup.app
```

**任务失败：Agent 进程启动失败 / 找不到命令**

- 先在终端确认 `claude`、`codex` 已登录并且能直接运行。
- App 启动时会读取登录 shell（`$SHELL`，默认 `/bin/zsh`）的 PATH，并合并到自身 PATH，因此 nvm、Homebrew、pnpm 安装在用户 profile 里的 CLI 通常可以直接找到。如果 shell 启动过慢、读取失败，或 CLI 不在登录 shell 的 PATH 中，App 会沿用系统继承的 PATH：
  - Claude/Codex 预设固定执行 `claude`/`codex`，请确保这两个命令在登录 shell 的 PATH 中，或链接到 `/usr/local/bin`；
  - 自定义 Agent 可以直接在「命令」中填写 CLI 的绝对路径（例如 `/Users/me/.local/bin/my-cli`）。
- DeepSeek 等自定义 CLI 需要自己处理登录和 API Key，AgentGroup 不存储密钥。

**任务失败：`setup_copy` 目标未被 `.gitignore` 忽略**

setup 复制的是运行环境文件（如 `.env`、`config/local.json`），它们不能进入 Agent 的提交和后续合并。请先把这些路径加入仓库的 `.gitignore`：

```gitignore
.env
.env.*
config/local.json
```

否则任务会在启动 Agent 前直接失败。

**改动超出路径范围 / 任务停在「等待确认」**

Agent 修改了路径范围之外的文件，或工作区关闭了自动合并。检查任务卡片的差异后确认合并，或调整 Agent 的路径范围。

**看不到窗口**

macOS 关闭全部窗口后 App 仍在后台运行，点击 Dock 图标即可重新打开窗口。

## 开发

```bash
pnpm typecheck  # TypeScript 类型检查
pnpm test       # Vitest
pnpm build      # electron-vite 构建
```
