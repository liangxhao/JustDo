/** Pure installed-artifact display projections. This module receives no application ports. */
export interface AppHistoryPresentation {
  text?(source: string): string;
  replyMirror?(message: unknown): boolean;
  nativeInput?(message: unknown): { senderLabelKey: string; senderId: string } | undefined;
  translations?: { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> };
}

/** Export a value, never a register(host) callback or a retained business-epoch closure. */
export interface AppHistoryPresentationModule {
  presentation: AppHistoryPresentation;
}
