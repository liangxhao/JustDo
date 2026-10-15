// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { McpServerConfig } from '@/features/plugins/mcp/mcp';

import McpServerFormModal from './McpServerFormModal';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));

const server: McpServerConfig = {
  id: 'docs-id',
  name: 'docs',
  description: '',
  enabled: true,
  transportType: 'stdio',
  command: 'npx',
  requestTimeoutSeconds: 120,
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 1,
};

describe('McpServerFormModal request timeout override', () => {
  afterEach(cleanup);

  test('offers a collapsed sanitized Markdown preview without duplicating the editor by default', () => {
    const { container } = render(
      <McpServerFormModal
        isOpen
        server={{ ...server, description: '**Useful**\n\n- one\n\n<script>alert(1)</script>' }}
        existingNames={[server.name]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const preview = screen.getByText('mcpDescriptionPreview').closest('details')!;
    expect(preview.open).toBe(false);
    fireEvent.click(screen.getByText('mcpDescriptionPreview'));
    expect(screen.getByText('Useful').tagName).toBe('STRONG');
    expect(screen.getByText('one').tagName).toBe('LI');
    expect(container.querySelector('script')).toBeNull();
  });

  test('edits an override and restores the visible default when cleared', async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true });
    render(
      <McpServerFormModal
        isOpen
        server={server}
        defaultRequestTimeoutSeconds={240}
        existingNames={[server.name]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const input = screen.getByLabelText('mcpRequestTimeout') as HTMLInputElement;
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '300' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestTimeoutSeconds: 300 }),
    );

    fireEvent.change(input, { target: { value: '' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestTimeoutSeconds: 240 }),
    );
  });

  test('shows the current global value at the end when the server has no override', async () => {
    const onSave = vi.fn().mockResolvedValue({ success: true });
    render(
      <McpServerFormModal
        isOpen
        server={{ ...server, requestTimeoutSeconds: undefined }}
        defaultRequestTimeoutSeconds={240}
        existingNames={[server.name]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const input = screen.getByLabelText('mcpRequestTimeout') as HTMLInputElement;
    expect(input.value).toBe('240');
    expect(input.getAttribute('placeholder')).toBeNull();
    expect(document.getElementById('mcp-request-timeout-description')).toBeNull();

    const commandInput = screen.getByPlaceholderText('mcpCommandPlaceholder');
    expect(commandInput.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('requestTimeoutSeconds');

    fireEvent.change(input, { target: { value: '300' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' })));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestTimeoutSeconds: 300 }),
    );
  });

  test('rejects an out-of-range override', () => {
    const onSave = vi.fn();
    render(
      <McpServerFormModal
        isOpen
        server={server}
        existingNames={[server.name]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText('mcpRequestTimeout'), {
      target: { value: '86401' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));

    expect(screen.getByText('mcpRequestTimeoutInvalid')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  test('offers deletion only from an existing server detail form', () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <McpServerFormModal
        isOpen
        server={server}
        existingNames={[server.name]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteButton = screen.getByRole('button', { name: 'deleteMcpServer' });
    expect(deleteButton.textContent).toBe('');
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();

    rerender(
      <McpServerFormModal
        isOpen
        existingNames={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />,
    );
    expect(screen.queryByRole('button', { name: 'deleteMcpServer' })).toBeNull();
  });

  test('keeps a save busy, blocks duplicate submissions and closing, then allows retrying a failure', async () => {
    let finish!: (result: { success: boolean; error?: string }) => void;
    const onSave = vi
      .fn()
      .mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
      .mockResolvedValueOnce({ success: true });
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const onProbe = vi.fn();
    const view = render(
      <McpServerFormModal
        isOpen
        server={server}
        existingNames={[server.name]}
        onClose={onClose}
        onDelete={onDelete}
        onProbe={onProbe}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
    const saving = screen.getByRole('button', { name: 'saving' });
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(saving.querySelector('.animate-spin')).toBeTruthy();
    expect(saving.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'deleteMcpServer' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(saving);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'deleteMcpServer' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    const backdrop = view.container.querySelector('[data-workspace-overlay="true"]')!;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    const testButton = screen.getByRole('button', { name: 'mcpTestSavedConfiguration' });
    expect(testButton.textContent).toBe('mcpTestShort');
    expect((testButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(testButton);
    expect(onProbe).not.toHaveBeenCalled();

    await act(async () => finish({ success: false, error: 'Native save refused' }));
    expect(screen.getByText('Native save refused')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'saveMcpServer' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    expect(retry.getAttribute('aria-busy')).toBeNull();
    await act(async () => fireEvent.click(retry));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a late save for a previous form cannot close or report failure on its replacement', async () => {
    let finish!: (result: { success: boolean; error?: string }) => void;
    const onSave = vi.fn(
      () => new Promise<{ success: boolean; error?: string }>(resolve => (finish = resolve)),
    );
    const onClose = vi.fn();
    const view = render(
      <McpServerFormModal
        isOpen
        server={server}
        existingNames={[server.name]}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
    const replacement = { ...server, id: 'other-server', name: 'Other server' };
    view.rerender(
      <McpServerFormModal
        isOpen
        server={replacement}
        existingNames={[replacement.name]}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    await act(async () => finish({ success: true }));

    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText('mcpServerNamePlaceholder') as HTMLInputElement).value,
    ).toBe(replacement.name);
    expect(screen.getByRole('button', { name: 'saveMcpServer' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  test('an unexpected save rejection remains visible and releases the busy state', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Unexpected transport failure'));
    const onClose = vi.fn();
    render(
      <McpServerFormModal
        isOpen
        server={server}
        existingNames={[server.name]}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));

    await screen.findByText('Unexpected transport failure');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'saveMcpServer' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
