import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

import {
  isEmptyFailureSourceContent,
  projectFailurePartialContent,
} from '../../plugins/extensions/runtime-services/history-failure';
import type { GatewayClient } from '../../src/renderer/libs/openclaw-chat/gateway/client';
import { hydrateTruncatedHistoryMessages } from '../../src/renderer/libs/openclaw-chat/gateway/history/chat-history-protocol';
import { normalizeGatewayHistoryForDisplay } from '../../src/renderer/libs/openclaw-chat/pipeline/history-display-normalizer';

const dist = path.join(
  path.resolve(
    process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ??
      process.env.OPENCLAW_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
  ),
  'dist',
);
const projectionFile = fs.existsSync(dist)
  ? fs
      .readdirSync(dist)
      .find(
        name =>
          /^chat-display-projection\.core-.*\.mjs$/u.test(name) &&
          fs
            .readFileSync(path.join(dist, name), 'utf8')
            .includes('function projectChatDisplayMessages('),
      )
  : undefined;

if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1' && !projectionFile) {
  throw new Error('Required native history projection is missing from the selected runtime.');
}

test.skipIf(!projectionFile)(
  'recovers failed commentary and reasoning omitted by the locked native history projection',
  async () => {
    const filename = path.join(dist, projectionFile!);
    const native = await import(pathToFileURL(filename).href);
    const exportName = fs
      .readFileSync(filename, 'utf8')
      .match(/projectChatDisplayMessages as (\w+)/u)?.[1];
    expect(exportName).toBeTruthy();
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Provider returned an incomplete or malformed tool call',
      content: [
        {
          type: 'thinking',
          thinking: 'Inspect the environment first.',
          thinkingSignature: 'reasoning_content',
        },
        {
          type: 'text',
          text: 'Checking the environment.',
          textSignature: '{"v":1,"id":"commentary-0","phase":"commentary"}',
        },
      ],
      openclawDelivery: { textPhaseRequiresTerminal: true },
      __openclaw: { id: 'native-failure', runId: 'run-failure', seq: 153 },
    };
    const before = structuredClone(message);
    const projected = native[exportName!]([message], {
      maxChars: 500_000,
      includeCommentaryFallbacks: true,
    });
    expect(JSON.stringify(projected)).not.toContain('Inspect the environment first.');
    expect(JSON.stringify(projected)).not.toContain('Checking the environment.');
    const request = vi.fn().mockResolvedValue({
      failureDetails: {
        'native-failure': {
          errorMessage: message.errorMessage,
          emptyContent: false,
          partialContent: projectFailurePartialContent(message, value => value),
        },
      },
    });

    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      projected,
      'session-1',
    );
    const normalized = await normalizeGatewayHistoryForDisplay(hydrated, {
      sessionKey: 'session-1',
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: message.errorMessage,
      content: [
        { type: 'thinking', thinking: 'Inspect the environment first.' },
        { type: 'text', text: 'Checking the environment.' },
      ],
      __openclaw: message.__openclaw,
    });
    expect(message).toEqual(before);
    expect(JSON.stringify(hydrated)).not.toContain('thinkingSignature');

    const attachment = {
      type: 'attachment',
      attachment: {
        url: 'https://example.test/report.pdf',
        kind: 'document',
        label: 'report.pdf',
        mimeType: 'application/pdf',
      },
    };
    const withDisplayAttachment = {
      ...message,
      content: [{ type: 'text', text: 'Partial reply' }],
      openclawDisplayContent: [{ type: 'text', text: 'Partial reply' }, attachment],
    };
    expect(projectFailurePartialContent(withDisplayAttachment, value => value)).toBeUndefined();
    const displayProjection = native[exportName!]([withDisplayAttachment], { maxChars: 500_000 });
    expect(JSON.stringify(displayProjection)).toContain('report.pdf');
    request.mockResolvedValue({
      failureDetails: {
        'native-failure': {
          errorMessage: message.errorMessage,
          emptyContent: false,
          // Defend against an incorrect text-only response as well as a correct server.
          partialContent: projectFailurePartialContent(message, value => value),
        },
      },
    });
    const kept = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      displayProjection,
      'session-1',
    );
    expect(JSON.stringify(kept)).toContain('report.pdf');

    const fallbackOnly = {
      ...message,
      content: [{ type: 'text', text: '[assistant turn failed before producing content]' }],
    };
    const failedProjection = native[exportName!]([fallbackOnly], { maxChars: 500_000 });
    request.mockResolvedValue({
      failureDetails: {
        'native-failure': {
          errorMessage: message.errorMessage,
          emptyContent: isEmptyFailureSourceContent(fallbackOnly),
          partialContent: projectFailurePartialContent(fallbackOnly, value => value),
        },
      },
    });
    const failedHydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      failedProjection,
      'session-1',
    );
    const failedNormalized = await normalizeGatewayHistoryForDisplay(failedHydrated, {
      sessionKey: 'session-1',
    });
    expect(failedNormalized).toHaveLength(1);
    expect(failedNormalized[0]).toMatchObject({
      role: 'system',
      isError: true,
      content: message.errorMessage,
    });
    expect(JSON.stringify(failedNormalized)).not.toContain(
      '[assistant turn failed before producing content]',
    );
  },
  // Cold imports traverse the complete published native module graph.
  30_000,
);
