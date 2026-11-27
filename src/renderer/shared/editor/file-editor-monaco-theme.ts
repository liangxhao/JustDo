// Monaco holds one palette per renderer runtime, including editors in its portals.
const fileEditors = new Set<symbol>();
const listeners = new Set<() => void>();

function notifyThemeUseChanged(): void {
  for (const listener of listeners) listener();
}

export function retainFileEditorMonacoTheme(): () => void {
  const editor = Symbol();
  fileEditors.add(editor);
  if (fileEditors.size === 1) notifyThemeUseChanged();
  return () => {
    if (fileEditors.delete(editor) && !fileEditors.size) notifyThemeUseChanged();
  };
}

export function isFileEditorMonacoThemeInUse(): boolean {
  return fileEditors.size > 0;
}

export function observeFileEditorMonacoTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
