import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { isSwarmWorkflowParentKey } from '../contracts/workflow';

export const managed = isSwarmWorkflowParentKey;
export const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const entry = (key: string) =>
  getSessionEntry({ sessionKey: key, readConsistency: 'latest' }) as
    Record<string, unknown> | undefined;
export const inPlanMode = (value: Record<string, unknown> | undefined): boolean => {
  const extensions = value?.pluginExtensions;
  const plan = object(extensions) ? extensions['plan-mode'] : undefined;
  return object(plan) && object(plan.state) && plan.state.enabled === true;
};
