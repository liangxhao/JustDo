import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ChevronDownIcon,
  ClockIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import {
  type ExtensionImportRequest,
  type ExtensionImportResult,
  ExtensionState,
  type InstalledOpenClawExtension,
  type OpenClawExtensionConfigurationField,
  type OpenClawPluginCapabilityReview,
} from '@shared/plugins/extensions';
import { PluginKind } from '@shared/plugins/marketplace';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { PluginOperationAction, PluginOperationStage } from '@shared/plugins/pluginOperation';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { LOCAL_TTS_PROVIDER_ID } from '@shared/speech/localTts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { OPEN_TEAM_RECORDS } from '@/features/cowork/components/display/summary/agentTeamHistory';
import {
  canToggleExtension,
  ExtensionGroupId,
  groupExtensionsByOwnership,
} from '@/features/plugins/extensions/extensionGroups';
import { getExtensionManagementLabel } from '@/features/plugins/extensions/extensionManagementLabel';
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
import OperationResultModal, {
  type OperationResult,
} from '@/features/plugins/shared/OperationResultModal';
import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import {
  PLUGIN_DETAIL_BODY_CLASS_NAME,
  PLUGIN_DETAIL_FOOTER_CLASS_NAME,
  PLUGIN_DETAIL_MODAL_CLASS_NAME,
  PluginDetailHeader,
} from '@/features/plugins/shared/PluginDetail';
import PluginGroupSection from '@/features/plugins/shared/PluginGroupSection';
import type { PluginHubManagerProps } from '@/features/plugins/shared/pluginHubTypes';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import {
  pluginOperationErrorMessage,
  pluginOperationFailure,
  pluginOperationRefreshFailure,
} from '@/features/plugins/shared/pluginMutationFeedback';
import {
  type PluginOperationFailureItem,
  pluginSourceLabel,
  reportPluginOperationFailure,
  startPluginOperation,
} from '@/features/plugins/shared/pluginOperationService';
import PluginStateButton, {
  PluginLockedIndicator,
} from '@/features/plugins/shared/PluginStateButton';
import { i18nService } from '@/services/i18n';
import PuzzleIcon from '@/shared/components/icons/PuzzleIcon';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import TrashIcon from '@/shared/components/icons/TrashIcon';
import Modal from '@/shared/components/ui/Modal';
import Tooltip from '@/shared/components/ui/Tooltip';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

import AgentTeamSettingsDialog from './AgentTeamSettingsDialog';
import LocalSpeechExtensionSettingsButton from './LocalSpeechExtensionSettingsButton';
import LocalSpeechExtensionSettingsDialog from './LocalSpeechExtensionSettingsDialog';

type ExtensionToggleProps = {
  extension: InstalledOpenClawExtension;
  canToggle: boolean;
  pending: boolean;
  busy: boolean;
  onToggle: () => void;
};

const ExtensionToggle: React.FC<ExtensionToggleProps> = ({
  extension,
  canToggle,
  pending,
  busy,
  onToggle,
}) => {
  const displayedEnabled = pending ? !extension.enabled : extension.enabled;
  const label = !canToggle
    ? i18nService.t('extensionToggleUnavailable')
    : pending
      ? `${i18nService.t(
          displayedEnabled ? 'extensionEnable' : 'extensionDisable',
        )} · ${i18nService.t('pluginStatusApplying')}`
      : i18nService.t(extension.enabled ? 'extensionDisable' : 'extensionEnable');

  return (
    <PluginStateButton
      checked={displayedEnabled}
      label={label}
      disabled={busy || !canToggle}
      busy={pending}
      onToggle={onToggle}
    />
  );
};

const getConfigurationVariable = (
  field: OpenClawExtensionConfigurationField,
  selections: Record<string, string>,
): string | undefined =>
  selections[field.path] ??
  field.configuredEnvironmentVariables?.[0] ??
  field.environmentVariables?.[0];

const isNumericConfigurationField = (field: OpenClawExtensionConfigurationField): boolean =>
  field.type === 'integer' || field.type === 'number';

interface ExtensionsManagerProps extends PluginHubManagerProps {
  onOpenRuntime?: () => void;
  onManageSpeechModels?: (
    kind: LocalSpeechModelKind,
    target?: import('@/features/speech/speechModelCatalogNavigation').SpeechModelCatalogTarget,
  ) => void;
  isActive?: boolean;
  requestedExtensionId?: string;
  onRequestedExtensionHandled?: () => void;
}

const reportInterruptedImportFailures = (pending: {
  completedLabels: string[];
  failures: PluginOperationFailureItem[];
  startedAt: number;
  refreshFailed?: boolean;
}) => {
  if (pending.failures.length === 0 && !pending.refreshFailed) return;
  reportPluginOperationFailure(
    {
      kind: PluginKind.EXTENSION,
      action: PluginOperationAction.INSTALL,
      label:
        pending.failures.length === 1 && pending.completedLabels.length === 0
          ? pending.failures[0].label
          : i18nService.t('importExtension'),
    },
    {
      ...(pending.failures.length === 1 && pending.completedLabels.length === 0
        ? pending.failures[0]
        : {}),
      ...(pending.failures.length === 0 ? pluginOperationRefreshFailure() : {}),
      message:
        pending.failures.length === 0
          ? i18nService.t('pluginOperationRefreshFailed')
          : pending.completedLabels.length > 0 || pending.failures.length > 1
            ? i18nService
                .t('pluginImportPartialSummary')
                .replace('{successCount}', String(pending.completedLabels.length))
                .replace('{failureCount}', String(pending.failures.length))
            : pending.failures[0].message || i18nService.t('extensionImportFailed'),
      elapsedMs: Date.now() - pending.startedAt,
      ...(pending.failures.length > 0 && pending.refreshFailed
        ? { details: i18nService.t('pluginOperationRefreshFailed') }
        : {}),
      items: [
        ...pending.completedLabels.map(label => ({
          label,
          message: i18nService.t('pluginImportItemSuccess'),
          type: 'success' as const,
        })),
        ...pending.failures.map(item => ({ ...item, type: 'error' as const })),
      ],
    },
  );
};

