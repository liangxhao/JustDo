import type { PluginKind } from './marketplace';

export const PluginOperationIpc = {
  Progress: 'plugins:operation:progress',
} as const;

export const PluginOperationAction = {
  INSTALL: 'install',
  UPDATE: 'update',
  REMOVE: 'remove',
  ENABLE: 'enable',
  DISABLE: 'disable',
  SAVE: 'save',
  SYNC: 'sync',
} as const;

export type PluginOperationAction =
  (typeof PluginOperationAction)[keyof typeof PluginOperationAction];

export const PluginOperationStage = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  PREPARING_PACKAGE: 'preparing_package',
  FETCHING_METADATA: 'fetching_metadata',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  VALIDATING: 'validating',
  CONVERTING: 'converting',
  PREPARING_RUNTIME: 'preparing_runtime',
  INSTALLING: 'installing',
  INSTALLING_DEPENDENCIES: 'installing_dependencies',
  SAVING_CONFIGURATION: 'saving_configuration',
  ENABLING: 'enabling',
  DISABLING: 'disabling',
  UNINSTALLING: 'uninstalling',
  APPLYING_CONFIGURATION: 'applying_configuration',
  RESTARTING_GATEWAY: 'restarting_gateway',
  CONFIRMING: 'confirming',
  REFRESHING_INVENTORY: 'refreshing_inventory',
  CLEANING_UP: 'cleaning_up',
  ROLLING_BACK: 'rolling_back',
} as const;

export type PluginOperationStage = (typeof PluginOperationStage)[keyof typeof PluginOperationStage];

/** Correlation only. Progress never grants permission or establishes an outcome. */
export interface PluginOperationContext {
  requestId: string;
}

export interface PluginOperationProgress extends PluginOperationContext {
  kind: PluginKind;
  action: PluginOperationAction;
  stage: PluginOperationStage;
  elapsedMs: number;
}

/** Outcome evidence is returned by the mutation; progress cannot establish it. */
export interface PluginOperationFeedback {
  failedStage?: PluginOperationStage;
  /** The install persisted even though a later step did not complete. */
  installationCommitted?: true;
  /** A native install was admitted but its result remains unconfirmed. */
  installSourceInUse?: true;
  /** The native mutation was admitted but its final state cannot yet be verified. */
  operationUnconfirmed?: true;
  /** The mutation completed, but the following inventory read failed. */
  refreshWarning?: true;
}

const operationStages = new Set<string>(Object.values(PluginOperationStage));

export const toPluginOperationStage = (stage: string): PluginOperationStage | undefined =>
  operationStages.has(stage) ? (stage as PluginOperationStage) : undefined;
