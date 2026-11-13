function normalizeBrowserAuthenticationExecutable(value: unknown): string {
  const executable = typeof value === 'string' ? value.trim() : null;
  if (executable === '') return '';
  if (
    !executable ||
    !/^[a-z]{1,64}\.exe$/i.test(executable) ||
    /^(con|prn|aux|nul)\.exe$/i.test(executable)
  ) {
    throw new Error(
      'Browser authentication executableName must be a non-reserved Windows filename with 1–64 ASCII letters followed by .exe.',
    );
  }
  return executable.toLowerCase();
}

export function resolveBrowserAuthenticationConfig(config: {
  executableName: string;
  localEndpoint: string;
}) {
  const executableName = normalizeBrowserAuthenticationExecutable(config.executableName);
  const localEndpoint = URL.parse(config.localEndpoint);
  if (
    localEndpoint?.protocol !== 'https:' ||
    localEndpoint.hostname !== 'localhost' ||
    localEndpoint.href !== localEndpoint.origin + localEndpoint.pathname ||
    localEndpoint.port === '0'
  ) throw new Error('Browser authentication localEndpoint must be an HTTPS localhost URL without credentials, query, or fragment.');
  return { executableName, localEndpoint };
}
