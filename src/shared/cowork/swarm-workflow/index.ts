// Application bridge only; workflow protocol and prompt behavior belong to the plugin.
export * from '../../../../openclaw-extensions/swarm-workflow/contracts/api';
export * from '../../../../openclaw-extensions/swarm-workflow/contracts/events';
export * from '../../../../openclaw-extensions/swarm-workflow/contracts/options';
export * from '../../../../openclaw-extensions/swarm-workflow/contracts/workflow';
export * from '../../../../openclaw-extensions/swarm-workflow/prompt/request';

export const SwarmWorkflowIpc = {
  Prepare: 'cowork:swarm-workflow:prepare',
  List: 'cowork:swarm-workflow:list',
  Activity: 'cowork:swarm-workflow:activity',
  Summary: 'cowork:swarm-workflow:summary',
  Changed: 'cowork:swarm-workflow:changed',
  Control: 'cowork:swarm-workflow:control',
  Detail: 'cowork:swarm-workflow:detail',
  Intervene: 'cowork:swarm-workflow:intervene',
  Batch: 'cowork:swarm-workflow:batch',
  RetryBatch: 'cowork:swarm-workflow:retry-batch',
} as const;
