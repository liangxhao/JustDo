import { PluginOperationAction, PluginOperationStage } from '@shared/plugins/pluginOperation';

import { i18nService } from '@/services/i18n';

import {
  isPluginOperationRecoveryPending,
  type PluginOperationFailure,
  PluginOperationFailureState,
} from './pluginOperationService';

type FailureContext = Pick<
  PluginOperationFailure,
  | 'action'
  | 'state'
  | 'failedStage'
  | 'operationUnconfirmed'
  | 'installSourceInUse'
  | 'mutationCompleted'
  | 'runtimeRecoveryPending'
>;
type PresentationContext = FailureContext & Pick<PluginOperationFailure, 'items'>;

const guidanceByStage: Partial<Record<PluginOperationStage, string>> = {
  [PluginOperationStage.FETCHING_METADATA]: 'connection',
  [PluginOperationStage.DOWNLOADING]: 'connection',
  [PluginOperationStage.EXTRACTING]: 'package',
  [PluginOperationStage.CONVERTING]: 'package',
  [PluginOperationStage.VALIDATING]: 'package',
  [PluginOperationStage.INSTALLING]: 'dependencies',
  [PluginOperationStage.INSTALLING_DEPENDENCIES]: 'dependencies',
  [PluginOperationStage.PREPARING_RUNTIME]: 'runtime',
  [PluginOperationStage.RESTARTING_GATEWAY]: 'runtime',
  [PluginOperationStage.ENABLING]: 'enable',
  [PluginOperationStage.SAVING_CONFIGURATION]: 'configuration',
  [PluginOperationStage.APPLYING_CONFIGURATION]: 'configuration',
  [PluginOperationStage.DISABLING]: 'status',
  [PluginOperationStage.UNINSTALLING]: 'status',
  [PluginOperationStage.CONFIRMING]: 'status',
  [PluginOperationStage.REFRESHING_INVENTORY]: 'status',
  [PluginOperationStage.CLEANING_UP]: 'recovery',
  [PluginOperationStage.ROLLING_BACK]: 'recovery',
};

const removalFollowupGuidanceByStage: Partial<Record<PluginOperationStage, string>> = {
  [PluginOperationStage.PREPARING_RUNTIME]: 'removalRuntime',
  [PluginOperationStage.RESTARTING_GATEWAY]: 'removalRuntime',
  [PluginOperationStage.APPLYING_CONFIGURATION]: 'removalPolicy',
  [PluginOperationStage.SAVING_CONFIGURATION]: 'removalConfiguration',
};

export const pluginOperationNeedsConfirmation = (
  operation: Pick<FailureContext, 'state' | 'operationUnconfirmed' | 'installSourceInUse'>,
) =>
  operation.state === PluginOperationFailureState.UNCONFIRMED ||
  operation.operationUnconfirmed === true ||
  operation.installSourceInUse === true;

const operationGuidanceKey = (operation: FailureContext) => {
  let guidance = operation.failedStage ? guidanceByStage[operation.failedStage] : undefined;
  if (operation.action === PluginOperationAction.REMOVE) {
    if (operation.state === PluginOperationFailureState.REFRESH_FAILED && operation.failedStage) {
      guidance = removalFollowupGuidanceByStage[operation.failedStage] ?? guidance;
    } else if (
      operation.state === PluginOperationFailureState.FAILED &&
      operation.failedStage === PluginOperationStage.UNINSTALLING
    ) {
      guidance = 'removal';
    }
  }
  // Closing/removing a plugin must never recommend enabling it as a repair.
  if (
    (operation.action === PluginOperationAction.DISABLE ||
      operation.action === PluginOperationAction.REMOVE) &&
    (guidance === 'enable' || guidance === 'configuration')
  )
    guidance = 'status';
  return guidance ?? (operation.failedStage ? 'support' : 'missingStage');
};

export function pluginOperationFailureGuidance(operation: FailureContext): string {
  if (pluginOperationNeedsConfirmation(operation)) {
    return i18nService.t('pluginOperationFailureNext.unconfirmed');
  }
  const next = i18nService.t(`pluginOperationFailureGuidance.${operationGuidanceKey(operation)}`);
  return operation.state === PluginOperationFailureState.COMMITTED
    ? `${next} ${i18nService.t('pluginOperationFailureGuidance.saved')}`
    : next;
}

