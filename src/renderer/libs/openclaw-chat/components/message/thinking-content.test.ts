// @vitest-environment jsdom

import { nothing, render } from 'lit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import type { ThinkingItem } from '../../model/chat-transcript-state';
import {
  renderThinkingContent,
  revealThinkingContent,
  ThinkingContentPresentation,
} from './thinking-content';

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
  const commit = () => render(presentation.render(item), host);
  const preserve = vi.fn();
  let following = true;
  const presentation = new ThinkingContentPresentation({ requestUpdate: commit, preserve, isFollowing: () => following });
  presentation.reset('session:incarnation:0');
  commit();
  return {
    host,
    presentation,
    preserve,
    commit,
    follow(value: boolean) {
      following = value;
      presentation.syncScrollMode();
    },
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
  vi.unstubAllGlobals();
});

describe('Thinking line preview', () => {
  let resize: () => void;
  let height: number;
  const disconnect = vi.fn();

  beforeEach(() => {
    height = 220;
    disconnect.mockClear();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
  });

  function preview(text = 'A thinking paragraph.\n\nA growing tail') {
    const view = fixture(text);
    const content = view.host.querySelector<HTMLElement>('[data-thinking-body]')!;
    content.style.lineHeight = '20px';
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
    vi.spyOn(content, 'scrollHeight', 'get').mockImplementation(() => height);
    resize();
    return {
      ...view,
      toggle: () => view.host.querySelector<HTMLButtonElement>('[data-thinking-action="toggle-preview"]'),
    };
  }

  test.each([20, 200, 201])('omits the control when layout fits ten lines (%ipx)', contentHeight => {
    height = contentHeight;
    const view = preview();
    expect(view.toggle()).toBeNull();
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(false);
  });

  test('reveals the complete body and collapses it without replacing Markdown or starting page navigation', () => {
    const view = preview();
    const paragraph = view.body().querySelector('p');
    expect(view.toggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(view.toggle()!.getAttribute('aria-controls')).toBe(view.body().id);
    expect(view.toggle()!.getAttribute('aria-label')).toBe(i18nService.t('thinkingExpand'));

    view.click('toggle-preview');

    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    expect(view.toggle()!.getAttribute('aria-expanded')).toBe('true');
    expect(view.toggle()!.getAttribute('aria-label')).toBe(i18nService.t('thinkingCollapse'));
    expect(view.body().querySelector('p')).toBe(paragraph);
    expect(view.preserve).toHaveBeenCalledWith(view.host.querySelector('[data-thinking-content]'));
    view.click('toggle-preview');
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(false);
    expect(view.preserve).toHaveBeenLastCalledWith(view.toggle());
  });

  test('detects streaming growth and resize while retaining an explicit expanded choice', () => {
    height = 100;
    const view = preview();
    expect(view.toggle()).toBeNull();
    height = 240;
    view.update('A thinking paragraph.\n\nA growing tail with more content.');
    resize();
    expect(view.toggle()).not.toBeNull();
    view.click('toggle-preview');
    height = 100;
    resize();
    expect(view.toggle()!.getAttribute('aria-expanded')).toBe('true');
    view.click('toggle-preview');
    expect(view.toggle()).toBeNull();
  });

  test('follows the streamed tail, freezes while reading, and resumes without a text update', async () => {
    const view = preview();
    const viewport = view.body().parentElement!;
    expect(viewport.scrollTop).toBe(20);
    expect(viewport.classList.contains('has-hidden-prefix')).toBe(true);
    height = 360;
    view.update('A thinking paragraph.\n\nA growing tail extended');
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(160);
    view.follow(false);
    height = 480;
    view.update('A thinking paragraph.\n\nA growing tail extended again');
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(160);
    view.follow(true);
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(280);
    view.update('A thinking paragraph.\n\nA growing tail extended again', 'completed');
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(280);
    view.follow(false);
    view.follow(true);
    height = 500;
    resize();
    expect(viewport.scrollTop).toBe(280);
  });

  test('restores a paused offset on remount and resets a replacement and historical scope to the head', async () => {
    const view = preview();
    view.follow(false);
    render(nothing, view.host);
    view.commit();
    const body = view.body();
    body.style.lineHeight = '20px';
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
    vi.spyOn(body, 'scrollHeight', 'get').mockImplementation(() => height);
    height = 400;
    resize();
    expect(body.parentElement!.scrollTop).toBe(20);
    view.update('Replacement history', 'completed');
    await Promise.resolve();
    expect(body.parentElement!.scrollTop).toBe(0);
    expect(body.parentElement!.classList.contains('has-hidden-prefix')).toBe(false);
    view.presentation.reset('fresh-history');
    view.commit();
    await Promise.resolve();
    expect(view.body().parentElement!.scrollTop).toBe(0);
  });

  test('reveals the whole source from a tail preview and returns to the tail on collapse', async () => {
    const view = preview();
    const viewport = view.body().parentElement!;
    revealThinkingContent(view.body());
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.classList.contains('has-hidden-prefix')).toBe(false);
    height = 400;
    resize();
    expect(viewport.scrollTop).toBe(0);
    view.follow(false);
    view.click('toggle-preview');
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(200);
    height = 100;
    resize();
    expect(viewport.scrollTop).toBe(0);
  });

  test('reveals final appended text when completion remounts the same process', () => {
    const view = preview();
    render(nothing, view.host);
    height = 500;
    view.update('A thinking paragraph.\n\nA growing tail and final text', 'completed');
    const body = view.body();
    body.style.lineHeight = '20px';
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
    vi.spyOn(body, 'scrollHeight', 'get').mockImplementation(() => height);
    resize();
    expect(body.parentElement!.scrollTop).toBe(300);
  });

  test('keeps expansion through append, completion and remount, and resets at a new scope or replacement', () => {
    const source = 'First paragraph.\n\nGrowing tail';
    const view = preview(source);
    view.click('toggle-preview');
    view.update(`${source} appended`, 'completed');
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    render(nothing, view.host);
    view.commit();
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    view.update('Authoritative replacement.');
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(false);
    revealThinkingContent(view.body());
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    view.presentation.reset('another-session:incarnation:0');
    view.commit();
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(false);
  });

  test('reveals a search mark synchronously without detaching it and disconnects layout observation on unmount', () => {
    const view = preview();
    const mark = document.createElement('span');
    mark.textContent = 'Search tail';
    view.body().querySelector('.thinking-content__tail')!.append(mark);
    revealThinkingContent(mark);
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    expect(mark.isConnected).toBe(true);
    const calls = disconnect.mock.calls.length;
    render(nothing, view.host);
    expect(disconnect.mock.calls.length).toBeGreaterThan(calls);
  });

  test('reveals clipped links when keyboard navigation moves focus into the thinking body', () => {
    const view = preview('Opening paragraph.\n\n[Later link](https://example.com)\n\n');
    const link = view.body().querySelector<HTMLAnchorElement>('a')!;
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(view.body().parentElement!.classList.contains('is-expanded')).toBe(true);
    expect(view.toggle()!.getAttribute('aria-expanded')).toBe('true');
  });
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

  test.each(['running', 'completed'] as const)('keeps a complete long %s source without reader sections or navigation', status => {
    const source = 'start\r\n' + 'a'.repeat(70_000) + '\r\n😀<img src=x onerror=alert(1)>tail';
    const view = fixture(source, status);
    expect(view.body().textContent).toBe(source.replace(/\r\n/g, '\n'));
    expect(view.body().querySelector('img')).toBeNull();
    expect(view.host.querySelector('[data-thinking-section-start]')).toBeNull();
    expect(view.host.querySelector('.thinking-content__toolbar')).toBeNull();
    view.update(source + '\nMore thinking.', status);
    expect(view.body().textContent).toContain('tail\nMore thinking.');
    expect(view.body().textContent).toContain('a'.repeat(70_000));
  });

  test('standalone helpers keep full thinking text without a host registry', () => {
    const host = document.createElement('div');
    document.body.append(host);
    hosts.push(host);
    const source = 'a'.repeat(70_000);
    render(renderThinkingContent(source, false), host);
    expect(host.querySelector('[data-thinking-body]')!.textContent).toBe(source);
    revealThinkingContent(host.querySelector<HTMLElement>('[data-thinking-body]')!);
    expect(host.querySelector('.thinking-content__viewport')!.classList.contains('is-expanded')).toBe(true);
  });
});
