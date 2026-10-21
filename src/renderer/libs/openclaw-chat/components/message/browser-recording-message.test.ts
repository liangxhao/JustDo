// @vitest-environment jsdom
import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import { renderBrowserRecording } from './browser-recording-message';

afterEach(() => {
  document.body.innerHTML = '';
});
const draft: BrowserRecordingDraft = {
  id: 'r',
  sessionId: 's',
  title: 'Search tutorial',
  note: 'Try another keyword',
  profile: 'embedded',
  startedAt: 0,
  images: [],
  steps: [
    {
      id: 'nav',
      pageId: 'p',
      action: 'navigate',
      title: 'https://example.com/?long=url',
      url: 'https://example.com/?long=url',
      at: 0,
    },
    {
      id: 'click',
      pageId: 'p',
      action: 'click',
      title: 'Search',
      url: 'https://example.com/',
      at: 1,
      target: {
        tag: 'button',
        name: 'Search',
        role: 'button',
        selector: '#search',
        html: '<button onclick="alert(1)">Search</button><script>alert(1)</script>',
      },
      screenshotFiles: ['step.jpg'],
      note: 'Click once',
    },
  ],
};
function mount(value = draft) {
  i18nService.setLanguage('en', { persist: false });
  const host = document.createElement('div');
  document.body.append(host);
  render(renderBrowserRecording(value), host);
  return host;
}
describe('recording message cards', () => {
  it('renders expanded locator and observation evidence as inert text', () => {
    const host = mount({
      ...draft,
      steps: [
        {
          ...draft.steps[1],
          target: {
            ...draft.steps[1].target!,
            locators: [
              { kind: 'css', value: '[data-testid="search"]', matches: 1, verified: true },
            ],
            state: { expanded: 'true' },
            scopes: [{ kind: 'shadow', selector: '#host' }],
          },
          interaction: { observed: { messages: ['<img src=x onerror=alert(1)>'] } },
        },
      ],
    });
    expect(host.textContent).toContain('Locator candidates');
    expect(host.textContent).toContain('1 matches');
    expect(host.textContent).toContain('shadow: #host');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
  });
  it('explains scroll positions in the sent message too', () => {
    const host = mount({
      ...draft,
      steps: [{ ...draft.steps[0], action: 'scroll', value: '0,700' }],
    });
    expect(host.querySelector('.recording-value-label')?.textContent).toBe('Scroll position');
    expect(host.textContent).toContain('Horizontal 0 px · Vertical 700 px');
    expect(host.textContent).not.toContain('not the distance scrolled');
    expect(host.querySelector('.recording-value-hint')).toBeNull();
    expect(host.textContent).not.toContain('0,700');
  });
  it('renders a collapsed summary and counts historical screenshot references', () => {
    const host = mount();
    const card = host.querySelector('details.recording-message')!;
    expect(card.hasAttribute('open')).toBe(false);
    expect(card.querySelector('summary')?.textContent).toContain(
      '2 steps · 1 pages · 1 screenshots',
    );
    expect(host.querySelectorAll('.recording-message-timeline > li')).toHaveLength(2);
    expect(host.querySelector('h4')?.textContent).toBe('example.com');
  });
  it('keeps page information separate and never executes captured HTML', () => {
    const host = mount();
    const steps = host.querySelectorAll('.recording-message-step');
    expect(steps[0].querySelectorAll('details')).toHaveLength(1);
    expect(steps[0].querySelector('summary')?.textContent).toContain('Page info');
    expect(steps[1].querySelectorAll(':scope > details')).toHaveLength(2);
    expect(steps[1].querySelector('.recording-technical')?.tagName).toBe('DIV');
    expect(steps[1].querySelector('.recording-technical details')).toBeNull();
    expect(steps[1].querySelector('pre')?.textContent).toBe(draft.steps[1].target!.html);
    expect(host.querySelector('script,button[onclick],#search')).toBeNull();
    expect(host.textContent).toContain('Click once');
  });
  it('does not display password values or element metadata even in a malformed history item', () => {
    const host = mount({
      ...draft,
      steps: [{ ...draft.steps[1], sensitive: true, value: 'not-for-display' }],
    });
    expect(host.textContent).not.toContain('not-for-display');
    expect(host.querySelector('pre')).toBeNull();
    expect(host.textContent).toContain('Password not recorded');
  });
});
