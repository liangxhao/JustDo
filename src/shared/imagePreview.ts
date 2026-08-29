export const ImagePreviewIpc = {
  Open: 'imagePreview:open',
  GetCurrent: 'imagePreview:getCurrent',
  SourceChanged: 'imagePreview:sourceChanged',
} as const;

export type ImagePreviewOpenRequest = {
  src: string;
  alt?: string;
};

export type ImagePreviewOpenResult = {
  success: boolean;
  error?: string;
};

export type ImagePreviewDocument = {
  src: string;
  alt: string;
  title: string;
};