const ExtensionsManager: React.FC<ExtensionsManagerProps> = ({
  searchQuery: sharedSearchQuery,
  visibility = 'all',
  requestedExtensionId,
  onRequestedExtensionHandled,
  onOpenRuntime,
  onManageSpeechModels,
  isActive = true,
}) => {
  const ownerDocument = useOwnerDocument();
  const openTeamRecords = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_TEAM_RECORDS, { detail: ownerDocument }));
  }, [ownerDocument]);
  const [teamSettingsOpen, setTeamSettingsOpen] = useState(false);
  const [speechSettingsKind, setSpeechSettingsKind] = useState<LocalSpeechModelKind | null>(null);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const searchQuery = sharedSearchQuery ?? localSearchQuery;
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const importOperation = useRef<ReturnType<typeof startPluginOperation> | null>(null);
  const [actionOutcome, setActionOutcome] = useState<OperationResult | null>(null);
  const [extensions, setExtensions] = useState<InstalledOpenClawExtension[]>([]);
  const [loadingExtensions, setLoadingExtensions] = useState(true);
  const [inventoryReady, setInventoryReady] = useState(false);
  const agentTeamEnabled =
    inventoryReady &&
    extensions.some(
      extension => extension.id === OpenClawExtensionId.AGENT_TEAM && extension.enabled,
    );
  useEffect(() => {
    const id =
      speechSettingsKind === LocalSpeechModelKind.Asr
        ? OpenClawExtensionId.STT_LOCAL_CLI
        : LOCAL_TTS_PROVIDER_ID;
    if (
      speechSettingsKind &&
      inventoryReady &&
      !extensions.some(extension => extension.id === id)
    ) {
      setSpeechSettingsKind(null);
    }
  }, [extensions, inventoryReady, speechSettingsKind]);
  useEffect(() => {
    if (!agentTeamEnabled) setTeamSettingsOpen(false);
  }, [agentTeamEnabled]);
  const inventoryGeneration = useRef(0);
  const inventoryMounted = useRef(false);
  const latestInventoryRead = useRef<Promise<InstalledOpenClawExtension[] | null> | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InstalledOpenClawExtension | null>(null);
  const [deletingExtensionId, setDeletingExtensionId] = useState<string | null>(null);
  const [togglingExtensionId, setTogglingExtensionId] = useState<string | null>(null);
  const [pendingCapabilityReview, setPendingCapabilityReview] = useState<
    | {
        kind: 'toggle';
        extension: InstalledOpenClawExtension;
        review: OpenClawPluginCapabilityReview;
      }
    | {
        kind: 'import';
        requestId: string;
        sourcePath: string;
        displayName: string;
        review: OpenClawPluginCapabilityReview;
        remainingSourcePaths: string[];
        completedLabels: string[];
        failures: PluginOperationFailureItem[];
        startedAt: number;
        refreshFailed: boolean;
      }
    | null
  >(null);
  const pendingReviewRef = useRef(pendingCapabilityReview);
  pendingReviewRef.current = pendingCapabilityReview;
  const cancelCapabilityReview = () => {
    const pending = pendingReviewRef.current;
    pendingReviewRef.current = null;
    setPendingCapabilityReview(null);
    if (pending?.kind === 'import') reportInterruptedImportFailures(pending);
  };
  const [selectedExtension, setSelectedExtension] = useState<InstalledOpenClawExtension | null>(
    null,
  );
  const [detailArtworkTone, setDetailArtworkTone] = useState(() =>
    getPluginArtworkTone('extensions'),
  );
  const [configurationValues, setConfigurationValues] = useState<Record<string, string>>({});
  const [configurationVariables, setConfigurationVariables] = useState<Record<string, string>>({});
  const [configurationError, setConfigurationError] = useState('');
  const [configurationSaved, setConfigurationSaved] = useState(false);
  const [configurationPending, setConfigurationPending] = useState(false);
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const detailGeneration = useRef(0);
  const handledRequestedExtension = useRef<string | undefined>(undefined);
  const openExtensionDetails = useCallback(
    (extension: InstalledOpenClawExtension, artworkTone: string) => {
      detailGeneration.current += 1;
      setSelectedExtension(extension);
      setDetailArtworkTone(artworkTone);
      setConfigurationValues({});
      setConfigurationVariables({});
      setConfigurationError('');
      setConfigurationSaved(false);
      setConfigurationPending(false);
    },
    [],
  );
  const closeExtensionDetails = useCallback(() => {
    detailGeneration.current += 1;
    setSelectedExtension(null);
  }, []);
  const localExtensionActionBusy =
    importing ||
    deletingExtensionId !== null ||
    togglingExtensionId !== null ||
    savingConfiguration;

  const loadExtensions = useCallback(
    (options: { reportFailure?: boolean } = {}): Promise<InstalledOpenClawExtension[] | null> => {
      const generation = ++inventoryGeneration.current;
      const isCurrent = () =>
        inventoryMounted.current && generation === inventoryGeneration.current;
      const pending = (async () => {
        try {
          const result = await window.electron.extensions.list();
          if (!result.success)
            throw new Error(result.error || i18nService.t('extensionListFailed'));
          if (!isCurrent())
            return inventoryMounted.current ? latestInventoryRead.current : result.extensions;
          setExtensions(result.extensions);
          setSelectedExtension(current => {
            if (!current) return null;
            const updated = result.extensions.find(extension => extension.id === current.id);
            if (!updated) detailGeneration.current += 1;
            return updated ?? null;
          });
          setInventoryReady(true);
          return result.extensions;
        } catch (error) {
          if (!isCurrent()) return inventoryMounted.current ? latestInventoryRead.current : null;
          setInventoryReady(false);
          if (options.reportFailure !== false)
            setActionOutcome({
              type: 'error',
              title: i18nService.t('extensionListFailed'),
              message:
                error instanceof Error ? error.message : i18nService.t('extensionListFailed'),
            });
          return null;
        } finally {
          if (isCurrent()) setLoadingExtensions(false);
        }
      })();
      // Event and action refreshes can overlap. Their callers join the newest read
      // instead of using a superseded inventory to update an open details dialog.
      latestInventoryRead.current = pending;
      return pending;
    },
    [],
  );

  useEffect(() => {
    inventoryMounted.current = true;
    void loadExtensions();
    const stop = window.electron.extensions.onChanged(event => {
      if (!inventoryMounted.current) return;
      if (event.extensionId === OpenClawExtensionId.AGENT_TEAM && !event.enabled)
        setTeamSettingsOpen(false);
      setExtensions(current =>
        current.map(extension =>
          extension.id === event.extensionId ? { ...extension, enabled: event.enabled } : extension,
        ),
      );
      void loadExtensions({ reportFailure: false });
    });
    return () => {
      const pending = pendingReviewRef.current;
      pendingReviewRef.current = null;
      if (pending?.kind === 'import') reportInterruptedImportFailures(pending);
      inventoryMounted.current = false;
      detailGeneration.current += 1;
      inventoryGeneration.current += 1;
      latestInventoryRead.current = null;
      stop();
    };
  }, [loadExtensions]);

  useEffect(() => {
    if (!requestedExtensionId) {
      handledRequestedExtension.current = undefined;
      return;
    }
    if (handledRequestedExtension.current === requestedExtensionId) return;
    const requested = extensions.find(extension => extension.id === requestedExtensionId);
    if (!requested) return;
    handledRequestedExtension.current = requestedExtensionId;
    const group = groupExtensionsByOwnership(extensions).find(group =>
      group.extensions.some(extension => extension.id === requested.id),
    );
    openExtensionDetails(
      requested,
      getPluginArtworkTone(
        `extensions:${requested.origin}`,
        group?.extensions.findIndex(extension => extension.id === requested.id),
      ),
    );
    onRequestedExtensionHandled?.();
  }, [extensions, onRequestedExtensionHandled, openExtensionDetails, requestedExtensionId]);

  const installedMarketplaceExtensions = useMemo(
    () =>
      extensions.map(extension => ({
        id: extension.id,
        version: extension.version,
        installPath: extension.installPath,
        updateEligible: !extension.managed && extension.origin !== 'bundled',
      })),
    [extensions],
  );
  const marketplace = usePluginMarketplace({
    kind: PluginKind.EXTENSION,
    installed: installedMarketplaceExtensions,
    inventoryReady,
    searchQuery: searchQuery,
    readOnly: localExtensionActionBusy,
    onInstalled: async () => {
      if (!(await loadExtensions())) throw new Error('Inventory unavailable');
    },
  });

  const extensionActionBusy =
    localExtensionActionBusy ||
    Object.values(marketplace.operations).some(operation => operation.busy);
  const filteredExtensions = extensions.filter(extension =>
    marketplace.matchesInstalled(
      extension.id,
      [extension.name, extension.id, extension.description].some(value =>
        value.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      ),
    ),
  );
  const groupedExtensions = useMemo(
    () => groupExtensionsByOwnership(filteredExtensions),
    [filteredExtensions],
  );
  const displayExtensionGroups = useMemo(() => {
    if (searchQuery.trim() || groupedExtensions.some(group => group.id === ExtensionGroupId.USER)) {
      return groupedExtensions;
    }
    return [{ id: ExtensionGroupId.USER, extensions: [] }, ...groupedExtensions];
  }, [groupedExtensions, searchQuery]);

  const importExtension = (request: ExtensionImportRequest) => {
    importOperation.current?.finish();
    const operation = startPluginOperation({
      kind: PluginKind.EXTENSION,
      action: PluginOperationAction.INSTALL,
      label: pluginSourceLabel(request.sourcePath),
    });
    importOperation.current = operation;
    return window.electron.extensions
      .importPath(request, operation.context)
      .catch((error): ExtensionImportResult => ({
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
      }));
  };
  const refreshAfterImport = () => {
    importOperation.current?.stage(PluginOperationStage.REFRESHING_INVENTORY);
    return loadExtensions({ reportFailure: false });
  };

  const finishImportBatch = (
    completedLabels: string[],
    failures: PluginOperationFailureItem[],
    refreshFailed: boolean,
    startedAt: number,
  ) => {
    if (failures.length > 0) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.EXTENSION,
          action: PluginOperationAction.INSTALL,
          label:
            failures.length === 1 && completedLabels.length === 0
              ? failures[0].label
              : i18nService.t('importExtension'),
        },
        {
          ...(failures.length === 1 && completedLabels.length === 0 ? failures[0] : {}),
          message:
            completedLabels.length > 0 || failures.length > 1
              ? i18nService
                  .t('pluginImportPartialSummary')
                  .replace('{successCount}', String(completedLabels.length))
                  .replace('{failureCount}', String(failures.length))
              : failures[0].message || i18nService.t('extensionImportFailed'),
          ...(refreshFailed ? { details: i18nService.t('pluginOperationRefreshFailed') } : {}),
          elapsedMs: Date.now() - startedAt,
          items: [
            ...completedLabels.map(label => ({
              label,
              message: i18nService.t('pluginImportItemSuccess'),
              type: 'success' as const,
            })),
            ...failures.map(item => ({ ...item, type: 'error' as const })),
          ],
        },
      );
    } else if (refreshFailed) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.EXTENSION,
          action: PluginOperationAction.INSTALL,
          label: i18nService.t('importExtension'),
        },
        { ...pluginOperationRefreshFailure(), elapsedMs: Date.now() - startedAt },
      );
    } else if (completedLabels.length > 0 && inventoryMounted.current) {
      setActionOutcome({
        type: 'success',
        title: i18nService.t('importExtension'),
        message: i18nService
          .t('extensionImportSuccess')
          .replace('{extensionId}', completedLabels.join(', ')),
      });
    }
  };

  const handleImportExtensions = async (sourceType: 'folders' | 'archives') => {
    if (extensionActionBusy) return;
    const startedAt = Date.now();

    try {
      setImportPickerOpen(false);
      setImporting(true);
      setActionOutcome(null);

      const result =
        sourceType === 'folders'
          ? await window.electron.dialog.selectFolders({
              title: i18nService.t('selectExtensionFolders'),
            })
          : await window.electron.dialog.selectFiles({
              title: i18nService.t('selectExtensionArchives'),
              filters: [
                {
                  name: i18nService.t('extensionArchiveFiles'),
                  extensions: ['zip', 'tar', 'gz', 'tgz'],
                },
              ],
            });

      if (!result.success || !result.paths?.length) {
        if (result.error)
          reportPluginOperationFailure(
            {
              kind: PluginKind.EXTENSION,
              action: PluginOperationAction.INSTALL,
              label: i18nService.t('importExtension'),
            },
            { message: result.error, elapsedMs: Date.now() - startedAt },
          );
        return;
      }

      const results = [];
      for (const [index, sourcePath] of result.paths.entries()) {
        const requestId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        const importResult = await importExtension({ requestId, sourcePath });
        if (importResult.capabilityReview) {
          const completedLabels = results
            .filter(item => item.success)
            .map(
              item => item.extensionId || item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
            );
          const failures = results
            .filter(item => !item.success)
            .map(item => ({
              label: item.sourcePath.split(/[/\\]/).pop() || item.sourcePath,
              ...pluginOperationFailure(item, i18nService.t('extensionImportFailed')),
            }));
          const inventory = await refreshAfterImport();
          const refreshFailed =
            inventory === null || results.some(item => item.refreshWarning === true);
          if (!inventoryMounted.current) {
            reportInterruptedImportFailures({
              completedLabels,
              failures,
              startedAt,
              refreshFailed,
            });
            return;
          }
          setPendingCapabilityReview({
            kind: 'import',
            requestId,
            sourcePath,
            displayName: sourcePath.split(/[/\\]/).pop() || sourcePath,
            review: importResult.capabilityReview,
            remainingSourcePaths: result.paths.slice(index + 1),
            completedLabels,
            failures,
            startedAt,
            refreshFailed,
          });
          return;
        }
        results.push({ sourcePath, ...importResult });
      }

      const succeeded = results.filter(item => item.success);
      const failed = results.filter(item => !item.success);
      // Reconcile with disk even when a later installer step reports failure. OpenClaw
      // may have already published the extension before its CLI or Gateway restart fails.
      const inventory = await refreshAfterImport();
      finishImportBatch(
        succeeded.map(item => item.extensionId || pluginSourceLabel(item.sourcePath)),
        failed.map(item => ({
          label: pluginSourceLabel(item.sourcePath),
          ...pluginOperationFailure(item, i18nService.t('extensionImportFailed')),
        })),
        inventory === null || results.some(item => item.refreshWarning === true),
        startedAt,
      );
    } catch (error) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.EXTENSION,
          action: PluginOperationAction.INSTALL,
          label: i18nService.t('importExtension'),
        },
        {
          message: error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
          elapsedMs: Date.now() - startedAt,
        },
      );
    } finally {
      importOperation.current?.finish();
      importOperation.current = null;
      setImporting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || extensionActionBusy) return;
    const extension = pendingDelete;
    const operation = startPluginOperation({
      kind: PluginKind.EXTENSION,
      action: PluginOperationAction.REMOVE,
      label: extension.name,
    });
    let mutationResult: Awaited<ReturnType<typeof window.electron.extensions.delete>> | undefined;
    try {
      setDeletingExtensionId(extension.id);
      setActionOutcome(null);
      const result = await window.electron.extensions.delete(
        { extensionId: extension.id },
        operation.context,
      );
      mutationResult = result;
      if (!result.success) {
        operation.fail(pluginOperationFailure(result, i18nService.t('extensionDeleteFailed')));
        throw new Error(result.error || i18nService.t('extensionDeleteFailed'));
      }
      setPendingDelete(null);
    } catch (error) {
      operation.fail({
        message:
          error instanceof Error
            ? pluginOperationErrorMessage(error.message)
            : i18nService.t('extensionDeleteFailed'),
      });
    } finally {
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      const latestExtensions = await loadExtensions({ reportFailure: false });
      if (!latestExtensions || mutationResult?.refreshWarning)
        operation.fail(pluginOperationRefreshFailure(mutationResult));
      else if (mutationResult?.success && inventoryMounted.current)
        setActionOutcome({
          type: 'success',
          title: i18nService.t('extensionDelete'),
          message: [
            i18nService.t('extensionDeleteSuccess').replace('{name}', extension.name),
            ...(mutationResult.warnings ?? []),
          ].join('\n'),
        });
      if (latestExtensions && !latestExtensions.some(item => item.id === extension.id)) {
        setPendingDelete(null);
      }
      setDeletingExtensionId(null);
      operation.finish();
    }
  };

  const handleToggleExtension = async (
    extension: InstalledOpenClawExtension,
    reviewToken?: string,
  ) => {
    if (extensionActionBusy) return;
    const operation = startPluginOperation({
      kind: PluginKind.EXTENSION,
      action: extension.enabled ? PluginOperationAction.DISABLE : PluginOperationAction.ENABLE,
      label: extension.name,
    });
    let mutationResult:
      Awaited<ReturnType<typeof window.electron.extensions.setEnabled>> | undefined;
    try {
      setTogglingExtensionId(extension.id);
      setActionOutcome(null);
      const result = await window.electron.extensions.setEnabled(
        {
          extensionId: extension.id,
          enabled: !extension.enabled,
          reviewToken,
        },
        operation.context,
      );
      mutationResult = result;
      if (result.capabilityReview) {
        if (!inventoryMounted.current) return;
        setPendingCapabilityReview({ kind: 'toggle', extension, review: result.capabilityReview });
        return;
      }
      if (!result.success) {
        operation.fail(
          pluginOperationFailure(result, i18nService.t('extensionStatusUpdateFailed')),
        );
        throw new Error(result.error || i18nService.t('extensionStatusUpdateFailed'));
      }
    } catch (error) {
      operation.fail({
        message:
          error instanceof Error
            ? pluginOperationErrorMessage(error.message)
            : i18nService.t('extensionStatusUpdateFailed'),
      });
    } finally {
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      const inventory = await loadExtensions({ reportFailure: false });
      if (!inventory || mutationResult?.refreshWarning)
        operation.fail(pluginOperationRefreshFailure(mutationResult));
      else if (
        mutationResult?.success &&
        mutationResult.warnings?.length &&
        inventoryMounted.current
      )
        setActionOutcome({
          type: 'success',
          title: i18nService.t('extensionStatusUpdatedWithWarnings'),
          message: mutationResult.warnings.join('\n'),
        });
      setTogglingExtensionId(null);
      operation.finish();
    }
  };

  const handleConfirmImportCapability = async (
    pending: Extract<NonNullable<typeof pendingCapabilityReview>, { kind: 'import' }>,
  ) => {
    if (extensionActionBusy) return;
    try {
      setPendingCapabilityReview(null);
      pendingReviewRef.current = null;
      setImporting(true);
      setActionOutcome(null);
      const result = await importExtension({
        requestId: pending.requestId,
        sourcePath: pending.sourcePath,
        reviewToken: pending.review.reviewToken,
      });
      if (result.capabilityReview) {
        if (!inventoryMounted.current) {
          reportInterruptedImportFailures(pending);
          return;
        }
        setPendingCapabilityReview({ ...pending, review: result.capabilityReview });
        return;
      }
      const completedLabels = [...pending.completedLabels];
      const failures = [...pending.failures];
      let refreshFailed = pending.refreshFailed || result.refreshWarning === true;
      if (result.success) {
        completedLabels.push(result.extensionId || pending.displayName);
      } else {
        failures.push({
          label: pending.displayName,
          ...pluginOperationFailure(result, i18nService.t('extensionImportFailed')),
        });
      }
      for (const [index, sourcePath] of pending.remainingSourcePaths.entries()) {
        const requestId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        const nextResult = await importExtension({ requestId, sourcePath });
        refreshFailed ||= nextResult.refreshWarning === true;
        if (nextResult.capabilityReview) {
          const inventory = await refreshAfterImport();
          refreshFailed = refreshFailed || inventory === null;
          if (!inventoryMounted.current) {
            reportInterruptedImportFailures({
              completedLabels,
              failures,
              startedAt: pending.startedAt,
              refreshFailed,
            });
            return;
          }
          setPendingCapabilityReview({
            kind: 'import',
            requestId,
            sourcePath,
            displayName: sourcePath.split(/[/\\]/).pop() || sourcePath,
            review: nextResult.capabilityReview,
            remainingSourcePaths: pending.remainingSourcePaths.slice(index + 1),
            completedLabels,
            failures,
            startedAt: pending.startedAt,
            refreshFailed,
          });
          return;
        }
        const label = nextResult.extensionId || sourcePath.split(/[/\\]/).pop() || sourcePath;
        if (nextResult.success) {
          completedLabels.push(label);
        } else {
          failures.push({
            label,
            ...pluginOperationFailure(nextResult, i18nService.t('extensionImportFailed')),
          });
        }
      }
      const inventory = await refreshAfterImport();
      finishImportBatch(
        completedLabels,
        failures,
        inventory === null || refreshFailed,
        pending.startedAt,
      );
    } catch (error) {
      reportPluginOperationFailure(
        {
          kind: PluginKind.EXTENSION,
          action: PluginOperationAction.INSTALL,
          label: pending.displayName,
        },
        {
          message: error instanceof Error ? error.message : i18nService.t('extensionImportFailed'),
          elapsedMs: Date.now() - pending.startedAt,
        },
      );
    } finally {
      importOperation.current?.finish();
      importOperation.current = null;
      setImporting(false);
    }
  };

  const handleSaveConfiguration = async () => {
    if (
      !selectedExtension ||
      extensionActionBusy ||
      selectedExtension.management?.configure.allowed === false
    ) return;
    const values = Object.fromEntries(
      selectedExtension.configurationFields.flatMap(field => {
        const textField = !field.sensitive && field.type === 'string';
        const draft = configurationValues[field.path];
        if (textField && draft === undefined) return [];
        const value =
          draft ??
          (!field.sensitive && isNumericConfigurationField(field)
            ? String(field.value ?? field.defaultValue ?? '')
            : '');
        if (!textField && !value.trim()) return [];
        const variable = getConfigurationVariable(field, configurationVariables);
        return [[variable ? `env.vars.${variable}` : field.path, value]];
      }),
    );
    if (Object.keys(values).length === 0) {
      setConfigurationError(i18nService.t('extensionConfigurationValueRequired'));
      return;
    }
    const generation = detailGeneration.current;
    const isCurrentDetail = () =>
      inventoryMounted.current && generation === detailGeneration.current;
    const operation = startPluginOperation({
      kind: PluginKind.EXTENSION,
      action: PluginOperationAction.SAVE,
      label: selectedExtension.name,
    });
    try {
      setSavingConfiguration(true);
      setConfigurationError('');
      setConfigurationSaved(false);
      setConfigurationPending(false);
      const result = await window.electron.extensions.updateConfiguration(
        {
          extensionId: selectedExtension.id,
          values,
        },
        operation.context,
      );
      if (!result.success) {
        operation.fail(
          pluginOperationFailure(result, i18nService.t('extensionConfigurationSaveFailed')),
        );
        throw new Error(result.error || i18nService.t('extensionConfigurationSaveFailed'));
      }
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      const latestExtensions = await loadExtensions({ reportFailure: false });
      if (!latestExtensions || result.refreshWarning) {
        operation.fail(pluginOperationRefreshFailure(result));
        return;
      }
      if (!isCurrentDetail()) return;
      const updatedExtension = latestExtensions?.find(item => item.id === selectedExtension.id);
      if (updatedExtension) {
        setSelectedExtension(current =>
          current?.id === updatedExtension.id ? updatedExtension : current,
        );
      }
      setConfigurationValues({});
      setConfigurationSaved(true);
      setConfigurationPending(result.pending === true);
    } catch (error) {
      operation.fail({
        message:
          error instanceof Error
            ? pluginOperationErrorMessage(error.message)
            : i18nService.t('extensionConfigurationSaveFailed'),
      });
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      if (!(await loadExtensions({ reportFailure: false })))
        operation.fail(pluginOperationRefreshFailure());
    } finally {
      setSavingConfiguration(false);
      operation.finish();
    }
  };

  const handleOpenExtensionFolder = async (extension: InstalledOpenClawExtension) => {
    if (!extension.installPath) return;
    setConfigurationError('');
    const result = await window.electron.shell.openPath(extension.installPath);
    if (!result.success) {
      const error = result.error || i18nService.t('extensionOpenFolderFailed');
      if (selectedExtension?.id === extension.id) {
        setConfigurationError(error);
      } else {
        setActionOutcome({
          type: 'error',
          title: i18nService.t('extensionOpenFolderFailed'),
          message: error,
        });
      }
    }
  };

  const getExtensionGroupLabel = (groupId: ExtensionGroupId): string =>
    i18nService.t(`extensionGroup.${groupId}.label`);
  const importExtensionAction = (
    <Tooltip content={i18nService.t('importExtensionTooltip')} position="bottom">
      <button
        type="button"
        onClick={() => setImportPickerOpen(true)}
        disabled={extensionActionBusy}
        className={`flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground ${
          extensionActionBusy ? 'cursor-not-allowed opacity-50' : ''
        }`}
      >
        <ArrowUpTrayIcon className="h-4 w-4" />
        <span>
          {importing ? i18nService.t('importExtensionProgress') : i18nService.t('importExtension')}
        </span>
      </button>
    </Tooltip>
  );

  const renderInstalledCard = (extension: InstalledOpenClawExtension, visualIndex: number) => {
    const canToggle = canToggleExtension(extension);
    const artworkTone = getPluginArtworkTone(`extensions:${extension.origin}`, visualIndex);
    return (
      <article
        key={extension.id}
        onClick={() => openExtensionDetails(extension, artworkTone)}
        className="group relative flex min-h-16 min-w-0 cursor-pointer flex-col rounded-xl px-2 py-2 transition-colors hover:bg-surface-raised focus-within:bg-surface-raised"
      >
        <button
          type="button"
          className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label={`${i18nService.t('subtaskShowInfo')}: ${extension.name}`}
          onClick={event => {
            event.stopPropagation();
            openExtensionDetails(extension, artworkTone);
          }}
        />
        <div className="pointer-events-none relative z-10 flex items-center justify-between gap-2 [&_button]:pointer-events-auto">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${artworkTone}`}
            >
              <PuzzleIcon className="h-4 w-4" />
            </div>
            <h3 className="truncate text-sm font-medium text-foreground">{extension.name}</h3>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <InstalledMarketplaceAction
              controller={marketplace}
              id={extension.id}
              disabled={extensionActionBusy}
            />
            {extension.id === OpenClawExtensionId.AGENT_TEAM && agentTeamEnabled && (
              <>
                <button
                  type="button"
                  className="pointer-events-auto rounded-lg p-1.5 text-secondary hover:bg-surface-raised"
                  aria-label={i18nService.t('teamAllRecords')}
                  title={i18nService.t('teamAllRecords')}
                  onClick={event => {
                    event.stopPropagation();
                    openTeamRecords();
                  }}
                >
                  <ClockIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="pointer-events-auto rounded-lg p-1.5 text-secondary hover:bg-surface-raised"
                  aria-label={i18nService.t('agentTeamSettings')}
                  title={i18nService.t('agentTeamSettings')}
                  onClick={event => {
                    event.stopPropagation();
                    setTeamSettingsOpen(true);
                  }}
                >
                  <Cog6ToothIcon className="h-4 w-4" />
                </button>
              </>
            )}
            {(extension.id === OpenClawExtensionId.STT_LOCAL_CLI ||
              extension.id === LOCAL_TTS_PROVIDER_ID) && (
              <LocalSpeechExtensionSettingsButton
                kind={
                  extension.id === OpenClawExtensionId.STT_LOCAL_CLI
                    ? LocalSpeechModelKind.Asr
                    : LocalSpeechModelKind.Tts
                }
                name={extension.name}
                disabled={extensionActionBusy}
                onOpen={() => {
                  setSpeechSettingsKind(
                    extension.id === OpenClawExtensionId.STT_LOCAL_CLI
                      ? LocalSpeechModelKind.Asr
                      : LocalSpeechModelKind.Tts,
                  );
                }}
              />
            )}
            {canToggle ? (
              <ExtensionToggle
                extension={extension}
                canToggle
                pending={togglingExtensionId === extension.id}
                busy={extensionActionBusy || Boolean(marketplace.operationFor(extension.id)?.busy)}
                onToggle={() => void handleToggleExtension(extension)}
              />
            ) : (
              <PluginLockedIndicator
                checked={extension.enabled}
                label={getExtensionManagementLabel(extension)}
              />
            )}
            {extension.error ? (
              <Tooltip
                content={extension.error}
                position="bottom"
                maxWidth="360px"
                className="pointer-events-auto"
                renderInPortal
                dismissOnClick
              >
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-red-500 focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label={extension.error}
                  onClick={event => {
                    event.stopPropagation();
                    openExtensionDetails(extension, artworkTone);
                  }}
                >
                  <ExclamationTriangleIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            ) : extension.missingRequirements.length > 0 ||
              extension.state === ExtensionState.NEEDS_SETUP ? (
              <Tooltip
                content={i18nService.t('extensionMissingConfiguration')}
                position="top"
                className="pointer-events-auto"
                renderInPortal
                dismissOnClick
              >
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-amber-600 dark:text-amber-400 focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label={i18nService.t('extensionMissingConfiguration')}
                  onClick={event => {
                    event.stopPropagation();
                    openExtensionDetails(extension, artworkTone);
                  }}
                >
                  <ExclamationTriangleIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="pointer-events-none relative z-10 ml-10 min-w-0 pr-2">
          {extension.description && (
            <Tooltip
              content={extension.description}
              position="bottom"
              maxWidth="360px"
              className="pointer-events-auto block w-full"
              renderInPortal
            >
              <p className="truncate text-xs text-secondary">{extension.description}</p>
            </Tooltip>
          )}
        </div>
        <MarketplaceFeedback controller={marketplace} id={extension.id} />
      </article>
    );
  };

  return (
    <div className="space-y-4">
      <MarketplaceToolbar
        controller={marketplace}
        hasLocalMatches={filteredExtensions.length > 0}
      />
      {visibility !== 'available' &&
        (marketplace.filter !== MarketplaceFilter.UPDATES ||
          marketplace.updateById.size > 0 ||
          marketplace.recentlyUpdated.size > 0) && (
          <section className="space-y-4">
            <div className="space-y-4">
              {sharedSearchQuery === undefined && (
                <div className="relative min-w-0 sm:max-w-md">
                  <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                  <input
                    type="text"
                    placeholder={i18nService.t('searchExtensions')}
                    value={searchQuery}
                    onChange={event => setLocalSearchQuery(event.target.value)}
                    className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              )}

              {loadingExtensions ? (
                <div className="py-10 text-center text-sm text-secondary">
                  {i18nService.t('loading')}
                </div>
              ) : filteredExtensions.length === 0 && searchQuery.trim() ? null : (
                <div className="space-y-5">
                  {displayExtensionGroups.map(group => (
                    <PluginGroupSection
                      hideHeader={Boolean(searchQuery.trim())}
                      key={group.id}
                      title={getExtensionGroupLabel(group.id)}
                      count={group.extensions.length}
                      action={
                        group.id === ExtensionGroupId.USER ? importExtensionAction : undefined
                      }
                      collapsible={group.id === ExtensionGroupId.SYSTEM}
                      defaultExpanded={group.id !== ExtensionGroupId.SYSTEM}
                      forceExpanded={Boolean(searchQuery.trim())}
                    >
                      {group.extensions.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-secondary">
                          {i18nService.t('noExtensionsInstalled')}
                        </p>
                      ) : (
                        <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4">
                          {group.extensions.map(renderInstalledCard)}
                        </div>
                      )}
                    </PluginGroupSection>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

      {visibility !== 'installed' && (
        <section className={searchQuery.trim() ? '' : 'border-t border-border pt-6'}>
          <MarketplaceResults
            hasLocalMatches={filteredExtensions.length > 0}
            controller={marketplace}
            icon={<PuzzleIcon className="h-4 w-4" />}
            renderInstalled={(id, index) => {
              const entry = extensions.find(item => item.id === id);
              return entry ? renderInstalledCard(entry, index) : null;
            }}
          />
        </section>
      )}

      {agentTeamEnabled && teamSettingsOpen && (
        <AgentTeamSettingsDialog
          onClose={() => setTeamSettingsOpen(false)}
          onOpenRuntime={onOpenRuntime}
        />
      )}
      {speechSettingsKind && (
        <LocalSpeechExtensionSettingsDialog
          kind={speechSettingsKind}
          onClose={() => setSpeechSettingsKind(null)}
          onManageModels={onManageSpeechModels}
          hidden={!isActive}
        />
      )}
      {importPickerOpen &&
        createPortal(
          <Modal
            onClose={() => setImportPickerOpen(false)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('importExtension')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('selectExtensionSourceDescription')}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleImportExtensions('folders')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <FolderIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectExtensionFolders')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectExtensionFoldersDescription')}
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleImportExtensions('archives')}
                className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-surface-raised"
              >
                <ArchiveBoxIcon className="h-5 w-5 text-primary" />
                <div className="mt-2 text-sm font-medium text-foreground">
                  {i18nService.t('selectExtensionArchives')}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {i18nService.t('selectExtensionArchivesDescription')}
                </div>
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      {selectedExtension &&
        createPortal(
          <Modal
            onClose={() => {
              if (!savingConfiguration) closeExtensionDetails();
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className={PLUGIN_DETAIL_MODAL_CLASS_NAME}
          >
            <PluginDetailHeader
              title={selectedExtension.name}
              version={selectedExtension.version}
              icon={<PuzzleIcon className="h-5 w-5" />}
              artworkTone={detailArtworkTone}
              onClose={closeExtensionDetails}
              busy={savingConfiguration}
            />
            <div className={PLUGIN_DETAIL_BODY_CLASS_NAME}>
              {selectedExtension.description && (
                <PluginMarkdownDescription
                  className="text-[13px] leading-relaxed"
                  content={selectedExtension.description}
                />
              )}

              {!canToggleExtension(selectedExtension) && (
                <div className="mt-3 rounded-xl bg-surface-raised px-3 py-2 text-xs text-secondary">
                  {getExtensionManagementLabel(selectedExtension)}
                </div>
              )}

              <div className="space-y-4">
                {selectedExtension.error && (
                  <div
                    role="alert"
                    className="mb-4 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500"
                  >
                    {selectedExtension.error}
                  </div>
                )}
                {(selectedExtension.missingRequirements.length > 0 ||
                  selectedExtension.state === ExtensionState.NEEDS_SETUP) && (
                  <div className="mb-4 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{i18nService.t('extensionMissingConfiguration')}</span>
                  </div>
                )}
                {selectedExtension.configurationFields.length > 0 &&
                  (selectedExtension.management?.configure.allowed ?? true) && (
                    <div className="space-y-5">
                      {selectedExtension.configurationFields.map(field => {
                        const label = field.labelKey ? i18nService.t(field.labelKey) : field.label;
                        const help = field.helpKey ? i18nService.t(field.helpKey) : field.help;
                        const variable = getConfigurationVariable(field, configurationVariables);
                        const configured =
                          variable && field.configuredEnvironmentVariables
                            ? field.configuredEnvironmentVariables.includes(variable)
                            : field.configured;
                        const inherited = Boolean(
                          variable && field.inheritedEnvironmentVariables?.includes(variable),
                        );
                        const numeric = isNumericConfigurationField(field);
                        const required = Boolean(field.requirement || field.required);
                        return (
                          <div
                            key={field.path}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3"
                          >
                            <div className="flex min-w-0 items-center justify-end gap-1 text-right text-xs font-medium text-foreground">
                              {field.environmentVariables &&
                              field.environmentVariables.length > 1 ? (
                                <div className="relative min-w-0 flex-1">
                                  <select
                                    aria-label={i18nService.t(
                                      'extensionConfigurationCredentialType',
                                    )}
                                    title={variable}
                                    value={variable}
                                    disabled={savingConfiguration}
                                    onChange={event => {
                                      setConfigurationVariables(current => ({
                                        ...current,
                                        [field.path]: event.target.value,
                                      }));
                                      setConfigurationValues(current => ({
                                        ...current,
                                        [field.path]: '',
                                      }));
                                      setConfigurationSaved(false);
                                      setConfigurationError('');
                                    }}
                                    className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-2 pr-7 text-[11px] text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-[var(--justdo-primary-muted)] disabled:opacity-60"
                                  >
                                    {field.environmentVariables.map(name => (
                                      <option key={name} value={name}>
                                        {name}
                                      </option>
                                    ))}
                                  </select>
                                  <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary" />
                                </div>
                              ) : (
                                <label
                                  htmlFor={`extension-config-${field.path}`}
                                  className="min-w-0 leading-5 [overflow-wrap:anywhere]"
                                  title={field.requirement || field.label}
                                >
                                  {label}
                                </label>
                              )}
                              {required && !configured && (
                                <span aria-hidden="true" className="leading-5 text-red-500">
                                  *
                                </span>
                              )}
                              {help && (
                                <Tooltip
                                  content={help}
                                  position="bottom"
                                  maxWidth="320px"
                                  className="mt-0.5 shrink-0"
                                  renderInPortal
                                >
                                  <button
                                    type="button"
                                    aria-label={help}
                                    className="rounded text-secondary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                  >
                                    <QuestionMarkCircleIcon className="h-3.5 w-3.5" />
                                  </button>
                                </Tooltip>
                              )}
                            </div>
                            <div className="min-w-0">
                              <input
                                id={`extension-config-${field.path}`}
                                aria-label={variable || label}
                                type={field.sensitive ? 'password' : numeric ? 'number' : 'text'}
                                min={numeric ? field.minimum : undefined}
                                max={numeric ? field.maximum : undefined}
                                step={field.type === 'integer' ? 1 : undefined}
                                value={
                                  configurationValues[field.path] ??
                                  (field.sensitive
                                    ? ''
                                    : String(field.value ?? field.defaultValue ?? ''))
                                }
                                onChange={event => {
                                  setConfigurationSaved(false);
                                  setConfigurationValues(current => ({
                                    ...current,
                                    [field.path]: event.target.value,
                                  }));
                                }}
                                disabled={savingConfiguration || inherited}
                                required={required && !configured}
                                autoComplete={field.sensitive ? 'new-password' : 'off'}
                                spellCheck={false}
                                placeholder={i18nService.t(
                                  inherited
                                    ? 'extensionConfigurationInherited'
                                    : configured
                                      ? 'extensionConfigurationStored'
                                      : field.sensitive
                                        ? 'extensionConfigurationEnterSecret'
                                        : 'extensionConfigurationEnterValue',
                                )}
                                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder-secondary transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-[var(--justdo-primary-muted)] disabled:opacity-60"
                              />
                              {inherited && (
                                <p className="mt-1.5 text-xs text-secondary">
                                  {i18nService.t('extensionConfigurationInheritedHelp')}
                                </p>
                              )}
                              {!inherited &&
                                Boolean(field.inheritedEnvironmentVariables?.length) && (
                                  <p className="mt-1.5 text-xs text-secondary">
                                    {i18nService.t('extensionConfigurationInheritedAlternatives')}
                                  </p>
                                )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                {selectedExtension.configurationFields.length > 0 &&
                  selectedExtension.management?.configure.allowed === false &&
                  canToggleExtension(selectedExtension) && (
                    <div className="rounded-xl bg-surface-raised px-3 py-2 text-xs text-secondary">
                      {i18nService.t('pluginManagedActionUnavailable')}
                    </div>
                  )}

                {configurationError && (
                  <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
                    {configurationError}
                  </div>
                )}
                {configurationSaved && (
                  <p role="status" className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
                    {i18nService.t(
                      configurationPending
                        ? 'extensionConfigurationPending'
                        : 'extensionConfigurationSaved',
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className={PLUGIN_DETAIL_FOOTER_CLASS_NAME + ' justify-between'}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {selectedExtension.installPath &&
                  (selectedExtension.management?.revealInFolder.allowed ?? true) && (
                    <Tooltip content={i18nService.t('openFolder')} position="top">
                      <button
                        type="button"
                        onClick={() => void handleOpenExtensionFolder(selectedExtension)}
                        disabled={savingConfiguration || extensionActionBusy}
                        className="rounded-lg p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                        aria-label={i18nService.t('openFolder')}
                      >
                        <FolderIcon className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  )}
                {selectedExtension.id === OpenClawExtensionId.AGENT_TEAM && agentTeamEnabled && (
                  <>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-primary hover:bg-surface-raised"
                      onClick={() => {
                        closeExtensionDetails();
                        openTeamRecords();
                      }}
                    >
                      <ClockIcon aria-hidden="true" className="h-4 w-4" />
                      {i18nService.t('teamAllRecords')}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-2 text-sm text-primary hover:bg-surface-raised"
                      onClick={() => {
                        closeExtensionDetails();
                        setTeamSettingsOpen(true);
                      }}
                    >
                      {i18nService.t('agentTeamSettings')}
                    </button>
                  </>
                )}
                {(selectedExtension.management?.remove.allowed ??
                  selectedExtension.removable === true) && (
                  <Tooltip content={i18nService.t('extensionDelete')} position="top">
                    <button
                      type="button"
                      onClick={() => {
                        const extension = selectedExtension;
                        closeExtensionDetails();
                        setPendingDelete(extension);
                      }}
                      disabled={savingConfiguration || extensionActionBusy}
                      className="rounded-lg p-2 text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={i18nService.t('extensionDelete')}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeExtensionDetails}
                  disabled={savingConfiguration}
                  className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {i18nService.t('cancel')}
                </button>
                {selectedExtension.configurationFields.length > 0 &&
                  (selectedExtension.management?.configure.allowed ?? true) && (
                    <button
                      type="button"
                      onClick={() => void handleSaveConfiguration()}
                      disabled={savingConfiguration}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {i18nService.t(savingConfiguration ? 'saving' : 'save')}
                    </button>
                  )}
              </div>
            </div>
          </Modal>,
          document.body,
        )}

      {pendingDelete &&
        createPortal(
          <Modal
            onClose={() => {
              if (!deletingExtensionId) setPendingDelete(null);
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="text-lg font-semibold text-foreground">
              {i18nService.t('extensionDelete')}
            </div>
            <p className="mt-2 text-sm text-secondary">
              {i18nService.t('extensionDeleteConfirm').replace('{name}', pendingDelete.name)}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deletingExtensionId !== null}
                className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deletingExtensionId !== null}
                aria-busy={deletingExtensionId !== null || undefined}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deletingExtensionId && (
                  <ArrowPathIcon aria-hidden="true" className="h-4 w-4 animate-spin" />
                )}
                <span role={deletingExtensionId ? 'status' : undefined}>
                  {deletingExtensionId
                    ? i18nService.t('extensionDeleting')
                    : i18nService.t('delete')}
                </span>
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      {pendingCapabilityReview &&
        createPortal(
          <Modal
            onClose={cancelCapabilityReview}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
              {i18nService.t('extensionCapabilityReviewTitle')}
            </div>
            <p className="mt-2 text-sm leading-5 text-secondary">
              {i18nService
                .t('extensionCapabilityReviewDescription')
                .replace(
                  '{name}',
                  pendingCapabilityReview.kind === 'toggle'
                    ? pendingCapabilityReview.extension.name
                    : pendingCapabilityReview.displayName,
                )}
            </p>
            {pendingCapabilityReview.review.source && (
              <div className="mt-4 rounded-xl border border-border bg-background p-3 text-xs">
                <div className="font-semibold text-foreground">
                  {i18nService.t('extensionCapabilitySource')}
                </div>
                <div className="mt-1 break-all text-secondary">
                  {[
                    pendingCapabilityReview.review.source.kind,
                    pendingCapabilityReview.review.source.spec ||
                      pendingCapabilityReview.review.source.packageName,
                  ]
                    .filter(Boolean)
                    .join(': ')}
                </div>
                {pendingCapabilityReview.review.source.integrity && (
                  <div className="mt-2 break-all text-secondary">
                    {i18nService.t('extensionCapabilityIntegrity')}:{' '}
                    <code>{pendingCapabilityReview.review.source.integrity}</code>
                  </div>
                )}
              </div>
            )}
            {Object.values(pendingCapabilityReview.review.widened ?? {}).flat().length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  {i18nService.t('extensionCapabilityWidened')}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.values(pendingCapabilityReview.review.widened ?? {})
                    .flat()
                    .map((item, index) => (
                      <code
                        key={`${item}:${index}`}
                        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-foreground"
                      >
                        {item}
                      </code>
                    ))}
                </div>
              </div>
            )}
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">
                {i18nService.t('extensionCapabilityDeclared')}
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-border bg-background p-3">
                <div className="flex flex-wrap gap-1.5">
                  {Object.values(pendingCapabilityReview.review.declared)
                    .flat()
                    .map((item, index) => (
                      <code
                        key={`${item}:${index}`}
                        className="rounded-md bg-surface-raised px-2 py-1 text-xs text-foreground"
                      >
                        {item}
                      </code>
                    ))}
                  {Object.values(pendingCapabilityReview.review.declared).flat().length === 0 && (
                    <span className="text-xs text-secondary">
                      {i18nService.t('extensionCapabilityNone')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-border bg-background p-3 text-xs text-secondary">
              <div className="font-semibold text-foreground">
                {i18nService.t('extensionCapabilityGrants')}
              </div>
              <div className="mt-2 space-y-1 break-all">
                <div>
                  {i18nService.t('extensionCapabilityPromptInjection')}:{' '}
                  {i18nService.t(
                    pendingCapabilityReview.review.grants.hooks.allowPromptInjection.effective
                      ? 'extensionCapabilityAllowed'
                      : 'extensionCapabilityDenied',
                  )}
                </div>
                <div>
                  {i18nService.t('extensionCapabilityConversationAccess')}:{' '}
                  {i18nService.t(
                    pendingCapabilityReview.review.grants.hooks.allowConversationAccess.effective
                      ? 'extensionCapabilityAllowed'
                      : 'extensionCapabilityDenied',
                  )}
                </div>
                {pendingCapabilityReview.review.grants.llm && (
                  <div>LLM: {JSON.stringify(pendingCapabilityReview.review.grants.llm)}</div>
                )}
                {pendingCapabilityReview.review.grants.subagent && (
                  <div>
                    Subagent: {JSON.stringify(pendingCapabilityReview.review.grants.subagent)}
                  </div>
                )}
              </div>
            </div>
            {pendingCapabilityReview.review.trust && (
              <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <div>
                  {i18nService.t('extensionCapabilityTrust')}:{' '}
                  {pendingCapabilityReview.review.trust.disposition}
                </div>
                {pendingCapabilityReview.review.trust.reasons?.length
                  ? pendingCapabilityReview.review.trust.reasons.map(reason => (
                      <div key={reason} className="mt-1">
                        {reason}
                      </div>
                    ))
                  : null}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelCapabilityReview}
                className="rounded-lg px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface-raised"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingCapabilityReview;
                  setPendingCapabilityReview(null);
                  if (pending.kind === 'toggle') {
                    void handleToggleExtension(pending.extension, pending.review.reviewToken);
                  } else {
                    void handleConfirmImportCapability(pending);
                  }
                }}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
              >
                {i18nService.t('extensionCapabilityAccept')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      <OperationResultModal result={actionOutcome} onClose={() => setActionOutcome(null)} />
    </div>
  );
};

export default ExtensionsManager;
