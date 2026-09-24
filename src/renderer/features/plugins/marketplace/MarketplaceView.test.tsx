// @vitest-environment jsdom

import {
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  PluginKind,
} from '@shared/plugins/marketplace';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import MarketplaceView from './MarketplaceView';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
    getLanguage: () => 'en',
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('uses an empty search as the provider-ranked recommendation feed', async () => {
  const search = vi.fn(async () => ({
    success: true,
    result: {
      items: [
        {
          id: 'writer',
          kind: PluginKind.SKILL,
          name: 'Writer',
          description: 'Writes concise documents',
          sourceId: 'enterprise',
          downloadCount: 12_345,
        },
      ],
    },
  }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            {
              id: 'enterprise',
              name: 'Enterprise',
              supportedKinds: [PluginKind.SKILL],
            },
          ],
        })),
        search,
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(await screen.findByText('Writer')).toBeTruthy();
  expect(
    screen.getByText(
      new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(12_345),
    ),
  ).toBeTruthy();
  expect(screen.getByText('marketplaceDiscoverTitle')).toBeTruthy();
  expect(search).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    query: undefined,
    limit: 8,
    sourceId: 'enterprise',
  });

  fireEvent.change(screen.getByPlaceholderText('marketplaceSearchPlaceholder'), {
    target: { value: 'notes' },
  });
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith({
      kind: PluginKind.SKILL,
      query: 'notes',
      limit: 60,
      sourceId: 'enterprise',
    }),
  );
  expect(screen.getByText('marketplaceResultsTitle')).toBeTruthy();
});

test('keeps the recommendation section when the provider has no default feed', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({ success: true, result: { items: [] } })),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(screen.getByText('marketplaceDiscoverTitle')).toBeTruthy();
  expect(await screen.findByText('marketplaceEmpty')).toBeTruthy();
});

test('loads provider categories and applies a toggleable category filter', async () => {
  const search = vi.fn(async () => ({
    success: true,
    result: {
      items: [
        {
          id: 'writer',
          kind: PluginKind.SKILL,
          name: 'Writer',
          description: 'Writes documents',
          category: { id: 'docs', name: '文档撰写' },
          sourceId: 'enterprise',
        },
      ],
    },
  }));
  const listCategories = vi.fn(async () => ({
    success: true,
    result: {
      categories: [
        { id: 'development', name: '代码开发' },
        { id: 'docs', name: '文档撰写' },
      ],
    },
  }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            {
              id: 'enterprise',
              name: 'Enterprise',
              supportedKinds: [PluginKind.SKILL],
              supportsCategories: true,
            },
          ],
        })),
        listCategories,
        search,
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(await screen.findByRole('button', { name: '代码开发' })).toBeTruthy();
  expect(listCategories).toHaveBeenCalledWith({
    kind: PluginKind.SKILL,
    sourceId: 'enterprise',
  });
  expect(await screen.findByText('Writer')).toBeTruthy();
  expect(screen.getAllByText('文档撰写')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: '代码开发' }));
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith({
      kind: PluginKind.SKILL,
      categoryId: 'development',
      query: undefined,
      limit: 8,
      sourceId: 'enterprise',
    }),
  );

  fireEvent.click(screen.getByRole('button', { name: '代码开发' }));
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith({
      kind: PluginKind.SKILL,
      query: undefined,
      limit: 8,
      sourceId: 'enterprise',
    }),
  );

  fireEvent.change(screen.getByPlaceholderText('marketplaceSearchPlaceholder'), {
    target: { value: 'writer' },
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: '代码开发' })).toBeNull());
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith({
      kind: PluginKind.SKILL,
      query: 'writer',
      limit: 60,
      sourceId: 'enterprise',
    }),
  );
});

test('keeps the recommendation section when no marketplace provider is configured', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({ success: true, sources: [] })),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(screen.getByText('marketplaceDiscoverTitle')).toBeTruthy();
  expect(await screen.findByText('marketplaceNotConfigured')).toBeTruthy();
});

test('keeps marketplace source failures visible on the default page', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({ success: false, error: 'catalog unavailable' })),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(await screen.findByText('catalog unavailable')).toBeTruthy();
});

test('keeps minimal-provider cards focused on installation when details are unavailable', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            {
              id: 'enterprise',
              name: 'Enterprise',
              supportedKinds: [PluginKind.SKILL],
              supportsDetail: false,
            },
          ],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
        detail: vi.fn(),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);

  expect(await screen.findByText('Writer')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /subtaskShowInfo/ })).toBeNull();
});

