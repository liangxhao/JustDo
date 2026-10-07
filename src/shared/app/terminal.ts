export const TerminalIpc = {
  Create: 'terminal:create',
  Write: 'terminal:write',
  Resize: 'terminal:resize',
  Close: 'terminal:close',
  Data: 'terminal:data',
  Exit: 'terminal:exit',
  Status: 'terminal:status',
} as const;

export const TerminalGateway = {
  Open: 'terminal.open',
  Input: 'terminal.input',
  Resize: 'terminal.resize',
  Close: 'terminal.close',
  Attach: 'terminal.attach',
  Data: 'terminal.data',
  Exit: 'terminal.exit',
  OffsetCapability: 'terminal-offset-seq',
} as const;

export interface TerminalCreateRequest {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
}

export interface TerminalCreateResult {
  success: boolean;
  cwd?: string;
  error?: string;
}

export interface TerminalWriteRequest {
  id: string;
  data: string;
}

export interface TerminalResizeRequest {
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
  reset?: boolean;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number | null;
}

export interface TerminalStatusEvent {
  id: string;
  ready: boolean;
  failed?: boolean;
}

export interface TerminalActionResult {
  success: boolean;
  error?: string;
}
