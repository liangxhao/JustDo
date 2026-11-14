export const COWORK_SESSION_LIST_ACTION_EVENT = 'cowork:session-list-action';

export interface CoworkSessionListActionDetail {
  action: 'copy';
  sessionId: string;
}

export const requestCoworkSessionListAction = (detail: CoworkSessionListActionDetail): void => {
  window.dispatchEvent(
    new CustomEvent<CoworkSessionListActionDetail>(COWORK_SESSION_LIST_ACTION_EVENT, { detail }),
  );
};
