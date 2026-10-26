import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { OpenClawPluginApi, OpenClawPluginGatewayEvents } from 'openclaw/plugin-sdk/core';
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-store';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  type BrowserExecutionRun,
  type BrowserReleasedEvent,
  type BrowserRevokedEvent,
} from './browserExecutionContract.js';
import {
  BROWSER_CONTENT_NOTICE,
  BROWSER_PAGE_SOURCE_KIND,
  BROWSER_PAGE_SOURCE_PREFIX,
  readBrowserPageSource,
} from './browserPageSource.js';
import {
  type AdmittedBrowserCall,
  BrowserRunAdmission,
  isBrowserSessionCandidate,
} from './browserRunAdmission.js';
import {
  BrowserToolOutputSchema,
  BrowserToolSchema,
  describeEmbeddedBrowserTool,
} from './browserToolContract.js';

const TOOL_NAME = 'browser';
const RESOLVE_METHOD = 'embeddedBrowser.resolve';
const REQUEST_TIMEOUT_MS = 125_000;
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_MAX_BASE64_LENGTH = Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4 + 4;
const SCREENSHOT_SHARE_UNAVAILABLE =
  '[Screenshot sharing is unavailable because an outbound copy could not be prepared.]';

type BrowserCommand = Record<string, unknown>;
type BrowserResponse = { ok: true; result: unknown } | { ok: false; error: string };

