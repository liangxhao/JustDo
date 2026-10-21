/** Plugin-owned, read-only recovery of an existing native diagram result. */
export const DRAWIO_RESTORE_METHOD = 'drawio.app.restore';
export const DRAWIO_CURRENT_METHOD = 'drawio.app.current';
export const DRAWIO_SERVER = 'drawio';
export const DRAWIO_TOOL = 'create_diagram';
export const DRAWIO_RESOURCE = 'ui://drawio/editor';

export const DRAWIO_CANVAS_METHOD = 'drawio.canvas';
export const DRAWIO_SEND_METHOD = 'drawio.chat.send';
export const DRAWIO_EDIT_TOOL = 'drawio_diagram';
export const DRAWIO_SNAPSHOT_TOOL = 'diagram_snapshot';
export const DRAWIO_APPLY_TOOL = 'diagram_apply';
export const DRAWIO_UPDATE_KIND = 'drawio.diagram-update.v1';
export const DRAWIO_CANVAS_EVENT = 'plugin.drawio.canvas-changed';
export const DRAWIO_ENTRY_TOOLS = ['create_diagram', 'open_editor', 'open_file'] as const;

export interface DiagramSnapshot {
  diagramId: string;
  xml: string;
  title: string;
  contentStamp: string;
}

/** Authenticated desktop host admission, not a server identity returned by mcp.app.view. */
export interface DiagramSource {
  kind: 'desktop-native-admission' | 'native-history-recovery';
  diagramId: string;
  serverName: 'drawio';
  toolName: (typeof DRAWIO_ENTRY_TOOLS)[number];
  uiResourceUri: 'ui://drawio/editor';
  originViewId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
}

export interface PreparedDiagramCanvas {
  token: string;
  viewId: string;
  selected: boolean;
}

export interface DiagramUpdateReceipt extends DiagramSnapshot {
  kind: typeof DRAWIO_UPDATE_KIND;
  source: DiagramSource;
  operationId: string;
  runId: string;
  toolCallId: string;
  baseContentStamp: string;
  status: 'applied';
}

export interface DiagramReference {
  diagramId: string;
  operationId: string;
  toolCallId: string;
  originViewId: string;
  sessionId: string;
  title: string;
}
