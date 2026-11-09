// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspacePicker } from '../conversation-overlay/modules/sidepanel-workspace.js';

describe('Chrome working directory selection', () => {
  let root: HTMLElement;
  let picker: ReturnType<typeof createWorkspacePicker>;
  let request: ReturnType<typeof vi.fn>;
  let onSelected: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  const context = (extra = {}) => ({ threadId: '', draftId: 'draft', cwd: 'E:/当前 项目',
    recentCwds: ['E:/当前 项目', 'E:/another'], disabled: false, ...extra });
  const open = () => root.querySelector<HTMLButtonElement>('.workspace-button')!.click();
  const browse = () => document.querySelector<HTMLButtonElement>('.workspace-popover button')!.click();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    request = vi.fn(); onSelected = vi.fn(); onError = vi.fn();
    picker = createWorkspacePicker(root, { request, onSelected, onError });
    picker.update(context());
  });
  afterEach(() => { picker.dispose(); root.remove(); });

  it('binds a new draft folder to its explicit selection without creating a conversation', async () => {
    request.mockResolvedValue({ cwd: 'E:/中文 path', selectionToken: 'choice' });
    open(); browse(); await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith('chrome/workspace/select', { draftId: 'draft' });
    expect(onSelected).toHaveBeenCalledWith({ cwd: 'E:/中文 path', selectionToken: 'choice' });
    expect(document.querySelector('.workspace-popover')!.classList.contains('hidden')).toBe(true);
  });

  it('saves an existing conversation with its captured expected directory', async () => {
    picker.update(context({ threadId: 'thread' }));
    request.mockResolvedValueOnce({ cwd: 'E:/next', selectionToken: 'choice' })
      .mockResolvedValueOnce({ success: true, cwd: 'E:/next' });
    open(); browse(); await flush();
    expect(request).toHaveBeenNthCalledWith(2, 'chrome/thread/workspace/set', {
      threadId: 'thread', expectedCwd: 'E:/当前 项目', selectionToken: 'choice',
    });
    expect(onSelected).toHaveBeenCalledWith({ cwd: 'E:/next' });
  });

  it('leaves the draft untouched when the system picker is cancelled', async () => {
    request.mockResolvedValue({ cancelled: true });
    open(); browse(); await flush();
    expect(onSelected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('discards a picker result after changing conversation or losing the connection', async () => {
    let resolve!: (value: unknown) => void;
    request.mockReturnValue(new Promise(value => { resolve = value; }));
    open(); browse();
    picker.invalidate();
    picker.update(context({ threadId: 'other' }));
    resolve({ cwd: 'E:/stale', selectionToken: 'old' }); await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onSelected).not.toHaveBeenCalled();
  });

  it('uses the server selection route for recent folders and renders paths as text', async () => {
    picker.update(context({ recentCwds: ['E:/<private>'] }));
    request.mockResolvedValue({ cancelled: true });
    open();
    expect(root.querySelector('private')).toBeNull();
    document.querySelectorAll<HTMLButtonElement>('.workspace-popover button')[1].click();
    await flush();
    expect(request).toHaveBeenCalledWith('chrome/workspace/select', { draftId: 'draft', recentCwd: 'E:/<private>' });
  });

  it('keeps failed save feedback and prevents unavailable selections', async () => {
    picker.update(context({ threadId: 'thread' }));
    request.mockResolvedValueOnce({ cwd: 'E:/next', selectionToken: 'choice' })
      .mockResolvedValueOnce({ success: false, reason: 'busy' });
    open(); browse(); await flush();
    expect(onError).toHaveBeenCalled();
    expect(onSelected).not.toHaveBeenCalled();
    picker.update(context({ disabled: true })); open();
    expect(document.querySelector('.workspace-popover')!.classList.contains('hidden')).toBe(true);
  });
});
