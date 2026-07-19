import { PluginKind } from '@shared/plugins/marketplace';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import MarketplaceView from '@/features/plugins/components/marketplace/MarketplaceView';
import McpServerFormModal from '@/features/plugins/components/mcp/McpServerFormModal';
import { mcpRegistry } from '@/features/plugins/data/mcpRegistry';
import { mcpService } from '@/features/plugins/services/mcpService';
import { setMcpServers } from '@/features/plugins/slices/mcpSlice';
import {
  McpProbePrompt,
  McpProbeResource,
  McpProbeResult,
  McpProbeTool,
  McpReadResourceResult,
  McpRegistryEntry,
  McpServerConfig,
  McpServerFormData,
} from '@/features/plugins/types/mcp';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import ClockIcon from '@/shared/components/icons/ClockIcon';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import PencilIcon from '@/shared/components/icons/PencilIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Tooltip from '@/shared/components/ui/Tooltip';
import { RootState } from '@/store';

const TRANSPORT_BADGE_COLORS: Record<string, string> = {
  stdio: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  sse: 'bg-green-500/10 text-green-600 dark:text-green-400',
  http: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

type McpTab = 'installed' | 'marketplace';

const formatSchema = (schema?: unknown): string => {
  if (!schema) return '';
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
};

const formatResourceContent = (content: McpReadResourceResult): string => {
  const displayContents = content.contents.map(item => {
    if (typeof item.text === 'string') {
      const trimmedText = item.text.trim();
      if (item.mimeType?.includes('json')) {
        try {
          return JSON.parse(trimmedText);
        } catch {
          return item.text;
        }
      }
      return item.text;
    }
    if (typeof item.blob === 'string') {
      return {
        mimeType: item.mimeType,
        blob: item.blob,
      };
    }
    return item;
  });

  return JSON.stringify(displayContents, null, 2);
};

const hasProperty = (value: unknown, property: string): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && property in value);
};

const normalizeProbeResult = (result: McpProbeResult): McpProbeResult => {
  const tools: McpProbeTool[] = [];
  const prompts: McpProbePrompt[] = [];
  const resources: McpProbeResource[] = [];

  const addTool = (item: McpProbeTool) => {
    if (!tools.some(tool => tool.name === item.name)) {
      tools.push(item);
    }
  };

  const addPrompt = (item: McpProbePrompt) => {
    if (!prompts.some(prompt => prompt.name === item.name)) {
      prompts.push(item);
    }
  };

  const addResource = (item: McpProbeResource) => {
    if (!resources.some(resource => resource.uri === item.uri)) {
      resources.push(item);
    }
  };

  result.tools.forEach(item => {
    if (hasProperty(item, 'arguments') && !hasProperty(item, 'inputSchema')) {
      addPrompt(item as McpProbePrompt);
      return;
    }
    addTool(item);
  });

  result.prompts.forEach(item => {
    if (hasProperty(item, 'inputSchema') || hasProperty(item, 'outputSchema')) {
      addTool(item as McpProbeTool);
      return;
    }
    addPrompt(item);
  });

  result.resources.forEach(addResource);

  return {
    ...result,
    tools,
    prompts,
    resources,
  };
};

