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
  const toggle = screen.getByRole('button', { name: 'Human input' });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return { ...view, send, props, onChanged };
}

function saveOnly() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save without continuing' }));
}
test('continues with explicit text and refreshes both the node and graph after acceptance', async () => {
  const f = fixture();
  const input = screen.getByRole('textbox', { name: 'Add input for this node' });
  fireEvent.change(input, { target: { value: '  Environment fixed  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send and continue (same session)' }));
  await screen.findByText('Continuation requested.');
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
  saveOnly();
  await screen.findByRole('alert');
  expect((input as HTMLTextAreaElement).value).toBe('Additional evidence');
  saveOnly();
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
  await screen.findByText('Input saved.');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe('');
  expect(f.container.querySelector('[data-user-message]')!.shadowRoot!.textContent).toContain(
    'Additional evidence',
  );
});
test('running or uncertain nodes only save notes and stale details disable submissions', async () => {
  const f = fixture({ ...detail, canContinue: false, canRetry: false });
  expect(screen.queryByRole('button', { name: 'Send and continue (same session)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rerun this node' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use latest source' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await screen.findByText('Input saved.');
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
  saveOnly();
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
  await screen.findByText('Input saved.');
  expect(input.value).toBe('');
  if (outcome === 'failure') resolve({ success: false });
  else reject(new Error('lost reply'));
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Input saved.');
  expect(f.send).toHaveBeenCalledOnce();
});
test('reruns only the selected node and never offers a force-success action', async () => {
  const f = fixture();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rerun this node' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rerun this node' }));
  await screen.findByText('Rerun requested.');
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
  await screen.findByText('Continuation requested.');
});

test('offers one primary send action and explains optional save and rerun in the menu', async () => {
  const f = fixture();
  expect(screen.getByRole('button', { name: 'Human input' }).getAttribute('aria-expanded')).toBe(
    'true',
  );
  expect(screen.getByRole('button', { name: 'Send and continue (same session)' }).textContent).toBe(
    'Send & continue',
  );
  expect(screen.queryByRole('button', { name: 'Save input' })).toBeNull();
  expect(screen.queryByText('Save without continuing')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Evidence for later' } });
  fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'ArrowDown' });
  const save = screen.getByRole('menuitem', { name: 'Save without continuing' });
  expect(document.activeElement).toBe(save);
  expect(screen.getByText('Keep this input for later without starting work.')).toBeTruthy();
  expect(screen.getByText('Rerun this node in a new session; keep completed stages.')).toBeTruthy();
  fireEvent.click(save);
  await screen.findByText('Input saved.');
  expect(f.send.mock.calls[0][4].action).toBe('note');
  expect(screen.queryByRole('menu')).toBeNull();
  f.rerender(
    <SwarmNodeIntervention
      {...f.props}
      detail={{ ...detail, canContinue: false, canRetry: false }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Save input' }).textContent).toBe('Send input');
  expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  expect(screen.getByText('This input will be read on the next run.')).toBeTruthy();
});
