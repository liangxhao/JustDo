import { LightBulbIcon } from '@heroicons/react/24/outline';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import type { ComposerFeatureRegistration } from './composerFeatures';

export function usePlanModeComposerFeature({
  sessionId,
  enabled,
  disabled,
  runActive,
}: {
  sessionId?: string;
  enabled: boolean;
  disabled: boolean;
  runActive: boolean;
}): ComposerFeatureRegistration {
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const featureDisabled = isSaving || (!enabled && (disabled || runActive));

  const toggle = async () => {
    if (featureDisabled || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      if (!(await coworkService.setPlanMode(sessionId, !enabled))) {
        throw new Error('Plan mode update failed');
      }
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('planModeSaveFailed'),
        }),
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return {
    id: OpenClawExtensionId.PLAN_MODE,
    label: i18nService.t('planModeTitle'),
    description: i18nService.t(
      !enabled && runActive ? 'planModeRunningHint' : 'planModeDescription',
    ),
    icon: <LightBulbIcon className="h-4 w-4" />,
    selected: enabled,
    disabled: featureDisabled,
    onSelect: () => void toggle(),
  };
}
