export const isLocalAudioAttachment = (path: string): boolean =>
  /\.(mp3|wav|m4a|aac|ogg|flac|opus|webm|mp4|mov|mkv)$/iu.test(path);
