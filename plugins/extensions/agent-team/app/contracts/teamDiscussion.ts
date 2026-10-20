export * from '../../contracts/teamDiscussion';

export const TeamDiscussionIpc = {
  Participation: 'teamDiscussion:participation',
  CreateTask: 'teamDiscussion:createTask',
  List: 'teamDiscussion:list',
  Create: 'teamDiscussion:create',
  Read: 'teamDiscussion:read',
  Send: 'teamDiscussion:send',
  Enqueue: 'teamDiscussion:enqueue',
  CancelPending: 'teamDiscussion:cancelPending',
  Stop: 'teamDiscussion:stop',
  Delete: 'teamDiscussion:delete',
} as const;

export type TeamDiscussionResult<T> =
  { success: true; value: T } | { success: false; error: string };
