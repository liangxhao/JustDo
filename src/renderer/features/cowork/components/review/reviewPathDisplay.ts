export function isReviewExecutionPath(filePath: string) {
  return filePath.split('/').includes('.agent-tasks');
}

/** Native Git reads can return directory entries, including nested repositories. */
export function describeReviewPath(filePath: string) {
  // Git uses forward slashes on every platform; backslashes may be literal filename characters.
  const isDirectory = filePath.endsWith('/');
  const path = filePath.replace(/\/+$/, '');
  const separator = path.lastIndexOf('/');
  return {
    name: path.slice(separator + 1),
    directory: separator >= 0 ? path.slice(0, separator) : '',
    isDirectory,
  };
}
