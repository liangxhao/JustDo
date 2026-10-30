// Explicit, optional test-fixture seams for an incompletely installed native
// source checkout. They are not Gateway mocks and provide no fallback behavior.
// This content-free routing proof must fail if it touches any of these branches.
function unavailable(): never { throw new Error('Native routing conformance touched an unavailable dependency.'); }
export const probeTreeClone = unavailable;
export const copyTree = unavailable;
export const createCloneSource = unavailable;
export const readCloneFileMetadata = unavailable;
export const sha256FileSync = unavailable;
export const sha256File = unavailable;
export const publishFileExclusive = unavailable;
export const syncDirectory = unavailable;
export const ensureDurableDirectory = unavailable;
export const isHardlinkFallbackError = unavailable;
export const pinDirectory = unavailable;
export const syncDirectoryBestEffort = unavailable;
export const syncDirectoryBestEffortSync = unavailable;
export const syncDirectorySync = unavailable;
export const moduleResolve = unavailable;
export const gfmTable = unavailable;
export const gfmTableFromMarkdown = unavailable;
