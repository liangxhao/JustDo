// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { McpAppSession } from '../../gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '../../pipeline/native-mcp-app';
import { McpAppView } from './view';

afterEach(() => document.body.replaceChildren());

test('retains real read-only and confirmation notices in the compact header layout', async () => {
  const view = new McpAppView();
  const respond = vi.fn();
  view.inactive = true;
  view.confirmation = { text: 'User confirmation is required', purpose: 'draft', respond };
  document.body.append(view);
  await view.updateComplete;
  expect(view.shadowRoot!.querySelector('header .notice')?.textContent).toBe(
    i18nService.t('mcpAppsReadOnly'),
  );
  expect(view.shadowRoot!.querySelector('.confirmation')?.textContent).toContain(
    'User confirmation is required',
  );
  view.shadowRoot!.querySelector<HTMLButtonElement>('.confirmation button:last-child')!.click();
  expect(respond).toHaveBeenCalledWith(false);
});

function waitingFixture() {
  let ready = false;
  const request = vi.fn(async (_method: string) => {
    throw new Error('Test read completed with an unavailable view');
  });
  const client = { generation: 1, request };
  const apps = new McpAppSession(() =>
    ready
      ? {
          client: client as never,
          generation: 1,
          sessionKey: 'agent:a:test',
          sessionId: 'incarnation',
          isCurrent: () => ready,
        }
      : undefined,
  );
  const bind = vi.spyOn(apps, 'bind');
  const descriptor = {
    viewId: 'mcp-app-waiting',
    serverName: 'univer',
    toolName: 'open_editor',
    uiResourceUri: 'ui://univer/app.html',
  };
  const view = new McpAppView();
  view.preview = decodeMcpAppLaunch({
    viewId: descriptor.viewId,
    preview: {
      kind: 'canvas',
      mcpApp: descriptor,
      view: { id: descriptor.viewId, title: 'Univer' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
  });
  view.context = {
    apps,
    sessionKey: 'agent:a:test',
    isCurrent: () => true,
    canDraft: () => true,
    addDraft: async () => false,
  };
  document.body.append(view);
  return {
    view,
    request,
    bind,
    finishBinding: () => {
      ready = true;
      apps.refreshBinding();
    },
  };
}

test('App cards wait for authenticated history binding before issuing a view read', async () => {
  const f = waitingFixture();
  await f.view.updateComplete;
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.view.loading).toBe(true);
  f.finishBinding();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.view.loading).toBe(false));
  expect(f.view.error).not.toBe('');
});

test('a removed waiting App never resumes on a later binding notification', async () => {
  const f = waitingFixture();
  await f.view.updateComplete;
  f.view.remove();
  await Promise.resolve();
  f.finishBinding();
  await Promise.resolve();
  expect(f.request).not.toHaveBeenCalled();
});

test('reloading a message App reads the current view even when chat mutation is unavailable', async () => {
  const f = waitingFixture();
  const context = f.view.context!;
  context.canDraft = () => false;
  context.refresh = vi.fn(async () => {
    throw new Error('Chat mutation is unavailable');
  });
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));

  f.view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();

  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.request).toHaveBeenLastCalledWith(
    'mcp.app.view',
    expect.objectContaining({ viewId: f.view.preview!.viewId }),
    expect.anything(),
  );
  expect(context.refresh).not.toHaveBeenCalled();
});

test.each([
  { title: 'returns focus to retry', moveFocus: false, action: 'retry' },
  { title: 'keeps focus on another control in the card', moveFocus: true, action: 'dismiss' },
])('a failed read $title', async ({ moveFocus, action }) => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  let rejectRead!: (reason: Error) => void;
  f.request.mockImplementationOnce(
    () => new Promise<never>((_, reject) => {
      rejectRead = reject;
    }),
  );
  const root = f.view.shadowRoot!;
  const retry = root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  retry.focus();
  retry.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  if (moveFocus) root.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.focus();

  rejectRead(new Error('View unavailable'));

  await vi.waitFor(() => {
    expect(root.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(root.activeElement?.getAttribute('data-action')).toBe(action);
  });
});

