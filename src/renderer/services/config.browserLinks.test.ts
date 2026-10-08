import { BrowserLinkTarget } from '@shared/browser/browserLinkOpening';
import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';

const store = vi.hoisted(() => ({ getItem: vi.fn(), patchAppConfig: vi.fn() }));
vi.mock('@/services/store', () => ({ localStore: { getItem: store.getItem } }));
import { ConfigService } from './config';

afterEach(() => vi.unstubAllGlobals());

test('loads defaults for absent or invalid browser link targets and preserves saved choices on reload', async () => {
  let saved = { ...defaultConfig };
  store.getItem.mockImplementation(async () => saved);
  store.patchAppConfig.mockImplementation(async patch => {
    saved = { ...saved, ...patch };
    return saved;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: { store: { patchAppConfig: store.patchAppConfig } },
  });
  store.getItem.mockResolvedValueOnce({
    ...defaultConfig,
    browserWebLinkTarget: 'invalid',
    browserHtmlLinkTarget: undefined,
  });
  const service = new ConfigService();
  await service.init();
  expect(service.getConfig().browserWebLinkTarget).toBe(BrowserLinkTarget.Chrome);
  expect(service.getConfig().browserHtmlLinkTarget).toBe(BrowserLinkTarget.Embedded);
  await service.updateConfig({
    browserWebLinkTarget: BrowserLinkTarget.Embedded,
    browserHtmlLinkTarget: BrowserLinkTarget.Chrome,
  });
  await service.reloadFromStore();
  expect(service.getConfig()).toMatchObject({
    browserWebLinkTarget: BrowserLinkTarget.Embedded,
    browserHtmlLinkTarget: BrowserLinkTarget.Chrome,
    browserMode: defaultConfig.browserMode,
  });
});
