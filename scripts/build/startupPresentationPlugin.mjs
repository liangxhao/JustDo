import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

import { appTranslations } from '../../src/renderer/services/i18n/appTranslations.mts';
import { startupTranslations } from '../../src/renderer/services/i18n/startupTranslations.mts';
import { initializationTranslations } from '../../src/renderer/services/i18n/initializationTranslations.mts';
import { buildStartupAppearance } from '../theme/startupAppearance.mjs';

/** Embed the first paint so it works before any application modules can load. */
export function startupPresentationPlugin(rendererRoot) {
  const logo = 'data:image/png;base64,' + fs.readFileSync(
    path.join(rendererRoot, '../../resources/icons/logo.png'),
  ).toString('base64');
  const appearance = buildStartupAppearance(rendererRoot);
  const motion = buildSync({
    entryPoints: [path.join(rendererRoot, 'app/shell/startup/initialization/startupMotionBootstrap.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
  }).outputFiles[0].text.replaceAll('</script', '<\\/script');
  const dictionaries = Object.fromEntries(
    ['zh', 'en'].map(language => [
      language,
      Object.fromEntries(
        Object.entries({ ...appTranslations[language], ...startupTranslations[language], ...initializationTranslations[language] })
          .filter(([key]) => key.startsWith('startup') || key.startsWith('window') || key.startsWith('initialization') || key.startsWith('firstLaunch')),
      ),
    ]),
  );
  const failureBootstrap = buildSync({
    entryPoints: [path.join(rendererRoot, 'app/shell/startup/initialization/startupFailureBootstrap.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'startupFailureBootstrap',
    platform: 'browser',
    target: 'es2020',
    minify: true,
  }).outputFiles[0].text.replaceAll('</script', '<\\/script');
  return {
    name: 'startup-presentation-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.includes('%STARTUP_BOOTSTRAP_LOGO%')) {
          return html
            .replaceAll('%STARTUP_BOOTSTRAP_LOGO%', logo)
            .replaceAll('%STARTUP_TRANSLATIONS%', JSON.stringify(Object.fromEntries(
              ['zh', 'en'].map(language => [language, { startupBootstrap: dictionaries[language].startupBootstrap }]),
            )).replaceAll('<', '\\u003c'))
            .replace(/%STARTUP_COPY_(\w+)%/gu, (_, key) => dictionaries.en[key] ?? key);
        }
        if (!html.includes('%STARTUP_STYLES%')) return html;
        return html
          .replaceAll('%STARTUP_THEME_SCRIPT%', appearance.script)
          .replaceAll('%STARTUP_THEME_STYLES%', appearance.styles)
          .replaceAll('%STARTUP_MOTION_SCRIPT%', motion)
          .replaceAll('%STARTUP_FAILURE_SCRIPT%', failureBootstrap + '\nstartupFailureBootstrap.install(copy);')
          .replaceAll('%STARTUP_STYLES%', ['app/shell/startup/initialization/StartupScreen.css', 'app/shell/startup/initialization/FirstLaunchGuide.css', 'app/shell/startup/initialization/StartupDiagnostics.css'].map(file => fs.readFileSync(path.join(rendererRoot, file), 'utf8')).join('\n'))
          .replaceAll('%FIRST_LAUNCH_DOCUMENT%', fs.readFileSync(path.join(rendererRoot, 'app/shell/startup/initialization/firstLaunchDocument.html'), 'utf8'))
          .replaceAll('%STARTUP_DOCUMENT%', fs.readFileSync(path.join(rendererRoot, 'app/shell/startup/initialization/startupDocument.html'), 'utf8'))
          .replaceAll('%STARTUP_LOGO%', logo)
          .replaceAll('%STARTUP_TRANSLATIONS%', JSON.stringify(dictionaries).replaceAll('<', '\\u003c'))
          .replace(/%STARTUP_COPY_(\w+)%/gu, (_, key) => dictionaries.en[key] ?? key);
      },
    },
  };
}
