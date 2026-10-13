export const SwarmWorkflowMode = { Auto: 'auto', Research: 'research', Review: 'review' } as const;
export type SwarmWorkflowOptions = {
  mode: (typeof SwarmWorkflowMode)[keyof typeof SwarmWorkflowMode];
  verify: boolean;
};
export const isSwarmWorkflowOptions = (value: unknown): value is SwarmWorkflowOptions => {
  if (!value || typeof value !== 'object') return false;
  const options = value as Record<string, unknown>;
  return (
    Object.values(SwarmWorkflowMode).includes(options.mode as SwarmWorkflowOptions['mode']) &&
    typeof options.verify === 'boolean' &&
    Object.keys(options).every(key => key === 'mode' || key === 'verify')
  );
};
