import { beforeEach, expect, test, vi } from 'vitest';

import { SessionReviewIpc } from '../../../shared/cowork/sessionReview';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  load: vi.fn(),
  file: vi.fn(),
  createService: vi.fn(),
  openEditorChooser: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../cowork/review/sessionReviewService', () => ({
  createSessionReviewService: mocks.createService,
}));
vi.mock('../app/shell', () => ({ openPathWithSystemChooser: mocks.openEditorChooser }));

import { registerSessionReviewHandlers } from './sessionReview';

beforeEach(() => {
  mocks.handle.mockReset();
  mocks.load.mockReset();
  mocks.file.mockReset();
  mocks.openEditorChooser.mockReset();
  mocks.createService.mockReset().mockReturnValue({ load: mocks.load, file: mocks.file });
});

const handler = (channel: string): ((...args: unknown[]) => unknown) => {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel);
  expect(registration).toBeDefined();
  return registration![1];
};
const sender = (type: string) => ({ sender: { getType: () => type } });
const query = { sessionId: 'product', scope: 'all' as const };

test('rejects browser guests before invoking review or editor capabilities', async () => {
  const deps = { getRuntime: vi.fn(), getSession: vi.fn() };
  registerSessionReviewHandlers(deps);

  expect(await handler(SessionReviewIpc.Load)(sender('webview'), query)).toEqual({
    success: false,
    reason: 'identity',
  });
  expect(await handler(SessionReviewIpc.File)(sender('webview'), query, 'code.ts', 'editor')).toEqual({
    success: false,
    reason: 'identity',
  });
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.file).not.toHaveBeenCalled();
  expect(deps.getRuntime).not.toHaveBeenCalled();
  expect(deps.getSession).not.toHaveBeenCalled();
  expect(mocks.openEditorChooser).not.toHaveBeenCalled();
});

test('delegates window requests unchanged with the fixed Main editor chooser capability', async () => {
  const deps = { getRuntime: vi.fn(), getSession: vi.fn() };
  const loadResult = { success: false, reason: 'unavailable' };
  const fileResult = { success: true, filePath: 'E:/project/code.ts', relativePath: 'code.ts' };
  mocks.load.mockResolvedValue(loadResult);
  mocks.file.mockResolvedValue(fileResult);
  registerSessionReviewHandlers(deps);

  const serviceDependencies = mocks.createService.mock.calls[0][0];
  const chooserResult = { success: false };
  mocks.openEditorChooser.mockResolvedValue(chooserResult);
  expect(await serviceDependencies.openEditorChooser('E:/project/code.ts')).toBe(chooserResult);
  expect(mocks.openEditorChooser).toHaveBeenCalledWith('E:/project/code.ts');
  expect(mocks.openEditorChooser.mock.contexts[0]).toBeUndefined();
  const getRuntime = vi.fn().mockReturnThis();
  const getSession = vi.fn().mockReturnThis();
  deps.getRuntime = getRuntime;
  deps.getSession = getSession;
  expect(serviceDependencies.getRuntime()).toBe(deps);
  expect(serviceDependencies.getSession('current')).toBe(deps);
  expect(getRuntime).toHaveBeenCalledOnce();
  expect(getSession).toHaveBeenCalledWith('current');
  expect(await handler(SessionReviewIpc.Load)(sender('window'), query)).toBe(loadResult);
  expect(mocks.load).toHaveBeenCalledWith(query);
  expect(await handler(SessionReviewIpc.File)(sender('window'), query, 'code.ts', 'editor')).toBe(fileResult);
  expect(mocks.file).toHaveBeenCalledWith(query, 'code.ts', 'editor');
});
