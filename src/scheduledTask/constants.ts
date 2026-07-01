export const ScheduleKind = {
  At: 'at',
  Every: 'every',
  Cron: 'cron',
} as const;
export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

// ─── Payload Kind ───────────────────────────────────────────────────────────
export const PayloadKind = {
  AgentTurn: 'agentTurn',
  SystemEvent: 'systemEvent',
} as const;
export type PayloadKind = (typeof PayloadKind)[keyof typeof PayloadKind];

// ─── Delivery Mode ──────────────────────────────────────────────────────────
export const DeliveryMode = {
  None: 'none',
  Announce: 'announce',
  Webhook: 'webhook',
} as const;
export type DeliveryMode = (typeof DeliveryMode)[keyof typeof DeliveryMode];

export const SessionTarget = {
  Main: 'main',
  Isolated: 'isolated',
} as const;
export type SessionTarget = (typeof SessionTarget)[keyof typeof SessionTarget];

// ─── Wake Mode ──────────────────────────────────────────────────────────────
export const WakeMode = {
  Now: 'now',
  NextHeartbeat: 'next-heartbeat',
} as const;
export type WakeMode = (typeof WakeMode)[keyof typeof WakeMode];

export const TaskStatus = {
  Success: 'success',
  Error: 'error',
  Skipped: 'skipped',
  Running: 'running',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ─── Gateway Status (OpenClaw wire format) ────────────────────────────────���─
export const GatewayStatus = {
  Ok: 'ok',
  Error: 'error',
  Skipped: 'skipped',
} as const;
export type GatewayStatus = (typeof GatewayStatus)[keyof typeof GatewayStatus];

export const DefaultAgentId = 'main' as const;

export const IpcChannel = {
  List: 'scheduledTask:list',
  Get: 'scheduledTask:get',
  Create: 'scheduledTask:create',
  Update: 'scheduledTask:update',
  Delete: 'scheduledTask:delete',
  Toggle: 'scheduledTask:toggle',
  RunManually: 'scheduledTask:runManually',
  Stop: 'scheduledTask:stop',
  ListRuns: 'scheduledTask:listRuns',
  CountRuns: 'scheduledTask:countRuns',
  ListAllRuns: 'scheduledTask:listAllRuns',
  ResolveSession: 'scheduledTask:resolveSession',
  ListChannels: 'scheduledTask:listChannels',
  ListChannelConversations: 'scheduledTask:listChannelConversations',
  StatusUpdate: 'scheduledTask:statusUpdate',
  RunUpdate: 'scheduledTask:runUpdate',
  Refresh: 'scheduledTask:refresh',
} as const;
