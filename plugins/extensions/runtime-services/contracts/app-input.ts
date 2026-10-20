const OPEN = '\n\n<app-plugin-input>\n';
const CLOSE = '\n</app-plugin-input>';
export interface AppInput {
  v: 1;
  pluginId: string;
  epoch: string;
  mode: string;
  prompt: string;
  input?: unknown;
}
/** Display/intent data only. Main and native instance guards own admission. */
export function readAppInput(text: string): { display: string; input: AppInput } | undefined {
  if (!text.endsWith(CLOSE) || text.length > 4 * 1024 * 1024) return undefined;
  const offset = text.lastIndexOf(OPEN);
  if (offset < 0) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(offset + OPEN.length, -CLOSE.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as AppInput;
    if (
      !['epoch,mode,pluginId,prompt,v', 'epoch,input,mode,pluginId,prompt,v'].includes(
        Object.keys(input).sort().join(','),
      ) ||
      input.v !== 1 ||
      typeof input.pluginId !== 'string' ||
      !/^[a-z][a-z0-9-]{0,95}$/u.test(input.pluginId) ||
      typeof input.mode !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,96}$/u.test(input.mode) ||
      typeof input.epoch !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,96}$/u.test(input.epoch) ||
      typeof input.prompt !== 'string'
    )
      return undefined;
    return { display: text.slice(0, offset), input };
  } catch {
    return undefined;
  }
}
export const stripAppInput = (text: string): string => readAppInput(text)?.display ?? text;
export const unwrapAppInput = (text: string): string => readAppInput(text)?.input.prompt ?? text;
export const appendAppInput = (display: string, input: AppInput): string =>
  display + OPEN + JSON.stringify(input) + CLOSE;
