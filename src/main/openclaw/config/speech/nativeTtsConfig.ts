import { isRecord } from '../configShape';

/** Copy native TTS settings before managed provider/persona projection. */
export function normalizeNativeTtsConfig(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? structuredClone(value) : null;
}
