import type { WorkspaceWindowBounds } from '../../../shared/cowork/workspaceWindow';

export const isWorkspaceWindowBounds = (value: unknown): value is WorkspaceWindowBounds => {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as WorkspaceWindowBounds;
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
};

export const fitWorkspaceWindowBounds = (
  requested: WorkspaceWindowBounds,
  workAreas: readonly WorkspaceWindowBounds[],
): WorkspaceWindowBounds => {
  const intersection = (candidate: WorkspaceWindowBounds): number =>
    Math.max(
      0,
      Math.min(requested.x + requested.width, candidate.x + candidate.width) -
        Math.max(requested.x, candidate.x),
    ) *
    Math.max(
      0,
      Math.min(requested.y + requested.height, candidate.y + candidate.height) -
        Math.max(requested.y, candidate.y),
    );
  const distance = (candidate: WorkspaceWindowBounds): number =>
    Math.max(
      candidate.x - requested.x - requested.width,
      requested.x - candidate.x - candidate.width,
      0,
    ) **
      2 +
    Math.max(
      candidate.y - requested.y - requested.height,
      requested.y - candidate.y - candidate.height,
      0,
    ) **
      2;
  const area = workAreas.reduce<WorkspaceWindowBounds | undefined>(
    (best, candidate) =>
      !best ||
      intersection(candidate) > intersection(best) ||
      (intersection(candidate) === intersection(best) && distance(candidate) < distance(best))
        ? candidate
        : best,
    undefined,
  );
  if (!area) return requested;
  const width = Math.min(Math.max(480, requested.width), area.width);
  const height = Math.min(Math.max(320, requested.height), area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(requested.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(requested.y, area.y + area.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
};

export const clipWorkspaceViewBounds = (
  requested: WorkspaceWindowBounds,
  content: { width: number; height: number },
  zoom: number,
): WorkspaceWindowBounds => {
  const x = Math.max(0, Math.round(requested.x * zoom));
  const y = Math.max(0, Math.round(requested.y * zoom));
  return {
    x,
    y,
    width: Math.max(
      0,
      Math.min(Math.round((requested.x + requested.width) * zoom), content.width) - x,
    ),
    height: Math.max(
      0,
      Math.min(Math.round((requested.y + requested.height) * zoom), content.height) - y,
    ),
  };
};
