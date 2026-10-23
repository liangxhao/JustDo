import { PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { type MarketplacePluginKind,PluginKind } from '@shared/plugins/marketplace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import ExtensionsManager from '@/features/plugins/extensions/ExtensionsManager';
import { MarketplaceResults } from '@/features/plugins/marketplace/MarketplaceView';
import { usePluginMarketplace } from '@/features/plugins/marketplace/usePluginMarketplace';
import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';
import PluginOperationStatus from '@/features/plugins/shared/PluginOperationStatus';
import { classicDark } from '@/theme/themes/classic-dark';
import { classicLight } from '@/theme/themes/classic-light';

type InstalledProbePlugin = {
  id: string;
  version?: string;
  installPath?: string;
  enabled?: boolean;
};

declare global {
  interface Window {
    marketplaceProbe: {
      inventory: (kind: MarketplacePluginKind) => Promise<{ installed: InstalledProbePlugin[] }>;
      setScenario: (scenario: {
        pluginId?: string;
        failure?: 'metadata' | 'download' | 'invalid' | 'activation' | 'refresh';
        delayMs?: number;
        version?: string;
      }) => Promise<unknown>;
      evidence: () => Promise<Record<string, unknown>>;
      selectInputs: (paths: string[]) => Promise<unknown>;
      nativeInventory: () => Promise<Record<string, unknown>>;
    };
  }
}

const labels: Record<MarketplacePluginKind, string> = {
  [PluginKind.EXTENSION]: '扩展',
  [PluginKind.SKILL]: 'Skill',
  [PluginKind.MCP]: 'MCP',
};

function CatalogPane({ kind }: { kind: MarketplacePluginKind }) {
  const [installed, setInstalled] = useState<InstalledProbePlugin[]>([]);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const refreshInventory = useCallback(async () => {
    const generation = ++readGeneration.current;
    const result = await window.marketplaceProbe.inventory(kind);
    if (!Array.isArray(result.installed)) throw new Error('The probe inventory is unavailable');
    if (mounted.current && generation === readGeneration.current) {
      setInstalled(result.installed);
      setInventoryReady(true);
      setInventoryError('');
    }
  }, [kind]);
  useEffect(() => {
    mounted.current = true;
    void refreshInventory().catch(error => {
      if (!mounted.current) return;
      setInventoryReady(false);
      setInventoryError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
    };
  }, [refreshInventory]);
  const marketInventory = useMemo(
    () => installed.map(({ id, version, installPath }) => ({ id, version, installPath })),
    [installed],
  );
  const marketplace = usePluginMarketplace({
    kind,
    installed: marketInventory,
    inventoryReady,
    searchQuery: '',
    onInstalled: refreshInventory,
  });

  return (
    <section data-testid={`catalog-${kind}`} className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-5">
        <MarketplaceResults
          controller={marketplace}
          icon={<PuzzlePieceIcon className="h-4 w-4" />}
        />
      </div>
      <aside
        data-testid="installed-inventory"
        className="rounded-xl border border-border bg-surface p-4"
      >
        <h2 className="text-sm font-medium">隔离测试目录中的实际安装清单</h2>
        <p className="mt-1 text-xs text-secondary">
          读取 Main 的受管文件和原生状态；不修改当前用户的插件。
        </p>
        {inventoryError && <p role="alert">{inventoryError}</p>}
        {!inventoryReady && !inventoryError && (
          <p className="mt-3 text-xs text-secondary">正在读取清单…</p>
        )}
        <ul className="mt-3 space-y-2 text-xs">
          {installed.map(item => (
            <li
              key={item.id}
              data-testid={`installed-${item.id}`}
              data-enabled={String(item.enabled)}
              className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised px-3 py-2"
            >
              <code>{item.id}</code>
              <span>{item.version || '—'}</span>
              <span>
                {item.enabled === true
                  ? '已启用'
                  : item.enabled === false
                    ? '已停用'
                    : '状态未提供'}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}

function MarketplaceProbe() {
  const [kind, setKind] = useState<MarketplacePluginKind>(PluginKind.SKILL);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const theme = dark ? classicDark : classicLight;
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    for (const [key, value] of Object.entries(theme.tokens))
      document.documentElement.style.setProperty(`--justdo-${key}`, value);
  }, [dark]);
  return (
    <main className="min-h-screen bg-background px-6 py-8 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">本地插件市场联调</h1>
            <p className="mt-1 text-sm text-secondary">
              真实 Renderer → 隔离 preload → Electron IPC → 本地市场与安装服务
            </p>
          </div>
          <button
            type="button"
            data-testid="toggle-theme"
            onClick={() => setDark(value => !value)}
            className="rounded-lg border border-border px-3 py-2 text-xs"
          >
            {dark ? '浅色' : '深色'}
          </button>
        </header>
        <nav aria-label="插件分类" className="mb-5 flex gap-2">
          {Object.entries(labels).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`category-${id}`}
              aria-pressed={kind === id}
              onClick={() => setKind(id as MarketplacePluginKind)}
              className={`rounded-lg border px-4 py-2 text-sm ${kind === id ? 'border-primary text-primary' : 'border-border text-secondary'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <CatalogPane key={kind} kind={kind} />
      </div>
      <PluginOperationStatus />
      <PluginOperationFeedback />
    </main>
  );
}

function ExtensionImportProbe() {
  useEffect(() => {
    for (const [key, value] of Object.entries(classicLight.tokens))
      document.documentElement.style.setProperty(`--justdo-${key}`, value);
  }, []);
  return (
    <main className="min-h-screen bg-background px-6 py-8 text-foreground">
      <div data-testid="extension-import-pane" className="mx-auto max-w-5xl">
        <h1 className="mb-5 text-xl font-semibold">扩展包导入联调</h1>
        <ExtensionsManager />
      </div>
      <PluginOperationStatus />
      <PluginOperationFeedback />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The marketplace probe root is missing');
createRoot(root).render(new URLSearchParams(location.search).get('mode') === 'extension-import'
  ? <ExtensionImportProbe /> : <MarketplaceProbe />);
