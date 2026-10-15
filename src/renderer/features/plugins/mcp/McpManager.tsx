import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { PluginHubScope } from '@shared/plugins/management';
import { PluginKind } from '@shared/plugins/marketplace';
import { DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS } from '@shared/plugins/mcp';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  InstalledMarketplaceAction,
  MarketplaceFeedback,
} from '@/features/plugins/marketplace/MarketplaceActions';
import MarketplaceToolbar from '@/features/plugins/marketplace/MarketplaceToolbar';
import { MarketplaceResults } from '@/features/plugins/marketplace/MarketplaceView';
import {
  MarketplaceFilter,
  usePluginMarketplace,
} from '@/features/plugins/marketplace/usePluginMarketplace';
import ExtensionMcpCard from '@/features/plugins/mcp/ExtensionMcpCard';
import ExtensionMcpParametersModal from '@/features/plugins/mcp/ExtensionMcpParametersModal';
import {
  ExtensionProvidedMcpServer,
  McpProbePrompt,
  McpProbeResource,
  McpProbeResult,
  McpProbeTool,
  McpReadResourceResult,
  McpRegistryEntry,
  McpServerConfig,
  McpServerFormData,
} from '@/features/plugins/mcp/mcp';
import { mcpRegistry } from '@/features/plugins/mcp/mcpRegistry';
import McpServerCard from '@/features/plugins/mcp/McpServerCard';
import McpServerFormModal from '@/features/plugins/mcp/McpServerFormModal';
import { mcpService } from '@/features/plugins/mcp/mcpService';
import { setMcpServers } from '@/features/plugins/mcp/mcpSlice';
import { MCP_TRANSPORT_BADGE_COLORS } from '@/features/plugins/mcp/mcpTransport';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginGroupSection from '@/features/plugins/shared/PluginGroupSection';
import type { PluginHubManagerProps } from '@/features/plugins/shared/pluginHubTypes';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import { comparePluginNames } from '@/features/plugins/shared/pluginOrdering';
import PluginStateButton from '@/features/plugins/shared/PluginStateButton';
import { i18nService } from '@/services/i18n';
import ClockIcon from '@/shared/components/icons/ClockIcon';
import ConnectorIcon from '@/shared/components/icons/ConnectorIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import ErrorMessage from '@/shared/components/ui/ErrorMessage';
import Modal from '@/shared/components/ui/Modal';
import Tooltip from '@/shared/components/ui/Tooltip';
import { RootState } from '@/store';

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

interface McpManagerProps extends PluginHubManagerProps {
  onOpenExtension?: (extensionId: string) => void;
}

type McpDetailServer = McpServerConfig | ExtensionProvidedMcpServer;
const isExtensionServer = (server: McpDetailServer): server is ExtensionProvidedMcpServer =>
  'providerId' in server;

