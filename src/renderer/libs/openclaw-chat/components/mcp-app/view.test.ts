// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { McpAppSession } from '../../gateway/mcp-app-session';
import { decodeMcpAppLaunch } from '../../pipeline/native-mcp-app';
import { McpAppView } from './view';

afterEach(() => document.body.replaceChildren());

function waitingFixture() {
  let ready = false;
  const request = vi.fn(async () => {
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
