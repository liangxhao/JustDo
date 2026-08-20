import { describe, expect, test, vi } from 'vitest';

import {
  deferFilePreviewGrantRevocation,
  getFilePreviewEditorLanguage,
  hasUnsavedFilePreviewChanges,
  isFilePreviewCleanAfterSave,
  isValidJsonDocument,
  runFilePreviewSingleFlight,
} from './filePreviewEditor';

describe('file preview editor state', () => {
  test.each([
    ['.md', 'markdown'],
    ['.markdown', 'markdown'],
    ['.json', 'json'],
    ['.txt', 'plaintext'],
    ['.yaml', 'yaml'],
    ['.yml', 'yaml'],
    ['.toml', 'ini'],
    ['.ini', 'ini'],
    ['.xml', 'xml'],
    ['.csv', 'plaintext'],
    ['.log', 'plaintext'],
    ['.conf', 'ini'],
    ['.properties', 'ini'],
    ['.js', 'javascript'],
    ['.jsx', 'javascript'],
    ['.ts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.html', 'html'],
    ['.css', 'css'],
    ['.scss', 'scss'],
    ['.less', 'less'],
    ['.py', 'python'],
    ['.sh', 'shell'],
    ['.bash', 'shell'],
    ['.ps1', 'powershell'],
    ['.bat', 'bat'],
    ['.java', 'java'],
    ['.go', 'go'],
    ['.rs', 'rust'],
    ['.c', 'cpp'],
    ['.h', 'cpp'],
    ['.cpp', 'cpp'],
    ['.cs', 'csharp'],
    ['.sql', 'sql'],
  ] as const)('maps %s files to the %s Monaco language', (extension, language) => {
    expect(getFilePreviewEditorLanguage(extension)).toBe(language);
  });

  test('detects unsaved changes by comparing the exact draft content', () => {
    expect(hasUnsavedFilePreviewChanges('same', 'same')).toBe(false);
    expect(hasUnsavedFilePreviewChanges('same\n', 'same')).toBe(true);
  });

  test.each(['{}', '{"enabled":true}', '[1, 2, 3]'])(
    'accepts a valid JSON document: %s',
    content => {
      expect(isValidJsonDocument(content)).toBe(true);
    },
  );

  test.each(['', '{', '{enabled:true}'])('rejects an invalid JSON document: %s', content => {
    expect(isValidJsonDocument(content)).toBe(false);
  });

  test('deduplicates an in-flight save and permits a later retry', async () => {
    const holder: { current: Promise<boolean> | null } = { current: null };
    let resolveFirst: ((value: boolean) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveFirst = resolve;
        }),
    );

    const first = runFilePreviewSingleFlight(holder, operation);
    const duplicate = runFilePreviewSingleFlight(holder, operation);

    expect(duplicate).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    resolveFirst?.(true);
    await first;

    const retry = runFilePreviewSingleFlight(holder, async () => false);
    await expect(retry).resolves.toBe(false);
    expect(retry).not.toBe(first);
  });

  test('does not consider navigation safe when the draft changes during a save', async () => {
    let draft = 'old draft';
    let savedContent = 'baseline';
    let finishSave: (() => void) | undefined;
    const save = new Promise<void>(resolve => {
      finishSave = resolve;
    });
    const cleanAfterSave = isFilePreviewCleanAfterSave(
      save,
      () => draft,
      () => savedContent,
    );

    draft = 'new input typed while saving';
    savedContent = 'old draft';
    finishSave?.();

    await expect(cleanAfterSave).resolves.toBe(false);
  });

  test('cancels StrictMode simulated cleanup revocation but revokes on real unmount', () => {
    const scheduled: Array<() => void> = [];
    const revoke = vi.fn();
    const cancelSimulatedCleanup = deferFilePreviewGrantRevocation('edit-token', revoke, callback =>
      scheduled.push(callback),
    );

    cancelSimulatedCleanup();
    scheduled.shift()?.();
    expect(revoke).not.toHaveBeenCalled();

    deferFilePreviewGrantRevocation('edit-token', revoke, callback => scheduled.push(callback));
    scheduled.shift()?.();
    expect(revoke).toHaveBeenCalledWith('edit-token');
  });
});
