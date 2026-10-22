export const hasComposerContent = (
  text: string,
  attachmentCount: number,
  annotationCount: number,
  hasRecording: boolean,
  requiresText = false,
  quoteCount = 0,
): boolean =>
  Boolean(
    text.trim() ||
    (!requiresText && (attachmentCount || annotationCount || hasRecording || quoteCount)),
  );
