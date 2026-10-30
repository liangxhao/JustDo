// @vitest-environment jsdom
import type { AppBrowserHost, AppBrowserModule } from '@app-plugin/sdk/browser';
import type { AppPluginBridge, AppPluginSnapshot } from '@app-plugin/sdk/contracts';
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { ApprovalKind } from '@shared/security/approvals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { AppBrowserRegistry } from '../../../plugins/app/browserRegistry';
import type { CoworkInteractionRequest, CoworkInteractionResult } from '../../coworkTypes';
import ExecApprovalModal from '../approvals/ExecApprovalModal';
import CoworkQuestionFloatingWindow from './CoworkQuestionFloatingWindow';
import { questionSourceLabel, visibleQuestionQueue } from './questionQueue';
import { QuestionSurface } from './QuestionSurface';

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposers.splice(0).forEach(dispose => dispose());
});

const snapshot = (epoch = 'first', active = true): AppPluginSnapshot => ({
  id: 'question-owner',
  hash: 'b'.repeat(64),
  version: '1.0.0',
  epoch,
  state: active ? 'active' : 'prepared',
  installed: true,
  browserEntry: `/assets/app-plugins/${'b'.repeat(64)}/${epoch}/browser.mjs`,
  commands: ['question.read'],
  slots: [
    'interactions.presentation',
    'plugin.settings',
    'plugin.history',
    'workspace.tab',
    'composer.mode',
  ],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture(load?: (url: string) => Promise<AppBrowserModule>) {
  const state = { visible: true, ownerDocument: undefined as Document | undefined };
  const hosts: AppBrowserHost[] = [];
  const invoke = vi.fn().mockResolvedValue({ success: true });
  const bridge: AppPluginBridge = {
    snapshot: async () => [],
    invoke,
    onChanged: () => () => undefined,
  };
  const module: AppBrowserModule = {
    register(host) {
      hosts.push(host);
      for (const slot of ['plugin.settings', 'plugin.history', 'workspace.tab'] as const)
        host.registerView({ id: slot, slot, labelKey: slot, component: () => null });
      host.registerMode({ id: 'group', labelKey: 'Group', prepare: async input => input });
      host.registerInteractionPresentation(key =>
        key.startsWith('group:')
          ? {
              visible: state.visible,
              label: `Member ${key.slice('group:'.length)}`,
              ownerDocument: state.ownerDocument,
            }
          : undefined,
      );
    },
  };
  const registry = new AppBrowserRegistry(
    bridge,
    {
      t: key => key,
      translations: () => () => undefined,
      components: {},
      renderHistory: () => null,
    },
    load ?? (async () => module),
  );
  disposers.push(() => registry.dispose());
  return { state, hosts, invoke, registry, module };
}

const question = (
  requestId: string,
  overrides: Partial<CoworkInteractionRequest> = {},
): CoworkInteractionRequest => ({
  requestId,
  sessionId: 'source-chat',
  toolName: 'ask_user_question',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolInput: {
    sessionKey: `group:${requestId}`,
    questions: [
      {
        id: 'same-question-id',
        question: 'Choose the next action',
        options: [
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ],
      },
    ],
  },
  origin: {
    sessionKey: `group:${requestId}`,
    nativeSessionId: `native-${requestId}`,
    pluginId: 'question-owner',
    epoch: 'first',
    available: true,
    createdAt: requestId === 'one' ? 1 : 2,
  },
  ...overrides,
});

/** Exercise the same public registry, filtering, portal and real dialogs composed by App. */
function Questions({
  registry,
  interactions,
  respond,
  approval = false,
  currentSessionId = 'source-chat',
  visible = true,
  sourceViewVisible = true,
}: {
  registry: AppBrowserRegistry;
  interactions: CoworkInteractionRequest[];
  respond: (id: string, result: CoworkInteractionResult) => Promise<boolean>;
  approval?: boolean;
  currentSessionId?: string;
  visible?: boolean;
  sourceViewVisible?: boolean;
}) {
  useSyncExternalStore(registry.subscribe, registry.getContextRevision);
  const [selected, setSelected] = useState<string | null>(null);
  const queue = visibleQuestionQueue(interactions, {
    currentSessionId,
    visible,
    sourceViewVisible,
    presentation: key => registry.interactionPresentation(key),
    isPluginCurrent: (id, epoch) => registry.isBusinessCurrent(id, epoch),
  });
  const current = queue.find(item => item.requestId === selected) ?? queue[0];
  return (
    <>
      {interactions.map(interaction => {
        const presentation = registry.interactionPresentation(interaction.toolInput.sessionKey);
        return (
          <QuestionSurface key={interaction.requestId} target={presentation?.ownerDocument}>
            <CoworkQuestionFloatingWindow
              interaction={interaction}
              isVisible={!approval && current?.requestId === interaction.requestId}
              sourceLabel={questionSourceLabel(interaction, presentation)}
              queue={queue.map(item => ({ id: item.requestId, label: questionSourceLabel(item) }))}
              onSelectRequest={setSelected}
              onRespond={result => respond(interaction.requestId, result)}
            />
          </QuestionSurface>
        );
      })}
      {approval && (
        <ExecApprovalModal
          approval={{
            id: 'approval-from-another-child',
            kind: ApprovalKind.Exec,
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
            request: { command: 'echo verify', sessionKey: 'native:third-child' },
          }}
          onExpire={() => undefined}
          onResolve={async () => undefined}
        />
      )}
    </>
  );
}

function writeOtherAnswer(text: string, target = document.body) {
  const query = within(target);
  fireEvent.click(query.getByRole('radio', { name: /Other|其他/ }));
  fireEvent.change(query.getByRole('textbox'), { target: { value: text } });
}

test('concurrent identical questions keep separate drafts through real permission approval and reply only to the selected child', async () => {
  const { registry } = fixture();
  await registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  const interactions = [question('one'), question('two')];
  const view = (approval = false) => (
    <Questions {...{ registry, interactions, respond, approval }} />
  );
  const { rerender } = render(view());
  writeOtherAnswer('First child draft');
  fireEvent.click(screen.getByRole('button', { name: /Question 2|问题 2/ }));
  writeOtherAnswer('Second child draft');
  const form = screen.getByRole('dialog');

  rerender(view(true));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('alertdialog')).not.toBe(form);
  expect(screen.getByText('echo verify')).toBeTruthy();
  expect(respond).not.toHaveBeenCalled();
  rerender(view());
  expect(screen.getByRole('dialog')).toBe(form);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Second child draft');
  fireEvent.click(screen.getByRole('button', { name: /Question 1|问题 1/ }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('First child draft');
  fireEvent.click(screen.getByRole('button', { name: /Submit current selection|提交当前选择/ }));
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    'one',
    expect.objectContaining({
      updatedInput: expect.objectContaining({
        answers: { 'same-question-id': { selected: [], other: 'First child draft' } },
      }),
    }),
  );
});

test('a hidden group keeps its form draft while another chat and the source view stay unchanged', async () => {
  const { registry, state, hosts } = fixture();
  await registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  render(
    <Questions
      registry={registry}
      interactions={[question('one')]}
      respond={respond}
      currentSessionId="another-chat"
      sourceViewVisible={false}
    />,
  );
  writeOtherAnswer('Group draft');
  const form = screen.getByRole('dialog');
  act(() => {
    state.visible = false;
    hosts[0].interactionContextChanged();
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
  act(() => {
    state.visible = true;
    hosts[0].interactionContextChanged();
  });
  expect(screen.getByRole('dialog')).toBe(form);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Group draft');
});

test('hot disable withdraws settings/history/modes and owned questions while leaving Native-only questions available', async () => {
  const { registry, hosts } = fixture();
  await registry.update([snapshot()]);
  const standalone = question('native-only', {
    sessionId: '',
    toolInput: { ...question('native-only').toolInput, sessionKey: 'native:standalone' },
    origin: {
      sessionKey: 'native:standalone',
      nativeSessionId: 'exact-standalone',
      available: true,
    },
  });
  const respond = vi.fn().mockResolvedValue(true);
  render(
    <Questions
      registry={registry}
      interactions={[question('one'), standalone]}
      respond={respond}
    />,
  );
  expect(registry.getViews().map(view => view.slot)).toEqual([
    'plugin.settings',
    'plugin.history',
    'workspace.tab',
  ]);
  expect(registry.getModes()).toHaveLength(1);
  await act(async () => {
    await registry.update([snapshot('first', false)]);
  });
  expect(registry.getViews()).toHaveLength(0);
  expect(registry.getModes()).toHaveLength(0);
  expect(hosts[0].signal.aborted).toBe(true);
  expect(screen.getByText('native:standalone')).toBeTruthy();
  expect(screen.queryByText('Member one')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'First' }));
  fireEvent.click(screen.getByRole('button', { name: /Submit current selection|提交当前选择/ }));
  expect(respond).toHaveBeenCalledExactlyOnceWith('native-only', expect.anything());
});

test('re-enabling the same artifact cannot revive an old epoch question or submit its retained draft', async () => {
  const { registry } = fixture();
  await registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  const old = question('one');
  const { rerender } = render(
    <Questions registry={registry} interactions={[old]} respond={respond} />,
  );
  writeOtherAnswer('Old epoch draft');
  await act(async () => {
    await registry.update([snapshot('first', false)]);
  });
  await act(async () => {
    await registry.update([snapshot('second')]);
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  const current = question('two', { origin: { ...question('two').origin!, epoch: 'second' } });
  rerender(<Questions registry={registry} interactions={[old, current]} respond={respond} />);
  expect(screen.getByText('Member two')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /Question 2|问题 2/ })).toBeNull();
  expect(respond).not.toHaveBeenCalled();
});

test('a question moves back from a closing secondary window during approval without resetting its form or answering it', async () => {
  const { registry, state } = fixture();
  const frame = document.createElement('iframe');
  document.body.append(frame);
  disposers.push(() => frame.remove());
  const secondary = frame.contentDocument!;
  state.ownerDocument = secondary;
  await registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  const interactions = [question('one')];
  const view = (approval = false) => (
    <Questions {...{ registry, interactions, respond, approval }} />
  );
  const { rerender } = render(view());
  writeOtherAnswer('Secondary-window draft', secondary.body);
  const form = within(secondary.body).getByRole('dialog');
  rerender(view(true));
  fireEvent(secondary.defaultView!, new secondary.defaultView!.Event('pagehide'));
  expect(document.body.contains(form)).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  rerender(view());
  expect(screen.getByRole('dialog')).toBe(form);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Secondary-window draft');
  expect(respond).not.toHaveBeenCalled();
});

test('late Browser registration cannot restore old entries or an old question after another epoch is admitted', async () => {
  const pending = deferred<AppBrowserModule>();
  let current!: AppBrowserModule;
  const f = fixture(url => (url.includes('/first/') ? pending.promise : Promise.resolve(current)));
  current = f.module;
  const oldUpdate = f.registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  render(<Questions registry={f.registry} interactions={[question('one')]} respond={respond} />);
  await act(async () => {
    await f.registry.update([snapshot('second')]);
  });
  await act(async () => {
    pending.resolve(f.module);
    await oldUpdate;
  });
  expect(f.hosts).toHaveLength(1);
  expect(f.registry.isBusinessCurrent('question-owner', 'first')).toBe(false);
  expect(f.registry.isBusinessCurrent('question-owner', 'second')).toBe(true);
  expect(f.registry.getViews().every(view => view.epoch === 'second')).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
});

test('an unanswered form survives replay and view changes while its exact availability can withdraw it', async () => {
  const { registry } = fixture();
  await registry.update([snapshot()]);
  const respond = vi.fn().mockResolvedValue(true);
  const first = question('one');
  const view = (interactions: CoworkInteractionRequest[], visible = true) => (
    <Questions {...{ registry, interactions, respond, visible }} />
  );
  const { rerender } = render(view([first]));
  writeOtherAnswer('Retain through replay');
  const form = screen.getByRole('dialog');
  rerender(view([structuredClone(first)], false));
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(view([structuredClone(first)]));
  expect(screen.getByRole('dialog')).toBe(form);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Retain through replay');
  rerender(view([{ ...first, origin: { ...first.origin!, available: false } }]));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
});

test('failure of an already sent answer leaves the other child editable and preserves both drafts', async () => {
  const { registry } = fixture();
  await registry.update([snapshot()]);
  const pending = deferred<boolean>();
  const respond = vi.fn(() => pending.promise);
  render(
    <Questions
      registry={registry}
      interactions={[question('one'), question('two')]}
      respond={respond}
    />,
  );
  writeOtherAnswer('Awaiting first answer');
  fireEvent.click(screen.getByRole('button', { name: /Submit current selection|提交当前选择/ }));
  fireEvent.click(screen.getByRole('button', { name: /Question 2|问题 2/ }));
  writeOtherAnswer('Keep editing second answer');
  await act(async () => {
    pending.resolve(false);
  });
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
    'Keep editing second answer',
  );
  fireEvent.click(screen.getByRole('button', { name: /Question 1|问题 1/ }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Awaiting first answer');
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: /Submit current selection|提交当前选择/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(respond).toHaveBeenCalledExactlyOnceWith('one', expect.anything());
});

test('finishing asynchronous Browser registration notifies an already mounted pending-question surface', async () => {
  const pending = deferred<AppBrowserModule>();
  const { registry } = fixture(() => pending.promise);
  const respond = vi.fn().mockResolvedValue(true);
  render(
    <Questions
      registry={registry}
      interactions={[question('one')]}
      respond={respond}
      currentSessionId="another-chat"
      sourceViewVisible={false}
    />,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  const update = registry.update([
    {
      ...snapshot(),
      slots: ['interactions.presentation'],
    },
  ]);
  await act(async () => {
    pending.resolve({
      register(host) {
        host.registerInteractionPresentation(() => ({
          visible: true,
          label: 'Newly admitted member',
        }));
      },
    });
    await update;
  });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Newly admitted member')).toBeTruthy();
  expect(respond).not.toHaveBeenCalled();
});
