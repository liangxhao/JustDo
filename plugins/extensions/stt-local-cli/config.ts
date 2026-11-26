import path from 'node:path';

export type TranscriptionConfig = {
  mode: 'local';
  command: string;
  args: string[];
  modelId: string;
  language: string;
};

export function readLocalConfig(value: unknown): TranscriptionConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<TranscriptionConfig>;
  if (
    config.mode !== 'local' ||
    typeof config.command !== 'string' ||
    !path.isAbsolute(config.command) ||
    !Array.isArray(config.args) ||
    !config.args.every(arg => typeof arg === 'string') ||
    typeof config.modelId !== 'string' ||
    typeof config.language !== 'string'
  )
    return null;
  return config as TranscriptionConfig;
}
