export const COWORK_SESSION_LIST_ACTION_EVENT = 'cowork:session-list-action';

export type CoworkSessionListAction = 'copy' | 'export';

export interface CoworkSessionListActionDetail {
  action: CoworkSessionListAction;
  sessionId: string;
  memberSessionId?: string;
}

export const requestCoworkSessionListAction = (detail: CoworkSessionListActionDetail): void => {
  window.dispatchEvent(
    new CustomEvent<CoworkSessionListActionDetail>(COWORK_SESSION_LIST_ACTION_EVENT, { detail }),
  );
};
