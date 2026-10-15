import { ChevronRightIcon } from '@heroicons/react/24/outline';
import type { ExtensionMcpSettingsSnapshot } from '@shared/plugins/mcp';
import { useEffect, useState } from 'react';

import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import {
  PLUGIN_DETAIL_BODY_CLASS_NAME,
  PLUGIN_DETAIL_FOOTER_CLASS_NAME,
  PLUGIN_DETAIL_MODAL_CLASS_NAME,
  PluginDetailHeader,
} from '@/features/plugins/shared/PluginDetail';
import { i18nService } from '@/services/i18n';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import Modal from '@/shared/components/ui/Modal';

import type { ExtensionProvidedMcpServer, McpProbeResult } from './mcp';
import { MCP_FORM_INPUT_CLASS_NAME, MCP_FORM_LABEL_CLASS_NAME } from './mcpFormStyles';
import McpProbeButton from './McpProbeButton';
import { mcpService } from './mcpService';

const ParameterField = ({
  id,
  label,
  value,
  multiline = false,
}: {
  id: string;
  label: string;
  value: string;
  multiline?: boolean;
}) => (
  <div className="space-y-1.5">
    <label htmlFor={id} className={MCP_FORM_LABEL_CLASS_NAME}>
      {label}
    </label>
    {multiline ? (
      <textarea
        id={id}
        value={value}
        readOnly
        rows={3}
        spellCheck={false}
        className={`${MCP_FORM_INPUT_CLASS_NAME} resize-none font-mono`}
      />
    ) : (
      <input id={id} type="text" value={value} readOnly className={MCP_FORM_INPUT_CLASS_NAME} />
    )}
  </div>
);

const ExtensionMcpParametersModal = ({
  server: initialServer,
  artworkTone = getPluginArtworkTone('mcp:user'),
  onClose,
  onProbe,
  probing,
  probeResult,
}: {
  server: ExtensionProvidedMcpServer;
  artworkTone?: string;
  onClose: () => void;
  onProbe?: (server: ExtensionProvidedMcpServer) => void;
  probing?: boolean;
  probeResult?: McpProbeResult;
}) => {
  const [snapshot, setSnapshot] = useState<ExtensionMcpSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const server = snapshot?.server ?? initialServer;
  const definition = snapshot?.definition ?? snapshot?.override ?? null;
  const transportType = server.transportType;
  const transportLabel = transportType
    ? i18nService.t(
        { stdio: 'mcpTransportStdio', sse: 'mcpTransportSse', http: 'mcpTransportHttp' }[
          transportType
        ],
      )
    : i18nService.t('mcpDetailEmpty');
  const stringField = (field: string) =>
    typeof definition?.[field] === 'string' ? (definition[field] as string) : '';
  const requestTimeoutMs =
    typeof definition?.requestTimeoutMs === 'number'
      ? definition.requestTimeoutMs
      : server.requestTimeoutMs;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSnapshot(null);
    setError('');
    void mcpService
      .readExtensionSettings(initialServer.id)
      .then(result => {
        if (!active) return;
        if (result.success) setSnapshot(result.value);
        else setError(i18nService.t(`mcpExtensionMutation.${result.code}`));
      })
      .catch(() => {
        if (active) setError(i18nService.t('mcpExtensionMutation.unavailable'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialServer.id]);

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      className={PLUGIN_DETAIL_MODAL_CLASS_NAME}
    >
      <PluginDetailHeader
        title={i18nService.t('mcpViewParameters')}
        icon={<ConnectorIcon className="h-5 w-5" />}
        artworkTone={artworkTone}
      />
      <div className={PLUGIN_DETAIL_BODY_CLASS_NAME}>
        <ParameterField
          id="extension-mcp-name"
          label={i18nService.t('mcpServerName')}
          value={server.name}
        />
        <ParameterField
          id="extension-mcp-transport"
          label={i18nService.t('mcpTransportType')}
          value={transportLabel}
        />
        {definition &&
        (typeof definition.command === 'string' || typeof definition.url === 'string') ? (
          <>
            {transportType === 'stdio' ? (
              <>
                <ParameterField
                  id="extension-mcp-command"
                  label={i18nService.t('mcpCommand')}
                  value={stringField('command')}
                />
                <ParameterField
                  id="extension-mcp-args"
                  label={i18nService.t('mcpArgs')}
                  value={Array.isArray(definition.args) ? definition.args.join('\n') : ''}
                  multiline
                />
                <ParameterField
                  id="extension-mcp-cwd"
                  label={i18nService.t('mcpWorkingDirectory')}
                  value={stringField('cwd') || stringField('workingDirectory')}
                />
              </>
            ) : (
              <ParameterField
                id="extension-mcp-url"
                label={i18nService.t('mcpUrl')}
                value={stringField('url')}
              />
            )}
          </>
        ) : (
          <ParameterField
            id="extension-mcp-connection"
            label={i18nService.t(
              transportType === 'stdio'
                ? 'mcpLaunchCommand'
                : transportType
                  ? 'mcpUrl'
                  : 'mcpConnectionParameters',
            )}
            value={server.connectionSummary || i18nService.t('mcpDetailEmpty')}
            multiline
          />
        )}
        {requestTimeoutMs !== undefined && (
          <div className="space-y-1.5">
            <label htmlFor="extension-mcp-request-timeout" className={MCP_FORM_LABEL_CLASS_NAME}>
              {i18nService.t('mcpRequestTimeout')}
            </label>
            <div className="flex items-center overflow-hidden rounded-xl border border-border bg-background focus-within:ring-2 focus-within:ring-primary">
              <input
                id="extension-mcp-request-timeout"
                type="text"
                value={requestTimeoutMs / 1000}
                readOnly
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none"
              />
              <span className="border-l border-border px-3 text-xs text-secondary">
                {i18nService.t('agentRuntimeSeconds')}
              </span>
            </div>
          </div>
        )}
        {loading ? (
          <p role="status" className="text-xs text-secondary">
            {i18nService.t('loading')}
          </p>
        ) : definition ? (
          <details className="group rounded-xl border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold text-secondary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
              />
              {i18nService.t('mcpRawParameters')}
            </summary>
            <div className="space-y-2 border-t border-border p-3">
              <label className={MCP_FORM_LABEL_CLASS_NAME} htmlFor="extension-mcp-original">
                {i18nService.t('mcpRawParametersJson')}
              </label>
              <textarea
                id="extension-mcp-original"
                value={JSON.stringify(definition, null, 2)}
                readOnly
                rows={8}
                spellCheck={false}
                className={`${MCP_FORM_INPUT_CLASS_NAME} resize-y font-mono text-xs leading-relaxed`}
              />
            </div>
          </details>
        ) : null}
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <div className={PLUGIN_DETAIL_FOOTER_CLASS_NAME + ' justify-end'}>
        {onProbe && (
          <McpProbeButton
            onProbe={() => onProbe(server)}
            disabled={loading || !snapshot || !server.supported}
            probing={probing}
            result={probeResult}
            label={i18nService.t('mcpTestSavedConfiguration')}
            showText
          />
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised"
        >
          {i18nService.t('close')}
        </button>
      </div>
    </Modal>
  );
};

export default ExtensionMcpParametersModal;
