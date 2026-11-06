import { createBrowserAssistant } from './modules/web-launch-sdk.js';
Object.defineProperty(window, 'browserAssistant', {
  value: createBrowserAssistant(),
  configurable: false,
  writable: false,
});