test('uses the shared hub query without rendering a second search box', async () => {
  const search = vi.fn(async () => ({ success: true, result: { items: [] } }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            {
              id: 'enterprise',
              name: 'Enterprise',
              supportedKinds: [PluginKind.SKILL],
            },
          ],
        })),
        search,
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} searchQuery="notes" />);

  await waitFor(() =>
    expect(search).toHaveBeenCalledWith({
      kind: PluginKind.SKILL,
      query: 'notes',
      limit: 60,
      sourceId: 'enterprise',
    }),
  );
  expect(screen.queryByPlaceholderText('marketplaceSearchPlaceholder')).toBeNull();
});

test('keeps source selection available with the shared hub search', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            { id: 'one', name: 'One', supportedKinds: [PluginKind.SKILL] },
            { id: 'two', name: 'Two', supportedKinds: [PluginKind.SKILL] },
          ],
        })),
        search: vi.fn(async () => ({ success: true, result: { items: [] } })),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} searchQuery="notes" />);

  expect(await screen.findByRole('combobox', { name: 'marketplaceSource' })).toBeTruthy();
  expect(screen.queryByPlaceholderText('marketplaceSearchPlaceholder')).toBeNull();
});

test('uses runtime inventory as installation authority and filters installed items', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'not-installed',
                kind: PluginKind.SKILL,
                name: 'Not installed',
                description: 'Catalog incorrectly says update',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
              {
                id: 'installed',
                kind: PluginKind.SKILL,
                name: 'Installed item',
                description: 'Catalog incorrectly says unavailable',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UNAVAILABLE,
              },
            ],
          },
        })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'installed' }]}
      availableOnly
    />,
  );

  expect(await screen.findByText('Not installed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'marketplaceInstall' })).toBeTruthy();
  expect(screen.queryByText('Installed item')).toBeNull();
});

test('marks an installed marketplace item when an update is available', async () => {
  const onUpdateIdsChange = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes documents',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
            ],
          },
        })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[
        { id: 'writer', updateEligible: true },
        { id: 'writer', updateEligible: false },
      ]}
      onUpdateIdsChange={onUpdateIdsChange}
    />,
  );

  expect(await screen.findByLabelText('marketplaceUpdateAvailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'marketplaceUpdate' })).toBeTruthy();
  await waitFor(() => expect(onUpdateIdsChange).toHaveBeenLastCalledWith(new Set(['writer'])));
});

test('does not offer marketplace updates for a system-managed installation', async () => {
  const onUpdateIdsChange = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'system-skill',
                kind: PluginKind.SKILL,
                name: 'System skill',
                description: 'Bundled capability',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
            ],
          },
        })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'system-skill', updateEligible: false }]}
      onUpdateIdsChange={onUpdateIdsChange}
    />,
  );

  expect(await screen.findByRole('button', { name: 'marketplaceInstalled' })).toBeTruthy();
  expect(screen.queryByLabelText('marketplaceUpdateAvailable')).toBeNull();
  await waitFor(() => expect(onUpdateIdsChange).toHaveBeenLastCalledWith(new Set()));
});

test('reports background update checks independently of recommendation results', async () => {
  const onUpdateIdsChange = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({ success: true, result: { items: [] } })),
        checkUpdates: vi.fn(async () => ({
          success: true,
          result: {
            updates: [
              {
                id: 'catalog-writer',
                runtimeId: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes documents',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
            ],
          },
        })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'writer', version: '1.0.0' }]}
      onUpdateIdsChange={onUpdateIdsChange}
    />,
  );

  await waitFor(() => expect(onUpdateIdsChange).toHaveBeenLastCalledWith(new Set(['writer'])));
  expect(screen.queryByText('Writer')).toBeNull();
});

test('uses a bulk update candidate when search metadata only says installed', async () => {
  const install = vi.fn(async () => ({ success: true, pluginId: 'writer' }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'catalog-writer',
                runtimeId: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes documents',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
        checkUpdates: vi.fn(async () => ({
          success: true,
          result: {
            updates: [
              {
                id: 'catalog-writer',
                runtimeId: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes documents',
                sourceId: 'enterprise',
                version: '2.0.0',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
            ],
          },
        })),
        install,
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'writer', version: '1.0.0' }]}
    />,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceUpdate' }));
  await waitFor(() =>
    expect(install).toHaveBeenCalledWith({
      sourceId: 'enterprise',
      pluginId: 'catalog-writer',
      kind: PluginKind.SKILL,
      version: '2.0.0',
      operation: MarketplaceInstallOperation.UPDATE,
    }),
  );
});