export const pluginOperationHasPendingRecovery = isPluginOperationRecoveryPending;

export function pluginOperationFailurePresentation(operation: PresentationContext) {
  if (pluginOperationHasPendingRecovery(operation)) {
    return {
      title: i18nService.t(`pluginOperationCompleted.${operation.action}`),
      guidance: i18nService.t('pluginOperationRecoveryPendingNext'),
      nextStep: i18nService.t('pluginOperationRecoveryPendingNext'),
    };
  }
  if ((operation.items?.length ?? 0) > 1) {
    return {
      title: i18nService.t('pluginOperationFailureTitle.batch'),
      guidance: i18nService.t('pluginOperationFailureGuidance.batch'),
      nextStep: i18nService.t('pluginOperationFailureShortNext.batch'),
    };
  }
  let titleKey = `pluginOperationFailureTitle.${operation.state}`;
  if (
    pluginOperationNeedsConfirmation(operation) &&
    (operation.state !== PluginOperationFailureState.COMMITTED ||
      operation.action === PluginOperationAction.REMOVE)
  ) {
    titleKey = 'pluginOperationFailureTitle.unconfirmed';
  } else if (operation.state === PluginOperationFailureState.COMMITTED) {
    if (
      operation.action === PluginOperationAction.INSTALL ||
      operation.action === PluginOperationAction.UPDATE
    ) {
      titleKey = `pluginOperationFailureTitle.${operation.action}.${
        operation.mutationCompleted && !pluginOperationNeedsConfirmation(operation)
          ? 'completed'
          : 'committed'
      }`;
    }
  } else if (operation.state === PluginOperationFailureState.REFRESH_FAILED) {
    if (
      operation.mutationCompleted &&
      (operation.action === PluginOperationAction.INSTALL ||
        operation.action === PluginOperationAction.UPDATE)
    ) {
      titleKey = `pluginOperationFailureTitle.${operation.action}.completed`;
    } else if (
      (operation.action === PluginOperationAction.ENABLE ||
        operation.action === PluginOperationAction.DISABLE) &&
      operation.failedStage === PluginOperationStage.CONFIRMING
    )
      titleKey = `pluginOperationFailureTitle.${operation.action}.followup_failed`;
    else if (
      operation.action === PluginOperationAction.REMOVE &&
      (operation.failedStage === PluginOperationStage.PREPARING_RUNTIME ||
        operation.failedStage === PluginOperationStage.RESTARTING_GATEWAY)
    ) {
      titleKey = 'pluginOperationFailureTitle.remove.recovery_failed';
    } else if (
      operation.action === PluginOperationAction.REMOVE &&
      (operation.failedStage === PluginOperationStage.APPLYING_CONFIGURATION ||
        operation.failedStage === PluginOperationStage.SAVING_CONFIGURATION ||
        operation.failedStage === PluginOperationStage.CONFIRMING)
    ) {
      titleKey = 'pluginOperationFailureTitle.remove.followup_failed';
    }
  } else if (operation.state === PluginOperationFailureState.FAILED) {
    titleKey =
      operation.action === PluginOperationAction.SYNC &&
      operation.failedStage === PluginOperationStage.REFRESHING_INVENTORY
        ? 'pluginOperationFailureTitle.refresh'
        : `pluginOperationFailureTitle.${operation.action}`;
  }
  const problem = pluginOperationNeedsConfirmation(operation)
    ? i18nService.t('pluginOperationFailureProblem.unconfirmed')
    : !operation.failedStage
      ? i18nService.t('pluginOperationFailureProblem.missingStage')
      : operation.failedStage === PluginOperationStage.CONFIRMING
        ? i18nService.t('pluginOperationFailureProblem.confirming')
        : i18nService
            .t('pluginOperationFailureProblem.stage')
            .replace(
              '{stage}',
              i18nService.t(`pluginOperationStageLabel.${operation.failedStage}`),
            );
  return {
    title: i18nService.t(titleKey).replace('{problem}', problem),
    guidance: pluginOperationFailureGuidance(operation),
    nextStep: i18nService.t(
      `pluginOperationFailureShortNext.${
        pluginOperationNeedsConfirmation(operation)
          ? 'unconfirmed'
          : operationGuidanceKey(operation)
      }`,
    ),
  };
}
