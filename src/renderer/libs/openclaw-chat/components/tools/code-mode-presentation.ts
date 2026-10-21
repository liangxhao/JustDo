// Detect the native OpenClaw exec({ code }) contract, never shell exec({ command }).
// Do not infer code from command text: command is also a native shell surface.
export function getCodeModeSource(name: string, input: unknown): string | null {
  if (name !== 'exec' || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const code = (input as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

export function getCodeModeTitle(name: string, input: unknown): string | null {
  if (getCodeModeSource(name, input) === null) return null;
  const title = (input as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}
