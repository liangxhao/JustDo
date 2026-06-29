/**
 * Tool display resolution — simplified version of webchat's tool-display.ts.
 * Maps tool names to human-readable titles.
 */

const TOOL_TITLE_MAP: Record<string, string> = {
  bash: 'Bash',
  exec: 'Bash',
  shell: 'Bash',
  read: 'Read',
  readfile: 'Read',
  write: 'Write',
  writefile: 'Write',
  edit: 'Edit',
  editfile: 'Edit',
  multiedit: 'MultiEdit',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Task',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  cron: 'Cron',
  process: 'Process',
  sessions_spawn: 'Subagent',
  sessions_list: 'Sessions',
  sessions_send: 'Send Message',
  agent: 'Agent',
  memory: 'Memory',
  memory_search: 'Memory Search',
  memory_store: 'Memory Store',
  notebook_edit: 'Notebook Edit',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '');
}

function defaultTitle(name: string): string {
  if (!name) return 'Tool';
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[_-]/g, ' ');
}

export function resolveToolDisplay(toolName: string): { title: string } {
  const normalized = normalizeToolName(toolName);
  const title = TOOL_TITLE_MAP[normalized] ?? defaultTitle(toolName);
  return { title };
}
