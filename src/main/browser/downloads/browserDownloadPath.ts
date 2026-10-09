import fs from 'fs';
import path from 'path';

export const resolveBrowserDownloadDirectory = (
  configuredDirectory: string,
  systemDownloadsDirectory: string,
): string => {
  if (!configuredDirectory || !path.isAbsolute(configuredDirectory)) {
    return systemDownloadsDirectory;
  }
  try {
    return fs.statSync(configuredDirectory).isDirectory()
      ? configuredDirectory
      : systemDownloadsDirectory;
  } catch {
    return systemDownloadsDirectory;
  }
};

export const resolveAvailableBrowserDownloadPath = (
  directory: string,
  suggestedName: string,
  unavailable: (candidate: string) => boolean = candidate => fs.existsSync(candidate),
): string => {
  const safeName = path.basename(suggestedName) || 'download';
  const extension = path.extname(safeName);
  const baseName = safeName.slice(0, safeName.length - extension.length) || 'download';
  let candidate = path.join(directory, safeName);
  for (let suffix = 1; unavailable(candidate); suffix += 1) {
    candidate = path.join(directory, `${baseName} (${suffix})${extension}`);
  }
  return candidate;
};
