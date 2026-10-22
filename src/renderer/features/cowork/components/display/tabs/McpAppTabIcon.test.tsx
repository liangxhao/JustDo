// @vitest-environment jsdom
import type { McpAppDiscovery, McpAppPreview } from '@shared/plugins/mcpApps';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '@/libs/openclaw-chat/pipeline/native-mcp-app';

import { WorkspaceFileIconContext } from '../../shared/WorkspaceFileIconContext';
import { McpAppTabIcon } from './McpAppTabIcon';

afterEach(cleanup);
const src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
const catalog: McpAppDiscovery = {
  servers: [
    {
      serverName: 'editor',
      label: 'Editor',
      icons: [{ src }],
      entrypoints: [],
    },
  ],
};
const descriptor = {
  viewId: 'mcp-app-icons',
  serverName: 'editor',
  toolName: 'open',
  uiResourceUri: 'ui://editor/app',
};
function preview() {
  return decodeMcpAppLaunch({
    viewId: descriptor.viewId,
    preview: {
      kind: 'canvas',
      mcpApp: { ...descriptor },
      view: { id: descriptor.viewId, title: 'Document' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
  })!;
}
function fixture() {
  const request = vi.fn(async () => catalog);
  const client = { generation: 1, request };
  const apps = new McpAppSession(() => ({
    client: client as never,
    generation: 1,
    sessionKey: 'agent:a:icons',
    sessionId: 'incarnation',
    isCurrent: () => true,
  }));
  return { apps, request, context: { apps } as McpAppViewContext };
}

test('App Tab icons use the admitted plugin rather than the content title or file extension', async () => {
  const { apps, context, request } = fixture();
  await apps.discover();
  const { container, rerender } = render(
    <McpAppTabIcon preview={preview()} context={context} label="Another plugin.drawio" />,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
  expect(request).toHaveBeenCalledOnce();
  rerender(
    <McpAppTabIcon
      preview={{ ...preview() } as McpAppPreview}
      context={context}
      label="Another plugin.drawio"
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});

test('reserved Tabs use the selected entry icon and loaded Tabs follow catalog removal', async () => {
  const { apps, context, request } = fixture();
  const { container, rerender } = render(<McpAppTabIcon label="Loading" icons={[{ src }]} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
  expect(request).not.toHaveBeenCalled();
  await apps.discover();
  rerender(<McpAppTabIcon preview={preview()} context={context} label="Editor" />);
  request.mockResolvedValueOnce({ servers: [] });
  await act(() => apps.discover());
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

test('a broken plugin image falls back without starting another request', async () => {
  const { apps, context, request } = fixture();
  await apps.discover();
  const { container } = render(
    <McpAppTabIcon preview={preview()} context={context} label="Editor" />,
  );
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

test('the current workspace refreshes icons of adopted home Apps without rebinding them', async () => {
  const { apps, context, request } = fixture();
  await apps.discover();
  const admitted = preview();
  const icon = <McpAppTabIcon preview={admitted} context={context} label="Home editor" />;
  const { container, rerender } = render(icon);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
  act(() => apps.invalidate(true));
  rerender(
    <WorkspaceFileIconContext.Provider value={catalog}>{icon}</WorkspaceFileIconContext.Provider>,
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
  rerender(
    <WorkspaceFileIconContext.Provider value={{ servers: [] }}>
      {icon}
    </WorkspaceFileIconContext.Provider>,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});
