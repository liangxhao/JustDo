import {
  readGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from 'openclaw/plugin-sdk/media-generation-runtime';
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from 'openclaw/plugin-sdk/provider-http';
import { fetchWithSsrFGuard } from 'openclaw/plugin-sdk/ssrf-runtime';
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from 'openclaw/plugin-sdk/video-generation';

export const PROVIDER_ID = 'video-openai';
const LABEL = 'Video generation';
const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const PENDING_STATUSES = new Set(['queued', 'in_progress']);
const OPTIONS = {
  fps: 'number',
  num_frames: 'number',
  num_inference_steps: 'number',
  guidance_scale: 'number',
  seed: 'number',
  negative_prompt: 'string',
} as const;

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Video service URL is required.');
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid video service URL.');
  return url.toString().replace(/\/+$/, '');
}

function buildForm(req: VideoGenerationRequest): FormData {
  if (!req.model?.trim() || !req.prompt?.trim())
    throw new Error('Video model and prompt are required.');
  if ((req.inputVideos?.length ?? 0) || (req.inputAudios?.length ?? 0))
    throw new Error('This video adapter does not support video or audio references.');
  if ((req.inputImages?.length ?? 0) > 1)
    throw new Error('This video adapter supports one reference image.');
  if (req.audio === true || req.watermark !== undefined || req.aspectRatio || req.resolution)
    throw new Error(
      'This video adapter accepts size; audio, watermark, aspect ratio and resolution are unsupported.',
    );
  const body = new FormData();
  body.set('model', req.model);
  body.set('prompt', req.prompt);
  if (req.durationSeconds !== undefined) {
    if (!Number.isFinite(req.durationSeconds) || req.durationSeconds <= 0)
      throw new Error('Invalid video duration.');
    body.set('seconds', String(req.durationSeconds));
  }
  if (req.size) {
    if (!/^[1-9]\d*x[1-9]\d*$/.test(req.size)) throw new Error('Invalid video size.');
    body.set('size', req.size);
  }
  for (const [key, value] of Object.entries(req.providerOptions ?? {})) {
    const type = OPTIONS[key as keyof typeof OPTIONS];
    if (!type || typeof value !== type || (type === 'number' && !Number.isFinite(value)))
      throw new Error('Invalid video provider option.');
    body.set(key, String(value));
  }
  const image = req.inputImages?.[0];
  if (image) {
    if (image.role && image.role !== 'first_frame' && image.role !== 'reference_image')
      throw new Error('Unsupported video reference image role.');
    if (!image.buffer?.length || image.buffer.length > MAX_REFERENCE_BYTES)
      throw new Error('Video reference image must contain at most 20 MiB of image data.');
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    };
    const extension = extensions[image.mimeType ?? ''];
    if (!extension) throw new Error('Video reference image must be PNG, JPEG or WebP.');
    body.set(
      'input_reference',
      new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
      'reference.' + extension,
    );
  }
  return body;
}

function readJob(
  value: Record<string, unknown>,
  expectedId?: string,
): { id: string; complete: boolean } {
  if (
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId)
  )
    throw new Error('Video service returned an invalid job ID.');
  if (value.status === 'completed') return { id: value.id, complete: true };
  if (value.status === 'failed' || value.status === 'cancelled' || value.status === 'canceled')
    throw new Error('Video generation job ' + value.status + '.');
  if (typeof value.status !== 'string' || !PENDING_STATUSES.has(value.status))
    throw new Error('Video service returned an unsupported job status.');
  return { id: value.id, complete: false };
}

export function buildIntranetVideoProvider(): VideoGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: LABEL,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // Model IDs are supplied by Settings, with no vendor catalog or public-service defaults.
    isConfigured: ({ cfg }) => {
      try {
        validateBaseUrl(cfg?.models?.providers?.[PROVIDER_ID]?.baseUrl);
        return true;
      } catch {
        return false;
      }
    },
    capabilities: {
      maxVideos: 1,
      supportsSize: true,
      providerOptions: OPTIONS,
      imageToVideo: { enabled: true, maxInputImages: 1, supportsSize: true },
      videoToVideo: { enabled: false },
      maxInputAudios: 0,
    },
    async generateVideo(req) {
      const config = req.cfg.models?.providers?.[PROVIDER_ID];
      const base = validateBaseUrl(config?.baseUrl);
      const body = buildForm(req);
      if (config?.apiKey !== undefined && typeof config.apiKey !== 'string')
        throw new Error('Video service credential has not been resolved.');
      const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
      const http = resolveProviderHttpRequestConfig({
        provider: PROVIDER_ID,
        capability: 'video',
        transport: 'http',
        baseUrl: base,
        defaultBaseUrl: base,
        defaultHeaders: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
        request: sanitizeConfiguredModelProviderRequest(config?.request),
      });
      http.headers.delete('content-type');
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        label: LABEL,
      });
      const timeoutMs = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const readOptions = { timeoutMs, requestHeaders: http.headers };
      const errorOptions = { bodyTimeoutMs: timeoutMs, requestHeaders: http.headers };
      const send = (url: string, method: 'GET' | 'POST', body?: FormData) =>
        fetchWithSsrFGuard({
          url,
          fetchImpl: fetch,
          init: { method, headers: http.headers, ...(body ? { body } : {}) },
          timeoutMs: timeoutMs(),
          policy: { allowPrivateNetwork: http.allowPrivateNetwork },
          dispatcherPolicy: http.dispatcherPolicy,
          mode: 'strict',
          maxRedirects: 0,
        });
      // No submission retry: a network failure may already have created a job.
      const submitted = await send(http.baseUrl + '/videos', 'POST', body);
      let job;
      try {
        await assertOkOrThrowHttpError(
          submitted.response,
          LABEL + ' submission failed',
          errorOptions,
        );
        job = readJob(await readProviderJsonObjectResponse(submitted.response, LABEL, readOptions));
      } finally {
        await submitted.release();
      }
      const jobUrl = http.baseUrl + '/videos/' + encodeURIComponent(job.id);
      while (!job.complete) {
        const polled = await send(jobUrl, 'GET');
        try {
          await assertOkOrThrowHttpError(
            polled.response,
            LABEL + ' status request failed',
            errorOptions,
          );
          job = readJob(
            await readProviderJsonObjectResponse(polled.response, LABEL, readOptions),
            job.id,
          );
        } finally {
          await polled.release();
        }
        if (!job.complete)
          await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
      }
      const content = await send(jobUrl + '/content', 'GET');
      try {
        await assertOkOrThrowHttpError(content.response, LABEL + ' download failed', errorOptions);
        const asset = await readGeneratedVideoAsset(content.response, {
          label: LABEL,
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, 'video'),
          validateBinaryResponse: true,
          readOptions,
        });
        return { videos: [asset], model: req.model };
      } finally {
        await content.release();
      }
    },
  };
}
