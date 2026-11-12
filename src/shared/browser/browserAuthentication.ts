export const BROWSER_AUTHENTICATION_SWITCH = '--browser-authentication-helper';

export function normalizeBrowserAuthenticationExecutable(value: unknown): string {
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
  providerOrigin: string;
  executableName: string;
}) {
  const provider = URL.parse(config.providerOrigin);
  const providerOrigin =
    provider?.protocol === 'https:' && provider.href === `${provider.origin}/`
      ? provider.origin
      : null;
  const executableName = normalizeBrowserAuthenticationExecutable(config.executableName);
  return { providerOrigin, executableName: providerOrigin ? executableName : '' };
}