const McpManager: React.FC<McpManagerProps> = ({
  searchQuery: sharedSearchQuery,
  visibility = 'all',
  onOpenExtension,
}) => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);

  const [extensionServers, setExtensionServers] = useState<ExtensionProvidedMcpServer[]>(
    () => mcpService.getExtensionServers() ?? [],
  );
  const [isLoadingServers, setIsLoadingServers] = useState(true);
  const [serverLoadFailed, setServerLoadFailed] = useState(false);
  const [providerLoadFailed, setProviderLoadFailed] = useState(false);
  const inventoryGeneration = useRef(0);
  const inventoryReadGeneration = useRef(0);
  const providerReadGeneration = useRef(0);
  const providerReadPending = useRef(false);
  const formGeneration = useRef(0);
  const mounted = useRef(false);
  const detailGeneration = useRef(0);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const searchQuery = sharedSearchQuery ?? localSearchQuery;
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [updatingServerIds, setUpdatingServerIds] = useState<Set<string>>(() => new Set());
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [detailArtworkTone, setDetailArtworkTone] = useState(() =>
    getPluginArtworkTone('mcp:user'),
  );
  const [installingRegistry, setInstallingRegistry] = useState<McpRegistryEntry | null>(null);
  const [defaultRequestTimeoutSeconds, setDefaultRequestTimeoutSeconds] = useState(
    DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS,
  );
  const [probingServerIds, setProbingServerIds] = useState<Set<string>>(() => new Set());
  const [probeResults, setProbeResults] = useState<Record<string, McpProbeResult>>({});
  const [isBulkProbeOpen, setIsBulkProbeOpen] = useState(false);
  const [isBulkProbing, setIsBulkProbing] = useState(false);
  const [bulkProbeServerId, setBulkProbeServerId] = useState<string | null>(null);
  const [bulkProbeResults, setBulkProbeResults] = useState<Record<string, McpProbeResult>>({});
  const [detailServer, setDetailServer] = useState<McpDetailServer | null>(null);
  const [parameterServer, setParameterServer] = useState<ExtensionProvidedMcpServer | null>(null);
  const [expandedToolNames, setExpandedToolNames] = useState<Set<string>>(() => new Set());
  const [expandedPromptNames, setExpandedPromptNames] = useState<Set<string>>(() => new Set());
  const [expandedResourceUris, setExpandedResourceUris] = useState<Set<string>>(() => new Set());
  const [readingResourceUris, setReadingResourceUris] = useState<Set<string>>(() => new Set());
  const [resourceContents, setResourceContents] = useState<Record<string, McpReadResourceResult>>(
    {},
  );
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!detailServer) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDetailServer(null);
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [detailServer]);
  // Using local registry only (no remote marketplace)
  const dynamicRegistry = mcpRegistry;
  const [bridgeSyncing, setBridgeSyncing] = useState(false);
  const [bridgeSyncResult, setBridgeSyncResult] = useState<{
    tools: number;
    error?: string;
  } | null>(null);
  const invalidateConnectionResults = useCallback(() => {
    inventoryGeneration.current += 1;
    detailGeneration.current += 1;
    setDetailServer(null);
    setProbeResults({});
    setProbingServerIds(new Set());
    setReadingResourceUris(new Set());
    setResourceContents({});
    setResourceErrors({});
    setIsBulkProbing(false);
    setIsBulkProbeOpen(false);
    setBulkProbeServerId(null);
    setBulkProbeResults({});
  }, []);
  useEffect(() => {
    mounted.current = true;
    let isActive = true;
    const loadServers = async () => {
      const generation = ++inventoryReadGeneration.current;
      const providerGeneration = ++providerReadGeneration.current;
      const isCurrent = () => isActive && generation === inventoryReadGeneration.current;
      const isProviderCurrent = () =>
        isActive && providerGeneration === providerReadGeneration.current;
      providerReadPending.current = true;
      setIsLoadingServers(true);
      setServerLoadFailed(false);
      setActionError('');
      await Promise.all([
        mcpService.loadServers().then(loaded => {
          if (isCurrent()) {
            dispatch(setMcpServers(loaded));
            if (mcpService.hasServerLoadFailed()) {
              setServerLoadFailed(true);
              setActionError(i18nService.t('mcpLoadFailed'));
            }
          }
        }),
        mcpService
          .loadExtensionServers()
          .then(loaded => {
            if (isProviderCurrent()) {
              providerReadPending.current = false;
              setProviderLoadFailed(false);
              setExtensionServers(loaded);
              if (!isCurrent()) setIsLoadingServers(false);
            }
          })
          .catch(() => {
            if (isProviderCurrent()) {
              providerReadPending.current = false;
              setProviderLoadFailed(true);
              if (!isCurrent()) setIsLoadingServers(false);
            }
          }),
      ]);
      if (isCurrent() || isProviderCurrent()) setIsLoadingServers(false);
    };
    void loadServers();
    const stop = window.electron.extensions.onChanged(() => {
      if (isActive) {
        invalidateConnectionResults();
        setExtensionServers([]);
        setParameterServer(null);
        void loadServers();
      }
    });
    return () => {
      isActive = false;
      mounted.current = false;
      inventoryReadGeneration.current += 1;
      providerReadGeneration.current += 1;
      providerReadPending.current = false;
      formGeneration.current += 1;
      inventoryGeneration.current += 1;
      stop();
    };
  }, [dispatch, invalidateConnectionResults]);

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

  const getConnectionDetail = (server: McpDetailServer): string => {
    if (isExtensionServer(server))
      return (
        server.connectionSummary ||
        i18nService.t('mcpProvidedByExtension').replace('{name}', server.providerName)
      );
    if (server.transportType === 'stdio') {
      return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
    }
    return server.url || i18nService.t('mcpDetailEmpty');
  };

  const getConnectionDetailLabel = (server: McpDetailServer): string => {
    if (isExtensionServer(server))
      return i18nService.t(
        server.transportType === 'stdio'
          ? 'mcpDetailConnectionDetail'
          : server.transportType
            ? 'mcpDetailEndpoint'
            : 'pluginScope.extension',
      );
    return server.transportType === 'stdio'
      ? i18nService.t('mcpDetailConnectionDetail')
      : i18nService.t('mcpDetailEndpoint');
  };

  const getInstalledDescription = useCallback((server: McpServerConfig): string => {
    return server.description?.trim() ?? '';
  }, []);

  const installedMarketplaceServers = useMemo(
    () =>
      servers.map(server => ({
        id: server.id,
        updateEligible: true,
      })),
    [servers],
  );
  const marketplace = usePluginMarketplace({
    kind: PluginKind.MCP,
    installed: installedMarketplaceServers,
    inventoryReady: !isLoadingServers && !serverLoadFailed,
    searchQuery: searchQuery,
    onInstalled: async () => {
      dispatch(setMcpServers(await mcpService.loadServers()));
      if (mounted.current) setServerLoadFailed(mcpService.hasServerLoadFailed());
      if (mcpService.hasServerLoadFailed()) throw new Error('Inventory unavailable');
    },
  });

  const filteredInstalled = servers.filter(server =>
    marketplace.matchesInstalled(
      server.id,
      [server.id, server.name, getInstalledDescription(server)].some(value =>
        value.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      ),
    ),
  );
  const filteredExtensionServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (marketplace.filter === MarketplaceFilter.UPDATES) return [];
    if (!query) return extensionServers;
    return extensionServers.filter(
      server =>
        server.name.toLowerCase().includes(query) ||
        server.providerName.toLowerCase().includes(query) ||
        server.providerDescription.toLowerCase().includes(query),
    );
  }, [extensionServers, searchQuery, marketplace.filter]);
  const userExtensionServers = filteredExtensionServers.filter(
    server => server.scope !== PluginHubScope.SYSTEM,
  );
  const systemExtensionServers = filteredExtensionServers
    .filter(server => server.scope === PluginHubScope.SYSTEM)
    .sort(comparePluginNames);
  const userServers = [...filteredInstalled, ...userExtensionServers].sort(comparePluginNames);
  const userServerCount = userServers.length;
  const testableServers = [...servers, ...extensionServers.filter(server => server.supported)];

  const reconcileFailedMutation = async (generation: number) => {
    if (!mounted.current || generation !== inventoryReadGeneration.current) return;
    await mcpService.loadServers();
    if (mounted.current && generation === inventoryReadGeneration.current) {
      dispatch(setMcpServers(mcpService.getServers()));
    }
  };

  const handleToggleEnabled = async (serverId: string) => {
    if (marketplace.operationFor(serverId)?.busy) return;
    if (updatingServerIds.has(serverId)) return;
    const targetServer = servers.find(s => s.id === serverId);
    if (!targetServer) return;
    const generation = ++inventoryReadGeneration.current;
    setUpdatingServerIds(current => new Set(current).add(serverId));
    try {
      await mcpService.setServerEnabled(serverId, !targetServer.enabled);
      if (!mounted.current) return;
      dispatch(setMcpServers(mcpService.getServers()));
      setActionError(mcpService.hasServerLoadFailed() ? i18nService.t('mcpLoadFailed') : '');
    } catch (error) {
      if (!mounted.current) return;
      setActionError(error instanceof Error ? error.message : i18nService.t('mcpUpdateFailed'));
      await reconcileFailedMutation(generation);
    } finally {
      if (mounted.current) {
        setUpdatingServerIds(current => {
          const next = new Set(current);
          next.delete(serverId);
          return next;
        });
        if (generation === inventoryReadGeneration.current && !providerReadPending.current) {
          setIsLoadingServers(false);
        }
      }
    }
  };

  const handleToggleExtensionEnabled = async (server: ExtensionProvidedMcpServer) => {
    if (updatingServerIds.has(server.id)) return;
    const generation = ++providerReadGeneration.current;
    providerReadPending.current = false;
    invalidateConnectionResults();
    setParameterServer(null);
    setUpdatingServerIds(current => new Set(current).add(server.id));
    const isCurrent = () => mounted.current && generation === providerReadGeneration.current;
    try {
      const loaded = await mcpService.setExtensionServerEnabled(server.id, !server.enabled);
      if (isCurrent()) {
        setExtensionServers(loaded);
        setIsLoadingServers(false);
        setProviderLoadFailed(false);
        setActionError('');
      }
    } catch (error) {
      if (isCurrent()) {
        const key =
          error instanceof Error && error.message.startsWith('mcpExtensionMutation.')
            ? error.message
            : 'mcpExtensionMutation.unknown';
        setActionError(i18nService.t(key));
      }
      try {
        const loaded = await mcpService.loadExtensionServers();
        if (isCurrent()) {
          setExtensionServers(loaded);
          setProviderLoadFailed(false);
        }
      } catch {
        if (isCurrent()) setProviderLoadFailed(true);
      }
    } finally {
      if (mounted.current) {
        setUpdatingServerIds(current => {
          const next = new Set(current);
          next.delete(server.id);
          return next;
        });
      }
    }
  };

  const handleRequestDelete = (server: McpServerConfig) => {
    if (marketplace.operationFor(server.id)?.busy) return;
    setActionError('');
    setPendingDelete(server);
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    const generation = ++inventoryReadGeneration.current;
    setIsDeleting(true);
    setActionError('');
    try {
      const result = await mcpService.deleteServer(pendingDelete.id);
      if (!mounted.current) return;
      if (!result.success) {
        setActionError(result.error || i18nService.t('mcpDeleteFailed'));
        await reconcileFailedMutation(generation);
        return;
      }
      if (result.servers) dispatch(setMcpServers(mcpService.getServers()));
      if (mcpService.hasServerLoadFailed()) setActionError(i18nService.t('mcpLoadFailed'));
      setPendingDelete(null);
    } catch (error) {
      if (mounted.current) {
        setActionError(error instanceof Error ? error.message : i18nService.t('mcpDeleteFailed'));
      }
    } finally {
      if (mounted.current) {
        setIsDeleting(false);
        if (generation === inventoryReadGeneration.current && !providerReadPending.current) {
          setIsLoadingServers(false);
        }
      }
    }
  };

  const refreshDefaultRequestTimeout = async (): Promise<void> => {
    try {
      const result = await window.electron.cowork.getAgentRuntimeSettings();
      if (result.success && result.settings) {
        setDefaultRequestTimeoutSeconds(result.settings.mcp.requestTimeoutSeconds);
      }
    } catch {
      // Keep the last known default when runtime settings are unavailable.
    }
  };

  const handleOpenEditForm = async (server: McpServerConfig, artworkTone: string) => {
    const generation = ++formGeneration.current;
    await refreshDefaultRequestTimeout();
    if (!mounted.current || generation !== formGeneration.current) return;
    setEditingServer(server);
    setDetailArtworkTone(artworkTone);
    setInstallingRegistry(getRegistryEntryForServer(server) ?? null);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    formGeneration.current += 1;
    setIsFormOpen(false);
    setEditingServer(null);
    setInstallingRegistry(null);
  };

  const handleSaveForm = async (data: McpServerFormData) => {
    const generation = ++inventoryReadGeneration.current;
    const formRevision = formGeneration.current;
    setActionError('');
    try {
      const result = editingServer?.id
        ? await mcpService.updateServer(editingServer.id, data)
        : await mcpService.createServer(data);
      if (mounted.current && formRevision === formGeneration.current) {
        if (result.success && result.servers) dispatch(setMcpServers(mcpService.getServers()));
        if (result.success && mcpService.hasServerLoadFailed()) {
          setActionError(i18nService.t('mcpLoadFailed'));
        }
        if (!result.success) await reconcileFailedMutation(generation);
      }
      return result;
    } finally {
      if (
        mounted.current &&
        generation === inventoryReadGeneration.current &&
        !providerReadPending.current
      ) {
        setIsLoadingServers(false);
      }
    }
  };

  const handleOpenCreateForm = async () => {
    const generation = ++formGeneration.current;
    await refreshDefaultRequestTimeout();
    if (!mounted.current || generation !== formGeneration.current) return;
    setEditingServer(null);
    setDetailArtworkTone(getPluginArtworkTone('mcp:user'));
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

  const handleProbeServer = async (server: McpDetailServer, openDetail = false) => {
    if (probingServerIds.has(server.id)) return;
    setActionError('');
    if (openDetail) {
      detailGeneration.current += 1;
      setDetailServer(server);
      setExpandedToolNames(new Set());
      setExpandedPromptNames(new Set());
      setExpandedResourceUris(new Set());
      setReadingResourceUris(new Set());
      setResourceContents({});
      setResourceErrors({});
    }
    if (isExtensionServer(server) && !server.supported) {
      setProbeResults(current => ({
        ...current,
        [server.id]: {
          available: false,
          tools: [],
          resources: [],
          prompts: [],
          latencyMs: 0,
          error: i18nService.t('mcpExtensionUnsupported'),
        },
      }));
      return;
    }
    setProbeResults(current => {
      const next = { ...current };
      delete next[server.id];
      return next;
    });
    setServerProbing(server.id, true);
    const generation = inventoryGeneration.current;
    const result = await mcpService.probeServer(server.id);
    if (generation !== inventoryGeneration.current) return;
    setServerProbing(server.id, false);

    if (!result.success || !result.result) {
      setActionError(result.error || i18nService.t('mcpProbeFailed'));
      setProbeResults(current => ({
        ...current,
        [server.id]: {
          available: false,
          tools: [],
          resources: [],
          prompts: [],
          latencyMs: 0,
          error: result.error || i18nService.t('mcpProbeFailed'),
        },
      }));
      return;
    }

    const normalizedResult = normalizeProbeResult(result.result);

    setProbeResults(current => ({
      ...current,
      [server.id]: normalizedResult,
    }));
  };

  const handleOpenBulkProbe = async () => {
    if (testableServers.length === 0 || isBulkProbing) return;
    const generation = inventoryGeneration.current;
    setActionError('');
    setIsBulkProbeOpen(true);
    setIsBulkProbing(true);
    setBulkProbeResults({});

    const pendingIds = testableServers.map(server => server.id);
    setProbingServerIds(current => new Set([...current, ...pendingIds]));

    for (const server of testableServers) {
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

      if (generation !== inventoryGeneration.current) return;
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
    const generation = inventoryGeneration.current;
    const detailRevision = detailGeneration.current;
    setExpandedResourceUris(current => new Set(current).add(resourceUri));
    setReadingResourceUris(current => new Set(current).add(resourceUri));
    setResourceErrors(current => {
      const next = { ...current };
      delete next[resourceUri];
      return next;
    });

    const result = await mcpService.readResource(detailServer.id, resourceUri);
    if (generation !== inventoryGeneration.current || detailRevision !== detailGeneration.current)
      return;

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

  const existingNames = useMemo(
    () => [...servers, ...extensionServers].map(server => server.name),
    [servers, extensionServers],
  );

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

  const userActions = (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => void handleOpenCreateForm()}
        className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        + {i18nService.t('addMcpServer')}
      </button>
      <button
        type="button"
        onClick={handleOpenBulkProbe}
        disabled={testableServers.length === 0 || isBulkProbing}
        className="inline-flex shrink-0 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
        title={i18nService.t('mcpTestAll')}
      >
        <ClockIcon className="h-4 w-4" />
        <span>{i18nService.t('mcpTestAll')}</span>
      </button>
    </div>
  );

  const renderInstalledCard = (server: McpServerConfig, visualIndex: number) => {
    const installedDescription = getInstalledDescription(server);
    return (
      <McpServerCard
        key={server.id}
        visualIndex={visualIndex}
        group="user"
        onOpen={
          marketplace.operationFor(server.id)?.busy
            ? undefined
            : () => void handleOpenEditForm(server, getPluginArtworkTone('mcp:user', visualIndex))
        }
        openLabel={`${i18nService.t('editMcpServer')}: ${server.name}`}
        onProbe={() => void handleProbeServer(server, true)}
        probeDisabled={probingServerIds.has(server.id)}
        probing={probingServerIds.has(server.id)}
        probeResult={probeResults[server.id]}
        title={
          <span className="block truncate text-sm font-medium text-foreground">{server.name}</span>
        }
        actions={
          <InstalledMarketplaceAction
            controller={marketplace}
            id={server.id}
            disabled={updatingServerIds.has(server.id) || marketplace.operationFor(server.id)?.busy}
          />
        }
        stateAction={
          <PluginStateButton
            checked={server.enabled}
            label={i18nService.t(server.enabled ? 'disableMcpServer' : 'enableMcpServer')}
            disabled={updatingServerIds.has(server.id) || marketplace.operationFor(server.id)?.busy}
            busy={updatingServerIds.has(server.id)}
            onToggle={() => handleToggleEnabled(server.id)}
          />
        }
        description={
          <Tooltip
            content={installedDescription}
            position="bottom"
            maxWidth="360px"
            className="block w-full"
          >
            <p className="line-clamp-2 break-words">{installedDescription}</p>
          </Tooltip>
        }
        feedback={<MarketplaceFeedback controller={marketplace} id={server.id} />}
      />
    );
  };

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

      {(actionError || providerLoadFailed) && (
        <ErrorMessage
          message={actionError || i18nService.t('mcpLoadFailed')}
          onClose={actionError ? () => setActionError('') : undefined}
        />
      )}

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

      <div>
        <MarketplaceToolbar
          controller={marketplace}
          hasLocalMatches={filteredInstalled.length + filteredExtensionServers.length > 0}
        />
        {visibility !== 'available' &&
          (marketplace.filter !== MarketplaceFilter.UPDATES ||
            marketplace.updateById.size > 0 ||
            marketplace.recentlyUpdated.size > 0) && (
            <section className="space-y-4">
              <div className="space-y-4">
                {sharedSearchQuery === undefined && (
                  <div className="relative min-w-0 sm:max-w-md">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
                    <input
                      type="text"
                      placeholder={i18nService.t('searchMcpServers')}
                      value={searchQuery}
                      onChange={e => setLocalSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                )}
                {isLoadingServers && (
                  <div
                    className="flex items-center gap-2 px-2 py-3 text-xs text-secondary"
                    role="status"
                  >
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current"
                    />
                    {i18nService.t('mcpLoadingServers')}
                  </div>
                )}
                {!isLoadingServers &&
                !serverLoadFailed &&
                !providerLoadFailed &&
                filteredInstalled.length === 0 &&
                filteredExtensionServers.length === 0 &&
                searchQuery.trim() ? null : (
                  <div className="space-y-6">
                    {(userServerCount > 0 || !searchQuery.trim()) && (
                      <PluginGroupSection
                        hideHeader={Boolean(searchQuery.trim())}
                        title={i18nService.t('pluginGroup.user.label')}
                        count={userServerCount}
                        action={userActions}
                      >
                        {userServerCount === 0 ? (
                          !isLoadingServers &&
                          !serverLoadFailed &&
                          !providerLoadFailed && (
                            <p className="px-2 py-3 text-xs text-secondary">
                              {i18nService.t('mcpNoInstalledServers')}
                            </p>
                          )
                        ) : (
                          <div className="grid min-w-0 auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                            {userServers.map((server, visualIndex) =>
                              'providerId' in server ? (
                                <ExtensionMcpCard
                                  key={server.id}
                                  server={server}
                                  visualIndex={visualIndex}
                                  group="user"
                                  onOpenExtension={onOpenExtension}
                                  onOpenDetail={() => void handleProbeServer(server, true)}
                                  onOpenParameters={() => {
                                    setParameterServer(server);
                                    setDetailArtworkTone(
                                      getPluginArtworkTone('mcp:user', visualIndex),
                                    );
                                  }}
                                  onToggle={() => void handleToggleExtensionEnabled(server)}
                                  updating={updatingServerIds.has(server.id)}
                                  probing={probingServerIds.has(server.id)}
                                  probeResult={probeResults[server.id]}
                                />
                              ) : (
                                renderInstalledCard(server, visualIndex)
                              ),
                            )}
                          </div>
                        )}
                      </PluginGroupSection>
                    )}
                    {systemExtensionServers.length > 0 && (
                      <PluginGroupSection
                        hideHeader={Boolean(searchQuery.trim())}
                        title={i18nService.t('pluginGroup.system.label')}
                        count={systemExtensionServers.length}
                        description={i18nService.t('mcpGroupExtensionDescription')}
                        collapsible
                        defaultExpanded={false}
                        forceExpanded={Boolean(searchQuery.trim())}
                      >
                        <div className="grid min-w-0 auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                          {systemExtensionServers.map((server, visualIndex) => (
                            <ExtensionMcpCard
                              key={server.id}
                              server={server}
                              visualIndex={visualIndex}
                              group="system"
                              onOpenExtension={onOpenExtension}
                              onOpenDetail={() => void handleProbeServer(server, true)}
                              onOpenParameters={() => {
                                setParameterServer(server);
                                setDetailArtworkTone(
                                  getPluginArtworkTone('mcp:system', visualIndex),
                                );
                              }}
                              onToggle={() => void handleToggleExtensionEnabled(server)}
                              updating={updatingServerIds.has(server.id)}
                              probing={probingServerIds.has(server.id)}
                              probeResult={probeResults[server.id]}
                            />
                          ))}
                        </div>
                      </PluginGroupSection>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

        {visibility !== 'installed' && (
          <section className={searchQuery.trim() ? '' : 'mt-6 border-t border-border pt-6'}>
            <MarketplaceResults
              hasLocalMatches={filteredInstalled.length + filteredExtensionServers.length > 0}
              controller={marketplace}
              icon={<ConnectorIcon className="h-4 w-4" />}
              renderInstalled={(id, index) => {
                const entry = servers.find(item => item.id === id);
                return entry ? renderInstalledCard(entry, index) : null;
              }}
            />
          </section>
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
              aria-busy={isDeleting || undefined}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isDeleting && <ArrowPathIcon aria-hidden="true" className="h-4 w-4 animate-spin" />}
              <span role={isDeleting ? 'status' : undefined}>{i18nService.t('confirmDelete')}</span>
            </button>
          </div>
        </Modal>
      )}

      {/* Edit / Registry-install form modal */}
      {parameterServer && (
        <ExtensionMcpParametersModal
          key={parameterServer.id}
          server={parameterServer}
          artworkTone={detailArtworkTone}
          onClose={() => setParameterServer(null)}
          onProbe={server => void handleProbeServer(server, true)}
          probing={probingServerIds.has(parameterServer.id)}
          probeResult={probeResults[parameterServer.id]}
        />
      )}
      <McpServerFormModal
        key={formGeneration.current}
        isOpen={isFormOpen}
        server={editingServer}
        artworkTone={detailArtworkTone}
        registryEntry={installingRegistry}
        defaultRequestTimeoutSeconds={defaultRequestTimeoutSeconds}
        existingNames={existingNames}
        onClose={handleCloseForm}
        onSave={handleSaveForm}
        onProbe={editingServer ? () => void handleProbeServer(editingServer, true) : undefined}
        probing={editingServer ? probingServerIds.has(editingServer.id) : false}
        probeResult={editingServer ? probeResults[editingServer.id] : undefined}
        onDelete={
          editingServer
            ? () => {
                const server = editingServer;
                handleCloseForm();
                handleRequestDelete(server);
              }
            : undefined
        }
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
                  .replace('{total}', String(testableServers.length))}
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
            {testableServers.map(server => {
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
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${server.transportType ? MCP_TRANSPORT_BADGE_COLORS[server.transportType] : ''}`}
                        >
                          {server.transportType || i18nService.t('pluginScope.extension')}
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

      {detailServer && (
        <Modal
          onClose={() => setDetailServer(null)}
          closeOnBackdrop={false}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          className="w-full max-w-4xl max-h-[84vh] mx-4 rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden flex flex-col"
        >
          {(() => {
            const detail = getDetailResult();
            if (!detail)
              return (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-foreground">
                      {detailServer.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDetailServer(null)}
                      className="text-xs text-secondary hover:text-foreground"
                    >
                      {i18nService.t('close')}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-secondary" role="status">
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current"
                    />
                    {i18nService.t('mcpTestingServer')}
                  </div>
                </div>
              );
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
                  {isExtensionServer(detailServer) && (
                    <button
                      type="button"
                      onClick={() => onOpenExtension?.(detailServer.providerId)}
                      disabled={!onOpenExtension}
                      className="text-xs text-secondary enabled:hover:text-primary"
                    >
                      {i18nService
                        .t('mcpProvidedByExtension')
                        .replace('{name}', detailServer.providerName)}
                    </button>
                  )}
                  {(isExtensionServer(detailServer)
                    ? detailServer.providerDescription
                    : detailServer.description) && (
                    <PluginMarkdownDescription
                      content={
                        isExtensionServer(detailServer)
                          ? detailServer.providerDescription
                          : detailServer.description
                      }
                    />
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="text-[11px] text-secondary shrink-0">
                        {i18nService.t('mcpDetailTransport')}
                      </div>
                      <div className="min-w-0">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            detailServer.transportType
                              ? MCP_TRANSPORT_BADGE_COLORS[detailServer.transportType]
                              : ''
                          }`}
                        >
                          {detailServer.transportType?.toUpperCase() ||
                            i18nService.t('pluginScope.extension')}
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
                        <PluginMarkdownDescription
                          className="mt-1 text-xs"
                          content={detail.instructions}
                        />
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
