import { BrowserMode } from '@shared/browser/browser';
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
    browserMode: undefined,
    browserWebLinkTarget: 'invalid',
    browserHtmlLinkTarget: undefined,
  });
  const service = new ConfigService();
  await service.init();
  expect(service.getConfig().browserMode).toBe(BrowserMode.Embedded);
  expect(service.getConfig().browserWebLinkTarget).toBe(BrowserLinkTarget.Embedded);
  expect(service.getConfig().browserHtmlLinkTarget).toBe(BrowserLinkTarget.Embedded);
  await service.updateConfig({
    browserMode: BrowserMode.Isolated,
    browserWebLinkTarget: BrowserLinkTarget.Chrome,
    browserHtmlLinkTarget: BrowserLinkTarget.Chrome,
  });
  await service.reloadFromStore();
  expect(service.getConfig()).toMatchObject({
    browserWebLinkTarget: BrowserLinkTarget.Chrome,
    browserHtmlLinkTarget: BrowserLinkTarget.Chrome,
    browserMode: BrowserMode.Isolated,
  });
});
