// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';
import { createMessageRenderer } from '../conversation-overlay/modules/sidepanel-messages.js';
import { processDetailLabels } from '../conversation-overlay/modules/sidepanel-rich-content.js';
import { messagesFromThread } from '../conversation-overlay/modules/sidepanel-state.js';
import { ChromeExtensionStream } from '../conversation-overlay/modules/sidepanel-stream.js';

const thinking = (id: string, status = 'completed') => ({
  key: `turn:thinking:${id}`,
  id,
  type: 'thinking',
  title: 'Thinking',
  text: `Thought ${id}`,
  status,
});
const tool = (id: string, status = 'completed', output = 'File contents') => ({
  key: `turn:tool:${id}`,
  id,
  type: 'tool',
  title: 'Read',
  input: '{ "path": "notes.txt" }',
  output,
  status,
});
const process = (key: string, items = [thinking(key), tool(key)]) => ({
  role: 'process',
  key,
  items,
});
const completed = (key: string, items: Array<Record<string, unknown>>) => ({
  role: 'completed-process',
  key,
  items,
});
const answer = (key: string, text: string) => ({ role: 'assistant', key, text });
const live = (item: Record<string, unknown>) => ({
  role: 'live-process',
  key: `live:${item.key}`,
  item,
});
const processLabels = processDetailLabels();

