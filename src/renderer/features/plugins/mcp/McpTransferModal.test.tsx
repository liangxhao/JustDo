// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { McpTransferModal } from './McpTransferModal';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) =>
      ({
        mcpTransferSelectRow: 'Select {name}',
        mcpTransferImportCount: 'Import {count}',
        mcpTransferExportCount: 'Export {count}',
      })[key] ?? key,
  },
}));

const bridge = {
  previewImport: vi.fn<typeof window.electron.mcp.previewImport>(),
  listExport: vi.fn<typeof window.electron.mcp.listExport>(),
  previewExport: vi.fn<typeof window.electron.mcp.previewExport>(),
  saveExport: vi.fn<typeof window.electron.mcp.saveExport>(),
};

const onImport = vi.fn<typeof window.electron.mcp.commitImport>();
const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electron', { configurable: true, value: { mcp: bridge } });
});
afterEach(cleanup);

const open = (knownNames: string[] = []) =>
  render(
    <McpTransferModal knownNames={new Set(knownNames)} onClose={onClose} onImport={onImport} />,
  );

test('previews pasted connections, requires transport and rename choices, and imports selected rows once', async () => {
  const text = '{ "mcpServers": {} }';
  bridge.previewImport.mockResolvedValue({
    success: true,
    value: {
      token: 'preview-token',
      format: 'mcpServers',
      rows: [
        { index: 0, name: 'search', transportType: 'http', conflict: true },
        { index: 1, name: 'endpoint', connectionSummary: 'https://tools.example/mcp' },
        { index: 2, name: 'local', transportType: 'stdio' },
        { index: 3, name: 'malformed', issue: 'missing-command' },
      ],
    },
  });
  onImport.mockResolvedValue({
    success: true,
    value: { imported: [{ id: 'one', name: 'search-2' }], skipped: 3 },
  });
  open(['search']);
  fireEvent.change(screen.getByRole('textbox', { name: 'mcpTransferPaste' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'mcpTransferPreview' }));
  await screen.findByText('mcpTransferImportPreview');
  expect(bridge.previewImport).toHaveBeenCalledWith({ kind: 'text', text });
  expect(onImport).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('checkbox', { name: 'Select search' }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('checkbox', { name: 'Select endpoint' }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('checkbox', { name: 'Select malformed' }) as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select local' }));
  fireEvent.click(screen.getByRole('button', { name: 'mcpTransferRename' }));
  fireEvent.click(screen.getByRole('button', { name: 'mcpTransferApplyRename' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'mcpDetailTransport' }), {
    target: { value: 'sse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'mcpTransferConfirmTransport' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));
  await screen.findByText('mcpTransferImportDone');
  expect(onImport).toHaveBeenCalledExactlyOnceWith({
    token: 'preview-token',
    selection: [
      { index: 0, name: 'search-2' },
      { index: 1, transportType: 'sse' },
    ],
  });
  expect(screen.getByText('mcpTransferImportDoneDetail')).toBeTruthy();
});

test('keeps user selection when a name conflict is refreshed at commit', async () => {
  const rows = [
    { index: 0, name: 'taken', transportType: 'stdio' as const },
    { index: 1, name: 'unchecked', transportType: 'stdio' as const },
    { index: 2, name: 'keep', transportType: 'stdio' as const },
  ];
  bridge.previewImport.mockResolvedValue({
    success: true,
    value: { token: 'initial', format: 'servers', rows },
  });
  onImport
    .mockResolvedValueOnce({
      success: false,
      code: 'conflict',
      conflictingIndices: [0],
      preview: {
        token: 'updated',
        format: 'servers',
        rows: [{ ...rows[0], conflict: true }, ...rows.slice(1)],
      },
    })
    .mockResolvedValueOnce({ success: false, code: 'apply-failed' });
  open();
  fireEvent.click(screen.getByRole('button', { name: /mcpTransferChooseFile/ }));
  await screen.findByText('mcpTransferImportPreview');
  expect(bridge.previewImport).toHaveBeenCalledWith({ kind: 'file' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select unchecked' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));
  await screen.findByText('mcpTransfer.error.conflict');
  expect(
    (screen.getByRole('checkbox', { name: 'Select unchecked' }) as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByRole('checkbox', { name: 'Select taken' }) as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));
  await screen.findByText('mcpTransfer.error.apply-failed');
  expect(onImport).toHaveBeenLastCalledWith({ token: 'updated', selection: [{ index: 2 }] });
  fireEvent.click(screen.getByRole('button', { name: 'mcpTransferEditSource' }));
  expect(screen.getByRole('textbox', { name: 'mcpTransferPaste' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import 1' })).toBeNull();
});

test('saves the JSON preview for the current export selection and preserves it when cancelled', async () => {
  bridge.listExport.mockResolvedValue({
    success: true,
    value: [
      { id: 'id-a', name: 'search', transportType: 'http' },
      { id: 'id-b', name: 'tools', transportType: 'stdio' },
    ],
  });
  bridge.previewExport.mockImplementation(async ({ ids }) => ({
    success: true,
    value: { token: ids.join(','), json: JSON.stringify(ids) },
  }));
  bridge.saveExport
    .mockResolvedValueOnce({ success: false, code: 'cancelled' })
    .mockResolvedValueOnce({ success: true, value: { count: 1, filePath: 'C:/Example/mcp.json' } });
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'mcpTransferExport' }));
  await screen.findByText('["id-a","id-b"]');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select tools' }));
  await screen.findByText('["id-a"]');
  fireEvent.click(screen.getByRole('button', { name: 'Export 1' }));
  await waitFor(() => expect(bridge.saveExport).toHaveBeenCalledExactlyOnceWith('id-a'));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Export 1' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export 1' }));
  await screen.findByText('C:/Example/mcp.json');
  expect(bridge.saveExport).toHaveBeenLastCalledWith('id-a');
});

test('previews current credential options and cannot save a stale selection', async () => {
  bridge.listExport.mockResolvedValue({
    success: true,
    value: [{ id: 'id-a', name: 'search', transportType: 'http' }],
  });
  let completePreview!: (value: Awaited<ReturnType<typeof bridge.previewExport>>) => void;
  bridge.previewExport
    .mockResolvedValueOnce({ success: true, value: { token: 'names', json: 'names only' } })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          completePreview = resolve;
        }),
    );
  bridge.saveExport.mockResolvedValue({ success: false, code: 'cancelled' });
  open();
  fireEvent.click(screen.getByRole('tab', { name: 'mcpTransferExport' }));
  await screen.findByText('names only');

  const headers = screen.getByRole('checkbox', {
    name: 'mcpTransferExportHeaderValues',
  }) as HTMLInputElement;
  const env = screen.getByRole('checkbox', {
    name: 'mcpTransferExportEnvValues',
  }) as HTMLInputElement;
  expect(headers.checked).toBe(false);
  expect(env.checked).toBe(false);
  fireEvent.click(headers);
  expect(screen.getByText('mcpTransferExportPlaintext')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Export 1' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await waitFor(() =>
    expect(bridge.previewExport).toHaveBeenLastCalledWith({
      ids: ['id-a'],
      includeEnvValues: false,
      includeHeaderValues: true,
    }),
  );
  completePreview({ success: true, value: { token: 'headers', json: 'headers masked' } });
  await screen.findByText('headers masked');
  fireEvent.click(screen.getByRole('button', { name: 'Export 1' }));
  expect(bridge.saveExport).toHaveBeenCalledExactlyOnceWith('headers');
});
