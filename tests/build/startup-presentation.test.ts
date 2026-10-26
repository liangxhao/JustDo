import path from 'node:path';
import fs from 'node:fs';

import { expect, test } from 'vitest';

import { startupPresentationPlugin } from '../../scripts/build/startupPresentationPlugin.mjs';
import { AppInitializationActivity } from '../../src/shared/app/initialization';
import { RendererStartupActivity } from '../../src/renderer/app/shell/startup/routing/startupPresentation';
import { initializationTranslations } from '../../src/renderer/services/i18n/initializationTranslations';
import { startupTranslations } from '../../src/renderer/services/i18n/startupTranslations';

test('embeds local startup assets and both languages without touching other HTML entries', () => {
  const transform = startupPresentationPlugin(path.resolve('src/renderer')).transformIndexHtml.handler;
  const otherEntry = '<html><body>preview</body></html>';
  expect(transform(otherEntry)).toBe(otherEntry);
  const result = transform('<style>%STARTUP_STYLES%</style><script>const copy = %STARTUP_TRANSLATIONS%;</script><h1>%STARTUP_COPY_startupHeading%</h1><template>%FIRST_LAUNCH_DOCUMENT%</template><template>%STARTUP_DOCUMENT%</template>');
  expect(result).not.toContain('%STARTUP_');
  expect(result).toContain('.startup-screen');
  expect(result).toContain(startupTranslations.zh.startupHeading);
  expect(result).toContain(startupTranslations.en.startupHeading);
  expect(result).toContain('data-startup-view="first-launch"');
  expect(result).toContain('data-startup-view="launch"');
  expect(result).toContain(initializationTranslations.zh.firstLaunchTitle);
  expect(result).not.toContain('%FIRST_LAUNCH_DOCUMENT%');
  expect(result).not.toMatch(/(?:src|href)=["']https?:/u);
});

test('every published startup activity has matching operation and description translations', () => {
  const startupKeys = [
    ...Object.values(AppInitializationActivity).map(activity => `startupActivity_${activity}`),
    ...Object.values(RendererStartupActivity).map(activity => `startupRenderer_${activity}`),
  ];
  for (const language of ['zh', 'en'] as const) {
    const dictionary: Record<string, string> = startupTranslations[language];
    for (const key of startupKeys) {
      expect(dictionary[key], `${language}: ${key}`).toBeTruthy();
      expect(dictionary[`${key}Description`], `${language}: ${key}Description`).toBeTruthy();
    }
    const guide: Record<string, string> = initializationTranslations[language];
    for (const activity of Object.values(AppInitializationActivity)) {
      expect(guide[`initializationActivity_${activity}`]).toBeTruthy();
      expect(guide[`initializationActivity_${activity}Description`]).toBeTruthy();
    }
    for (const activity of Object.values(RendererStartupActivity)) {
      expect(guide[`initializationRenderer_${activity}`]).toBeTruthy();
      expect(guide[`initializationRenderer_${activity}Description`]).toBeTruthy();
    }
  }
});

test('embeds the route-neutral first paint without application scripts or external resources', () => {
  const transform = startupPresentationPlugin(path.resolve('src/renderer')).transformIndexHtml.handler;
  const result = transform(fs.readFileSync('src/renderer/startup-bootstrap.html', 'utf8'));
  expect(result).toContain('data:image/png;base64,');
  expect(result).toContain(startupTranslations.zh.startupBootstrap);
  expect(result).toContain(startupTranslations.en.startupBootstrap);
  expect(result).not.toContain('%STARTUP_');
  expect(result).not.toMatch(/(?:src|href)=["'](?:https?:|[^"']+\.(?:js|css))/u);
  expect(result).not.toContain('window.electron');
});

test('paints the bundled logo in every static startup route without another image request', () => {
  const transform = startupPresentationPlugin(path.resolve('src/renderer')).transformIndexHtml.handler;
  const logo = fs.readFileSync('resources/icons/logo.png');
  for (const [entry, expectedImages] of [['index.html', 2], ['startup-bootstrap.html', 1]] as const) {
    const result = transform(fs.readFileSync(path.join('src/renderer', entry), 'utf8'));
    const images = [...result.matchAll(/<img\b[^>]*>/gu)].map(match => match[0]);
    expect(images, entry).toHaveLength(expectedImages);
    for (const image of images) {
      const source = /\bsrc="data:image\/png;base64,([^"]+)"/u.exec(image)?.[1];
      expect(source, `${entry}: logo must be embedded before modules run`).toBeTruthy();
      expect(Buffer.from(source!, 'base64').equals(logo), `${entry}: bundled logo bytes`).toBe(true);
      expect(image).toContain('loading="eager"');
      expect(image).toContain('decoding="sync"');
    }
  }
});
