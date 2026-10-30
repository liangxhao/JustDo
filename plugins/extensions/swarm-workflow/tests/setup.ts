import { afterAll, afterEach, beforeEach } from 'vitest';
import { installBrowserRuntime } from '@app-plugin/build/testing';
import { bindBrowserHost } from '../app/browser/workflowBrowserPorts';
import { createBrowserHost, resetBrowserPorts, runtime } from './browserRuntime';

const restore = installBrowserRuntime(runtime);
let controller: AbortController;
let unbind: () => void;
beforeEach(() => {
  resetBrowserPorts();
  controller = new AbortController();
  unbind = bindBrowserHost(createBrowserHost(controller.signal));
});
afterEach(() => {
  controller.abort();
  unbind();
});
afterAll(restore);
