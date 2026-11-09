/** Plain per-render preferences, with no application or native authority. */
export interface AppMessagePresentationContext {
  readonly language: 'zh' | 'en';
}

/** Pure installed-artifact display projections. This module receives no application ports. */
export interface AppHistoryPresentation {
  text?(source: string): string;
  /** Visible text only, after transport framing has been decoded. Never used for drafts. */
  displayText?(source: string, context?: AppMessagePresentationContext): string;
  replyMirror?(message: unknown): boolean;
  nativeInput?(message: unknown): { senderLabelKey: string; senderId: string } | undefined;
  translations?: { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> };
}

/** Export a value, never a register(host) callback or a retained business-epoch closure. */
export interface AppHistoryPresentationModule {
  presentation: AppHistoryPresentation;
}
