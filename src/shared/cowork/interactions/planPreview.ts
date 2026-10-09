import { OpenClawToolName } from '../../plugins/nativeIds';

export const COWORK_PLAN_PREVIEW_EVENT = 'cowork:preview-plan';

export interface CoworkPlanPreview {
  sourceId: string;
  plan: string;
  title?: string;
}

export function isPresentPlanToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === OpenClawToolName.PRESENT_PLAN.toLowerCase();
}

export function extractPresentPlanPreview(
  toolName: string,
  input: unknown,
  sourceId: string,
): CoworkPlanPreview | null {
  if (!isPresentPlanToolName(toolName)) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  if (typeof record.plan !== 'string') return null;
  const plan = record.plan.trim();
  if (!plan) return null;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  return {
    sourceId,
    plan,
    ...(title ? { title } : {}),
  };
}

export function isCoworkPlanPreview(value: unknown): value is CoworkPlanPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sourceId === 'string' &&
    Boolean(record.sourceId.trim()) &&
    typeof record.plan === 'string' &&
    Boolean(record.plan.trim()) &&
    (record.title === undefined || typeof record.title === 'string')
  );
}
