export type BrowserConnectionVerificationState = {
  user: boolean;
  extension: boolean;
};

export type BrowserConnectionVerificationAction =
  | { type: 'reset' }
  | { type: 'set-user'; verified: boolean }
  | { type: 'set-extension'; verified: boolean };

export const initialBrowserConnectionVerificationState: BrowserConnectionVerificationState = {
  user: false,
  extension: false,
};

export const browserConnectionVerificationReducer = (
  state: BrowserConnectionVerificationState,
  action: BrowserConnectionVerificationAction,
): BrowserConnectionVerificationState => {
  switch (action.type) {
    case 'reset':
      return initialBrowserConnectionVerificationState;
    case 'set-user':
      return { ...state, user: action.verified };
    case 'set-extension':
      return { ...state, extension: action.verified };
  }
};
