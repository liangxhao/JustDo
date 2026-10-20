import '@/theme/css/themes.css';

import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ShareIcon, UserGroupIcon } from '@heroicons/react/24/outline';

import ComposerFeatureMenu from '@/features/cowork/components/composer/ComposerFeatureMenu';
import FeatureTextarea from '@/features/cowork/components/composer/draft/FeatureTextarea';
import CoworkDisplayPanel from '@/features/cowork/components/display/CoworkDisplayPanel';
import SessionSummaryPanel from '@/features/cowork/components/display/summary/SessionSummaryPanel';
import { AppPluginSlot } from '@/features/plugins/app/AppPluginSlot';
import { useAppComposer } from '@/features/plugins/app/useAppComposer';
import { useAppWorkspace } from '@/features/plugins/app/useAppWorkspace';
import { i18nService } from '@/services/i18n';

import { appBrowserRegistry, source } from './runtime';
import { buildAgentTeamFeature } from 'ui-baseline-menu';

const t = (key: string) => i18nService.t(key);
const results: Record<string, unknown> = {};
const errors: string[] = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));

function Surface() {
  const [baselineMode, setBaselineMode] = useState<'task' | 'group'>();
  const [baselineWorkflow, setBaselineWorkflow] = useState(false);
  const [draft, setDraft] = useState('验收目标');
  const [active, setActive] = useState('');
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryAnchor = useRef<HTMLButtonElement>(null);
  const composer = useAppComposer('ui-parity', true);
  const workspace = useAppWorkspace(source.id, id => {
    setActive(id);
    setOpen(true);
  });
  const team = {
    ...buildAgentTeamFeature(baselineMode, setBaselineMode),
    section: t('composerPlugins'),
  };
  const baseline = [
    {
      id: 'swarm-workflow',
      label: t('swarmWorkflowTitle'),
      section: t('composerPlugins'),
      icon: <ShareIcon className="h-4 w-4" />,
      onSelect: () => {
        setBaselineMode(undefined);
        setBaselineWorkflow(true);
      },
    },
    team,
  ];
  Object.assign((window as any).uiParity, {
    openTeam() {
      const view = appBrowserRegistry
        .getViews()
        .find(item => item.pluginId === 'agent-team' && item.id === 'team');
      if (!view) throw new Error('Team workspace is unavailable');
      workspace.open(view);
    },
    clear: composer.clear,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    openSummary: () => setSummaryOpen(true),
    closeSummary: () => setSummaryOpen(false),
    selection: () => composer.selected?.id,
  });
  return (
    <div className="cowork-display-host relative flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <main data-ui-chat="true" className="flex min-w-0 flex-1 flex-col p-6">
        <h1 className="text-lg font-semibold">插件界面回归对比</h1>
        <div className="relative mt-4 w-80" data-ui-summary="true">
          <button ref={summaryAnchor} type="button" hidden>
            摘要定位
          </button>
          <SessionSummaryPanel
            sessionId="ui-summary"
            visible={summaryOpen}
            anchorRef={summaryAnchor}
            tasks={[]}
            resources={null}
            onClose={() => setSummaryOpen(false)}
            onOpenSubagents={() => {}}
            onOpenResource={() => {}}
            onOpenResourceList={() => {}}
            pluginEntries={
              <AppPluginSlot
                slot="session.summary"
                context={{
                  session: { ...source, id: 'ui-summary' },
                  onClose: () => setSummaryOpen(false),
                }}
              />
            }
          />
        </div>
        <div className="mt-4 flex gap-8">
          <section className="w-72" data-ui-token="baseline">
            <FeatureTextarea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              featureLabel={
                baselineMode
                  ? `${t('teamTitle')} · ${t(baselineMode === 'group' ? 'teamGroup' : 'teamTask')}`
                  : baselineWorkflow
                    ? t('swarmWorkflowTitle')
                    : undefined
              }
              featureIcon={baselineMode ? <UserGroupIcon /> : <ShareIcon className="h-4 w-4" />}
              removeLabel={t(baselineMode ? 'teamFeatureRemove' : 'swarmWorkflowRemoveToken')}
              onRemoveFeature={() => {
                setBaselineMode(undefined);
                setBaselineWorkflow(false);
              }}
            />
          </section>
          <section className="w-72" data-ui-token="plugin">
            <FeatureTextarea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              featureLabel={composer.token?.label}
              featureIcon={composer.token?.icon}
              removeLabel={composer.token?.removeLabel ?? ''}
              onRemoveFeature={composer.clear}
            />
          </section>
        </div>
        <div className="flex flex-1 items-end gap-8 pb-6">
          <section data-ui-menu="baseline">
            <p className="mb-3">原版</p>
            <ComposerFeatureMenu
              items={baseline}
              label="原版功能"
              backLabel={t('teamFeatureBack')}
            />
          </section>
          <section data-ui-menu="plugin">
            <p className="mb-3">插件版</p>
            <ComposerFeatureMenu items={composer.features} label="插件功能" backLabel={t('back')} />
          </section>
        </div>
      </main>
      <CoworkDisplayPanel
        activeTabId={active}
        isOpen={open}
        onClose={() => setOpen(false)}
        tabs={workspace.views.map(view => ({
          id: view.tabId,
          label: t(view.labelKey),
          icon: view.icon,
          onSelect: () => setActive(view.tabId),
          onClose: () => workspace.close(view.tabId),
        }))}
      >
        {workspace.views.map(view => (
          <div key={view.tabId} className="absolute inset-0" hidden={view.tabId !== active}>
            <AppPluginSlot
              slot="workspace.tab"
              pluginId={view.pluginId}
              contributionId={view.id}
              context={{
                session: source,
                selection: view.selection,
                active: view.tabId === active,
              }}
            />
          </div>
        ))}
      </CoworkDisplayPanel>
      {settingsOpen && (
        <AppPluginSlot
          slot="plugin.settings"
          pluginId="agent-team"
          context={{ onClose: () => setSettingsOpen(false) }}
        />
      )}
    </div>
  );
}

function menuState(kind: string) {
  const menu = document.querySelector(`[data-ui-menu="${kind}"] [role="menu"]`)!;
  return {
    labels: [...menu.querySelectorAll('button[role^="menuitem"]')].map(button =>
      button.getAttribute('aria-label'),
    ),
    descriptions: [...menu.querySelectorAll('[id$="-description"]')].map(node => node.textContent),
    sections: [...menu.querySelectorAll('[role="presentation"]')].map(node => node.textContent),
    back: menu.querySelector('button:not([role])')?.getAttribute('aria-label') ?? null,
    icons: [...menu.querySelectorAll('button[role^="menuitem"]')].map(button =>
      [...button.querySelectorAll('svg path')].map(path => path.getAttribute('d')),
    ),
    shadow: getComputedStyle(menu).boxShadow,
  };
}
const state = window as any;
state.uiParity = {
  results,
  errors,
  mount() {
    flushSync(() => createRoot(document.getElementById('root')!).render(<Surface />));
  },
  async admit(snapshots: unknown[]) {
    await appBrowserRegistry.update(snapshots as never);
  },
  async disable() {
    await appBrowserRegistry.update([]);
  },
  menuState,
};
