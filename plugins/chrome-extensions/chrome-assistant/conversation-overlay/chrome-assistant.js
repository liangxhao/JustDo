import { createChromeAssistant } from './modules/web-launch-sdk.js';
Object.defineProperty(window, 'chromeAssistant', {
  value: createChromeAssistant(),
  configurable: false,
  writable: false,
});