test('changing the captured context during reload discards its response and leaves retry available', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  const original = f.view.context!;
  let finish!: (context: typeof original) => void;
  original.isCurrent = () => false;
  original.refresh = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );

  f.view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
  await vi.waitFor(() => expect(original.refresh).toHaveBeenCalledOnce());
  expect(f.view.shadowRoot!.querySelector('[role="status"]')?.textContent).toContain(
    i18nService.t('mcpAppsLoading'),
  );
  expect(f.view.shadowRoot!.querySelector('[role="status"] .app-loading-indicator')).not.toBeNull();
  const replacement = { ...original, isCurrent: () => true };
  f.view.context = replacement;
  finish({ ...replacement });

  await vi.waitFor(() => expect(f.view.loading).toBe(false));
  expect(f.view.context).toBe(replacement);
  expect(f.request).toHaveBeenCalledOnce();
  f.view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
});

test('the user can reopen an unavailable file using a fresh admitted view', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  const fresh = { ...f.view.context! };
  const descriptor = {
    viewId: 'mcp-app-new-file',
    serverName: 'univer',
    toolName: 'open_editor',
    uiResourceUri: 'ui://univer/app.html',
  };
  const preview = decodeMcpAppLaunch({
    viewId: descriptor.viewId,
    preview: {
      kind: 'canvas',
      mcpApp: descriptor,
      view: { id: descriptor.viewId, title: 'File' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
  })!;
  const reopen = vi.fn(async () => ({ context: fresh, preview }));
  f.view.context!.reopen = reopen;
  (f.view.shadowRoot!.querySelector('.status button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(reopen).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenLastCalledWith(
    'mcp.app.view',
    expect.objectContaining({ viewId: descriptor.viewId }),
    expect.anything(),
  );
});

test('a successful close after reopening does not retain an earlier cleanup warning', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  const first = f.bind.mock.results[0].value;
  vi.spyOn(first, 'close').mockRejectedValueOnce(new Error('Cleanup response unavailable'));
  await f.view.closeApp();
  expect(f.view.contextCleanupUnconfirmed).toBe(true);
  await f.view.updateComplete;

  f.view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="reopen"]')!.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.view.loading).toBe(false));
  await f.view.closeApp();

  expect(f.view.contextCleanupUnconfirmed).toBe(false);
});

test('resuming a stale workspace view reads its original view without reopening the App tool', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  const original = f.view.context!;
  const fresh = { ...original };
  const reopen = vi.fn();
  original.isCurrent = () => false;
  original.resume = vi.fn(() => fresh);
  original.reopen = reopen;

  f.view.resume();

  expect(f.view.error).toBe('');
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.view.context).toBe(fresh);
  expect(f.request.mock.calls.every(call => call[0] === 'mcp.app.view')).toBe(true);
  expect(f.request).toHaveBeenLastCalledWith(
    'mcp.app.view',
    expect.objectContaining({ viewId: f.view.preview!.viewId }),
    expect.anything(),
  );
  expect(reopen).not.toHaveBeenCalled();
  f.view.resume();
  expect(original.resume).toHaveBeenCalledOnce();
});

test('resuming waits for an admitted binding and never reopens a closed App', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  f.view.context!.isCurrent = () => false;
  const resume = vi.fn(() => undefined);
  f.view.context!.resume = resume;
  f.view.resume();
  expect(resume).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledOnce();
  await f.view.closeApp();
  f.view.resume();
  expect(resume).toHaveBeenCalledOnce();
  expect(f.view.closed).toBe(true);
});

