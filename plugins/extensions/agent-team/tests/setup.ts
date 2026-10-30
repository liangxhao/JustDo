import { installBrowserRuntime } from '@app-plugin/build/testing';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';

import { bindBrowserHost } from '../app/browser/ports';
import { createBrowserHost, runtime } from './browserRuntime';

vi.mock('../app/browser/state', () => import('./fixtures/state'));
const restore = installBrowserRuntime(runtime);
let controller: AbortController;
let unbind: () => void;
beforeEach(async () => {
  controller = new AbortController();
  unbind = bindBrowserHost(await createBrowserHost(controller.signal));
});
afterEach(() => { controller.abort(); unbind(); });
afterAll(restore);