const McpManager: React.FC = () => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);

  const [activeTab, setActiveTab] = useState<McpTab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [installingRegistry, setInstallingRegistry] = useState<McpRegistryEntry | null>(null);
  const [probingServerIds, setProbingServerIds] = useState<Set<string>>(() => new Set());
  const [probeResults, setProbeResults] = useState<Record<string, McpProbeResult>>({});
  const [isBulkProbeOpen, setIsBulkProbeOpen] = useState(false);
  const [isBulkProbing, setIsBulkProbing] = useState(false);
  const [bulkProbeServerId, setBulkProbeServerId] = useState<string | null>(null);
  const [bulkProbeResults, setBulkProbeResults] = useState<Record<string, McpProbeResult>>({});
  const [detailServer, setDetailServer] = useState<McpServerConfig | null>(null);
  const [expandedToolNames, setExpandedToolNames] = useState<Set<string>>(() => new Set());
  const [expandedPromptNames, setExpandedPromptNames] = useState<Set<string>>(() => new Set());
  const [expandedResourceUris, setExpandedResourceUris] = useState<Set<string>>(() => new Set());
  const [readingResourceUris, setReadingResourceUris] = useState<Set<string>>(() => new Set());
  const [resourceContents, setResourceContents] = useState<Record<string, McpReadResourceResult>>(
    {},
  );
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  // Using local registry only (no remote marketplace)
  const dynamicRegistry = mcpRegistry;
  const [bridgeSyncing, setBridgeSyncing] = useState(false);
  const [bridgeSyncResult, setBridgeSyncResult] = useState<{
    tools: number;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let isActive = true;
    const loadServers = async () => {
      const loaded = await mcpService.loadServers();
      if (!isActive) return;
      dispatch(setMcpServers(loaded));
    };
    loadServers();
    return () => {
      isActive = false;
    };
  }, [dispatch]);

  const getRegistryEntryForServer = (server: McpServerConfig): McpRegistryEntry | undefined => {
    if (server.registryId) {
      return dynamicRegistry.find(entry => entry.id === server.registryId);
    }
    if (!server.isBuiltIn) return undefined;
    return dynamicRegistry.find(
      entry =>
        entry.name.toLowerCase() === server.name.toLowerCase() &&
        entry.transportType === server.transportType &&
        entry.command === server.command,
    );
  };

  const getConnectionDetail = (server: McpServerConfig): string => {
    if (server.transportType === 'stdio') {
      return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
    }
    return server.url || i18nService.t('mcpDetailEmpty');
  };

  const getConnectionDetailLabel = (server: McpServerConfig): string => {
    return server.transportType === 'stdio'
      ? i18nService.t('mcpDetailConnectionDetail')
      : i18nService.t('mcpDetailEndpoint');
  };

  const getInstalledDescription = useCallback((server: McpServerConfig): string => {
    return server.description?.trim() ?? '';
  }, []);

  const getServerStatusLabel = (server: McpServerConfig): string | null => {
    const probeResult = probeResults[server.id];
    if (probeResult) {
      return probeResult.available
        ? i18nService.t('mcpProbeStatusAvailable')
        : i18nService.t('mcpProbeUnavailable');
    }
    return null;
  };

  const getServerStatusClass = (server: McpServerConfig): string | null => {
    const probeResult = probeResults[server.id];
    if (probeResult) {
      return probeResult.available
        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
        : 'bg-red-500/10 text-red-600 dark:text-red-400';
    }
    return null;
  };

  const filteredInstalled = useMemo(() => {
    const query = searchQuery.toLowerCase();
    if (!query) return servers;
    return servers.filter(
      server =>
        server.name.toLowerCase().includes(query) ||
        getInstalledDescription(server).toLowerCase().includes(query),
    );
  }, [servers, searchQuery, getInstalledDescription]);

  const handleToggleEnabled = async (serverId: string) => {
    const targetServer = servers.find(s => s.id === serverId);
    if (!targetServer) return;
    try {
      const updatedServers = await mcpService.setServerEnabled(serverId, !targetServer.enabled);
      dispatch(setMcpServers(updatedServers));
      setActionError('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'));
    }
  };

  const handleRequestDelete = (server: McpServerConfig) => {
    setActionError('');
    setPendingDelete(server);
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    setActionError('');
    const result = await mcpService.deleteServer(pendingDelete.id);
    if (!result.success) {
      setActionError(result.error || i18nService.t('mcpDeleteFailed'));
      setIsDeleting(false);
      return;
    }
    if (result.servers) {
      dispatch(setMcpServers(result.servers));
    }
    setIsDeleting(false);
    setPendingDelete(null);
  };

  const handleOpenEditForm = (server: McpServerConfig) => {
    setEditingServer(server);
    setInstallingRegistry(getRegistryEntryForServer(server) ?? null);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingServer(null);
    setInstallingRegistry(null);
  };

  const handleSaveForm = async (data: McpServerFormData) => {
    setActionError('');
    if (editingServer && editingServer.id) {
      const result = await mcpService.updateServer(editingServer.id, data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpUpdateFailed'));
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
    } else {
      const result = await mcpService.createServer(data);
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpCreateFailed'));
        return;
      }
      if (result.servers) {
        dispatch(setMcpServers(result.servers));
      }
    }
    handleCloseForm();
  };

  const handleOpenCreateForm = () => {
    setEditingServer(null);
    setInstallingRegistry(null);
    setIsFormOpen(true);
  };

  const setServerProbing = (serverId: string, probing: boolean) => {
    setProbingServerIds(current => {
      const next = new Set(current);
      if (probing) {
        next.add(serverId);
      } else {
        next.delete(serverId);
      }
      return next;
    });
  };

  const handleProbeServer = async (server: McpServerConfig, openDetail = false) => {
    setActionError('');
    setServerProbing(server.id, true);
    const result = await mcpService.probeServer(server.id);
    setServerProbing(server.id, false);

    if (!result.success || !result.result) {
      setActionError(result.error || i18nService.t('mcpProbeFailed'));
      return;
    }

    const normalizedResult = normalizeProbeResult(result.result);

    setProbeResults(current => ({
      ...current,
      [server.id]: normalizedResult,
    }));

    if (openDetail) {
      setDetailServer(server);
      setExpandedToolNames(new Set());
      setExpandedPromptNames(new Set());
      setExpandedResourceUris(new Set());
      setReadingResourceUris(new Set());
      setResourceContents({});
      setResourceErrors({});
    }
  };

  const handleOpenBulkProbe = async () => {
    if (servers.length === 0 || isBulkProbing) return;
    setActionError('');
    setIsBulkProbeOpen(true);
    setIsBulkProbing(true);
    setBulkProbeResults({});

    const pendingIds = servers.map(server => server.id);
    setProbingServerIds(current => new Set([...current, ...pendingIds]));

    for (const server of servers) {
      setBulkProbeServerId(server.id);
      let normalizedResult: McpProbeResult;
      try {
        const result = await mcpService.probeServer(server.id);
        normalizedResult =
          result.success && result.result
            ? normalizeProbeResult(result.result)
            : {
                available: false,
                tools: [],
                prompts: [],
                resources: [],
                latencyMs: 0,
                error: result.error || i18nService.t('mcpProbeFailed'),
              };
      } catch (error) {
        normalizedResult = {
          available: false,
          tools: [],
          prompts: [],
          resources: [],
          latencyMs: 0,
          error: error instanceof Error ? error.message : i18nService.t('mcpProbeFailed'),
        };
      }

      setBulkProbeResults(current => ({
        ...current,
        [server.id]: normalizedResult,
      }));
      setServerProbing(server.id, false);
    }

    setBulkProbeServerId(null);
    setIsBulkProbing(false);
  };

  const handleCloseBulkProbe = () => {
    if (isBulkProbing) return;
    setProbeResults(current => ({
      ...current,
      ...bulkProbeResults,
    }));
    setIsBulkProbeOpen(false);
  };

  const toggleExpandedTool = (toolName: string) => {
    setExpandedToolNames(current => {
      const next = new Set(current);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  const toggleExpandedPrompt = (promptName: string) => {
    setExpandedPromptNames(current => {
      const next = new Set(current);
      if (next.has(promptName)) {
        next.delete(promptName);
      } else {
        next.add(promptName);
      }
      return next;
    });
  };

  const handleReadResource = async (resourceUri: string) => {
    if (!detailServer || readingResourceUris.has(resourceUri)) return;
    setExpandedResourceUris(current => new Set(current).add(resourceUri));
    setReadingResourceUris(current => new Set(current).add(resourceUri));
    setResourceErrors(current => {
      const next = { ...current };
      delete next[resourceUri];
      return next;
    });

    const result = await mcpService.readResource(detailServer.id, resourceUri);

    setReadingResourceUris(current => {
      const next = new Set(current);
      next.delete(resourceUri);
      return next;
    });

    const readResult = result.result;
    if (!result.success || !readResult) {
      setResourceErrors(current => ({
        ...current,
        [resourceUri]: result.error || 'Failed to read MCP resource',
      }));
      return;
    }

    setResourceContents(current => ({
      ...current,
      [resourceUri]: readResult,
    }));
  };

  const handleToggleResource = (resourceUri: string, isExpanded: boolean) => {
    if (isExpanded) {
      setExpandedResourceUris(current => {
        const next = new Set(current);
        next.delete(resourceUri);
        return next;
      });
      return;
    }
    void handleReadResource(resourceUri);
  };

  const getDetailResult = (): McpProbeResult | null => {
    if (!detailServer) return null;
    return probeResults[detailServer.id] ?? null;
  };

  const existingNames = useMemo(() => servers.map(s => s.name), [servers]);

  /**
   * Listen for MCP bridge sync events from the main process.
   * Main process broadcasts syncStart/syncDone after server config changes.
   */
  useEffect(() => {
    let syncTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanupStart = mcpService.onConfigSyncStart(() => {
      setBridgeSyncing(true);
      setBridgeSyncResult(null);
      // Fallback: auto-clear overlay after 40s to prevent permanent lock
      if (syncTimeout) clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => {
        setBridgeSyncing(false);
        setBridgeSyncResult({
          tools: 0,
          error: i18nService.t('mcpBridgeSyncError') || 'Sync timed out',
        });
      }, 40_000);
    });
    const cleanupDone = mcpService.onConfigSyncDone(data => {
      if (syncTimeout) {
        clearTimeout(syncTimeout);
        syncTimeout = null;
      }
      setBridgeSyncing(false);
      setBridgeSyncResult({ tools: data.tools, error: data.error });
      if (!data.error) {
        setTimeout(() => setBridgeSyncResult(null), 5000);
      }
    });
    return () => {
      cleanupStart();
      cleanupDone();
      if (syncTimeout) clearTimeout(syncTimeout);
    };
  }, []);

  const tabClass = (tab: McpTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative ${
      activeTab === tab ? 'text-foreground' : 'text-secondary hover:hover:text-foreground'
    }`;

  const tabIndicatorClass = (tab: McpTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-primary' : 'bg-transparent'
    }`;

  return (
    <div className="relative space-y-4">
      {/* Sync overlay — blocks ALL interaction (including sidebar) while MCP bridge is refreshing */}
      {bridgeSyncing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-4 px-10 py-8 rounded-2xl bg-surface border border-border shadow-card">
            <svg
              className="animate-spin h-8 w-8 text-primary"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm text-foreground font-medium">
              {i18nService.t('mcpBridgeSyncing') || 'Syncing MCP tools...'}
            </span>
          </div>
        </div>
      )}

      {actionError && <ErrorMessage message={actionError} onClose={() => setActionError('')} />}

      {/* MCP Bridge sync result */}
      {!bridgeSyncing && bridgeSyncResult && (
        <div
          className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs border ${
            bridgeSyncResult.error
              ? 'dark:bg-red-500/10 bg-red-50 dark:text-red-400 text-red-600 dark:border-red-500/20 border-red-200'
              : 'dark:bg-green-500/10 bg-green-50 dark:text-green-400 text-green-600 dark:border-green-500/20 border-green-200'
          }`}
        >
          <span>
            {bridgeSyncResult.error
              ? `${i18nService.t('mcpBridgeSyncError') || 'Sync failed'}: ${bridgeSyncResult.error}`
              : `${i18nService.t('mcpBridgeSyncDone') || 'MCP configuration synced'}: ${bridgeSyncResult.tools}`}
          </span>
          <button
            type="button"
            onClick={() => setBridgeSyncResult(null)}
            className="ml-2 opacity-60 hover:opacity-100"
          >
            &times;
          </button>
        </div>
      )}

      {/* Sticky toolbar: Tabs + description */}
      <div className="sticky top-0 z-10 bg-background pb-4 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              className={tabClass('installed')}
            >
              {i18nService.t('mcpInstalled')}
              {servers.length > 0 && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised">
                  {servers.length}
                </span>
              )}
              <div className={tabIndicatorClass('installed')} />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              className={tabClass('marketplace')}
            >
              {i18nService.t('mcpMarketplace')}
              <div className={tabIndicatorClass('marketplace')} />
            </button>
          </div>
          <p className="min-w-0 truncate pb-2 text-right text-sm text-secondary">
            {i18nService.t('mcpDescription')}
          </p>
        </div>
      </div>

      <div>
        {/* ── Tab: Installed ──────────────────────────────── */}
        {activeTab === 'installed' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <div className="relative min-w-0 flex-1 sm:max-w-md">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
                <input
                  type="text"
                  placeholder={i18nService.t('searchMcpServers')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <button
                type="button"
                onClick={handleOpenCreateForm}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised hover:text-foreground sm:ml-auto sm:w-auto"
              >
                + {i18nService.t('addMcpServer')}
              </button>
              <button
                type="button"
                onClick={handleOpenBulkProbe}
                disabled={servers.length === 0 || isBulkProbing}
                className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
              >
                <ClockIcon className="h-4 w-4" />
                <span>{i18nService.t('mcpTestAll')}</span>
              </button>
            </div>
            {filteredInstalled.length === 0 ? (
              <div className="py-12 text-center text-sm text-secondary">
                {i18nService.t('mcpNoInstalledServers')}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] items-start gap-3">
                {filteredInstalled.map(server => {
                  const registryEntry = getRegistryEntryForServer(server);
                  const installedDescription = getInstalledDescription(server);
                  const statusLabel = getServerStatusLabel(server);
                  const statusClass = getServerStatusClass(server);
                  return (
                    <div
                      key={server.id}
                      className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                            <ConnectorIcon className="h-4 w-4 text-secondary" />
                          </div>
                          <span className="text-sm font-medium text-foreground truncate">
                            {server.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => handleOpenEditForm(server)}
                            className="p-1 rounded-lg text-secondary hover:text-primary dark:hover:text-primary transition-colors"
                            title={i18nService.t('editMcpServer')}
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRequestDelete(server)}
                            className="p-1 rounded-lg text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                            title={i18nService.t('deleteMcpServer')}
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                          <div
                            className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                              server.enabled ? 'bg-primary' : 'bg-border'
                            }`}
                            onClick={() => handleToggleEnabled(server.id)}
                          >
                            <div
                              className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                                server.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                              }`}
                            />
                          </div>
                        </div>
                      </div>

                      <Tooltip
                        content={installedDescription}
                        position="bottom"
                        maxWidth="360px"
                        className="block w-full"
                      >
                        <p className="line-clamp-2 text-xs text-secondary">
                          {installedDescription}
                        </p>
                      </Tooltip>

                      <div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-secondary">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}
                          >
                            {server.transportType}
                          </span>
                          {registryEntry?.requiredEnvKeys &&
                            registryEntry.requiredEnvKeys.length > 0 && (
                              <>
                                <span>·</span>
                                <span className="text-amber-500 dark:text-amber-400">
                                  {registryEntry.requiredEnvKeys.length} key
                                  {registryEntry.requiredEnvKeys.length > 1 ? 's' : ''}
                                </span>
                              </>
                            )}
                          {statusLabel && statusClass && (
                            <span
                              title={probeResults[server.id]?.error}
                              className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${statusClass}`}
                            >
                              {statusLabel}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleProbeServer(server, true)}
                          disabled={probingServerIds.has(server.id)}
                          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                          title={i18nService.t('mcpTestServer')}
                        >
                          <ClockIcon className="h-3.5 w-3.5" />
                          <span>{i18nService.t('mcpTestShort')}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Marketplace ────────────────────────────── */}
        {activeTab === 'marketplace' && (
          <MarketplaceView
            kind={PluginKind.MCP}
            icon={<ConnectorIcon className="h-4 w-4" />}
            installed={servers.map(server => ({
              id: server.registryId || server.id,
            }))}
            onInstalled={async () => {
              dispatch(setMcpServers(await mcpService.loadServers()));
            }}
          />
        )}
      </div>

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <Modal
          onClose={handleCancelDelete}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="w-full max-w-sm mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-5"
        >
          <div className="text-lg font-semibold text-foreground">
            {i18nService.t('deleteMcpServer')}
          </div>
          <p className="mt-2 text-sm text-secondary">
            {i18nService.t('mcpDeleteConfirm').replace('{name}', pendingDelete.name)}
          </p>
          {actionError && <div className="mt-3 text-xs text-red-500">{actionError}</div>}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancelDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {i18nService.t('confirmDelete')}
            </button>
          </div>
        </Modal>
      )}

      {/* Edit / Registry-install form modal */}
      <McpServerFormModal
        isOpen={isFormOpen}
        server={editingServer}
        registryEntry={installingRegistry}
        existingNames={existingNames}
        onClose={handleCloseForm}
        onSave={handleSaveForm}
      />

      {isBulkProbeOpen && (
        <Modal
          onClose={handleCloseBulkProbe}
          closeOnBackdrop={false}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="w-full max-w-2xl max-h-[76vh] mx-4 rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden flex flex-col"
        >
          <div className="px-5 py-4 border-b border-border bg-surface-raised/60 flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold leading-6 text-foreground">
                {i18nService.t('mcpTestAllTitle')}
              </div>
              <div className="mt-1 text-xs text-secondary">
                {i18nService
                  .t('mcpTestAllProgress')
                  .replace('{done}', String(Object.keys(bulkProbeResults).length))
                  .replace('{total}', String(servers.length))}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCloseBulkProbe}
              disabled={isBulkProbing}
              className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface transition-colors disabled:cursor-wait disabled:opacity-60"
            >
              {i18nService.t('close')}
            </button>
          </div>

          <div className="overflow-y-auto p-4 space-y-2">
            {servers.map(server => {
              const result = bulkProbeResults[server.id];
              const isRunning = bulkProbeServerId === server.id;
              const statusText = isRunning
                ? i18nService.t('mcpTestAllTesting')
                : result
                  ? result.available
                    ? i18nService.t('mcpProbeStatusAvailable')
                    : i18nService.t('mcpProbeUnavailable')
                  : i18nService.t('mcpTestAllPending');
              const statusClass = isRunning
                ? 'bg-primary/10 text-primary'
                : result
                  ? result.available
                    ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'bg-red-500/10 text-red-600 dark:text-red-400'
                  : 'bg-surface-raised text-secondary';

              return (
                <div
                  key={server.id}
                  className="rounded-xl border border-border bg-surface px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {server.name}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TRANSPORT_BADGE_COLORS[server.transportType] || ''}`}
                        >
                          {server.transportType}
                        </span>
                      </div>
                      {result && (
                        <div className="mt-1 text-[11px] text-secondary">
                          {result.available
                            ? i18nService
                                .t('mcpProbeAvailable')
                                .replace('{latency}', String(result.latencyMs))
                                .replace('{tools}', String(result.tools.length))
                            : result.error || i18nService.t('mcpDetailErrorEmpty')}
                        </div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${statusClass}`}
                    >
                      {statusText}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {detailServer && getDetailResult() && (
        <Modal
          onClose={() => setDetailServer(null)}
          closeOnBackdrop={false}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="w-full max-w-4xl max-h-[84vh] mx-4 rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden flex flex-col"
        >
          {(() => {
            const detail = getDetailResult()!;
            return (
              <>
                <div className="px-5 py-4 border-b border-border bg-surface-raised/60 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-lg font-semibold leading-6 text-foreground">
                        {detailServer.name}
                      </div>
                      <div
                        title={detail.available ? undefined : detail.error}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          detail.available
                            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                            : 'bg-red-500/10 text-red-600 dark:text-red-400'
                        }`}
                      >
                        {detail.available
                          ? i18nService.t('mcpProbeStatusAvailable')
                          : i18nService.t('mcpProbeUnavailable')}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailServer(null)}
                    className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface transition-colors"
                  >
                    {i18nService.t('close')}
                  </button>
                </div>

                <div className="overflow-y-auto p-5 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-secondary shrink-0">
                        {i18nService.t('mcpDetailTransport')}
                      </div>
                      <div className="min-w-0">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            TRANSPORT_BADGE_COLORS[detailServer.transportType]
                          }`}
                        >
                          {detailServer.transportType.toUpperCase()}
                        </span>
                      </div>
                    </div>
                    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-secondary shrink-0">
                        {i18nService.t('mcpDetailServerName')}
                      </div>
                      <div className="min-w-0 text-sm font-medium text-foreground truncate">
                        {detail.serverName || detailServer.name}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-secondary shrink-0">
                        {i18nService.t('mcpDetailLatency')}
                      </div>
                      <div className="text-sm font-medium text-foreground truncate">
                        {detail.latencyMs}ms
                      </div>
                    </div>
                    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-secondary shrink-0">
                        {i18nService.t('mcpDetailVersion')}
                      </div>
                      <div className="min-w-0 text-sm font-medium text-foreground truncate">
                        {detail.serverVersion || i18nService.t('mcpDetailEmpty')}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-start gap-3">
                    <div className="text-[11px] text-secondary shrink-0 pt-0.5">
                      {getConnectionDetailLabel(detailServer)}
                    </div>
                    <div className="min-w-0 flex-1 text-xs font-mono text-foreground break-all">
                      {getConnectionDetail(detailServer)}
                    </div>
                  </div>

                  {!detail.available && (
                    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                      <div className="text-[11px] font-medium text-red-600 dark:text-red-400">
                        {i18nService.t('mcpDetailErrorReason')}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-red-700 dark:text-red-300">
                        {detail.error || i18nService.t('mcpDetailErrorEmpty')}
                      </div>
                    </div>
                  )}

                  {detail.instructions && (
                    <div className="rounded-xl border border-border bg-surface p-3">
                      <div>
                        <div className="text-[11px] font-medium text-foreground">
                          {i18nService.t('mcpDetailInstructions')}
                        </div>
                        <div className="mt-1 text-xs text-secondary whitespace-pre-wrap">
                          {detail.instructions}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-border bg-surface p-3">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-sm font-medium text-foreground">Tools</div>
                      <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-secondary">
                        {detail.tools.length}
                      </span>
                    </div>
                    {detail.tools.length === 0 ? (
                      <div className="text-xs text-secondary">
                        {i18nService.t('mcpDetailEmpty')}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {detail.tools.map(tool => {
                          const inputSchema = formatSchema(tool.inputSchema);
                          const outputSchema = formatSchema(tool.outputSchema);
                          const isExpanded = expandedToolNames.has(tool.name);
                          return (
                            <div
                              key={tool.name}
                              className="rounded-lg bg-surface-raised overflow-hidden"
                            >
                              <button
                                type="button"
                                onClick={() => toggleExpandedTool(tool.name)}
                                className="w-full px-3 py-2.5 text-left hover:bg-surface transition-colors"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                      <span className="text-xs font-semibold text-foreground break-all">
                                        {tool.title || tool.name}
                                      </span>
                                      {tool.title && (
                                        <span className="text-[11px] text-secondary break-all">
                                          {tool.name}
                                        </span>
                                      )}
                                    </div>
                                    {tool.title && tool.title !== tool.name && (
                                      <div className="sr-only">
                                        {i18nService.t('mcpDetailTitle')}: {tool.title}
                                      </div>
                                    )}
                                    <div className="mt-1 text-xs text-secondary whitespace-pre-wrap">
                                      {tool.description || i18nService.t('mcpDetailEmpty')}
                                    </div>
                                  </div>
                                  <span className="shrink-0 text-[11px] text-secondary">
                                    {isExpanded ? '-' : '+'}
                                  </span>
                                </div>
                              </button>
                              {isExpanded && (
                                <div className="border-t border-border p-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
                                  <div className="rounded-lg border border-border bg-surface p-2">
                                    <div className="text-[11px] font-medium text-foreground">
                                      {i18nService.t('mcpDetailInputSchema')}
                                    </div>
                                    {inputSchema ? (
                                      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2 py-2 text-[10px] leading-4 text-secondary">
                                        {inputSchema}
                                      </pre>
                                    ) : (
                                      <div className="mt-2 text-xs text-secondary">
                                        {i18nService.t('mcpDetailEmpty')}
                                      </div>
                                    )}
                                  </div>
                                  <div className="rounded-lg border border-border bg-surface p-2">
                                    <div className="text-[11px] font-medium text-foreground">
                                      {i18nService.t('mcpDetailOutputSchema')}
                                    </div>
                                    {outputSchema ? (
                                      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2 py-2 text-[10px] leading-4 text-secondary">
                                        {outputSchema}
                                      </pre>
                                    ) : (
                                      <div className="mt-2 text-xs text-secondary">
                                        {i18nService.t('mcpDetailEmpty')}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border border-border bg-surface p-3">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-medium text-foreground">Prompts</div>
                        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-secondary">
                          {detail.prompts.length}
                        </span>
                      </div>
                      {detail.prompts.length === 0 ? (
                        <div className="text-xs text-secondary">
                          {i18nService.t('mcpDetailEmpty')}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {detail.prompts.map(prompt => {
                            const isExpanded = expandedPromptNames.has(prompt.name);
                            return (
                              <div
                                key={prompt.name}
                                className="rounded-lg bg-surface-raised overflow-hidden"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleExpandedPrompt(prompt.name)}
                                  className="w-full px-3 py-2.5 text-left hover:bg-surface transition-colors"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                        <span className="text-xs font-semibold text-foreground break-all">
                                          {prompt.title || prompt.name}
                                        </span>
                                        {prompt.title && (
                                          <span className="text-[11px] text-secondary break-all">
                                            {prompt.name}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-1 text-xs text-secondary whitespace-pre-wrap">
                                        {prompt.description || i18nService.t('mcpDetailEmpty')}
                                      </div>
                                    </div>
                                    <span className="shrink-0 text-[11px] text-secondary">
                                      {isExpanded ? '-' : '+'}
                                    </span>
                                  </div>
                                </button>
                                {isExpanded && (
                                  <div className="border-t border-border p-3">
                                    <div className="rounded-lg border border-border bg-surface p-2">
                                      <div className="text-[11px] font-medium text-foreground">
                                        {i18nService.t('mcpDetailArguments')}
                                      </div>
                                      {prompt.arguments && prompt.arguments.length > 0 ? (
                                        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2 py-2 text-[10px] leading-4 text-secondary">
                                          {formatSchema(prompt.arguments)}
                                        </pre>
                                      ) : (
                                        <div className="mt-2 text-xs text-secondary">
                                          {i18nService.t('mcpDetailEmpty')}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-border bg-surface p-3">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-medium text-foreground">Resources</div>
                        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-secondary">
                          {detail.resources.length}
                        </span>
                      </div>
                      {detail.resources.length === 0 ? (
                        <div className="text-xs text-secondary">
                          {i18nService.t('mcpDetailEmpty')}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {detail.resources.map(resource => {
                            const isExpanded = expandedResourceUris.has(resource.uri);
                            const isReading = readingResourceUris.has(resource.uri);
                            const content = resourceContents[resource.uri];
                            const error = resourceErrors[resource.uri];
                            return (
                              <div
                                key={resource.uri}
                                className="rounded-lg bg-surface-raised overflow-hidden"
                              >
                                <div className="px-3 py-2.5">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                        <span className="text-xs font-semibold text-foreground break-all">
                                          {resource.title || resource.name || resource.uri}
                                        </span>
                                        {resource.mimeType && (
                                          <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-secondary">
                                            {resource.mimeType}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-1 text-[11px] font-mono text-secondary break-all">
                                        {resource.uri}
                                      </div>
                                      {resource.description && (
                                        <div className="mt-1 text-xs text-secondary whitespace-pre-wrap">
                                          {resource.description}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleToggleResource(resource.uri, isExpanded)
                                        }
                                        disabled={isReading}
                                        className="rounded-lg border border-border px-2 py-1 text-[11px] text-secondary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        {isReading ? 'Reading...' : isExpanded ? 'Hide' : 'Show'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                                {isExpanded && (
                                  <div className="border-t border-border p-3 space-y-2">
                                    <div className="rounded-lg border border-border bg-surface p-2">
                                      <div className="text-[11px] font-medium text-foreground">
                                        Metadata
                                      </div>
                                      <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2 py-2 text-[10px] leading-4 text-secondary">
                                        {formatSchema(resource)}
                                      </pre>
                                    </div>
                                    <div className="rounded-lg border border-border bg-surface p-2">
                                      <div className="text-[11px] font-medium text-foreground">
                                        Content
                                      </div>
                                      {isReading ? (
                                        <div className="mt-2 text-xs text-secondary">
                                          Reading...
                                        </div>
                                      ) : error ? (
                                        <div className="mt-2 text-xs text-red-500">{error}</div>
                                      ) : content ? (
                                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2 py-2 text-[10px] leading-4 text-secondary">
                                          {formatResourceContent(content)}
                                        </pre>
                                      ) : (
                                        <div className="mt-2 text-xs text-secondary">
                                          Content has not been loaded.
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
};

export default McpManager;
