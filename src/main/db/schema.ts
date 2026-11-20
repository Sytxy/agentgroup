// 数据库结构。列名使用 snake_case 与领域类型一一对应；JSON 数组列以 TEXT 存储。
// 当前没有迁移框架，启动时用 CREATE TABLE IF NOT EXISTS 保证表结构存在。
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  target_branch TEXT,
  setup_command TEXT,
  setup_copy_json TEXT NOT NULL,
  setup_timeout_min INTEGER NOT NULL,
  task_timeout_min INTEGER NOT NULL,
  auto_merge INTEGER NOT NULL,
  auto_test_after_merge INTEGER NOT NULL,
  default_agent_id TEXT,
  test_agent_id TEXT,
  test_task_template TEXT NOT NULL,
  last_verification TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  command TEXT NOT NULL,
  args_template TEXT,
  role_prompt TEXT NOT NULL,
  path_scope_json TEXT NOT NULL,
  permission_profile TEXT NOT NULL,
  can_delegate INTEGER NOT NULL,
  enabled INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  parent_task_id TEXT,
  task_type TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  base_ref TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]'
);
`