type PendingRequest = {
  resolve: (response: BrowserResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionKey: string;
  run: BrowserExecutionRun;
  toolCallId: string;
  removeAbortListener?: () => void;
};

type GatewayEventEmitter = OpenClawPluginGatewayEvents['emit'];

const runtimeRequire = createRequire(import.meta.url);

const resolveDeviceDescriptor = (name: string): Record<string, unknown> | undefined => {
  try {
    const playwright = runtimeRequire('playwright-core') as {
      devices?: Record<string, Record<string, unknown>>;
    };
    const descriptor = playwright.devices?.[name];
    if (!descriptor) return undefined;
    const viewport = isRecord(descriptor.viewport) ? descriptor.viewport : null;
    const screen = isRecord(descriptor.screen) ? descriptor.screen : null;
    if (
      typeof descriptor.deviceScaleFactor !== 'number' ||
      typeof descriptor.isMobile !== 'boolean' ||
      typeof descriptor.hasTouch !== 'boolean' ||
      typeof descriptor.userAgent !== 'string' ||
      typeof viewport?.width !== 'number' ||
      typeof viewport.height !== 'number'
    ) {
      return undefined;
    }
    return {
      userAgent: descriptor.userAgent,
      viewport: { width: viewport.width, height: viewport.height },
      ...(typeof screen?.width === 'number' && typeof screen.height === 'number'
        ? { screen: { width: screen.width, height: screen.height } }
        : {}),
      deviceScaleFactor: descriptor.deviceScaleFactor,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
    };
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const formatScreenshotShareHint = (filePath: string): string =>
  `[Screenshot saved to ${JSON.stringify(filePath)}. A sanitized outbound copy is ready at this path for explicit sharing.]`;

const findScreenshotImage = (
  content: unknown[],
): { data: string; mimeType: 'image/png' | 'image/jpeg' } | undefined => {
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue;
    const mimeType = block.mimeType;
    const data = block.data;
    if (
      (mimeType !== 'image/png' && mimeType !== 'image/jpeg') ||
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length > SCREENSHOT_MAX_BASE64_LENGTH ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      continue;
    }
    return { data, mimeType };
  }
  return undefined;
};

const appendScreenshotShareHint = async (content: unknown[]): Promise<unknown[]> => {
  const image = findScreenshotImage(content);
  if (!image) return content;

  let shareHint = SCREENSHOT_SHARE_UNAVAILABLE;
  try {
    const buffer = Buffer.from(image.data, 'base64');
    if (buffer.length === 0 || buffer.length > SCREENSHOT_MAX_BYTES) {
      throw new Error('Screenshot exceeds the outbound media limit.');
    }
    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const saved = await saveMediaBuffer(
      buffer,
      image.mimeType,
      'outbound',
      SCREENSHOT_MAX_BYTES,
      `embedded-browser-screenshot.${extension}`,
    );
    shareHint = formatScreenshotShareHint(saved.path);
  } catch {
    // Private Agent observation remains useful when optional outbound staging fails.
  }
  return [...content, { type: 'text', text: shareHint }];
};

const neutralizeBrowserContent = (value: string): string =>
  value
    .replace(/\b(MEDIA|FILE)\s*:/giu, '$1\uFF1A')
    .replace(
      /<\|(?:im_start|im_end|endoftext|begin_of_text|end_of_text|start_header_id|end_header_id|eot_id|python_tag|eom_id|channel|message|return|call|reserved_special_token_\d+)\|>/gu,
      '[REMOVED_SPECIAL_TOKEN]',
    )
    .replace(
      /<<<(?:END_)?(?:EXTERNAL_)?UNTRUSTED_(?:BROWSER_)?CONTENT\b[^>]*>>>/giu,
      '[REMOVED_UNTRUSTED_BOUNDARY]',
    );

const wrapBrowserContent = (value: string): string => {
  const id = randomUUID().replaceAll('-', '').slice(0, 16);
  const sanitized = neutralizeBrowserContent(value);
  const bounded =
    sanitized.length > 50_000 ? `${sanitized.slice(0, 50_000)}\n[truncated]` : sanitized;
  return [
    `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
    BROWSER_CONTENT_NOTICE,
    bounded,
    `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`,
  ].join('\n');
};

const appendPageSource = (
  content: unknown[],
  details: Record<string, unknown>,
  action: unknown,
) => {
  if (
    details.ok !== true ||
    details.isError === true ||
    details.error ||
    details.closed === true ||
    details.download ||
    details.downloads ||
    (isRecord(details.aborted) && details.aborted.reason === 'closed') ||
    (Array.isArray(details.results) &&
      details.results.some(value => isRecord(value) && value.ok === false))
  )
    return content;
  const source = readBrowserPageSource({
    kind: BROWSER_PAGE_SOURCE_KIND,
    action,
    targetId: details.targetId,
    url: details.url,
    ...(typeof details.title === 'string'
      ? { title: neutralizeBrowserContent(details.title).trim().slice(0, 240) }
      : {}),
  });
  // Preserve literal URL characters through the existing media-directive
  // neutralizer. JSON decoding restores these colons without rewriting a URL.
  const sourceJson = source
    ? JSON.stringify(source).replace(/\b(MEDIA|FILE)(\s*):/giu, '$1$2\\u003a')
    : '';
  // Public history drops arbitrary details. The dedicated prefix distinguishes
  // this bounded reference from page text; its values remain explicitly untrusted.
  return source
    ? [
        ...content,
        {
          type: 'text',
          text: `${BROWSER_PAGE_SOURCE_PREFIX}${wrapBrowserContent(sourceJson)}`,
        },
      ]
    : content;
};

class EmbeddedBrowserRequestManager {
  private readonly pending = new Map<string, PendingRequest>();
  readonly admission = new BrowserRunAdmission(
    sessionKey => getSessionEntry({ sessionKey, readConsistency: 'latest' }),
    event => this.publishRelease(event),
    event => this.publishRevocation(event),
  );
  private removeAgentEventListener?: () => void;
  private gatewayEventEmitter: {
    owner: symbol;
    emit: GatewayEventEmitter;
    logger: OpenClawPluginApi['logger'];
  } | null = null;

  setGatewayEventEmitter(
    owner: symbol,
    emitter: GatewayEventEmitter,
    logger: OpenClawPluginApi['logger'],
    subscribe: OpenClawPluginApi['runtime']['events']['onAgentEvent'],
  ): void {
    if (this.gatewayEventEmitter) {
      this.clearGatewayEventEmitter(this.gatewayEventEmitter.owner);
    }
    this.gatewayEventEmitter = { owner, emit: emitter, logger };
    this.admission.activate();
    this.removeAgentEventListener = subscribe(event => {
      this.admission.observeLifecycle(event);
    });
  }

  clearGatewayEventEmitter(owner: symbol): void {
    if (this.gatewayEventEmitter?.owner !== owner) return;
    this.admission.revokeAll();
    this.cancelAll();
    this.removeAgentEventListener?.();
    this.removeAgentEventListener = undefined;
    try {
      // Includes conversation-owned pages whose original run already settled.
      // A retired registry's stop is ignored by the owner check above.
      this.gatewayEventEmitter.emit('stopped', {}, { scope: 'operator.read' });
    } catch (error) {
      this.gatewayEventEmitter.logger.warn(
        `[embedded-browser] failed to publish service stop: ${String(error)}`,
      );
    }
    this.gatewayEventEmitter = null;
  }

  request(
    call: AdmittedBrowserCall,
    command: BrowserCommand,
    policy: { allowLocalFiles: boolean },
    signal?: AbortSignal,
  ): Promise<BrowserResponse> {
    call.assertCurrent();
    signal?.throwIfAborted();
    const emitGatewayEvent = this.gatewayEventEmitter?.emit;
    if (!emitGatewayEvent) throw new Error('Gateway event delivery is unavailable.');

    const requestId = `browser_${randomUUID()}`;
    let resolveResponse!: (response: BrowserResponse) => void;
    const response = new Promise<BrowserResponse>(resolve => {
      resolveResponse = resolve;
    });
    const timeout = setTimeout(() => {
      this.cancel(requestId, {
        ok: false,
        error: 'The desktop browser did not respond within 125 seconds.',
      });
    }, REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    const { run, toolCallId } = call;
    const { sessionKey } = run;
    const pending: PendingRequest = {
      resolve: resolveResponse,
      timeout,
      sessionKey,
      run,
      toolCallId,
    };
    this.pending.set(requestId, pending);

    if (signal) {
      const handleAbort = () => {
        this.cancel(requestId, { ok: false, error: 'The browser request was cancelled.' });
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
    }

    try {
      call.assertCurrent();
      emitGatewayEvent(
        'requested',
        { requestId, sessionKey, run, toolCallId, command, policy },
        { scope: 'operator.read' },
      );
    } catch (error) {
      this.settle(requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return response;
  }

  resolve(requestId: string, response: BrowserResponse): void {
    if (!this.pending.has(requestId)) {
      throw new Error('The browser request is no longer pending.');
    }
    this.settle(requestId, response);
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId, {
        ok: false,
        error: 'The desktop browser service stopped before the request completed.',
      });
    }
  }

  private cancel(requestId: string, response: BrowserResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    try {
      this.gatewayEventEmitter?.emit(
        'cancelled',
        {
          requestId,
          sessionKey: pending.sessionKey,
          run: pending.run,
          toolCallId: pending.toolCallId,
        },
        { scope: 'operator.read' },
      );
    } catch (error) {
      this.gatewayEventEmitter?.logger.warn(
        `[embedded-browser] failed to publish cancellation: ${String(error)}`,
      );
    } finally {
      this.settle(requestId, response);
    }
  }

  private settle(requestId: string, response: BrowserResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    pending.resolve(response);
  }

  private cancelRunRequests(run: BrowserExecutionRun): void {
    for (const [requestId, request] of this.pending) {
      if (
        request.run.sessionKey === run.sessionKey &&
        request.run.sessionId === run.sessionId &&
        request.run.runId === run.runId
      )
        this.cancel(requestId, { ok: false, error: 'The native browser run is no longer active.' });
    }
  }

  private publishRevocation(event: BrowserRevokedEvent): void {
    // Tool signals also retire on successful native cleanup. Invalidate effects
    // immediately without turning that cleanup into a whole-run outcome.
    this.cancelRunRequests(event.run);
    try {
      this.gatewayEventEmitter?.emit('revoked', event, { scope: 'operator.read' });
    } catch (error) {
      this.gatewayEventEmitter?.logger.warn(
        `[embedded-browser] failed to publish effect revocation: ${String(error)}`,
      );
    }
  }

  private publishRelease(event: BrowserReleasedEvent): void {
    // Revoke pending transport before announcing resource cleanup. This is not
    // evidence that a cancelled Main operation has already drained.
    this.cancelRunRequests(event.run);
    try {
      this.gatewayEventEmitter?.emit('released', event, { scope: 'operator.read' });
    } catch (error) {
      this.gatewayEventEmitter?.logger.warn(
        `[embedded-browser] failed to publish resource release: ${String(error)}`,
      );
    }
  }
}

const SHARED_MANAGER_KEY = Symbol.for('embedded-browser.request-manager');

type EmbeddedBrowserGlobal = typeof globalThis & {
  [SHARED_MANAGER_KEY]?: EmbeddedBrowserRequestManager;
};

const getSharedManager = (): EmbeddedBrowserRequestManager => {
  const shared = globalThis as EmbeddedBrowserGlobal;
  shared[SHARED_MANAGER_KEY] ??= new EmbeddedBrowserRequestManager();
  return shared[SHARED_MANAGER_KEY];
};

const plugin = {
  id: 'embedded-browser',
  name: 'Embedded Browser',
  description: 'Controls the live desktop browser panel.',
  // The native provider is disabled while this plugin owns the browser tool.
  // Keep mode-controlled profile edits hot on the return trip to Chrome too;
  // plugins.entries changes replace the tools, hooks and services together.
  reload: {
    hotPrefixes: ['browser.profiles', 'browser.defaultProfile'],
  },
  register(api: OpenClawPluginApi) {
    // OpenClaw may register the Gateway service and a prepared per-run tool from
    // different plugin registry instances. Keep their request transport shared
    // within the Gateway process so every prepared tool reaches the live service.
    const manager = getSharedManager();
    const serviceOwner = Symbol('embedded-browser-service');

    api.registerService({
      id: 'embedded-browser',
      start(ctx) {
        if (!ctx.gatewayEvents) throw new Error('Embedded browser requires plugin Gateway events.');
        manager.setGatewayEventEmitter(
          serviceOwner,
          ctx.gatewayEvents.emit,
          api.logger,
          api.runtime.events.onAgentEvent,
        );
      },
      stop() {
        manager.clearGatewayEventEmitter(serviceOwner);
      },
    });

    api.on('before_prompt_build', (_event, context) => manager.admission.observeRun(context), {
      requiresToolAuthority: true,
    });
    api.on(
      'before_tool_call',
      (event, context) => {
        try {
          if (event.toolName !== TOOL_NAME || context.toolName !== TOOL_NAME)
            throw new Error('Browser tool identity does not match.');
          if (event.runId !== undefined && event.runId !== context.runId)
            throw new Error('Browser tool run identity does not match.');
          if (event.toolCallId !== undefined && event.toolCallId !== context.toolCallId)
            throw new Error('Browser tool call identity does not match.');
          manager.admission.prepareToolCall(context);
        } catch (error) {
          return {
            block: true,
            blockReason:
              error instanceof Error ? error.message : 'Browser execution is unavailable.',
          };
        }
      },
      { matcher: [TOOL_NAME] },
    );
    api.on('after_tool_call', (_event, context) => manager.admission.finishToolCall(context), {
      matcher: [TOOL_NAME],
    });

    api.registerGatewayMethod(
      RESOLVE_METHOD,
      ({ params, respond }) => {
        try {
          const requestId = readString(params.requestId);
          if (!requestId || typeof params.ok !== 'boolean') {
            throw new Error('Invalid embedded browser response.');
          }
          if (params.ok) {
            manager.resolve(requestId, { ok: true, result: params.result });
          } else {
            const error = readString(params.error);
            if (!error) throw new Error('Invalid embedded browser error response.');
            manager.resolve(requestId, { ok: false, error });
          }
          respond(true, { requestId });
        } catch (error) {
          respond(false, undefined, {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: 'operator.write' },
    );

    api.registerTool(
      {
        contextVersion: 2,
        create: context => {
          const sessionKey = context.sessionKey?.trim() ?? '';
          const sessionId = context.sessionId?.trim() ?? '';
          if (!sessionId || !isBrowserSessionCandidate(sessionKey)) return null;
          return {
            name: TOOL_NAME,
            label: 'Browser',
            resultContentSource: 'network',
            description: describeEmbeddedBrowserTool(),
            parameters: BrowserToolSchema,
            outputSchema: BrowserToolOutputSchema,
            async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
              let call: AdmittedBrowserCall | undefined;
              try {
                call = manager.admission.claimToolCall(
                  sessionKey,
                  sessionId,
                  toolCallId,
                  context.assertInvocationCurrent,
                );
                if (
                  context.browser?.allowHostControl === false ||
                  (context.sandboxed === true && context.browser?.allowHostControl !== true) ||
                  (context.browser?.sandboxBridgeUrl && context.browser?.allowHostControl !== true)
                ) {
                  throw new Error('This execution does not allow host browser control.');
                }
                const normalizeRoot = (value: string): string => {
                  const resolved = path.resolve(value);
                  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
                };
                if (
                  context.fsPolicy?.root &&
                  (!context.workspaceDir ||
                    !path.isAbsolute(context.fsPolicy.root) ||
                    normalizeRoot(context.fsPolicy.root) !== normalizeRoot(context.workspaceDir))
                ) {
                  throw new Error(
                    'The embedded browser cannot satisfy this filesystem root policy.',
                  );
                }
                const input: BrowserCommand = isRecord(params) ? { ...params } : {};
                for (const key of [
                  'run',
                  'execution',
                  'sessionKey',
                  'sessionId',
                  'runId',
                  'toolCallId',
                  'trigger',
                  'jobId',
                  'workspaceDir',
                  'policy',
                ])
                  delete input[key];
                if (input.headless !== undefined && typeof input.headless !== 'boolean')
                  throw new Error('headless must be a boolean.');
                if (call.run.trigger === 'cron' && input.headless === false)
                  throw new Error(
                    'Scheduled browser tasks must run in the background (headless=true).',
                  );
                const command = call.run.trigger === 'cron' ? { ...input, headless: true } : input;
                const deviceName =
                  readString(input.action) === 'emulate' ? readString(input.device) : '';
                const deviceDescriptor = deviceName
                  ? resolveDeviceDescriptor(deviceName)
                  : undefined;
                const operationSignal =
                  signal && call.signal
                    ? AbortSignal.any([signal, call.signal])
                    : (signal ?? call.signal);
                // Transport completion releases the pending response listener,
                // while native cancellation remains bound to this browser run.
                call.retainCancellation(signal);
                const response = await manager.request(
                  call,
                  deviceDescriptor ? { ...command, deviceDescriptor } : command,
                  { allowLocalFiles: context.fsPolicy?.workspaceOnly !== true },
                  operationSignal,
                );
                operationSignal?.throwIfAborted();
                call.assertCurrent();
                if (!response.ok) throw new Error(response.error);
                if (isRecord(response.result) && Array.isArray(response.result.content)) {
                  const details = isRecord(response.result.details) ? response.result.details : {};
                  const content =
                    readString(input.action) === 'screenshot'
                      ? await appendScreenshotShareHint(response.result.content)
                      : response.result.content;
                  operationSignal?.throwIfAborted();
                  call.assertCurrent();
                  return {
                    ...response.result,
                    content:
                      response.result.isError === true
                        ? content
                        : appendPageSource(content, details, input.action),
                    details: {
                      ...details,
                      externalContent: {
                        untrusted: true,
                        source: 'browser',
                        kind: readString(input.action) || 'browser',
                        wrapped: true,
                      },
                    },
                  };
                }
                return {
                  content: appendPageSource(
                    [
                      {
                        type: 'text',
                        text: wrapBrowserContent(JSON.stringify(response.result, null, 2)),
                      },
                    ],
                    isRecord(response.result) ? response.result : {},
                    input.action,
                  ),
                  details: {
                    ...(isRecord(response.result) ? response.result : { result: response.result }),
                    externalContent: {
                      untrusted: true,
                      source: 'browser',
                      kind: readString(input.action) || 'browser',
                      wrapped: true,
                    },
                  },
                };
              } catch (error) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: wrapBrowserContent(
                        `Browser action failed: ${error instanceof Error ? error.message : String(error)}`,
                      ),
                    },
                  ],
                  isError: true,
                  details: {
                    externalContent: {
                      untrusted: true,
                      source: 'browser',
                      kind: 'error',
                      wrapped: true,
                    },
                  },
                };
              } finally {
                call?.release();
              }
            },
          };
        },
      },
      { name: TOOL_NAME },
    );
  },
};

export default plugin;
