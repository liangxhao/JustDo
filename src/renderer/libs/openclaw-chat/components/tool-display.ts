/**
 * Tool titles from OpenClaw's canonical tool-display.json.
 *
 * Keep this projection aligned with the OpenClaw version locked in package.json;
 * JustDo must not invent aliases or product-specific tool titles here.
 */
const OPENCLAW_TOOL_TITLES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  computer: 'Computer',
  mobile_ui: 'Mobile UI',
  screen: 'Screen',
  terminal: 'Terminal',
  portal: 'Portal',
  process: 'Process',
  gateway_process: 'Background Shell',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  attach: 'Attach',
  api: 'API',
  browser: 'Browser',
  canvas: 'Canvas',
  dashboard: 'Dashboard',
  nodes: 'Nodes',
  cron: 'Cron',
  get_goal: 'Get Goal',
  create_goal: 'Create Goal',
  update_goal: 'Update Goal',
  progress_card: 'Progress Card',
  ask_user: 'Ask User',
  secrets: 'Secrets',
  suggest_task: 'Suggest Task',
  dismiss_task: 'Dismiss Task',
  skill_workshop: 'Skill Workshop',
  openclaw: 'OpenClaw',
  gateway: 'Gateway',
  exec: 'Exec',
  tool_call: 'Tool Call',
  tool_call_update: 'Tool Call',
  session_status: 'Session Status',
  github_publish: 'GitHub Publish',
  github_identity_status: 'GitHub Identity Status',
  sessions: 'Session Settings',
  sessions_list: 'Sessions',
  conversations_list: 'Conversations',
  conversations_send: 'Conversation Send',
  conversations_turn: 'Conversation Turn',
  sessions_send: 'Session Send',
  sessions_history: 'Session History',
  sessions_search: 'Session Search',
  transcripts: 'Transcripts',
  sessions_spawn: 'Sub-agent',
  agents_wait: 'Wait for Agents',
  structured_output: 'Structured Output',
  subagents: 'Subagents',
  agents_list: 'Agents',
  memory_search: 'Memory Search',
  memory_get: 'Memory Get',
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  code_execution: 'Code Execution',
  message: 'Message',
  apply_patch: 'Apply Patch',
  image: 'Image',
  view_image: 'View Image',
  image_generate: 'Image Generation',
  music_generate: 'Music Generation',
  video_generate: 'Video Generation',
  pdf: 'PDF',
  sessions_yield: 'Yield',
  tts: 'TTS',
};

// Mirrors OpenClaw src/agents/tool-display-common.ts for tools without an
// explicit entry in the canonical display resource.
function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, ' ').trim();
  if (!cleaned) return 'Tool';

  return cleaned
    .split(/\s+/)
    .map(part =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(' ');
}

export function resolveToolDisplay(toolName: string): { title: string } {
  const name = toolName.trim() || 'tool';
  const key = name.toLowerCase();
  const title = OPENCLAW_TOOL_TITLES[key] ?? defaultTitle(name);
  return { title };
}
