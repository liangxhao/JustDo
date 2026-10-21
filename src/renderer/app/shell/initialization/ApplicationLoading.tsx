import { useContext, useEffect } from 'react';

import { i18nService } from '@/services/i18n';

import { InitializationContext, type RendererStartupActivity } from './startupPresentation';

/** The gate owns the single visible startup screen, including renderer work. */
export default function ApplicationLoading({ activity }: { activity: RendererStartupActivity }) {
  const context = useContext(InitializationContext);
  const active = context?.active;
  const controller = context?.controller;
  useEffect(() => {
    if (active) controller?.reportActivity(activity);
  }, [active, activity, controller]);
  if (active) return null;
  return (
    <div role="status" className="flex flex-1 items-center justify-center text-sm text-secondary">
      {i18nService.t(`startupRenderer_${activity}`)}
    </div>
  );
}

export function useInitialWorkspaceReadiness(ready: boolean, error: string | null): void {
  const context = useContext(InitializationContext);
  const active = context?.active;
  const controller = context?.controller;
  useEffect(() => {
    if (!active) return;
    if (error) controller?.fail(error);
    else if (ready) controller?.complete();
  }, [active, controller, error, ready]);
}

export function useInitializationFailure(error: string | null): void {
  const context = useContext(InitializationContext);
  const active = context?.active;
  const controller = context?.controller;
  useEffect(() => {
    if (active && error) controller?.fail(error);
  }, [active, controller, error]);
}
