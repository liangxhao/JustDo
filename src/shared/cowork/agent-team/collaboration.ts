export * from '../../../../plugins/extensions/agent-team/contracts/collaboration';
export * from '../../../../plugins/extensions/agent-team/contracts/collaborationGraph';

export const CollaborationIpc = {
  Read: 'collaboration:read',
  ReadMessages: 'collaboration:read-messages',
  List: 'collaboration:list',
  Create: 'collaboration:create',
  Stop: 'collaboration:stop',
  StopMember: 'collaboration:stop-member',
  PrepareContinuation: 'collaboration:prepare-continuation',
} as const;
