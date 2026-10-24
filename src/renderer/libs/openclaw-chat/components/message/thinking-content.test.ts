// @vitest-environment jsdom

import { nothing, render } from 'lit';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ThinkingItem } from '../../model/chat-transcript-state';
import { renderThinkingContent, ThinkingContentPresentation } from './thinking-content';

function thinking(text: string, status: ThinkingItem['status'] = 'running'): ThinkingItem {
  return {
    id: 'native-thinking-1',
    type: 'thinking',
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1,
    updatedAt: 1,
    status,
    text,
  };
}

const hosts: HTMLElement[] = [];
function fixture(text: string, status: ThinkingItem['status'] = 'running') {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  let item = thinking(text, status);
  let following = true;
  const commit = () => render(presentation.render(item), host);
  const preserve = vi.fn(() => { following = false; });
  const latest = vi.fn((_element: HTMLElement, streaming: boolean) => {
    following = streaming;
  });
  const presentation = new ThinkingContentPresentation({
    requestUpdate: commit,
    preserve,
    following: () => following,
    latest,
  });
  presentation.reset('session:incarnation:0');
  commit();
  return {
    host,
    presentation,
    preserve,
    latest,
    commit,
    pause: () => { following = false; },
    resume: () => { following = true; },
    update(source: string, nextStatus = item.status) {
      item = { ...item, text: source, status: nextStatus, lastSeq: item.lastSeq + 1 };
      commit();
    },
    body: () => host.querySelector<HTMLElement>('[data-thinking-body]')!,
    click(action: string) {
      host.querySelector<HTMLButtonElement>(`[data-thinking-action="${action}"]`)!.click();
    },
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    render(nothing, host);
    host.remove();
  }
  vi.restoreAllMocks();
});

