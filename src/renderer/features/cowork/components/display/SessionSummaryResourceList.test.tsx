// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type {
  SessionSummaryResources,
  SummaryResource,
} from '@/libs/openclaw-chat/model/session-summary-resources';
import { i18nService } from '@/services/i18n';

import SessionSummaryResourceList from './SessionSummaryResourceList';

afterEach(cleanup);

function fixture() {
  i18nService.setLanguage('en', { persist: false });
  const items: SummaryResource[] = [
    {
      id: 'report',
      title: 'report.md',
      target: { kind: 'file', path: 'E:/project/report.md' },
    },
    {
      id: 'web',
      title: 'Reference guide',
      target: { kind: 'url', url: 'https://example.com/guide' },
    },
    ...['summary.json', 'orders.jsonl', 'results.csv'].map(title => ({
      id: title,
      title,
      target: { kind: 'file' as const, path: `E:/project/${title}` },
    })),
  ];
  const resources: SessionSummaryResources = {
    sessionKey: 'chat',
    outputs: items,
    sources: items,
    outputsLoading: false,
    outputsUnavailable: false,
    omittedOversized: false,
  };
  return { items, resources, onOpenResource: vi.fn() };
}

it.each(['outputs', 'sources'] as const)(
  'shows every %s entry and opens its original reference through the shared callback',
  kind => {
    const { items, resources, onOpenResource } = fixture();
    const { container } = render(
      <SessionSummaryResourceList
        kind={kind}
        resources={resources}
        onOpenResource={onOpenResource}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('E:/project/report.md')).toBeTruthy();
    expect(screen.getByText('https://example.com/guide')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'results.csv' }));
    expect(onOpenResource).toHaveBeenLastCalledWith(items[4]);
    fireEvent.click(screen.getByRole('button', { name: 'Reference guide' }));
    expect(onOpenResource).toHaveBeenLastCalledWith(items[1]);
    expect(container.querySelector('a[download]')).toBeNull();
    expect(container.querySelector('[data-file-icon-kind="json"]')).toBeTruthy();
  },
);

it('updates the open list when the current session publishes new resources', () => {
  const { items, resources, onOpenResource } = fixture();
  const { rerender } = render(
    <SessionSummaryResourceList
      kind="sources"
      resources={{ ...resources, sources: items.slice(0, 4) }}
      onOpenResource={onOpenResource}
    />,
  );
  expect(screen.queryByRole('button', { name: 'results.csv' })).toBeNull();
  rerender(
    <SessionSummaryResourceList
      kind="sources"
      resources={resources}
      onOpenResource={onOpenResource}
    />,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'results.csv' }));
  expect(onOpenResource).toHaveBeenCalledWith(items[4]);

  rerender(
    <SessionSummaryResourceList kind="sources" resources={null} onOpenResource={onOpenResource} />,
  );
  expect(screen.queryByRole('listitem')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Loading...');
});

it('retains confirmed outputs on read failure and does not claim the list is empty', () => {
  const { resources, onOpenResource } = fixture();
  render(
    <SessionSummaryResourceList
      kind="outputs"
      resources={{ ...resources, outputsUnavailable: true, omittedOversized: true }}
      onOpenResource={onOpenResource}
    />,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(screen.getByRole('status').textContent).toBe(
    'Outputs are temporarily unavailable. Please retry later.',
  );
  expect(screen.getByText('Some large outputs are omitted from this list.')).toBeTruthy();
  expect(screen.queryByText('None')).toBeNull();
});

it('keeps inline payloads and opaque artifact IDs out of resource descriptions', () => {
  const { resources, onOpenResource } = fixture();
  render(
    <SessionSummaryResourceList
      kind="outputs"
      resources={{
        ...resources,
        outputs: [
          {
            id: 'image',
            title: 'image.png',
            target: { kind: 'media', url: 'data:image/png;base64,YQ==' },
          },
          {
            id: 'opaque',
            title: 'report.pdf',
            target: { kind: 'artifact', artifactId: 'opaque-identity', assistantOnly: true },
          },
        ],
      }}
      onOpenResource={onOpenResource}
    />,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByText(/base64|opaque-identity/u)).toBeNull();
});
