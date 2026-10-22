import { sidePanelText as t } from './sidepanel-i18n.js';
import { foldBrowserExtensionEntries, isPresentPlanToolName } from './sidepanel-stream.js';

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
    const accepted = entries.some(
      entry =>
        entry.role === 'user' &&
        (entry.pendingInput?.runId === pendingMessage.runId ||
          entry.rawMessage?.idempotencyKey === key ||
          entry.rawMessage?.__openclaw?.idempotencyKey === key),
    );
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

const ENDED_PROCESS_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'aborted',
]);
const COMPACTION_KINDS = new Set(['compaction', 'compaction-status', 'compaction-skipped']);

function displayKey(turnKey, item, index, role) {
  if (typeof item.displayKey === 'string' && item.displayKey) {
    return JSON.stringify([turnKey, role, item.displayKey, '', 0]);
  }
  const source = item.display?.sourceId;
  const identity = source || (role === 'tool' && item.toolUseId) || item.id || index;
  return JSON.stringify([
    turnKey,
    role,
    identity,
    item.display?.sourceSegmentId || '',
    source ? (item.display.sourceIndex ?? 0) : 0,
    ...(role === 'tool' && source ? [item.toolUseId || ''] : []),
  ]);
}

function compactionMessage(item) {
  const raw = item.rawMessage;
  const nested = raw?.message && typeof raw.message === 'object' ? raw.message : raw;
  const marker = nested?.__openclaw;
  const kind = item.display?.kind ?? marker?.kind;
  if (!COMPACTION_KINDS.has(kind)) return null;
  return (
    raw ?? {
      role: 'system',
      content: '',
      __openclaw: { kind, ...(item.display?.phase ? { phase: item.display.phase } : {}) },
    }
  );
}

export function messagesFromThread(thread, options = {}) {
  const entries = [];
  const keyOccurrences = new Map();
  for (const [turnIndex, turn] of (thread?.turns ?? []).entries()) {
    const turnKey = turn.id || `${thread?.id || 'thread'}-turn-${turnIndex}`;
    const itemKey = (item, index, role) => {
      const base = displayKey(turnKey, item, index, role);
      const occurrence = keyOccurrences.get(base) ?? 0;
      keyOccurrences.set(base, occurrence + 1);
      // A native message owner may emit several visible sidecars. Unknown
      // duplicate shapes still need distinct display rows, never a guessed owner.
      return occurrence ? `${base}:occurrence:${occurrence}` : base;
    };
    let processes = [];
    const flushProcesses = () => {
      if (!processes.length) return;
      const thinkingCount = processes.filter(item => item.type === 'thinking').length;
      const toolCount = processes.filter(item => item.type === 'tool').length;
      const title = [
        ...(thinkingCount ? [`${t('thinking')} × ${thinkingCount}`] : []),
        ...(toolCount ? [`${t('tool')} × ${toolCount}`] : []),
      ].join(' · ');
      entries.push({
        role: 'process',
        key: `process:${processes[0].key}`,
        title,
        running: false,
        thinkingCount,
        toolCount,
        errorCount: processes.filter(item => item.isError || item.status === 'failed').length,
        interruptedCount: processes.filter(item =>
          ['cancelled', 'interrupted', 'aborted'].includes(item.status),
        ).length,
        items: processes,
      });
      processes = [];
    };
    const addProcess = process => {
      // Historical reasoning is a display segment, not an execution outcome.
      // A Tool without a known result/status remains directly accessible.
      if (
        !process.display?.keepVisible &&
        (ENDED_PROCESS_STATUSES.has(process.status) ||
          (process.type === 'thinking' && process.status === undefined))
      ) {
        processes.push(process);
      } else {
        flushProcesses();
        entries.push({ role: 'live-process', key: process.key, item: process });
      }
    };
    for (const [itemIndex, item] of (turn.items ?? []).entries()) {
      const compaction = compactionMessage(item);
      if (item.display?.kind === 'unsupported-content') {
        flushProcesses();
        entries.push({
          role: 'system',
          key: itemKey(item, itemIndex, 'system'),
          text: t('desktopContent'),
          display: { ...item.display, keepVisible: true },
        });
      } else if (item.display?.kind === 'phase-boundary') {
        flushProcesses();
        entries.push({
          role: 'phase-boundary',
          key: itemKey(item, itemIndex, 'phase'),
          text: typeof item.text === 'string' ? item.text : '',
        });
      } else if (compaction) {
        flushProcesses();
        entries.push({
          role: 'compaction',
          key: itemKey(item, itemIndex, 'compaction'),
          status: item.status,
          rawMessage: compaction,
          ...(item.display ? { display: item.display } : {}),
        });
      } else if (item.type === 'userMessage') {
        flushProcesses();
        const text = (item.content ?? [])
          .filter(content => content?.type === 'text' && typeof content.text === 'string')
          .map(content => content.text)
          .join('\n');
        if (text || item.rawMessage)
          entries.push({
            role: 'user',
            key: itemKey(item, itemIndex, 'user'),
            text,
            ...(item.id ? { id: item.id } : {}),
            ...(item.pendingInput ? { pendingInput: item.pendingInput } : {}),
            ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
            ...(item.display ? { display: item.display } : {}),
          });
      } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
        flushProcesses();
        entries.push({
          role: 'assistant',
          key: itemKey(item, itemIndex, 'assistant'),
          text: item.text,
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
          ...(item.id ? { id: item.id } : {}),
          ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
          ...(item.display ? { display: item.display } : {}),
        });
      } else if (item.type === 'systemMessage' && typeof item.text === 'string') {
        flushProcesses();
        entries.push({
          role: 'system',
          key: itemKey(item, itemIndex, 'system'),
          text: item.text,
          ...(item.id ? { id: item.id } : {}),
          ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
          ...(item.display ? { display: item.display } : {}),
        });
      } else if (item.type === 'phaseBoundary') {
        flushProcesses();
        entries.push({
          role: 'phase-boundary',
          key: itemKey(item, itemIndex, 'phase'),
          text: typeof item.text === 'string' ? item.text : '',
        });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary ?? []), ...(item.content ?? [])]
          .filter(value => typeof value === 'string' && value)
          .join('\n');
        if (text)
          addProcess({
            key: itemKey(item, itemIndex, 'thinking'),
            id: item.id,
            type: 'thinking',
            text,
            title: t('thinking'),
            status: item.status,
            ...(item.display ? { display: item.display } : {}),
          });
      } else if (item.type === 'toolCall') {
        const process = {
          key: itemKey(item, itemIndex, 'tool'),
          id: item.toolUseId || item.id,
          type: 'tool',
          name: item.toolName,
          title: toolDisplayTitle(item.toolName),
          input: formatSidePanelValue(item.input),
          output: formatSidePanelValue(item.output),
          isError: item.isError === true,
          status: item.status,
          ...(typeof item.progressText === 'string' ? { progressText: item.progressText } : {}),
          ...(item.display ? { display: item.display } : {}),
          ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
        };
        if (item.toolName?.trim().toLowerCase() === 'progress_card') {
          flushProcesses();
          entries.push({
            role: 'progress-receipt',
            key: process.key,
            item: { ...process, input: item.input, output: item.output },
          });
        } else if (typeof item.toolName === 'string' && isPresentPlanToolName(item.toolName)) {
          flushProcesses();
          entries.push({ role: 'live-process', key: process.key, item: process });
        } else {
          addProcess(process);
        }
      }
    }
    flushProcesses();
  }
  return foldBrowserExtensionEntries(entries, {
    protectTrailingTurn: options.protectTrailingTurn === true || Boolean(thread?.activity),
  });
}
