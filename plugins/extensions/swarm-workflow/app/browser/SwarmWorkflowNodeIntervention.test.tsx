// @vitest-environment jsdom
import type { SwarmWorkflowDetail } from '../contracts/index';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SwarmWorkflowNodeIntervention from './SwarmWorkflowNodeIntervention';

afterEach(cleanup);
const detail: SwarmWorkflowDetail = {
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
    value: { cowork: { interveneSwarmWorkflow: send } },
  });
  const onChanged = vi.fn();
  const props = { sessionId: 'product', detail: current, disabled: false, onChanged };
  const view = render(<SwarmWorkflowNodeIntervention {...props} />);
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
    text: '  Environment fixed  ',
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
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Send not confirmed. Your draft is still here; try again.');
  expect(alert.contains(input)).toBe(false);
  expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  expect((input as HTMLTextAreaElement).value).toBe('Additional evidence');
  saveOnly();
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.send.mock.calls[1][4]).toEqual(f.send.mock.calls[0][4]);
  f.rerender(
    <SwarmWorkflowNodeIntervention
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
  expect(f.container.querySelector('[data-user-message]')).toBeNull();
});
test('running or uncertain nodes only save notes and stale details disable submissions', async () => {
  const f = fixture({ ...detail, canContinue: false, canRetry: false });
  expect(screen.queryByRole('button', { name: 'Send and continue (same session)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rerun this node' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use latest source' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await screen.findByText('Input saved.');
  expect(f.send.mock.calls[0][4].action).toBe('note');
  f.rerender(<SwarmWorkflowNodeIntervention {...f.props} disabled />);
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
    <SwarmWorkflowNodeIntervention
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

test('removes the input panel and saved messages when a continued node finishes', async () => {
  const f = fixture();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Environment fixed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send and continue (same session)' }));
  await screen.findByText('Continuation requested.');
  const interventions = [{ ...f.send.mock.calls[0][4], createdAt: 1 }];
  f.rerender(
    <SwarmWorkflowNodeIntervention
      {...f.props}
      detail={{ ...detail, revision: 4, canContinue: false, canRetry: false, interventions }}
    />,
  );
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  f.rerender(
    <SwarmWorkflowNodeIntervention
      {...f.props}
      detail={{
        ...detail,
        revision: 5,
        status: 'done',
        canNote: false,
        canContinue: false,
        canRetry: false,
        interventions,
      }}
    />,
  );
  expect(f.container.childElementCount).toBe(0);
  expect(f.send).toHaveBeenCalledOnce();
});

test('keeps only an unconfirmed-send alert after input becomes unavailable and reconciles acceptance', async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error('lost reply'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Additional evidence' } });
  saveOnly();
  await screen.findByRole('alert');
  const closed = { ...detail, canNote: false, canContinue: false, canRetry: false };
  const prior = { id: 'prior', action: 'note' as const, text: 'Prior evidence', createdAt: 1 };
  f.rerender(
    <SwarmWorkflowNodeIntervention {...f.props} detail={{ ...closed, interventions: [prior] }} />,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Human input history' })).toBeNull();
  expect(f.container.querySelector('[data-user-message]')).toBeNull();
  f.rerender(
    <SwarmWorkflowNodeIntervention
      {...f.props}
      detail={{
        ...closed,
        revision: 4,
        interventions: [prior, { ...f.send.mock.calls[0][4], createdAt: 2 }],
      }}
    />,
  );
  await waitFor(() => expect(f.container.childElementCount).toBe(0));
  expect(f.send).toHaveBeenCalledOnce();
});

test('keeps only the composer without duplicating saved human messages', () => {
  const f = fixture({
    ...detail,
    interventions: [
      {
        id: 'input',
        action: 'note',
        createdAt: 1,
        text: 'Saved evidence',
      },
      { id: 'continue', action: 'continue', createdAt: 2, text: 'Environment fixed' },
      { id: 'retry', action: 'retry', createdAt: 3, text: 'Use the corrected input' },
    ],
  });
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  expect(f.container.querySelector('[data-user-message]')).toBeNull();
  expect(screen.queryByText('Saved evidence')).toBeNull();
  expect(screen.queryByText('Environment fixed')).toBeNull();
  expect(screen.queryByText('Use the corrected input')).toBeNull();
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

test('offers one icon send action with a descriptive label and explains optional actions in the menu', async () => {
  const f = fixture();
  expect(screen.queryByRole('button', { name: 'Human input' })).toBeNull();
  expect(screen.queryByText('Add input to continue this node in its existing session.')).toBeNull();
  expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBeNull();
  const sendButton = screen.getByRole('button', { name: 'Send and continue (same session)' });
  expect(sendButton.textContent).toBe('');
  expect(sendButton.title).toBe('Send and continue (same session) · Ctrl/⌘ + Enter');
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
    <SwarmWorkflowNodeIntervention
      {...f.props}
      detail={{ ...detail, canContinue: false, canRetry: false }}
    />,
  );
  const saveButton = screen.getByRole('button', { name: 'Save input' });
  expect(saveButton.textContent).toBe('');
  expect(saveButton.title).toBe('Save input · Ctrl/⌘ + Enter');
  expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  expect(screen.queryByText('This input will be read on the next run.')).toBeNull();
});
