// @vitest-environment jsdom
import type { SwarmFlowDetail } from '@shared/cowork/swarmFlow';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SwarmNodeIntervention from './SwarmNodeIntervention';

afterEach(cleanup);
const detail: SwarmFlowDetail = {
  flowId: 'flow',
  nodeId: 'verify',
  sessionKey: 'native',
  workingDirectory: '/project',
  submission: 'submitted',
  revision: 3,
  canNote: true,
  canContinue: true,
  canRetry: true,
  interventions: [],
};
function fixture(current = detail) {
  i18nService.setLanguage('en', { persist: false });
  const send = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { interveneSwarmFlow: send } },
  });
  const onChanged = vi.fn();
  const props = { sessionId: 'product', detail: current, disabled: false, onChanged };
  const view = render(<SwarmNodeIntervention {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Human input' }));
  return { ...view, send, props, onChanged };
}
test('continues with explicit text and refreshes both the node and graph after acceptance', async () => {
  const f = fixture();
  const input = screen.getByRole('textbox', { name: 'Add input for this node' });
  fireEvent.change(input, { target: { value: '  Environment fixed  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send and continue (same session)' }));
  await screen.findByText('Action accepted.');
  expect(f.send).toHaveBeenCalledWith('product', 'flow', 'verify', 3, {
    id: expect.any(String),
    action: 'continue',
    text: 'Environment fixed',
  });
  expect((input as HTMLTextAreaElement).value).toBe('');
  expect(f.onChanged).toHaveBeenCalledOnce();
});
test('keeps draft and request identity after a lost reply and reconciles a later accepted note', async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({ success: false });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Additional evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save input' }));
  await screen.findByRole('alert');
  expect((input as HTMLTextAreaElement).value).toBe('Additional evidence');
  fireEvent.click(screen.getByRole('button', { name: 'Save input' }));
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.send.mock.calls[1][4]).toEqual(f.send.mock.calls[0][4]);
  f.rerender(
    <SwarmNodeIntervention
      {...f.props}
      detail={{
        ...detail,
        revision: 4,
        interventions: [{ ...f.send.mock.calls[0][4], createdAt: 1 }],
      }}
    />,
  );
  await screen.findByText('Action accepted.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe('');
  expect(f.container.querySelector('[data-user-message]')!.shadowRoot!.textContent).toContain(
    'Additional evidence',
  );
});
test('running or uncertain nodes only save notes and stale details disable submissions', async () => {
  const f = fixture({ ...detail, canContinue: false, canRetry: false });
  expect(screen.queryByRole('button', { name: 'Send and continue (same session)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rerun this node (new session)' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use latest source' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await screen.findByText('Action accepted.');
  expect(f.send.mock.calls[0][4].action).toBe('note');
  f.rerender(<SwarmNodeIntervention {...f.props} disabled />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
});

test.each(['failure', 'lost reply'])('keeps polling acceptance after a late %s', async outcome => {
  const f = fixture();
  let resolve!: (result: { success: boolean }) => void;
  let reject!: (error: Error) => void;
  f.send.mockImplementation(
    () =>
      new Promise((accept, fail) => {
        resolve = accept;
        reject = fail;
      }),
  );
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Accepted evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save input' }));
  f.rerender(
    <SwarmNodeIntervention
      {...f.props}
      detail={{
        ...detail,
        revision: 4,
        interventions: [{ ...f.send.mock.calls[0][4], createdAt: 1 }],
      }}
    />,
  );
  await screen.findByText('Action accepted.');
  expect(input.value).toBe('');
  if (outcome === 'failure') resolve({ success: false });
  else reject(new Error('lost reply'));
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Action accepted.');
  expect(f.send).toHaveBeenCalledOnce();
});
test('reruns only the selected node and never offers a force-success action', async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Rerun this node (new session)' }));
  await screen.findByText('Action accepted.');
  expect(f.send.mock.calls[0][4]).toMatchObject({ action: 'retry', text: '' });
});

test('renders human input with native Markdown and safe rich message controls', () => {
  const f = fixture({
    ...detail,
    interventions: [
      {
        id: 'input',
        action: 'note',
        createdAt: 1,
        text: '**Latest evidence**\n\n> A reviewed source\n\n- Keep existing work\n- Check the result\n\n```js\nconst done = true;\n```\n\n<script>window.bad = true</script>\n\n[unsafe](javascript:alert(1))',
      },
    ],
  });
  const shadow = f.container.querySelector('[data-user-message]')!.shadowRoot!;
  expect(shadow.querySelector('strong')?.textContent).toBe('Latest evidence');
  expect(shadow.querySelector('blockquote')?.textContent).toContain('A reviewed source');
  expect(shadow.querySelectorAll('.chat-bubble li')).toHaveLength(2);
  expect(shadow.querySelector('code')?.textContent).toContain('const done = true;');
  expect(shadow.querySelector('button[aria-label="' + i18nService.t('copy') + '"]')).not.toBeNull();
  expect(shadow.querySelector('script')).toBeNull();
  expect(shadow.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(screen.getByRole('list', { name: 'Human input history' })).toBeTruthy();
});

test('does not submit a Chinese IME composition and blocks repeated sends awaiting acceptance', async () => {
  const f = fixture();
  let accept!: (result: { success: boolean }) => void;
  f.send.mockImplementation(
    () =>
      new Promise(resolve => {
        accept = resolve;
      }),
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '补充说明' } });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 });
  expect(f.send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.click(screen.getByRole('button', { name: 'Send and continue (same session)' }));
  expect(f.send).toHaveBeenCalledOnce();
  expect((input as HTMLTextAreaElement).disabled).toBe(true);
  accept({ success: true });
  await screen.findByText('Action accepted.');
});
