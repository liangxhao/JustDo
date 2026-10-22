import type { McpAppIcon, McpAppPreview } from '@shared/plugins/mcpApps';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { isNativeMcpAppPreview } from '@/libs/openclaw-chat/pipeline/native-mcp-app';

export const MCP_APP_WORKSPACE_EVENT = 'mcp-app-workspace-entry';
export const MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT = 'mcp-app-workspace-controls-close';
export interface McpAppWorkspaceEntry {
  id: string;
  sessionId: string;
  preview: McpAppPreview;
  context: McpAppViewContext;
  filePath?: string;
  label?: string;
}
export interface McpAppWorkspaceLoadEntry {
  id: string;
  sessionId: string;
  filePath?: string;
  label: string;
  /** Display-only icons from the chosen plugin entry, before a view exists. */
  icons?: readonly McpAppIcon[];
  retryable?: boolean;
  load: (signal: AbortSignal) => Promise<{
    preview: McpAppPreview;
    context: McpAppViewContext;
  }>;
}
export interface McpAppWorkspaceFileEntry extends McpAppWorkspaceLoadEntry {
  filePath: string;
}
export interface McpAppWorkspaceControlsEntry {
  id: string;
  sessionId: string;
  label: string;
  icons?: readonly McpAppIcon[];
  isCurrent: () => boolean;
  attach: (element: HTMLElement | null) => void;
  onClose: () => void;
}
export type McpAppWorkspaceItem =
  McpAppWorkspaceEntry | McpAppWorkspaceLoadEntry | McpAppWorkspaceControlsEntry;
const entries = new WeakSet<object>();
export function openWorkspaceApp(entry: McpAppWorkspaceEntry): void {
  if (!isNativeMcpAppPreview(entry.preview) || !entry.context.isCurrent()) return;
  entries.add(entry);
  window.dispatchEvent(new CustomEvent(MCP_APP_WORKSPACE_EVENT, { detail: entry }));
}
/** Reserve the file tab before native preparation; the tab owns its local wait. */
export function openWorkspaceAppFile(entry: McpAppWorkspaceFileEntry): void {
  openWorkspaceAppLaunch(entry);
}
export function openWorkspaceAppLaunch(entry: McpAppWorkspaceLoadEntry): void {
  entries.add(entry);
  window.dispatchEvent(new CustomEvent(MCP_APP_WORKSPACE_EVENT, { detail: entry }));
}
export function openWorkspaceAppControls(entry: McpAppWorkspaceControlsEntry): void {
  if (!entry.isCurrent()) return;
  entries.add(entry);
  window.dispatchEvent(new CustomEvent(MCP_APP_WORKSPACE_EVENT, { detail: entry }));
}
export function closeWorkspaceAppControls(entry: McpAppWorkspaceControlsEntry): void {
  if (!entries.has(entry)) return;
  window.dispatchEvent(new CustomEvent(MCP_APP_WORKSPACE_CONTROLS_CLOSE_EVENT, { detail: entry }));
}
export const isWorkspaceAppEntry = (value: unknown): value is McpAppWorkspaceItem =>
  Boolean(value && typeof value === 'object' && entries.has(value));
