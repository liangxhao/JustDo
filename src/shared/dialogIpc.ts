export const DialogIpc = {
  SaveTextFile: 'dialog:saveTextFile',
} as const;

export interface SaveTextFileOptions {
  title?: string;
  defaultFileName: string;
  content: string;
  filters?: { name: string; extensions: string[] }[];
}

export const SaveTextFileErrorCode = {
  MissingContent: 'missing_content',
  FileTooLarge: 'file_too_large',
  SaveFailed: 'save_failed',
} as const;

export type SaveTextFileErrorCode =
  (typeof SaveTextFileErrorCode)[keyof typeof SaveTextFileErrorCode];

export interface SaveTextFileResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  errorCode?: SaveTextFileErrorCode;
}
