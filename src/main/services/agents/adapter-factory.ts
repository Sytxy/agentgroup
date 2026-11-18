/**
 * Agent 适配器工厂。
 *
 * 每个任务都新建适配器实例，避免不同 Agent 的权限档位/命令配置互相污染。
 * 选择依据是 Agent 的 preset：claude / codex / custom（用户自定义命令）。
 * 不依赖 Electron，便于在测试中替换成 FakeAdapter。
 */
import type { AgentConfig } from '../../../shared/types'
import type { AgentAdapter } from './adapter'
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { GenericCliAdapter } from './generic-cli-adapter'
import { ChildProcessRunner } from './process-runner'

export interface AdapterFactory {
  create(agent: AgentConfig): AgentAdapter
}

export class DefaultAdapterFactory implements AdapterFactory {
  create(agent: AgentConfig): AgentAdapter {
    switch (agent.preset) {
      case 'claude':
        return new ClaudeAdapter(new ChildProcessRunner(), agent.permissionProfile)
      case 'codex':
        return new CodexAdapter(new ChildProcessRunner(), agent.permissionProfile)
      case 'custom':
        return new GenericCliAdapter(new ChildProcessRunner(), {
          command: agent.command,
          argsTemplate: agent.argsTemplate ?? '{prompt}'
        })
    }
  }
}
