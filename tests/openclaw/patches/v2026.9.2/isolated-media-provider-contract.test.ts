import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.9.2/021-isolated-openai-compatible-media-providers.cjs') as {
  __testing: { MARKER: string; transform: (content: string, filePath: string) => string };
};

const temporaryRoots: string[] = [];

const pluginFixture = `
//#region extensions/openai/index.ts
var openai_default = definePluginEntry({
\tregister(api) {
\t\tapi.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
\t\tapi.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
\t\tapi.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());
\t}
});
//#endregion
export { openai_default as default };
`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('isolated OpenAI-compatible media provider runtime patch', () => {
  it('is exact-shape idempotent and rejects partial state', () => {
    const transformed = patch.__testing.transform(pluginFixture, 'openai/index.js');
    expect(transformed).toContain(patch.__testing.MARKER);
    expect(patch.__testing.transform(transformed, 'openai/index.js')).toBe(transformed);
    expect(() =>
      patch.__testing.transform(
        transformed.replace(
          'JUSTDO_IMAGE_CONFIG_PROVIDER_ID',
          'JUSTDO_IMAGE_CONFIG_PROVIDER_ID_BROKEN',
        ),
        'openai/index.js',
      ),
    ).toThrow(/historical, partial, or ambiguous/);
  });

  it('routes real image and video provider calls through independent cloned config views', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-isolated-media-provider-'));
    temporaryRoots.push(root);
    const transformed = patch.__testing.transform(pluginFixture, 'openai/index.js');
    const moduleSource = `
const definePluginEntry = value => value;
const openaiMediaUnderstandingProvider = {};
const buildOpenAIImageGenerationProvider = () => ({
  id: 'openai',
  isConfigured: ({ cfg }) => cfg.models.providers.openai.apiKey === 'image-key',
  generateImage: async req => ({ cfg: req.cfg })
});
const buildOpenAIVideoGenerationProvider = () => ({
  id: 'openai',
  isConfigured: ({ cfg }) => cfg.models.providers.openai.apiKey === 'video-key',
  generateVideo: async req => ({ cfg: req.cfg })
});
${transformed}
`;
    const modulePath = path.join(root, 'patched-openai.mjs');
    fs.writeFileSync(modulePath, moduleSource);
    const loaded = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    const imageProviders: Array<Record<string, unknown>> = [];
    const videoProviders: Array<Record<string, unknown>> = [];
    loaded.default.register({
      registerImageGenerationProvider: (provider: Record<string, unknown>) =>
        imageProviders.push(provider),
      registerMediaUnderstandingProvider: () => undefined,
      registerVideoGenerationProvider: (provider: Record<string, unknown>) =>
        videoProviders.push(provider),
    });

    const cfg = {
      models: {
        providers: {
          openai: { baseUrl: 'https://language.example/v1', apiKey: 'language-key' },
          'justdo-image-openai': { baseUrl: 'http://image.lan/v1', apiKey: 'image-key' },
          'justdo-video-openai': { baseUrl: 'http://video.lan/v1', apiKey: 'video-key' },
        },
      },
    };
    const image = imageProviders[0] as {
      id: string;
      isConfigured: (ctx: { cfg: typeof cfg }) => boolean;
      generateImage: (req: { cfg: typeof cfg }) => Promise<{ cfg: typeof cfg }>;
    };
    const video = videoProviders[0] as {
      id: string;
      isConfigured: (ctx: { cfg: typeof cfg }) => boolean;
      generateVideo: (req: { cfg: typeof cfg }) => Promise<{ cfg: typeof cfg }>;
    };

    // Keep the manifest-declared canonical IDs so prepared
    // image_generate/video_generate catalogs resolve the OpenAI plugin normally.
    expect(image.id).toBe('openai');
    expect(video.id).toBe('openai');
    expect(image.isConfigured({ cfg })).toBe(true);
    expect(video.isConfigured({ cfg })).toBe(true);
    const imageResult = await image.generateImage({ cfg });
    const videoResult = await video.generateVideo({ cfg });
    expect(imageResult.cfg.models.providers.openai).toEqual(
      cfg.models.providers['justdo-image-openai'],
    );
    expect(videoResult.cfg.models.providers.openai).toEqual(
      cfg.models.providers['justdo-video-openai'],
    );
    expect(cfg.models.providers.openai).toEqual({
      baseUrl: 'https://language.example/v1',
      apiKey: 'language-key',
    });
  });
});
