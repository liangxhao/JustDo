export const MessageFileLinkSourceKind = {
  NativePath: 'native-path',
  FileUrl: 'file-url',
  MarkdownUri: 'markdown-uri',
} as const;

export type MessageFileLinkSourceKind =
  (typeof MessageFileLinkSourceKind)[keyof typeof MessageFileLinkSourceKind];

/** The source kind determines the sole URI-to-native-path conversion boundary. */
export interface MessageFileLinkTarget {
  sourceKind: MessageFileLinkSourceKind;
  target: string;
  navigationSuffix?: string;
}

export interface PrepareMessageFileLinkRequest extends MessageFileLinkTarget {
  workspaceSessionId?: string;
  expectedProjectRoot?: string;
}

export const MessageFileLinkPreparationError = {
  InvalidTarget: 'invalid-target',
  MissingSource: 'missing-source',
  SourceChanged: 'source-changed',
  NotFound: 'not-found',
  NotRegularFile: 'not-regular-file',
  Unavailable: 'unavailable',
  Failed: 'failed',
} as const;

export type MessageFileLinkPreparationError =
  (typeof MessageFileLinkPreparationError)[keyof typeof MessageFileLinkPreparationError];

export type PrepareMessageFileLinkResult =
  | { success: true; filePath: string; navigationSuffix?: string }
  | { success: false; error: MessageFileLinkPreparationError };

const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maxLength &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);

export const isMessageFileLinkTarget = (value: unknown): value is MessageFileLinkTarget => {
  if (!value || typeof value !== 'object') return false;
  const target = value as MessageFileLinkTarget;
  return (
    Object.values(MessageFileLinkSourceKind).includes(target.sourceKind) &&
    isBoundedText(target.target, 32_768) &&
    (target.navigationSuffix === undefined ||
      (typeof target.navigationSuffix === 'string' &&
        target.navigationSuffix.length <= 8192 &&
        (target.navigationSuffix === '' || /^[?#]/u.test(target.navigationSuffix)) &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(target.navigationSuffix)))
  );
};

export const isPrepareMessageFileLinkRequest = (
  value: unknown,
): value is PrepareMessageFileLinkRequest => {
  if (!isMessageFileLinkTarget(value)) return false;
  const request = value as PrepareMessageFileLinkRequest;
  return (
    (request.workspaceSessionId === undefined || isBoundedText(request.workspaceSessionId, 512)) &&
    (request.expectedProjectRoot === undefined ||
      isBoundedText(request.expectedProjectRoot, 32_768))
  );
};
