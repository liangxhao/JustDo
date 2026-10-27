/** @vitest-environment jsdom */
import { MessageFileLinkSourceKind } from '@shared/preview/messageFileLink';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { QueuedInputMessage } from '../composer/submission/QueuedInputMessage';
import { MessageFileLinkContext } from '../preview/messageFileLinks';
import ChatMessageDisplay from './ChatMessageDisplay';
import { UserMessageContent } from './UserMessageContent';

afterEach(cleanup);

test('the primary assistant display consumes its receiving workspace opener', async () => {
  const openFile = vi.fn();
  const view = render(
    <MessageFileLinkContext.Provider value={openFile}>
      <ChatMessageDisplay
        gatewayMessages={[{ role: 'assistant', content: '[Book](<./My book.pdf>)' }]}
      />
    </MessageFileLinkContext.Provider>,
  );
  const chat = view.container.querySelector('justdo-chat')!;
  await act(async () => {
    await chat.updateComplete;
  });
  const anchor = chat.shadowRoot!.querySelector<HTMLAnchorElement>('[data-message-file-target]')!;
  expect(anchor).not.toBeNull();
  anchor.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
  );
  expect(openFile).toHaveBeenCalledWith({
    sourceKind: MessageFileLinkSourceKind.MarkdownUri,
    target: './My%20book.pdf',
    navigationSuffix: undefined,
  });
});

test.each([
  { name: 'user', Reader: UserMessageContent },
  { name: 'queued', Reader: QueuedInputMessage },
])('uses the workspace context for $name message readers', ({ Reader }) => {
  const message = { role: 'user', content: '[Book](<./output/My book.pdf>)' };
  const openFile = vi.fn();
  const view = render(
    <MessageFileLinkContext.Provider value={openFile}>
      <Reader message={message} workingDirectory="C:/old-message-project" />
    </MessageFileLinkContext.Provider>,
  );
  const host = view.container.querySelector<HTMLElement>('[data-user-message]')!;
  const anchor = host.shadowRoot!.querySelector<HTMLAnchorElement>('[data-message-file-target]')!;
  expect(anchor).not.toBeNull();
  anchor.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
  );
  expect(openFile).toHaveBeenCalledWith({
    sourceKind: MessageFileLinkSourceKind.MarkdownUri,
    target: './output/My%20book.pdf',
    navigationSuffix: undefined,
  });
});

test('an independent reader without a workspace opener keeps new file targets inactive', () => {
  const view = render(
    <UserMessageContent message={{ role: 'user', content: '[Book](<./output/My book.pdf>)' }} />,
  );
  const host = view.container.querySelector<HTMLElement>('[data-user-message]')!;
  expect(host.shadowRoot!.querySelector('a')).toBeNull();
});
