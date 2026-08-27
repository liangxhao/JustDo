// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { McpServerConfig } from '@/features/plugins/types/mcp';

import McpServerFormModal from './McpServerFormModal';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
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

  test('edits an override and restores the visible default when cleared', () => {
    const onSave = vi.fn();
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
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestTimeoutSeconds: 300 }),
    );

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestTimeoutSeconds: 240 }),
    );
  });

  test('shows the current global value at the end when the server has no override', () => {
    const onSave = vi.fn();
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

    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('requestTimeoutSeconds');

    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'saveMcpServer' }));
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
});
