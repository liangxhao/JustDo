const TOOL_TITLES = {
  api: 'API',
  apply_patch: 'Apply Patch',
  ask_user: 'Ask User',
  agents_list: 'Agents',
  agents_wait: 'Wait for Agents',
  attach: 'Attach',
  bash: 'Bash',
  browser: 'Browser',
  canvas: 'Canvas',
  code_execution: 'Code Execution',
  computer: 'Computer',
  conversations_list: 'Conversations',
  conversations_send: 'Conversation Send',
  conversations_turn: 'Conversation Turn',
  create_goal: 'Create Goal',
  cron: 'Cron',
  dashboard: 'Dashboard',
  dismiss_task: 'Dismiss Task',
  edit: 'Edit',
  exec: 'Exec',
  gateway: 'Gateway',
  gateway_process: 'Background Shell',
  get_goal: 'Get Goal',
  github_identity_status: 'GitHub Identity Status',
  github_publish: 'GitHub Publish',
  image: 'Image',
  image_generate: 'Image Generation',
  memory_get: 'Memory Get',
  memory_search: 'Memory Search',
  message: 'Message',
  mobile_ui: 'Mobile UI',
  music_generate: 'Music Generation',
  nodes: 'Nodes',
  openclaw: 'OpenClaw',
  pdf: 'PDF',
  process: 'Process',
  progress_card: 'Progress Card',
  read: 'Read',
  screen: 'Screen',
  secrets: 'Secrets',
  session_status: 'Session Status',
  sessions: 'Session Settings',
  sessions_history: 'Session History',
  sessions_list: 'Sessions',
  sessions_search: 'Session Search',
  sessions_send: 'Session Send',
  sessions_spawn: 'Sub-agent',
  sessions_yield: 'Yield',
  structured_output: 'Structured Output',
  subagents: 'Subagents',
  suggest_task: 'Suggest Task',
  skill_workshop: 'Skill Workshop',
  terminal: 'Terminal',
  tool_call: 'Tool Call',
  tool_call_update: 'Tool Call',
  transcripts: 'Transcripts',
  tts: 'TTS',
  update_goal: 'Update Goal',
  video_generate: 'Video Generation',
  view_image: 'View Image',
  web_fetch: 'Web Fetch',
  web_search: 'Web Search',
  write: 'Write',
};

export function isCurrentThreadRunning(activeThreadId, selectedThreadId) {
  return Boolean(activeThreadId) && activeThreadId === selectedThreadId;
}

export function shouldShowTurnError(completedThreadId, selectedThreadId, refreshApplied) {
  return Boolean(refreshApplied) && completedThreadId === selectedThreadId;
}

export function mergePendingUserMessage(entries, pendingMessage, selectedThreadId) {
  if (!pendingMessage || pendingMessage.threadId !== selectedThreadId) return entries;
  if (pendingMessage.runId) {
    const key = `${pendingMessage.runId}:user`;
    const accepted = entries.some(entry => entry.role === 'user' && (
      entry.pendingInput?.runId === pendingMessage.runId ||
      entry.rawMessage?.idempotencyKey === key ||
      entry.rawMessage?.__openclaw?.idempotencyKey === key
    ));
    return accepted ? entries : [...entries, { role: 'user', text: pendingMessage.text }];
  }
  const persistedMatches = entries.filter(
    entry => entry.role === 'user' && entry.text === pendingMessage.text,
  ).length;
  const persisted = persistedMatches > (pendingMessage.persistedMatches ?? 0);
  return persisted ? entries : [...entries, { role: 'user', text: pendingMessage.text }];
}

function formatSidePanelValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toolInputSummary(value) {
  const compact = formatSidePanelValue(value).trim().replace(/\s+/g, ' ');
  if (!compact) return '';
  return compact.length <= 160 ? compact : `${compact.slice(0, 159)}…`;
}

export function toolDisplayTitle(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return 'Tool';
  const canonical = TOOL_TITLES[name.toLowerCase()];
  if (canonical) return canonical;
  return name
    .replace(/_/g, ' ')
    .split(/\s+/)
    .map(part =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(' ');
}

export function messagesFromThread(thread) {
  const entries = [];
  for (const turn of thread?.turns ?? []) {
    let processes = [];
    let processSegment = 0;
    const flushProcesses = () => {
      if (!processes.length) return;
      const thinkingCount = processes.filter(item => item.type === 'thinking').length;
      const toolCount = processes.filter(item => item.type === 'tool').length;
      const title = [
        ...(thinkingCount ? [`Thinking × ${thinkingCount}`] : []),
        ...(toolCount ? [`Tool × ${toolCount}`] : []),
      ].join(' · ');
      entries.push({
        role: 'process',
        key: `${turn.id || 'turn'}-process-${processSegment}`,
        title,
        running: processes.some(item => item.type === 'thinking' && item.status === 'running'),
        items: processes,
      });
      processSegment += 1;
      processes = [];
    };
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        flushProcesses();
        const text = (item.content ?? [])
          .filter(content => content?.type === 'text' && typeof content.text === 'string')
          .map(content => content.text)
          .join('\n');
        if (text || item.rawMessage)
          entries.push({
            role: 'user',
            text,
            ...(item.pendingInput ? { pendingInput: item.pendingInput } : {}),
            ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
          });
      } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
        flushProcesses();
        entries.push({
          role: 'assistant',
          text: item.text,
          ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
        });
      } else if (item.type === 'systemMessage' && typeof item.text === 'string') {
        flushProcesses();
        entries.push({ role: 'system', text: item.text });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary ?? []), ...(item.content ?? [])]
          .filter(value => typeof value === 'string' && value)
          .join('\n');
        if (text)
          processes.push({
            id: item.id,
            type: 'thinking',
            text,
            title: 'Thinking',
            status: item.status,
          });
      } else if (item.type === 'toolCall') {
        processes.push({
          id: item.toolUseId || item.id,
          type: 'tool',
          title: toolDisplayTitle(item.toolName),
          input: formatSidePanelValue(item.input),
          output: formatSidePanelValue(item.output),
          isError: item.isError === true,
          status: item.status,
        });
      }
    }
    flushProcesses();
  }
  return entries;
}
