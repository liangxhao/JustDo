import path from 'node:path';

import { version } from '../../../../package.json';
import { ExternalSessionStatus } from '../../../shared/integrations/externalSession';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { AppServerResult } from '../../appServer/appServerProtocol';
import type { ExternalAgentModel, ExternalAgentThread, ExternalAgentThreadMetadata } from './externalAgentTypes';

export const CodexTurnStatus = {
  InProgress: 'inProgress',
  Completed: 'completed',
  Failed: 'failed',
  Interrupted: 'interrupted',
} as const;
export type CodexTurnStatus = (typeof CodexTurnStatus)[keyof typeof CodexTurnStatus];

export const codexInitializeResult = (home: string): AppServerResult => ({
  userAgent: `${PRODUCT_NAME}/codex-compatible`,
  codexHome: path.resolve(home),
  platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
  platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
});

export const codexModelProvider = (modelRef?: string): string => {
  const separator = modelRef?.indexOf('/') ?? -1;
  return separator > 0 ? modelRef!.slice(0, separator) : '';
};

export const codexModel = (model: ExternalAgentModel): AppServerResult => ({
  id: model.id,
  model: model.id,
  displayName: model.name,
  description: '',
  hidden: false,
  isDefault: model.isDefault,
  // The desktop owns reasoning defaults; "none" would falsely promise disabled reasoning.
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'default',
  inputModalities: ['text'],
  supportsPersonality: false,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  modelSpecialty: null,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
});

export const codexThreadStatus = (metadata: ExternalAgentThreadMetadata, loaded: boolean): AppServerResult =>
  !loaded
    ? { type: 'notLoaded' }
    : metadata.status === ExternalSessionStatus.Running
      ? { type: 'active', activeFlags: [] }
      : { type: 'idle' };

export const codexThread = (
  metadata: ExternalAgentThreadMetadata,
  loaded = false,
): AppServerResult => ({
  id: metadata.id,
  sessionId: metadata.id,
  forkedFromId: null,
  parentThreadId: null,
  preview: '', // Native history is authoritative; metadata reads do not fetch message bodies.
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: 'legacy',
  modelProvider: codexModelProvider(metadata.modelRef),
  model: metadata.modelRef ?? null,
  reasoningEffort: null,
  createdAt: Math.floor(metadata.createdAt / 1000),
  updatedAt: Math.floor(metadata.updatedAt / 1000),
  recencyAt: Math.floor(metadata.updatedAt / 1000),
  status: codexThreadStatus(metadata, loaded),
  path: null,
  cwd: metadata.cwd,
  cliVersion: version,
  originator: null,
  // CLI, ACP and app-server deliberately share this persisted origin namespace.
  source: 'cli',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: metadata.name,
  turns: [],
});

export const codexThreadOpen = (
  thread: ExternalAgentThread,
  metadata: ExternalAgentThreadMetadata,
  interactiveApprovals = false,
): AppServerResult => {
  const model = thread.modelRef ?? metadata.modelRef;
  if (!model) throw new Error('The selected model is unavailable.');
  return {
    thread: codexThread({ ...metadata, modelRef: model }, true),
    model,
    modelProvider: codexModelProvider(model),
    cwd: thread.cwd,
    serviceTier: null,
    // The host enforces native permissions; this only describes client presentation.
    approvalPolicy: interactiveApprovals ? 'on-request' : 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'externalSandbox', networkAccess: 'enabled' },
    permissionMode: metadata.permissionMode,
    reasoningEffort: null,
  };
};

export const codexTurn = (
  id: string,
  status: CodexTurnStatus,
  options: { error?: string; startedAt?: number; completedAt?: number } = {},
): AppServerResult => ({
  id,
  items: [],
  itemsView: 'notLoaded',
  status,
  error: options.error ? { message: options.error, codexErrorInfo: null, additionalDetails: null } : null,
  startedAt: options.startedAt === undefined ? null : Math.floor(options.startedAt / 1000),
  completedAt: options.completedAt === undefined ? null : Math.floor(options.completedAt / 1000),
  durationMs: options.startedAt === undefined || options.completedAt === undefined
    ? null : Math.max(0, options.completedAt - options.startedAt),
});
