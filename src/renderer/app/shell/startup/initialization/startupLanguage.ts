/** Bundled copy is immediately usable even if the locale bridge is slow/unavailable. */
export async function resolveStartupLanguage(
  readLocale: () => Promise<string>,
): Promise<'zh' | 'en'> {
  const fallback = () =>
    navigator.language.toLowerCase().startsWith('zh') ? ('zh' as const) : ('en' as const);
  let timer: number | undefined;
  try {
    const locale = await Promise.race([
      readLocale(),
      new Promise<string>(resolve => {
        timer = window.setTimeout(() => resolve(navigator.language), 1000);
      }),
    ]);
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return fallback();
  } finally {
    window.clearTimeout(timer);
  }
}