test('preserves update state when marketplace details omit installation metadata', async () => {
  const install = vi.fn(async () => ({ success: true }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'catalog-writer',
                runtimeId: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Search description',
                sourceId: 'enterprise',
                installState: MarketplaceInstallState.UPDATE_AVAILABLE,
              },
            ],
          },
        })),
        detail: vi.fn(async () => ({
          success: true,
          detail: {
            id: 'catalog-writer',
            kind: PluginKind.SKILL,
            name: 'Writer details',
            description: 'Detailed description',
            sourceId: 'enterprise',
          },
        })),
        install,
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'writer' }]}
    />,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'subtaskShowInfo: Writer' }));
  expect(await screen.findByText('Writer details')).toBeTruthy();
  expect(screen.getAllByText('marketplaceUpdateAvailable')).toHaveLength(1);
  const updateButtons = screen.getAllByRole('button', { name: 'marketplaceUpdate' });
  fireEvent.click(updateButtons[updateButtons.length - 1]);

  await waitFor(() =>
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ operation: MarketplaceInstallOperation.UPDATE }),
    ),
  );
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'marketplaceUpdate' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'marketplaceInstalled' }).length).toBeGreaterThan(0);
  });
});

test('does not open details when keyboard activation comes from the install button', async () => {
  const detail = vi.fn(async () => ({ success: true, detail: null }));
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
        detail,
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'marketplaceInstall' }), {
    key: ' ',
  });

  expect(detail).not.toHaveBeenCalled();
});

test('keeps catalog results visible while runtime installation is unavailable', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
      },
    },
  });

  render(<MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} runtimeUnavailable />);

  const action = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'marketplaceRuntimeUnavailable',
  });
  expect(action.disabled).toBe(true);
  expect(screen.getByText('Writer')).toBeTruthy();
});

test('announces a successful marketplace installation', async () => {
  const onInstalled = vi.fn(async () => undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
        install: vi.fn(async () => ({ success: true, pluginId: 'writer' })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      onInstalled={onInstalled}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));

  expect((await screen.findByRole('status')).textContent).toContain('marketplaceInstallSucceeded');
  expect(onInstalled).toHaveBeenCalledOnce();
});

test('keeps installation successful when the post-install refresh fails', async () => {
  const onInstalled = vi.fn(async () => {
    throw new Error('gateway reconnecting');
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [{ id: 'enterprise', name: 'Enterprise', supportedKinds: [PluginKind.SKILL] }],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
        install: vi.fn(async () => ({ success: true, pluginId: 'writer' })),
      },
    },
  });

  render(
    <MarketplaceView kind={PluginKind.SKILL} icon={<span>W</span>} onInstalled={onInstalled} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'marketplaceInstall' }));

  await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
  expect(screen.getByText(/marketplaceInstallSucceeded/)).toBeTruthy();
  expect(screen.getByText('marketplaceRefreshAfterInstallFailed')).toBeTruthy();
  expect(screen.queryByText('marketplaceInstallFailed')).toBeNull();
  expect(screen.getByRole('button', { name: 'marketplaceInstalled' })).toBeTruthy();
});

test('shows installed state without requiring a marketplace detail endpoint', async () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      marketplace: {
        listSources: vi.fn(async () => ({
          success: true,
          sources: [
            {
              id: 'enterprise',
              name: 'Enterprise',
              supportedKinds: [PluginKind.SKILL],
            },
          ],
        })),
        search: vi.fn(async () => ({
          success: true,
          result: {
            items: [
              {
                id: 'writer',
                kind: PluginKind.SKILL,
                name: 'Writer',
                description: 'Writes concise documents',
                sourceId: 'enterprise',
              },
            ],
          },
        })),
      },
    },
  });

  render(
    <MarketplaceView
      kind={PluginKind.SKILL}
      icon={<span>W</span>}
      installed={[{ id: 'writer' }]}
    />,
  );

  const installedButton = await screen.findByRole('button', { name: 'marketplaceInstalled' });
  expect(installedButton.hasAttribute('disabled')).toBe(true);
});
