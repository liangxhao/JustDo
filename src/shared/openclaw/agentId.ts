// Version-locked to OpenClaw v2026.8.2 routing/session-key normalizeAgentId.
export const normalizeOpenClawAgentId = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'main';
  const normalized = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return normalized;
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || 'main'
  );
};