test('returning during a stale explicit reopen resumes without waiting or adopting its late result', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  const original = f.view.context!;
  const fresh = { ...original };
  let rejectReopen!: (error: Error) => void;
  const reopen = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectReopen = reject;
      }),
  );
  original.reopen = reopen;
  f.view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
  await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce());
  expect(f.view.loading).toBe(true);
  original.isCurrent = () => false;
  original.resume = () => fresh;
  f.request.mockImplementation(() => new Promise<never>(() => {}));

  f.view.resume();

  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.view.context).toBe(fresh);
  expect(f.view.loading).toBe(true);
  rejectReopen(new Error('Old file open response arrived after navigation'));
  await Promise.resolve();
  await f.view.updateComplete;
  expect(f.view.context).toBe(fresh);
  expect(f.view.error).toBe('');
  expect(f.view.loading).toBe(true);
  expect(reopen).toHaveBeenCalledOnce();
});

test('an expired manual view first tries history and opens a fresh blank editor only on its separate action', async () => {
  const f = waitingFixture();
  const descriptor = { ...f.view.preview!.descriptor!, originSessionKey: f.view.context!.sessionKey };
  const preview = (viewId: string) =>
    decodeMcpAppLaunch({
      viewId,
      preview: {
        kind: 'canvas',
        mcpApp: { ...descriptor, viewId },
        view: { id: viewId, title: 'Editor' },
        presentation: { target: 'assistant_message', sandbox: 'scripts' },
      },
    })!;
  const original = preview(descriptor.viewId);
  const next = preview('mcp-app-replacement');
  f.view.preview = original;
  const context = { ...f.view.context! };
  const open = vi.fn(async () => ({ status: 'opened' as const, preview: next, context }));
  f.view.context!.reopenBlank = { viewId: original.viewId, status: () => 'ready', open };
  f.request.mockRejectedValueOnce(
    Object.assign(new Error('lease expired'), { details: { code: 'MCP_APP_VIEW_EXPIRED' } }),
  ).mockRejectedValueOnce(new Error('Original result unavailable'));
  f.finishBinding();

  const blankButton = () =>
    Array.from(f.view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.status button')).find(
      button => button.textContent?.trim() === i18nService.t('mcpAppsReopenBlank'),
    );
  await vi.waitFor(() => expect(blankButton()).toBeDefined());
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    'mcp.app.view',
    'runtimeServices.mcpAppHistoryView',
  ]);
  expect(open).not.toHaveBeenCalled();

  blankButton()!.click();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3));
  expect(open).toHaveBeenCalledOnce();
  expect(f.view.preview).toBe(next);
  expect(f.request).toHaveBeenLastCalledWith(
    'mcp.app.view',
    expect.objectContaining({ viewId: next.viewId }),
    expect.anything(),
  );
});

test('closing a view aborts its explicit reopen before pending file preparation can finish', async () => {
  const f = waitingFixture();
  f.finishBinding();
  await vi.waitFor(() => expect(f.view.error).not.toBe(''));
  let finish!: () => void;
  const stage = new Promise<void>(resolve => { finish = resolve; });
  const launch = vi.fn();
  const reopen = vi.fn(async (signal?: AbortSignal) => {
    await stage;
    signal?.throwIfAborted();
    return launch();
  });
  f.view.context!.reopen = reopen;
  f.view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
  await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce());
  const signal = reopen.mock.calls[0][0];
  expect(signal?.aborted).toBe(false);
  await f.view.closeApp();
  expect(signal?.aborted).toBe(true);
  finish();
  await Promise.resolve();
  expect(launch).not.toHaveBeenCalled();
  expect(f.view.closed).toBe(true);
});

test('an unconfirmed blank launch stays visible if reading the original view later fails generically', async () => {
  const f = waitingFixture();
  const open = vi.fn();
  f.view.context!.reopenBlank = {
    viewId: f.view.preview!.viewId,
    status: () => 'unknown',
    open,
  };

  f.finishBinding();

  await vi.waitFor(() => expect(f.view.shadowRoot!.querySelector('.status')?.textContent)
    .toContain(i18nService.t('mcpAppsOperationUnknown')));
  expect(f.view.shadowRoot!.querySelector('.status')?.textContent)
    .not.toContain(i18nService.t('mcpAppsReopenBlank'));
  expect(open).not.toHaveBeenCalled();
});
