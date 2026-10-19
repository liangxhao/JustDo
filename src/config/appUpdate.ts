export type AppUpdateConfig = Readonly<{
  feedUrl: string;
  speechModels: Readonly<{
    path: string;
  }>;
  releaseHistory: Readonly<{
    maxBytes: number;
    maxEntries: number;
    maxReleaseDateLength: number;
    maxReleaseNotesLength: number;
  }>;
}>;

/** 部署方编辑此处，然后重启 Electron 开发进程或重新打包。 */
export const APP_UPDATE_CONFIG: AppUpdateConfig = Object.freeze({
  feedUrl: '',
  speechModels: Object.freeze({
    path: 'speech-models/v1',
  }),
  releaseHistory: Object.freeze({
    maxBytes: 1048576,
    maxEntries: 200,
    maxReleaseDateLength: 64,
    maxReleaseNotesLength: 100000,
  }),
});
