// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { renderRichContent } from '../conversation-overlay/modules/sidepanel-rich-content.js';

describe('desktop process content in the extension', () => {
  it('renders native compaction metrics and retains an open summary on updates', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const entry = (tokensAfter: number) => ({
      role: 'compaction',
      rawMessage: {
        role: 'system',
        content: '',
        timestamp: 10,
        __openclaw: {
          kind: 'compaction-status',
          phase: 'completed',
          tokensBefore: 1000,
          tokensAfter,
          summary: 'Retained native summary',
        },
      },
    });
    renderRichContent(host, entry(400), vi.fn());
    const details = host.querySelector<HTMLDetailsElement>('.chat-divider__details')!;
    expect(host.textContent).toContain('1,000 → 400 tokens');
    expect(host.textContent).toContain('Retained native summary');
    details.open = true;
    renderRichContent(host, entry(300), vi.fn());
    expect(host.querySelector('.chat-divider__details')).toBe(details);
    expect(details.open).toBe(true);
    expect(host.textContent).toContain('1,000 → 300 tokens');
    host.remove();
  });

  it('uses the desktop progress receipt label and keeps model text as text', () => {
    const host = document.createElement('div');
    renderRichContent(
      host,
      {
        role: 'progress-receipt',
        item: {
          id: 'progress-1',
          status: 'completed',
          input: {
            plan: [
              { step: 'Done', status: 'completed' },
              { step: '<img src=x onerror=alert(1)>', status: 'in_progress' },
            ],
          },
        },
      },
      vi.fn(),
    );
    expect(host.querySelector('.progress-card-receipt')).not.toBeNull();
    expect(host.textContent).toMatch(/1\/2|1 of 2|1.*2/);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
  });
});
