import type { AppBrowserHost, AppViewContext } from '@app-plugin/sdk/browser';
import { runtime } from '@app-plugin/sdk/browser-runtime';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface PluginInfo {
  id: string;
  version: string;
}

function isPluginInfo(value: unknown): value is PluginInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.version === 'string';
}

export function register(host: AppBrowserHost): void {
  host.registerTranslations({
    zh: {
      helloPanelTitle: '插件示例',
      helloPanelId: '插件标识',
      helloPanelVersion: '版本',
      helloPanelLoading: '正在读取插件信息…',
      helloPanelUnavailable: '无法读取插件信息，请关闭后重试。',
      helloPanelClose: '关闭',
    },
    en: {
      helloPanelTitle: 'Plugin example',
      helloPanelId: 'Plugin ID',
      helloPanelVersion: 'Version',
      helloPanelLoading: 'Loading plugin information…',
      helloPanelUnavailable: 'Unable to load plugin information. Close and retry.',
      helloPanelClose: 'Close',
    },
  });
  const { Modal, useOwnerDocument } = runtime.services.ui;

  function InfoPanel({ onClose }: AppViewContext) {
    const ownerDocument = useOwnerDocument();
    const [info, setInfo] = useState<PluginInfo | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      const resources = host.resources.child();
      resources.run(
        () => host.invoke('info.read').catch(() => null),
        value => {
          if (isPluginInfo(value)) setInfo(value);
          else setFailed(true);
        },
      );
      return resources.dispose;
    }, []);

    return createPortal(
      <Modal
        onClose={() => onClose?.()}
        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5 text-foreground"
      >
        <h2 className="text-base font-semibold">{host.t('helloPanelTitle')}</h2>
        {failed ? (
          <p role="alert" className="mt-3 text-sm">
            {host.t('helloPanelUnavailable')}
          </p>
        ) : info ? (
          <dl className="mt-3 space-y-2 text-sm">
            <dt>{host.t('helloPanelId')}</dt>
            <dd>{info.id}</dd>
            <dt>{host.t('helloPanelVersion')}</dt>
            <dd>{info.version}</dd>
          </dl>
        ) : (
          <p role="status" className="mt-3 text-sm">
            {host.t('helloPanelLoading')}
          </p>
        )}
        <button
          type="button"
          className="mt-4 rounded-lg px-3 py-2 hover:bg-surface-raised"
          onClick={() => onClose?.()}
        >
          {host.t('helloPanelClose')}
        </button>
      </Modal>,
      ownerDocument.body,
    );
  }

  host.registerView({
    id: 'info',
    slot: 'plugin.settings',
    labelKey: 'helloPanelTitle',
    component: InfoPanel,
  });
}
