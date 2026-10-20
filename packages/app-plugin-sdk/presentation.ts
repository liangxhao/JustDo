import type { ComponentType, ReactNode } from 'react';
export interface GatewayMessage {
  role: string;
  content?: string | GatewayContentBlock[];
  text?: string;
  timestamp?: number;
  ts?: number;
  id?: string;
  __openclaw?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface GatewayContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: string | GatewayContentBlock[];
  [key: string]: unknown;
}
export interface Subtask {
  id: string;
  taskName: string;
  sessionKey: string;
  label: string;
  labelSource: 'taskName' | 'label' | 'task';
  status: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout' | 'blocked' | 'unknown';
  sessionId?: string;
  runtime?: 'subagent' | 'acp';
  swarmGroupId?: string;
  agentId?: string;
  task?: string;
  runId?: string;
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  runtimeSampledAt?: number;
  lifecycleRequestSequence?: number;
  totalTokens?: number;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  lastActivity?: string;
  lastToolName?: string;
  toolUseCount?: number;
}
export interface ComposerFeatureItem {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  section?: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect(): void;
  children?: ComposerFeatureItem[];
  backLabel?: string;
  role?: 'menuitem' | 'menuitemradio';
}
export interface AppPrimitives {
  LoadingDots: ComponentType;
  ChatAvatar: ComponentType<{
    role: 'user' | 'assistant';
    peer?: { id: string; label: string; color?: string };
  }>;
  PreviewMarkdown: ComponentType<{ html: string; mermaidIdPrefix: string }>;
  LocalSpeechInputButton: ComponentType<{ disabled: boolean; onTranscript(text: string): void }>;
  SessionSubtaskButton: ComponentType<{
    sessionId: string;
    parentRunning: boolean;
    onOpenSubtask(task: Subtask, sessionId: string): void;
  }>;
  RunControlButton: ComponentType<{
    isRunning: boolean;
    isStopping: boolean;
    canSubmit: boolean;
    canQueue?: boolean;
    size: 'normal' | 'large';
    sendTitle: string;
    sendLabel?: string;
    sendText?: string;
    onStop?(): void;
    onSend(): void;
  }>;
  UserMessageContent: ComponentType<{
    message: GatewayMessage;
    workingDirectory?: string;
    compact?: boolean;
  }>;
  ComposerFeatureMenu: ComponentType<{
    items: ComposerFeatureItem[];
    label: string;
    disabled?: boolean;
    backLabel?: string;
    className?: string;
    triggerIcon?: ReactNode;
  }>;
  ChatMessageDisplay: ComponentType<{
    gatewayMessages?: GatewayMessage[];
    fullWidth?: boolean;
    peerPerspective?: boolean;
    className?: string;
    assistantName?: string;
    assistantId?: string;
    workingDirectory?: string;
  }>;
}
export interface AppRendering {
  toSanitizedMarkdownHtml(text: string): string;
  normalizeMessage(
    message: unknown,
    options?: { peerPerspective?: boolean },
  ): {
    role: string;
    timestamp: number;
    content: (
      | { type: 'text' | 'tool_call' | 'tool_result'; text?: string; args?: unknown }
      | { type: string }
    )[];
  };
}
