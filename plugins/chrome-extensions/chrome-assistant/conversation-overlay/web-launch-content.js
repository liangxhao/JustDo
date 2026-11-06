import { installWebLaunchContent } from './modules/web-launch-content.js';
const key = Symbol.for('browser-conversation-content');
if (!globalThis[key]) globalThis[key] = installWebLaunchContent();