describe('side panel process presentation matches the desktop', () => {
  let renderer: ReturnType<typeof createMessageRenderer>;
  let messages: HTMLElement;
  let latest: HTMLButtonElement;
  let processDetails: HTMLButtonElement;
  let readImage: ReturnType<typeof vi.fn>;
  let openDelivery: ReturnType<typeof vi.fn>;
  let openMessageFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML =
      '<main id="messages"></main><button id="latest" class="hidden">Latest</button><button id="processDetails" type="button"></button>';
    messages = document.getElementById('messages')!;
    latest = document.getElementById('latest') as HTMLButtonElement;
    processDetails = document.getElementById('processDetails') as HTMLButtonElement;
    readImage = vi.fn(async () => 'data:image/png;base64,AA==');
    openDelivery = vi.fn(async () => {});
    openMessageFile = vi.fn(async () => {});
    renderer = createMessageRenderer(messages, {
      latestButton: latest,
      processDetailsButton: processDetails,
      readImage,
      openDelivery,
      openMessageFile,
    });
  });
  afterEach(() => renderer.dispose());

  const summary = (key: string) =>
    document.querySelector<HTMLElement>(`[data-process-summary-key="${key}"]`)!;
  const disclosure = (key: string) => summary(key).parentElement as HTMLDetailsElement;
  const history = () => messages.querySelector<HTMLDetailsElement>('.completed-process')!;

  it('shows assistant deliverables as file-type cards while keeping images and unrelated content unchanged', async () => {
    const local = './outputs/Quarterly report.pdf';
    const remote = 'https://files.test/archive.zip';
    const managed = '/api/chat/media/outgoing/agent%3Amain/11111111-1111-4111-8111-111111111111/full';
    const managedImage = '/api/chat/media/outgoing/agent%3Amain/22222222-2222-4222-8222-222222222222/full';
    const image = './preview.png';
    const media = { mediaUrls: [local, remote, managed, image] };
    renderer.render([
      { ...answer('reference', 'MEDIA: ./user.pdf'), role: 'user' },
      {
        ...answer('partial', 'Preparing the output'),
        rawMessage: {
          role: 'assistant', content: 'Preparing the output', openclawDelivery: media,
          __chromeExtensionOmitDeliveryMedia: true,
        },
      },
      {
        ...answer('delivered', 'Finished'),
        rawMessage: { role: 'assistant', content: 'Finished', openclawDelivery: media },
      },
      {
        ...answer('native-image', ''),
        rawMessage: { role: 'assistant', content: [
          { type: 'image', url: managedImage, alt: 'chart.png', mimeType: 'image/png' },
        ] },
      },
    ], 'thread-7');

    const card = messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card[title="Quarterly report.pdf"]')!;
    expect(card.querySelector('[data-file-icon-kind="pdf"] svg')).not.toBeNull();
    const remoteCard = messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card[title="archive.zip"]')!;
    expect(remoteCard.disabled).toBe(false);
    remoteCard.click();
    expect(openDelivery).not.toHaveBeenCalled();
    expect(messages.querySelector('.chrome-delivery-card[title="user.pdf"]')).toBeNull();
    expect(messages.querySelectorAll('.chrome-delivery-card')).toHaveLength(5);
    expect(messages.querySelectorAll('.chat-bubble__images img')).toHaveLength(2);
    expect(readImage.mock.calls).toEqual([['thread-7', image], ['thread-7', managedImage]]);

    card.click();
    expect(openDelivery).toHaveBeenCalledExactlyOnceWith('thread-7', local);
    await vi.waitFor(() => expect(card.disabled).toBe(false));
    messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card[title="attachment"]')!.click();
    expect(openDelivery).toHaveBeenLastCalledWith('thread-7', managed);
    messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card[title="chart.png"]')!.click();
    expect(openDelivery).toHaveBeenLastCalledWith('thread-7', managedImage);
  });

  it('deduplicates a pending open and shows only card-local safe feedback on failure', async () => {
    const source = '"./output files/summary.pdf"';
    renderer.render([answer('file', `MEDIA: ${source}`)], 'first-thread');
    const card = messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card')!;
    let rejectOpen!: (error: Error) => void;
    openDelivery.mockImplementation(() => new Promise((_resolve, reject) => { rejectOpen = reject; }));

    card.click();
    card.click();
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(card.disabled).toBe(false);
    expect(openDelivery).toHaveBeenCalledExactlyOnceWith('first-thread', source);
    rejectOpen(new Error('Private path used by the system opener'));
    await vi.waitFor(() => expect(card.hasAttribute('aria-busy')).toBe(false));
    expect(card.parentElement?.querySelector('[role="status"]')?.textContent).toBe('Unable to open this file');
    expect(messages.textContent).not.toContain('Private path');

    card.click();
    renderer.render([answer('other', 'Another conversation')], 'second-thread');
    rejectOpen(new Error('Late private error'));
    await Promise.resolve();
    expect(messages.textContent).toContain('Another conversation');
    expect(messages.querySelector('.chrome-delivery-card__status')).toBeNull();
  });

  it('renders one card for the same reference and clears its old warning on a successful retry', async () => {
    const source = './out/report.pdf';
    const distinct = './archive/report.pdf';
    const text = `MEDIA: ${source}\nMEDIA: "${source}"\nMEDIA: ${distinct}`;
    openDelivery.mockRejectedValueOnce(new Error('File not found'));

    renderer.render([answer('files', text)], 'thread-files');
    const cards = [...messages.querySelectorAll<HTMLButtonElement>('button.chrome-delivery-card')];
    expect(cards).toHaveLength(2);
    expect(cards.every(card => card.title === 'report.pdf')).toBe(true);
    const feedback = () => [...messages.querySelectorAll('.chrome-delivery-card__status')].map(node => node.textContent);
    expect(feedback()).toEqual(['', '']);
    cards[0].click();
    await vi.waitFor(() => expect(feedback()).toEqual(['Unable to open this file', '']));
    cards[0].click();
    await vi.waitFor(() => expect(cards[0].hasAttribute('aria-busy')).toBe(false));
    expect(feedback()).toEqual(['', '']);
    cards[1].click();
    expect(openDelivery.mock.calls).toEqual([['thread-files', source], ['thread-files', source], ['thread-files', distinct]]);
  });

  it('keeps one preview when a quoted MEDIA image repeats legacy metadata with a generic MIME type', () => {
    const source = './preview.png';
    const text = `MEDIA: "${source}"`;
    renderer.render([{
      ...answer('image', text),
      rawMessage: {
        role: 'assistant', content: text, MediaPath: source, MediaType: 'application/octet-stream',
      },
    }], 'thread-files');

    expect(messages.querySelectorAll('.chat-bubble__images img')).toHaveLength(1);
    expect(messages.querySelectorAll('button.chrome-delivery-card')).toHaveLength(1);
    expect(readImage.mock.calls).toEqual([['thread-files', source]]);
  });

  it.each(['read', 'decode'])('only reports an image attachment error after a card click (%s)', async stage => {
    const source = './preview.png';
    if (stage === 'read') readImage.mockRejectedValueOnce(new Error('File not found'));
    openDelivery.mockRejectedValueOnce(new Error('File not found'));
    renderer.render([answer('image', `MEDIA: ${source}`)], 'thread-files');

    const image = messages.querySelector<HTMLImageElement>('.chat-bubble__image')!;
    const card = messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card')!;
    const feedback = () => messages.querySelector('.chrome-delivery-card__status')?.textContent;
    if (stage === 'decode') {
      await vi.waitFor(() => expect(image.hasAttribute('src')).toBe(true));
      image.dispatchEvent(new Event('error'));
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(readImage).toHaveBeenCalledWith('thread-files', source);
    expect(image.alt).toBe('preview.png');
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
    expect(card.disabled).toBe(false);
    expect(openDelivery).not.toHaveBeenCalled();
    expect(feedback()).toBe('');

    card.click();
    expect(openDelivery).toHaveBeenCalledWith('thread-files', source);
    await vi.waitFor(() => expect(feedback()).toBe('Unable to open this file'));
  });

  it('uses one managed card for a native delivery alias and groups unresolved same-name references', () => {
    const local = './out/report.pdf';
    const managed = '/api/chat/media/outgoing/agent%3Amain/11111111-1111-4111-8111-111111111111/full';
    const content = [
      { type: 'text', text: `MEDIA: ${local}` },
      { type: 'attachment', attachment: { kind: 'document', label: 'report.pdf', url: managed } },
    ];
    const entry = { ...answer('files', ''), rawMessage: { role: 'assistant', content } };
    renderer.render([entry], 'thread-files');

    const group = messages.querySelector('.chrome-delivery-options')!;
    const cards = [...group.querySelectorAll<HTMLButtonElement>('button.chrome-delivery-card')];
    expect(cards).toHaveLength(2);
    const icons = cards.map(card => card.querySelector('.chrome-delivery-card__action path')?.getAttribute('d'));
    expect(icons.every(Boolean)).toBe(true);
    expect(icons[0]).not.toEqual(icons[1]);
    cards.forEach(card => card.click());
    expect(openDelivery.mock.calls).toEqual([['thread-files', local], ['thread-files', managed]]);

    renderer.render([{
      ...entry, rawMessage: { ...entry.rawMessage, openclawDelivery: { mediaUrls: [local] } },
    }], 'thread-files');
    expect(messages.querySelector('.chrome-delivery-options')).toBeNull();
    expect(messages.querySelectorAll('button.chrome-delivery-card')).toHaveLength(1);
    expect(messages.querySelector('.assistant-content')?.textContent?.match(/report\.pdf/g)).toHaveLength(1);
    messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card')!.click();
    expect(openDelivery).toHaveBeenLastCalledWith('thread-files', managed);
  });

  it('hides an invalid managed delivery and keeps the explicit local attachment', async () => {
    const local = './out/report.pdf';
    const invalid = '/api/chat/media/outgoing/agent%3Amain/missing/full';
    const managed = '/api/chat/media/outgoing/agent%3Amain/11111111-1111-4111-8111-111111111111/full';
    const invalidBlock = { type: 'attachment', attachment: { kind: 'document', label: 'report.pdf', url: invalid } };
    renderer.render([
      {
        ...answer('invalid-managed', `MEDIA: ${local}`),
        rawMessage: {
          role: 'assistant',
          openclawDelivery: { mediaUrls: [invalid, managed] },
          content: [
            { type: 'text', text: `MEDIA: ${local}` },
            invalidBlock,
            { type: 'attachment', attachment: { kind: 'document', label: 'other.pdf', url: managed } },
            { type: 'attachment_error', attachment: { code: 'delivery-failed', kind: 'document', label: 'report.pdf' } },
          ],
        },
      },
      {
        ...answer('invalid-projected-block', ''),
        rawMessage: {
          role: 'assistant',
          content: [invalidBlock],
          openclawDelivery: { mediaUrls: [local, invalid, managed] },
          __chromeExtensionOmitDeliveryMedia: true,
        },
      },
      answer('invalid-live-media', `MEDIA: ${invalid}`),
    ], 'thread-files');

    const cards = [...messages.querySelectorAll<HTMLButtonElement>('button.chrome-delivery-card')];
    expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['Open attachment report.pdf', 'Download other.pdf']);
    expect(messages.querySelectorAll('.message.assistant:not([hidden])')).toHaveLength(1);
    expect(messages.textContent?.match(/report\.pdf/g)).toHaveLength(1);
    expect(openDelivery).not.toHaveBeenCalled();
    cards[0].click();
    openDelivery.mockRejectedValueOnce(new Error('Gateway temporarily unavailable'));
    cards[1].click();
    await vi.waitFor(() => expect(cards[1].parentElement?.querySelector('[role="status"]')?.textContent).toBe('Unable to open this file'));
    expect(openDelivery.mock.calls).toEqual([['thread-files', local], ['thread-files', managed]]);
    expect(cards[1].isConnected).toBe(true);
  });

  it('preserves distinct local sources in a partial native delivery and groups the same-name choices', () => {
    const first = './out/report.pdf';
    const second = './archive/report.pdf';
    const unmatched = './out/appendix.pdf';
    const managed = '/api/chat/media/outgoing/agent%3Amain/11111111-1111-4111-8111-111111111111/full';
    renderer.render([{
      ...answer('partial', ''),
      rawMessage: {
        role: 'assistant',
        openclawDelivery: { mediaUrls: [first, unmatched, second] },
        content: [
          { type: 'text', text: `MEDIA: ${first}\nMEDIA: ${unmatched}\nMEDIA: ${second}` },
          { type: 'attachment', attachment: { kind: 'document', label: 'report.pdf', url: managed } },
          { type: 'attachment_error', attachment: { code: 'file-not-found', kind: 'document', label: 'report.pdf' } },
        ],
      },
    }], 'thread-files');

    const group = messages.querySelector('.chrome-delivery-options');
    const cards = [...group!.querySelectorAll<HTMLButtonElement>('button.chrome-delivery-card')];
    expect(cards.map(card => card.title)).toEqual(['report.pdf', 'report.pdf', 'report.pdf']);
    const body = messages.querySelector('.assistant-content')?.textContent ?? '';
    expect(body.match(/\w+\.pdf/g)).toEqual(['report.pdf', 'report.pdf', 'report.pdf', 'appendix.pdf']);
    expect(body).not.toMatch(/file not found|attachment unavailable/i);
    cards.forEach(card => card.click());
    messages.querySelector<HTMLButtonElement>('button.chrome-delivery-card[title="appendix.pdf"]')!.click();
    expect(openDelivery.mock.calls).toEqual([
      ['thread-files', first], ['thread-files', second], ['thread-files', managed], ['thread-files', unmatched],
    ]);
  });

  it('opens exact file links in message text while leaving external links, tools and code examples alone', () => {
    const user = '[Quarterly spreadsheet](./reports/Q4%20numbers.xlsx)';
    const assistant = [
      'Notes: `C:/notes/plan.md` and [source](file:///C:/notes/input.pdf).',
      '',
      '[Online docs](https://example.com)',
      '',
      '<a href="#" data-message-file-token="forged" data-message-file-target="C:/fake.pdf">fake</a>',
      '',
      '```text',
      'C:/notes/example.md',
      '```',
    ].join('\n');
    renderer.render([
      { role: 'user', key: 'user', text: user },
      answer('actual', assistant),
      live({ ...thinking('thinking-file', 'running'), text: '`C:/notes/thinking.md`' }),
      { role: 'system', key: 'system-file', text: '`C:/notes/system.md`' },
    ], 'thread-files');
    const links = [...messages.querySelectorAll<HTMLAnchorElement>('a.chrome-message-file-link')];
    expect(links.map(link => link.textContent)).toEqual(['Quarterly spreadsheet', 'C:/notes/plan.md', 'source']);
    expect(links.every(link => link.getAttribute('href') === '#')).toBe(true);
    expect(messages.querySelector('[data-message-file-token], [data-message-file-target]')).toBeNull();
    expect(messages.querySelector('a[href="https://example.com"]')?.getAttribute('target')).toBe('_blank');

    links.forEach(link => link.click());
    expect(openMessageFile.mock.calls).toEqual([
      ['thread-files', { sourceKind: 'markdown-uri', target: './reports/Q4%20numbers.xlsx' }],
      ['thread-files', { sourceKind: 'native-path', target: 'C:/notes/plan.md' }],
      ['thread-files', { sourceKind: 'file-url', target: 'file:///C:/notes/input.pdf' }],
    ]);
  });

  it('does not activate the incomplete bare path at the end of a streaming answer', () => {
    const row = answer('live-file', 'Saved C:/reports/Q4.pdf');
    renderer.render([{ ...row, status: 'streaming' }], 'thread-files');
    expect(messages.querySelector('.chrome-message-file-link')).toBeNull();

    renderer.render([{ ...row, text: row.text + ' backup.pdf', status: 'streaming' }], 'thread-files');
    expect(messages.querySelector('.chrome-message-file-link')).toBeNull();

    renderer.render([{ ...row, status: 'streaming' }], 'thread-files');
    // A snapshot carries the interruption in display metadata, without a live item status.
    renderer.render([{ ...row, display: { stopReason: 'aborted' } }], 'thread-files');
    expect(messages.querySelector('.chrome-message-file-link')).toBeNull();

    renderer.render([{ ...row, status: 'completed' }], 'thread-files');
    const link = messages.querySelector<HTMLAnchorElement>('.chrome-message-file-link');
    expect(link?.textContent).toBe('C:/reports/Q4.pdf');
    link?.click();
    expect(openMessageFile).toHaveBeenCalledExactlyOnceWith(
      'thread-files', { sourceKind: 'native-path', target: 'C:/reports/Q4.pdf' },
    );
  });

  it('keeps pending states outside their user bubbles with accessible explanations', () => {
    const languageGetter = vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    try {
      const inputs = [
        { state: 'queued', label: 'Pending', description: 'Input received, waiting for processing' },
        { state: 'cancelled', label: 'Cancelled', description: 'Input cancelled before submission to the model' },
        { state: 'interrupted', label: 'Interrupted', description: 'Input processing interrupted' },
        { state: 'queued', incomplete: true, label: 'Content incomplete', description: 'Some pending inputs could not be loaded. Refresh to retry.' },
      ];
      renderer.render(inputs.map((input, index) => ({
        role: 'user', key: `pending:${index}`, text: `Prompt ${index}`,
        pendingInput: { state: input.state, incomplete: input.incomplete },
      })), 'pending-statuses');
      const labels = messages.querySelectorAll<HTMLElement>('.user-message > .pending-input-status');
      expect(labels).toHaveLength(inputs.length);
      expect(messages.querySelector('.message.user .pending-input-status')).toBeNull();
      inputs.forEach((input, index) => {
        expect(labels[index].textContent).toBe(input.label);
        expect(labels[index].title).toBe(input.description);
        expect(labels[index].getAttribute('aria-label')).toBe(input.description);
        expect(labels[index].parentElement?.textContent).toContain(`Prompt ${index}`);
        expect(labels[index].previousElementSibling?.textContent?.trim()).toBe(`Prompt ${index}`);
        expect(messages.textContent).not.toContain(input.description);
      });
    } finally {
      languageGetter.mockRestore();
    }
  });

  it('retains the user content and selection when only the pending status changes or disappears', () => {
    const entry = { role: 'user', key: 'input', text: 'Original user message' };
    renderer.render([{ ...entry, pendingInput: { state: 'queued' } }], 'one');
    const bubble = messages.querySelector('.message.user')!;
    const paragraph = bubble.querySelector('p')!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    renderer.render([{ ...entry, pendingInput: { state: 'interrupted' } }], 'one');
    expect(messages.querySelector('.message.user')).toBe(bubble);
    expect(bubble.querySelector('p')).toBe(paragraph);
    expect(selection.toString()).toBe(entry.text);
    renderer.render([entry], 'one');
    expect(messages.querySelector('.pending-input-status')).toBeNull();
    expect(bubble.querySelector('p')).toBe(paragraph);
    expect(selection.toString()).toBe(entry.text);
    renderer.render([{ ...entry, text: 'Changed native content' }], 'one');
    expect(bubble.textContent?.trim()).toBe('Changed native content');
  });

  it('shows incomplete input metadata without creating an empty visible bubble', () => {
    renderer.render([{ role: 'user', key: 'incomplete', text: '',
      pendingInput: { state: 'queued', incomplete: true } }], 'one');
    expect(messages.querySelector<HTMLElement>('.message.user')!.hidden).toBe(true);
    expect(messages.querySelector('.pending-input-status')?.textContent).toBeTruthy();
    renderer.render([{ role: 'user', key: 'incomplete', text: 'Recovered content' }], 'one');
    expect(messages.querySelector<HTMLElement>('.message.user')!.hidden).toBe(false);
    expect(messages.querySelector('.message.user')!.textContent?.trim()).toBe('Recovered content');
  });

  it('renders question answers inside the existing disclosure and updates the same Lit host after timeout', () => {
    const questions = [{
      id: 'stack', question: 'Which stack?',
      options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
      defaultOptionIds: ['react'],
    }];
    const entry = (timedOut: boolean) => ({
      role: 'question-presentation', key: 'question',
      item: { type: 'tool', key: 'question-tool', status: 'completed', input: { questions },
        questionResult: { version: 1, questions, response: {
          status: 'answered', timedOut, answers: { stack: { selected: ['react'] } },
        } } },
    });
    renderer.render([completed('history', [entry(false)]), answer('final', 'Final answer')], 'question-session');
    const outer = history();
    expect(outer.open).toBe(false);
    outer.querySelector<HTMLElement>('summary')!.click();
    expect(outer.querySelector('.question-answer--human')?.textContent).toContain('Which stack?');
    expect(outer.querySelector('.question-answer--human')?.textContent).toContain('React');
    expect(messages.querySelector('.assistant')?.closest('.completed-process')).toBeNull();
    renderer.render([completed('history', [entry(true)]), answer('final', 'Final answer')], 'question-session');
    expect(history()).toBe(outer);
    expect(outer.querySelector('.question-answer--human')).toBeNull();
    expect(outer.querySelector('.question-answer--system')?.textContent).toContain('Which stack?');
    expect(outer.querySelector('.question-answer--system')?.textContent).toContain('React');
  });

  it('uses the desktop history trigger and lazy nested summaries, keeping the complete final answer outside', () => {
    const entries = [
      completed('history', [
        process('one'),
        answer('intermediate', 'Intermediate explanation'),
        process('two'),
      ]),
      answer('final', 'Final answer'),
    ];
    renderer.render(entries, 'one');
    const outer = history();
    expect(outer.open).toBe(false);
    expect(outer.firstElementChild?.getAttribute('aria-label')).toBe(t('expandProcessHistory'));
    expect(outer.firstElementChild?.textContent).not.toContain('×');
    expect(outer.querySelector('svg path')?.getAttribute('d')).toBe(
      'M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6M12 7v5l3 2',
    );
    expect(outer.querySelector('.process-summary-group')).toBeNull();
    expect(messages.querySelector('.assistant')?.textContent).toContain('Final answer');
    outer.querySelector<HTMLElement>('summary')!.click();
    expect(outer.firstElementChild?.getAttribute('aria-label')).toBe(t('collapseProcessHistory'));
    expect(outer.querySelectorAll('.process-summary-group')).toHaveLength(2);
    expect(outer.querySelector('.process-tool')).toBeNull();
    expect(outer.textContent).toContain('Intermediate explanation');
    expect(outer.textContent).not.toContain('Final answer');
    summary('one').click();
    expect(disclosure('one').open).toBe(true);
    expect(disclosure('one').querySelector('.message-detail')?.textContent).toContain(
      'Thought one',
    );
    summary('two').click();
    expect(disclosure('one').open).toBe(false);
    expect(disclosure('two').open).toBe(true);
    expect(outer.open).toBe(true);
  });

  it('keeps only one process summary open across independently expanded history groups', () => {
    renderer.render(
      [completed('history-one', [process('one')]), completed('history-two', [process('two')])],
      'one',
    );
    const outers = [...messages.querySelectorAll<HTMLDetailsElement>('.completed-process')];
    outers.forEach(outer => outer.querySelector<HTMLElement>('summary')!.click());
    summary('one').click();
    summary('two').click();
    expect(outers.map(outer => outer.open)).toEqual([true, true]);
    expect([disclosure('one').open, disclosure('two').open]).toEqual([false, true]);
    summary('two').click();
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(0);
  });

  it('shows compact counts in one accessible summary and omits empty metrics', () => {
    renderer.render([
      process('both', [thinking('one'), thinking('two'), tool('one')]),
      process('thinking-only', [thinking('three')]),
      process('tool-only', [tool('two')]),
    ], 'one');
    const counts = (key: string) => [...summary(key).querySelectorAll('.process-summary-metric:not([hidden])')]
      .map(metric => [metric.firstChild?.textContent, metric.lastElementChild?.textContent]);
    expect(counts('both')).toEqual([[t('thinking'), '2'], [t('tool'), '1']]);
    expect(counts('thinking-only')).toEqual([[t('thinking'), '1']]);
    expect(counts('tool-only')).toEqual([[t('tool'), '1']]);
    expect(summary('both').textContent).not.toContain('×');
    expect(summary('both').getAttribute('aria-label')).toBe(
      `${t('thinkingToolsSummary', { thinkingCount: 2, toolCount: 1 })} · ${t('openProcessDetails')}`,
    );
    expect(summary('both').getAttribute('aria-expanded')).toBe('false');
    summary('both').click();
    expect(summary('both').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows live Thinking and Tool directly and preserves focused raw readers while their output grows', () => {
    const currentThinking = thinking('live', 'running');
    const currentTool = tool('live', 'inProgress', 'First result');
    renderer.render([live(currentThinking), live(currentTool)], 'one');
    expect(messages.querySelector('.process-summary-group')).toBeNull();
    expect(messages.querySelector('.completed-process')).toBeNull();
    expect(messages.querySelector('details.process-thinking')).toBeNull();
    expect(messages.querySelector('.message-detail')?.textContent).toContain('Thought live');
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    const title = reader.querySelector<HTMLElement>('summary')!;
    title.click();
    title.focus();
    const output = reader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    output.scrollTop = 37;
    renderer.render(
      [
        live({ ...currentThinking, text: 'More thinking' }),
        live({ ...currentTool, output: 'Second result' }),
      ],
      'one',
    );
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(document.activeElement).toBe(title);
    expect(output.scrollTop).toBe(37);
    expect(output.textContent).toBe('Second result');
  });

  it('previews long live Thinking, preserves the expansion across fold, and keeps short Thinking directly readable', () => {
    const thought = thinking('long', 'running');
    renderer.render([live(thought)], 'one');
    const body = messages.querySelector<HTMLElement>('.process-thinking .message-detail')!;
    const button = messages.querySelector<HTMLButtonElement>('.process-thinking-toggle')!;
    const viewport = body.parentElement!;
    expect(button.hidden).toBe(true);
    body.style.lineHeight = '20px';
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 220, 500));
    const height = vi.spyOn(body, 'scrollHeight', 'get').mockReturnValue(500);
    const updated = { ...thought, text: `${thought.text}\n${'More text\n'.repeat(24)}` };
    renderer.render([live(updated)], 'one');
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-controls')).toBe(body.id);
    expect(viewport.scrollTop).toBe(300);
    expect(button.getAttribute('aria-label')).toBe(processLabels.thinkingExpand);
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(viewport.scrollTop).toBe(0);

    button.focus();
    renderer.render([process('folded', [{ ...updated, status: 'completed' }]), answer('after', 'Answer')], 'one');
    expect(document.activeElement).toBe(summary('folded'));
    expect(disclosure('folded').open).toBe(false);
    summary('folded').click();
    expect(messages.querySelector('.process-thinking-toggle')).toBe(button);
    expect(button.getAttribute('aria-label')).toBe(processLabels.thinkingCollapse);
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(viewport.scrollTop).toBe(300);
    button.click();
    height.mockReturnValue(20);
    renderer.render([
      process('folded', [{ ...thought, status: 'completed', text: 'Corrected native thought' }]),
      answer('after', 'Answer'),
    ], 'one');
    expect(body.textContent).toBe('Corrected native thought\n');
    expect(button.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(viewport.scrollTop).toBe(0);
  });

  it('keeps oversized Thinking as complete escaped text', () => {
    const text = '## Markdown\n' + '<example>\n'.repeat(5000);
    renderer.render([live({ ...thinking('large'), text })], 'one');
    expect(messages.querySelector('.process-thinking-plain')?.textContent).toBe(text);
    expect(messages.querySelector('.process-thinking h2, .process-thinking example')).toBeNull();
  });

  it('shows the Exec input title before progress and keeps the raw input available', () => {
    const input = { title: 'Run\n tests', command: 'npm test' };
    const item = {
      id: 'exec-1',
      type: 'toolCall',
      toolName: 'exec',
      status: 'inProgress',
      input: JSON.stringify(input),
      progressText: 'Running command',
    };

    renderer.render(messagesFromThread({ id: 'one', turns: [{ items: [item] }] }), 'one');

    expect(messages.querySelector('.process-tool-title strong')?.textContent).toBe('Exec');
    expect(messages.querySelector('.process-tool-input')?.textContent).toBe('Run tests');
    expect(messages.querySelector('.process-tool-progress')?.textContent).toBe(item.progressText);
    expect(messages.querySelector('[data-section="input"] pre')?.textContent).toBe(item.input);
    expect(messages.querySelector('[data-section="input"] strong')?.textContent).toBe(processLabels.toolInput);
  });

  it('retains the same raw Tool reader and choice when live content becomes a summary and later enters completed history', () => {
    const item = tool('same-source', 'inProgress');
    renderer.render([live(item)], 'one');
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    const title = reader.querySelector<HTMLElement>('summary')!;
    title.click();
    title.focus();
    const output = reader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    output.scrollTop = 51;
    const settled = { ...item, status: 'completed' };
    const archived = process('summary', [settled]);
    renderer.render([archived], 'one');
    expect(disclosure('summary').open).toBe(false);
    expect(document.activeElement).toBe(summary('summary'));
    summary('summary').click();
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(output.scrollTop).toBe(51);
    renderer.render([completed('complete', [archived]), answer('final', 'Final')], 'one');
    history().querySelector<HTMLElement>('summary')!.click();
    expect(messages.querySelector('.process-tool')).toBe(reader);
    expect(disclosure('summary').open).toBe(true);
    expect(output.scrollTop).toBe(51);
    expect(reader.querySelector('[data-section="output"] strong')?.textContent).toBe(processLabels.toolResult);
  });

  it('renders native compaction details visibly and patches the same open reader when history enriches its summary', () => {
    const entry = {
      role: 'compaction',
      key: 'compact-native-entry',
      rawMessage: {
        role: 'system',
        content: '',
        __openclaw: {
          kind: 'compaction',
          id: 'compact-native-entry',
          tokensBefore: 12000,
          tokensAfter: 4000,
          summary: 'Preserved native decisions',
        },
      },
    };
    renderer.render([entry], 'one');
    const reader = messages.querySelector<HTMLDetailsElement>('.chat-divider__details')!;
    expect(reader).not.toBeNull();
    expect(reader.textContent).toContain('12,000 → 4,000 tokens');
    expect(reader.textContent).toContain('Preserved native decisions');
    reader.open = true;
    reader.querySelector<HTMLElement>('summary')!.focus();
    renderer.render(
      [
        {
          ...entry,
          rawMessage: {
            ...entry.rawMessage,
            __openclaw: {
              ...entry.rawMessage.__openclaw,
              summary: 'Preserved native decisions and constraints',
            },
          },
        },
      ],
      'one',
    );
    expect(messages.querySelector('.chat-divider__details')).toBe(reader);
    expect(reader.open).toBe(true);
    expect(document.activeElement).toBe(reader.querySelector('summary'));
    expect(reader.textContent).toContain('Preserved native decisions and constraints');
  });

  it('renders structured native progress receipts using the same visible plan counts and current step as the App', () => {
    const entry = {
      role: 'progress-receipt',
      key: 'progress-one',
      item: {
        id: 'progress-one',
        name: 'progress_card',
        status: 'completed',
        input: {
          plan: [
            { step: 'Inspect files', status: 'completed' },
            { step: 'Check results', status: 'in_progress' },
          ],
        },
      },
    };
    renderer.render([completed('history', [entry]), answer('final', 'Final')], 'one');
    expect(messages.querySelector('.progress-card-receipt')).toBeNull();
    history().querySelector<HTMLElement>('summary')!.click();
    const receipt = messages.querySelector('.progress-card-receipt')!;
    expect(receipt.textContent).toContain('1/2');
    expect(receipt.textContent).toContain('Check results');
    expect(receipt.textContent).not.toContain('[object Object]');
    expect(messages.querySelector('.process-tool')).toBeNull();
  });

  it('preserves an expanded and locally collapsed summary through real native source metadata takeover and settlement', () => {
    const stream = new ChromeExtensionStream('one');
    const initial = {
      id: 'one',
      turns: [
        {
          id: 'old-turn',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Earlier request' }] }],
        },
      ],
    };
    stream.setHistory(initial);
    stream.start('Current request', undefined, 'exact-current-input');
    stream.bindRun('run-one');
    const emit = (seq: number, channel: string, data: Record<string, unknown>) =>
      stream.accept({
        kind: 'agent',
        event: {
          runId: 'run-one',
          sessionKey: 'agent:main:justdo:one',
          sessionId: null,
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: seq,
          frameSeq: seq,
          deliveryEvent: 'agent',
          timestamp: seq,
          stream: channel,
          data,
        },
      });
    emit(1, 'thinking', { text: 'Preserved native thought' });
    emit(2, 'assistant', { text: 'Native response' });
    renderer.render(messagesFromThread(stream.project()), 'one');
    const disclosure = messages.querySelector<HTMLDetailsElement>('.process-summary-group')!;
    const title = disclosure.querySelector<HTMLElement>('summary')!;
    title.click();
    title.focus();
    const nativeHistory = {
      id: 'one',
      turns: [
        ...initial.turns,
        {
          id: 'native-turn',
          items: [
            {
              id: 'native-user',
              type: 'userMessage', inputRunId: 'exact-current-input',
              content: [{ type: 'text', text: 'Current request' }],
            },
            {
              id: 'native-thought',
              type: 'reasoning',
              content: ['Preserved native thought'],
              status: 'completed',
              display: {
                sourceId: 'native-source',
                sourceSegmentId: 'native-reasoning',
                sourceIndex: 1,
              },
            },
            {
              id: 'native-response',
              type: 'agentMessage',
              text: 'Native response',
              display: {
                sourceId: 'native-source',
                sourceSegmentId: 'native-answer',
                sourceIndex: 2,
              },
            },
          ],
        },
      ],
    };
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(title);
    processDetails.click();
    title.click();
    expect(disclosure.open).toBe(false);
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(disclosure.open).toBe(false);
    processDetails.click();
    processDetails.click();
    title.focus();
    stream.finish();
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(history().contains(disclosure)).toBe(true);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(title);
    stream.setHistory(nativeHistory);
    renderer.render(messagesFromThread(stream.project()), 'one');
    expect(messages.querySelector('.process-summary-group')).toBe(disclosure);
    expect(document.activeElement).toBe(title);
  });

  it('bulk-controls completed history and summaries while live feedback and raw Tool choices remain independent', () => {
    const activeTool = tool('live', 'inProgress');
    const entries = [
      completed('history', [process('one'), process('two')]),
      live(thinking('live', 'running')),
      live(activeTool),
    ];
    const original = JSON.stringify(entries);
    renderer.render(entries, 'one');
    const currentReader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    currentReader.querySelector<HTMLElement>('summary')!.click();
    const title = currentReader.querySelector<HTMLElement>('summary')!;
    const output = currentReader.querySelector<HTMLElement>('[data-section="output"] pre')!;
    title.focus();
    output.scrollTop = 61;
    processDetails.click();
    expect(processDetails.getAttribute('aria-pressed')).toBe('true');
    expect(history().open).toBe(true);
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(2);
    expect(disclosure('one').querySelector<HTMLDetailsElement>('.process-tool')?.open).toBe(false);
    processDetails.click();
    expect(history().open).toBe(false);
    expect(messages.querySelectorAll('.process-summary-group[open]')).toHaveLength(0);
    expect(messages.querySelectorAll('.process-live')).toHaveLength(2);
    expect(currentReader.open).toBe(true);
    expect(messages.querySelector('.process-live-tool .process-tool')).toBe(currentReader);
    expect(document.activeElement).toBe(title);
    expect(output.scrollTop).toBe(61);
    expect(JSON.stringify(entries)).toBe(original);
  });

  it('allows per-summary exceptions in bulk mode and clears them on the next bulk operation', () => {
    renderer.render([completed('history', [process('one'), process('two')])], 'one');
    processDetails.click();
    summary('one').click();
    expect([disclosure('one').open, disclosure('two').open]).toEqual([false, true]);
    renderer.render(currentEntries(), 'one');
    expect(disclosure('one').open).toBe(false);
    processDetails.click();
    processDetails.click();
    expect([disclosure('one').open, disclosure('two').open]).toEqual([true, true]);
    history().querySelector<HTMLElement>('summary')!.click();
    processDetails.click();
    processDetails.click();
    expect(history().open).toBe(true);
    function currentEntries() {
      return [completed('history', [process('one'), process('two')])];
    }
  });

  it('applies bulk mode to newly arriving groups without overriding an individual exception', () => {
    const entries = [process('one')];
    renderer.render(entries, 'one');
    processDetails.click();
    summary('one').click();
    renderer.render([...entries, completed('later', [process('two')])], 'one');
    expect(disclosure('one').open).toBe(false);
    expect(history().open).toBe(true);
    expect(disclosure('two').open).toBe(true);
  });

  it('resets bulk mode on conversation changes but restores scoped individual history, summary and raw Tool choices', () => {
    const entries = [completed('history', [process('one'), process('two')])];
    renderer.render(entries, 'one');
    history().querySelector<HTMLElement>('summary')!.click();
    summary('one').click();
    messages
      .querySelector<HTMLDetailsElement>('.process-tool')!
      .querySelector<HTMLElement>('summary')!
      .click();
    renderer.render(entries, 'two');
    expect(processDetails.getAttribute('aria-pressed')).toBe('false');
    expect(history().open).toBe(false);
    renderer.render(entries, 'one');
    expect(history().open).toBe(true);
    expect(disclosure('one').open).toBe(true);
    expect(disclosure('two').open).toBe(false);
    expect(messages.querySelector<HTMLDetailsElement>('.process-tool')?.open).toBe(true);
    processDetails.click();
    renderer.render(entries, 'two');
    expect(processDetails.getAttribute('aria-pressed')).toBe('false');
  });

  it('closes the default accordion with Escape and restores summary focus without changing raw Tool choice', () => {
    renderer.render([process('one')], 'one');
    summary('one').click();
    const reader = messages.querySelector<HTMLDetailsElement>('.process-tool')!;
    reader.querySelector<HTMLElement>('summary')!.click();
    messages.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(disclosure('one').open).toBe(false);
    expect(document.activeElement).toBe(summary('one'));
    expect(reader.open).toBe(true);
  });

  it('pauses following immediately on upward input and only resumes through returning to latest', () => {
    let scrollHeight = 1000;
    Object.defineProperties(messages, {
      scrollHeight: { get: () => scrollHeight },
      clientHeight: { value: 200 },
    });
    renderer.render([answer('body', 'First response')], 'one');
    messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 }));
    messages.dispatchEvent(new Event('scroll'));
    messages.scrollTop = 650;
    scrollHeight = 1400;
    renderer.render([answer('body', 'Longer response')], 'one');
    expect(messages.scrollTop).toBe(650);
    expect(latest.classList.contains('hidden')).toBe(false);
    latest.click();
    expect(messages.scrollTop).toBe(1400);
    expect(latest.classList.contains('hidden')).toBe(true);
  });

  it('preserves the clicked summary anchor when accordion collapse removes preceding height', () => {
    renderer.render([process('one'), process('two')], 'one');
    summary('one').click();
    messages.scrollTop = 400;
    summary('two').getBoundingClientRect = () =>
      ({ top: disclosure('one').open ? 200 : 80 }) as DOMRect;
    summary('two').click();
    expect(messages.scrollTop).toBe(280);
    expect(disclosure('two').open).toBe(true);
  });

  it('ignores queued toggle events from a detached previous conversation', () => {
    renderer.render([process('one')], 'one');
    const previous = disclosure('one');
    renderer.render([process('one')], 'two');
    previous.open = true;
    previous.dispatchEvent(new Event('toggle'));
    expect(disclosure('one').open).toBe(false);
    expect(messages.querySelector('.process-tool')).toBeNull();
  });

  it.each([
    ['en-US', 'Expand all process details', 'Collapse all process details'],
    ['zh-CN', '展开所有过程详情', '折叠所有过程详情'],
  ])('localizes bulk accessibility state for %s', async (language, expand, collapse) => {
    const languageGetter = vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
    vi.resetModules();
    const { createMessageRenderer: createLocalizedRenderer } =
      await import('../conversation-overlay/modules/sidepanel-messages.js');
    const host = document.createElement('main');
    const button = document.createElement('button');
    const localized = createLocalizedRenderer(host, {
      readImage: vi.fn(),
      latestButton: document.createElement('button'),
      processDetailsButton: button,
    });
    try {
      localized.render([process('one')], language);
      expect(button.title).toBe(expand);
      expect(button.getAttribute('aria-label')).toBe(expand);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      button.click();
      expect(button.title).toBe(collapse);
      expect(button.getAttribute('aria-label')).toBe(collapse);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    } finally {
      localized.dispose();
      languageGetter.mockRestore();
      vi.resetModules();
    }
  });
});
