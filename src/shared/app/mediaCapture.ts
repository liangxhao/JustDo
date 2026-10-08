export const MediaCaptureIpc = {
  ArmSystemAudio: 'media-capture:arm-system-audio',
} as const;

export const MediaCaptureSurface = { Main: 'main', Workspace: 'workspace' } as const;
export type MediaCaptureSurface = (typeof MediaCaptureSurface)[keyof typeof MediaCaptureSurface];
