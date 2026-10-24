import '../index.css';
import '@/app/shell/startup/initialization/StartupScreen.css';
import '@/app/shell/startup/initialization/FirstLaunchGuide.css';
import '@/app/shell/startup/initialization/StartupDiagnostics.css';

import { installPreviewBridge, parsePreviewOptions } from './state';

async function main() {
  const options = parsePreviewOptions(window.location.search);
  installPreviewBridge(
    window,
    import.meta.env.DEV,
    options,
    action => window.dispatchEvent(new CustomEvent('startup-preview-action', { detail: action })),
    Date.now(),
    () => (document.documentElement.lang === 'en' ? 'en' : 'zh'),
  );
  // Install the deliberately powerless fixture before importing actual startup components.
  const [{ createRoot }, { default: Preview }, { i18nService }] = await Promise.all([
    import('react-dom/client'),
    import('./Preview'),
    import('@/services/i18n'),
  ]);
  i18nService.setLanguage(options.language, { persist: false });
  const root = document.getElementById('root');
  if (!root) throw new Error('Startup preview root is missing.');
  createRoot(root).render(<Preview options={options} />);
}

void main().catch(error => {
  const root = document.getElementById('root');
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
});
