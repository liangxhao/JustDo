import { jsxDEV } from 'react/jsx-dev-runtime';
import { jsx, jsxs } from 'react/jsx-runtime';

/** Preserve React's static-child validation, key/ref handling and development metadata. */
export const appJsxRuntime = Object.freeze({ jsx, jsxs, jsxDEV });