describe('Thinking-owned source presentation', () => {
  test('retains stable Markdown nodes and the literal tail text node during token updates', () => {
    const source = 'Completed **paragraph**.\n\nA growing tail';
    const view = fixture(source);
    const paragraph = view.body().querySelector('p');
    const tail = view.body().querySelector('.thinking-content__tail');
    const tailText = tail!.lastChild;

    view.update(`${source} with [an unfinished](link`);

    expect(view.body().querySelector('p')).toBe(paragraph);
    expect(view.body().querySelector('.thinking-content__tail')).toBe(tail);
    expect(tail!.lastChild).toBe(tailText);
    expect(tail!.textContent).toContain('[an unfinished](link');
    expect(view.host.querySelector('[data-thinking-content]')).not.toBeNull();
    expect(view.host.querySelector('justdo-tool-output')).toBeNull();
  });

  test('keeps an open code shell while rendering streamed HTML as literal code', () => {
    const source = 'Example:\n\n```typescript\nconst value = "<img src=x onerror=alert(1)>";';
    const view = fixture(source);
    const pre = view.body().querySelector('pre');
    const code = pre!.querySelector('code');

    view.update(`${source}\nnext();`);

    expect(view.body().querySelector('pre')).toBe(pre);
    expect(view.body().querySelector('code')).toBe(code);
    expect(code!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(view.body().querySelector('img')).toBeNull();
    view.update(`${source}\nnext();\n\x60\x60\x60`);
    expect(view.body().querySelector('img')).toBeNull();
    expect(view.body().querySelector('code')!.textContent).toContain('next();');
  });

  test('keeps incomplete Mermaid and incomplete fence info visible as text', () => {
    const view = fixture('```mermaid\ngraph TD\nA -->');
    expect(view.body().querySelector('.mermaid-block')).toBeNull();
    expect(view.body().textContent).toContain('```mermaid');
    view.update('```type');
    expect(view.body().querySelector('code')).toBeNull();
    expect(view.body().textContent).toContain('```type');
  });

  test('switches to a bounded recent view only after crossing the natural text budget', () => {
    const source = 'a'.repeat(40_000);
    const view = fixture(source);
    expect(view.body().textContent).toBe(source);
    expect(view.host.querySelector('[data-thinking-action]')).toBeNull();

    view.update(`${source}b`);

    expect(view.body().textContent!.length).toBeGreaterThan(16_000);
    expect(view.body().textContent!.length).toBeLessThanOrEqual(32_000);
    expect(view.body().textContent).toMatch(/b$/);
    expect(view.host.querySelector('justdo-tool-output')).toBeNull();
  });

  test('keeps the natural range when paused at the first threshold crossing', () => {
    const source = 'a'.repeat(39_999);
    const view = fixture(source);
    const tail = view.body().querySelector('.thinking-content__tail');
    view.pause();

    view.update(`${source}bc`);

    expect(view.body().textContent).toBe(source);
    expect(view.body().querySelector('.thinking-content__tail')).toBe(tail);
    expect(view.host.querySelector('.thinking-content__new-content')).not.toBeNull();
    const toolbar = view.host.querySelector('.thinking-content__toolbar')!;
    expect(view.body().compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(view.host.querySelector('.thinking-content__notice')).toBeNull();
    expect(view.host.querySelector('.thinking-content__toolbar--footer')).toBeNull();
    view.click('latest');
    expect(view.latest).toHaveBeenCalledWith(view.host.querySelector('[data-thinking-content]'), true);
    expect(view.body().textContent).toMatch(/bc$/);
    expect(view.body().textContent!.length).toBeLessThanOrEqual(32_000);
  });

  test('keeps a full preceding section when a new streaming section begins', () => {
    const source = 'a'.repeat(48_000);
    const view = fixture(source);
    const previousLast = view.body().querySelector('[data-thinking-section-start="32000"]');

    view.update(`${source}b`);

    expect(view.body().textContent).toBe(`${'a'.repeat(16_000)}b`);
    expect(view.body().querySelector('[data-thinking-section-start="32000"]')).toBe(previousLast);
    expect(view.body().querySelectorAll('[data-thinking-section-start]')).toHaveLength(2);
  });

  test('pins a manual range through appends and resumes latest only on request', () => {
    const source = 'a'.repeat(70_000);
    const view = fixture(source);
    view.click('previous');
    const section = view.body().querySelector('[data-thinking-section-start]');
    const text = view.body().textContent;

    view.update(`${source}${'b'.repeat(40_000)}`);

    expect(view.body().textContent).toBe(text);
    expect(view.body().querySelector('[data-thinking-section-start]')).toBe(section);
    expect(view.host.querySelector('.thinking-content__new-content')).not.toBeNull();
    view.click('latest');
    expect(view.body().textContent).toMatch(/b$/);
    expect(view.host.querySelector('.thinking-content__new-content')).toBeNull();
    expect(view.latest).toHaveBeenCalledWith(view.host.querySelector('[data-thinking-content]'), true);
  });

  test('historical next and end navigation works without a new transcript source', () => {
    const source = `${'a'.repeat(16_000)}${'b'.repeat(16_000)}${'c'.repeat(16_000)}`;
    const view = fixture(source, 'completed');
    expect(view.body().textContent).toBe('a'.repeat(16_000));

    view.click('next');
    expect(view.body().textContent).toBe('b'.repeat(16_000));
    expect(view.preserve).toHaveBeenCalled();
    view.click('latest');
    expect(view.body().textContent).toBe(`${'b'.repeat(16_000)}${'c'.repeat(16_000)}`);
    expect(view.latest).toHaveBeenCalledWith(view.host.querySelector('[data-thinking-content]'), false);
  });

  test('offers footer navigation after long content and pins a section selected there', () => {
    const source = `${'a'.repeat(16_000)}${'b'.repeat(16_000)}${'c'.repeat(16_000)}`;
    const view = fixture(source, 'completed');
    const footer = view.host.querySelector('.thinking-content__toolbar--footer')!;
    expect(view.body().compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(footer.querySelector('[data-thinking-action="copy"]')).toBeNull();
    expect(footer.querySelector('[data-thinking-action="download"]')).toBeNull();

    footer.querySelector<HTMLButtonElement>('[data-thinking-action="next"]')!.click();

    expect(view.body().textContent).toBe('b'.repeat(16_000));
    view.update(`${source}${'d'.repeat(16_000)}`);
    expect(view.body().textContent).toBe('b'.repeat(16_000));
    view.host.querySelector<HTMLButtonElement>('.thinking-content__toolbar--footer [data-thinking-action="latest"]')!.click();
    expect(view.body().textContent).toBe(`${'c'.repeat(16_000)}${'d'.repeat(16_000)}`);
    expect(view.latest).toHaveBeenCalledWith(view.host.querySelector('[data-thinking-content]'), false);
  });

  test('preserves a manual range across completion and a same-scope remount', () => {
    const source = 'a'.repeat(70_000);
    const view = fixture(source);
    view.click('previous');
    const text = view.body().textContent;
    const offset = view.body().querySelector<HTMLElement>('[data-thinking-section-start]')!.dataset.thinkingSectionStart;

    view.update(source, 'completed');
    expect(view.body().textContent).toBe(text);
    render(nothing, view.host);
    view.commit();
    expect(view.body().textContent).toBe(text);
    expect(view.body().querySelector<HTMLElement>('[data-thinking-section-start]')!.dataset.thinkingSectionStart).toBe(offset);

    view.presentation.reset('session:incarnation:1');
    view.commit();
    expect(view.body().querySelector('[data-thinking-section-start="0"]')).not.toBeNull();
  });

  test('invalidates pinned ranges for an equal-length replacement and for a retraction', () => {
    const view = fixture('a'.repeat(70_000), 'completed');
    view.click('next');

    view.update('b'.repeat(70_000));

    expect(view.body().querySelector('[data-thinking-section-start="0"]')).not.toBeNull();
    expect(view.body().textContent).toBe('b'.repeat(16_000));
    view.update('Short replacement.');
    expect(view.body().textContent?.trim()).toBe('Short replacement.');
    expect(view.host.querySelector('[data-thinking-action]')).toBeNull();
  });

  test.each([70_000, 75_000])('invalidates a same-scope remounted replacement of %s characters', length => {
    const view = fixture('a'.repeat(70_000), 'completed');
    view.click('next');
    view.click('next');
    expect(view.body().querySelector('[data-thinking-section-start="32000"]')).not.toBeNull();
    render(nothing, view.host);
    const replacement = `${'b'.repeat(32_000)}${'x'.repeat(15_999)}😀${'y'.repeat(length)}`.slice(0, length);

    view.update(replacement);

    expect(view.body().querySelector('[data-thinking-section-start="0"]')).not.toBeNull();
    expect(view.body().textContent).toBe('b'.repeat(16_000));
  });

  test('retains a selected range when a remounted source really appended to its original prefix', () => {
    const source = 'a'.repeat(70_000);
    const view = fixture(source, 'completed');
    view.click('next');
    const selected = view.body().textContent;
    render(nothing, view.host);

    view.update(`${source}${'b'.repeat(10_000)}`);

    expect(view.body().querySelector('[data-thinking-section-start="16000"]')).not.toBeNull();
    expect(view.body().textContent).toBe(selected);
  });

  test.each([
    ['a'.repeat(39_998) + '\ud83d', '\ude00'],
    ['a'.repeat(39_998) + '\r', '\n'],
  ])('keeps a frozen natural end on a complete source boundary after a delta', (source, suffix) => {
    const view = fixture(source);
    view.pause();

    view.update(`${source}${suffix}${'b'.repeat(100)}`);

    expect(view.body().textContent).toBe('a'.repeat(39_998));
    view.click('latest');
    expect(view.body().textContent).toContain(`${source.slice(-1)}${suffix}`);
    expect(view.body().textContent!.length).toBeLessThanOrEqual(32_000);
  });

  test.each(['\ud83d', '\r'])('keeps a frozen long end on a complete boundary after %s is completed', ending => {
    const source = `${'a'.repeat(49_999)}${ending}`;
    const suffix = ending === '\r' ? '\n' : '\ude00';
    const view = fixture(source);
    view.pause();

    view.update(`${source}${suffix}${'b'.repeat(20)}`);

    expect(view.body().textContent).toBe('a'.repeat(17_999));
    expect(view.body().textContent!.length).toBeLessThanOrEqual(32_000);
    view.click('latest');
    expect(view.body().textContent).toContain(`${ending}${suffix}`);
  });

  test('bounds a two-million-character source while preserving exact full-source copy and download', async () => {
    const source = `start\r\n${'a'.repeat(2_000_000)}\r\n😀<tail>`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const createObjectURL = vi.fn().mockReturnValue('blob:thinking-test');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = fixture(source);
    expect(view.body().textContent!.length).toBeLessThanOrEqual(32_000);
    expect(view.body().textContent).toMatch(/😀<tail>$/);

    view.click('copy');
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(source);
    view.click('download');
    expect(click).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const downloaded = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
    expect(downloaded).toBe(source);
  });

  test('does not split surrogate pairs or CRLF at source section boundaries', () => {
    const source = `${'a'.repeat(15_999)}😀\r\n${'b'.repeat(40_000)}`;
    const view = fixture(source, 'completed');
    expect(view.body().textContent).toBe('a'.repeat(15_999));
    view.click('next');
    expect(view.body().textContent).toMatch(/^😀\r\n/);
  });

  test('restarts clipboard feedback duration for a second copy operation', async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      const view = fixture('a'.repeat(50_000));
      view.click('copy');
      await Promise.resolve();
      const label = view.host.querySelector('[data-thinking-action="copy"]')!.textContent;
      vi.advanceTimersByTime(1000);
      view.click('copy');
      await Promise.resolve();

      vi.advanceTimersByTime(400);

      expect(view.host.querySelector('[data-thinking-action="copy"]')!.textContent).toBe(label);
      vi.advanceTimersByTime(900);
      expect(view.host.querySelector('[data-thinking-action="copy"]')!.textContent).not.toBe(label);
    } finally {
      vi.useRealTimers();
    }
  });

  test('standalone helpers keep a usable bounded reader without a host registry', () => {
    const host = document.createElement('div');
    document.body.append(host);
    hosts.push(host);
    const source = `${'a'.repeat(16_000)}${'b'.repeat(32_000)}`;
    render(renderThinkingContent(source, false), host);

    host.querySelector<HTMLButtonElement>('[data-thinking-action="next"]')!.click();

    expect(host.querySelector('[data-thinking-body]')!.textContent).toBe('b'.repeat(16_000));
  });
});
