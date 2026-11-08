import type {
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from 'openclaw/plugin-sdk/realtime-voice';
import {
  RealtimeVoiceSessionLifecycle,
  toStringifiedError,
} from 'openclaw/plugin-sdk/realtime-voice-provider';
import WebSocket from 'ws';

import { normalizeSpeechServiceBaseUrl, SPEECH_PROTOCOL_IDS } from '../../sdk/speech-protocols/index.js';
import { requireSpeechIdentifier } from './intranet-config.js';
import type { OpenAIRealtimeHost } from './realtime-host.js';
import { readRealtimeErrorDetail } from './realtime-provider-shared.js';
import {
  OpenAIRealtimeEvents,
  OpenAIRealtimeMalformedAudioError,
} from './realtime-voice-events.js';
import {
  OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES,
  OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
  type OpenAIRealtimeUserMessageOptions,
  type OpenAIRealtimeVoiceBridgeConfig,
  type RealtimeEvent,
} from './realtime-voice-session-policy.js';

const OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES = 1024 * 1024;
const OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS = 5_000;

export class OpenAIRealtimeBridge extends OpenAIRealtimeEvents implements RealtimeVoiceBridge {
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;

  private readonly lifecycle: RealtimeVoiceSessionLifecycle;

  private sessionReadyFired = false;

  private reconnectReason: string | undefined;

  private activeConnectionReason: string | undefined;

  private terminalError: Error | undefined;

  private droppedInputAudioFrames = 0;

  private lastInputAudioDropWarningAt = Number.NEGATIVE_INFINITY;

  constructor(config: OpenAIRealtimeVoiceBridgeConfig, runtime: OpenAIRealtimeHost) {
    super(config, runtime);
    this.lifecycle = new RealtimeVoiceSessionLifecycle('OpenAI', {
      pendingAudioOverflowPolicy: 'drop-oldest',
      onPendingAudioOverflow: () =>
        this.config.logger.warn('OpenAI realtime input audio queue overflow; keeping newest audio'),
    });
  }

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    await this.lifecycle.connect(connection => this.doConnect(connection));
  }

  sendAudio(audio: Buffer): void {
    if (this.lifecycle.phase() === 'terminal') {
      return;
    }
    if (!this.lifecycle.isReady() || this.ws?.readyState !== WebSocket.OPEN) {
      this.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    if (this.ws.bufferedAmount > OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES) {
      this.droppedInputAudioFrames += 1;
      const now = Date.now();
      if (now - this.lastInputAudioDropWarningAt >= OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS) {
        this.config.logger.warn(
          `OpenAI realtime input audio backpressure; droppedFrames=${this.droppedInputAudioFrames}`,
        );
        this.droppedInputAudioFrames = 0;
        this.lastInputAudioDropWarningAt = now;
      }
      return;
    }
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: audio.toString('base64'),
    });
  }

  sendUserMessage(text: string, options?: OpenAIRealtimeUserMessageOptions): void {
    if (options?.toolChoice && (this.responseBusy || this.pendingToolCallIds.size > 0)) {
      throw new Error('Forced realtime tool choice requires an idle response state');
    }
    if (this.pendingToolCallIds.size > 0) {
      // Control/status speech must not wait behind the long-running consult whose
      // function output owns the default conversation response.
      this.standaloneSpeechQueue.push(text);
      this.flushStandaloneSpeech();
      return;
    }
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.requestResponseCreate(options);
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? 'Greet the meeting.');
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.lifecycle.phase() === 'terminal' || !this.pendingToolCallIds.has(callId)) {
      return;
    }
    const output = JSON.stringify(result);
    if (typeof output !== 'string') {
      throw new Error('OpenAI realtime voice tool result is not JSON-serializable');
    }
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      this.flushPendingResponseCreate();
      return;
    }
    this.requestResponseCreate();
  }

  close(): void {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.resetTerminalState();
    if (!connection) {
      return;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'Bridge closed');
    this.notifyClose(connection, 'completed');
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.ws?.readyState === WebSocket.OPEN;
  }

  private async doConnect(lifecycleConnection: RealtimeVoiceSessionConnection): Promise<void> {
    let activeWs: WebSocket | undefined;
    let startupFrameBytes = 0;
    const attempt = this.lifecycle.createConnectAttempt({
      connection: lifecycleConnection,
      timeoutMs: OpenAIRealtimeBridge.CONNECT_TIMEOUT_MS,
      timeoutError: () => new Error('OpenAI realtime connection timeout'),
      onTimeout: () => activeWs?.terminate(),
      onAbort: () => {
        if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
          activeWs.close(1000, 'connection canceled');
        }
      },
    });

    const openWebSocket = (resolvedConnection: {
      url: string;
      headers: Record<string, string>;
    }) => {
      if (attempt.settled) {
        return;
      }
      if (!this.lifecycle.isCurrent(lifecycleConnection) || lifecycleConnection.signal.aborted) {
        attempt.resolve();
        return;
      }
      // Auth preparation owns its own timeout. Start the socket deadline only
      // after connection parameters are available.
      attempt.startTimeout();
      const debugProxy = this.runtime.resolveDebugProxySettings();
      const proxyAgent = this.runtime.createDebugProxyWebSocketAgent(debugProxy);
      const ws = new WebSocket(resolvedConnection.url, {
        headers: resolvedConnection.headers,
        maxPayload: OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      activeWs = ws;
      this.ws = ws;

      const rejectStartup = (error: Error) => {
        if (!attempt.rejectStartup(error)) {
          return;
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, 'startup failed');
        }
      };

      ws.on('open', () => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection)) {
          ws.close(1000, 'stale connection');
          return;
        }
        this.resetRealtimeSessionState();
        this.sendSessionUpdate();
      });

      ws.on('message', (data: Buffer) => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection) || this.ws !== ws) {
          return;
        }
        if (attempt.settled && !attempt.ready) {
          return;
        }
        if (!attempt.ready) {
          startupFrameBytes += data.byteLength;
          if (startupFrameBytes > OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES) {
            const error = new Error('OpenAI realtime sideband startup buffer exceeded');
            attempt.reject(error);
            this.failConnection(error, ws, lifecycleConnection, {
              code: 1009,
              reason: 'Sideband startup buffer exceeded',
            });
            return;
          }
        }
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          if (event.type === 'error' && !attempt.ready) {
            // The configured service owns its startup rejection; no account or endpoint retry.
            rejectStartup(
              new Error(readRealtimeErrorDetail(event.error)),
            );
            return;
          }
          if (event.type === 'session.updated') {
            try {
              this.handleEvent(event, lifecycleConnection);
            } catch (error) {
              const readyError = toStringifiedError(error);
              attempt.reject(readyError);
              this.failConnection(readyError, ws, lifecycleConnection, {
                code: 1011,
                reason: 'Readiness callback failed',
              });
              return;
            }
            attempt.resolve(this.lifecycle.isReady());
            return;
          }
          this.handleEvent(event, lifecycleConnection);
        } catch (error) {
          if (error instanceof OpenAIRealtimeMalformedAudioError) {
            attempt.reject(error);
            this.failConnection(error, ws, lifecycleConnection, {
              code: 1002,
              reason: 'Malformed audio payload',
            });
            return;
          }
          console.error('[openai] realtime event parse failed:', error);
        }
      });

      ws.on('error', error => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection) || this.ws !== ws) {
          return;
        }
        if (!attempt.ready) {
          const startupError = toStringifiedError(error);
          rejectStartup(
            startupError,
          );
          return;
        }
        this.config.onError?.(toStringifiedError(error));
      });

      ws.on('close', () => {
        if (!this.lifecycle.isCurrent(lifecycleConnection)) {
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (attempt.startupFailed) {
          return;
        }
        if (this.terminalError) {
          this.notifyClose(lifecycleConnection, 'error');
          return;
        }
        if (this.lifecycle.terminalOutcome(lifecycleConnection) === 'completed') {
          attempt.resolve();
          this.notifyClose(lifecycleConnection, 'completed');
          return;
        }
        if (!attempt.ready && !attempt.settled) {
          const error = new Error('OpenAI realtime connection closed before ready');
          attempt.reject(error);
          return;
        }
        const reason = this.reconnectReason ?? 'websocket-close';
        this.reconnectReason = undefined;
        void this.attemptReconnect(reason, lifecycleConnection);
      });
    };

    let connectionOrPromise:
      | { url: string; headers: Record<string, string> }
      | Promise<{ url: string; headers: Record<string, string> }>;
    try {
      connectionOrPromise = this.resolveConnectionParams();
    } catch (error) {
      attempt.reject(toStringifiedError(error));
      return attempt.promise;
    }
    if (connectionOrPromise instanceof Promise) {
      void connectionOrPromise.then(openWebSocket).catch((error: unknown) => {
        if (
          !this.lifecycle.isCurrent(lifecycleConnection) ||
          this.lifecycle.terminalOutcome(lifecycleConnection) === 'completed'
        ) {
          attempt.resolve();
          return;
        }
        attempt.reject(toStringifiedError(error));
      });
    } else {
      try {
        openWebSocket(connectionOrPromise);
      } catch (error) {
        attempt.reject(toStringifiedError(error));
      }
    }
    await attempt.promise;
  }

  private resolveConnectionParams(): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    const model = requireSpeechIdentifier(cfg.model, 'realtime model');
    requireSpeechIdentifier(cfg.voice, 'realtime voice');
    requireSpeechIdentifier(cfg.inputTranscriptionModel, 'input transcription model');
    if (typeof cfg.apiKey !== 'string' || cfg.apiKey.length > 16384 || /[\r\n\0]/.test(cfg.apiKey))
      throw new Error('The realtime credential has not been resolved.');
    const base = normalizeSpeechServiceBaseUrl(cfg.baseUrl, { protocolId: SPEECH_PROTOCOL_IDS.VOICE_REALTIME });
    const endpoint = new URL(base);
    endpoint.protocol = endpoint.protocol.replace('http', 'ws');
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/realtime';
    endpoint.searchParams.set('model', model);
    return { url: endpoint.toString(), headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {} };
  }

  private async attemptReconnect(_reason: string, connection: RealtimeVoiceSessionConnection): Promise<void> {
    if (this.lifecycle.failure(connection)) this.resetTerminalState();
    this.notifyClose(connection, 'error');
  }

  protected onSessionUpdated(connection: RealtimeVoiceSessionConnection): void {
    if (!this.lifecycle.ready(connection)) {
      return;
    }
    if (this.activeConnectionReason) {
      this.config.onEvent?.({
        direction: 'server',
        type: 'session.rotation.ready',
        detail: `reason=${this.activeConnectionReason}`,
      });
      this.activeConnectionReason = undefined;
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
    for (const chunk of this.lifecycle.drainPendingAudio()) {
      this.sendAudio(chunk);
    }
  }

  private resetTerminalState(): void {
    // Explicit bridge reuse starts with fresh readiness and response ownership.
    this.sessionReadyFired = false;
    this.reconnectReason = undefined;
    this.activeConnectionReason = undefined;
    this.resetRealtimeSessionState();
  }

  private failConnection(
    error: Error,
    ws: WebSocket,
    connection: RealtimeVoiceSessionConnection,
    close: { code: number; reason: string },
  ): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.lifecycle.failure(connection);
    this.resetTerminalState();
    try {
      this.config.onError?.(error);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close(close.code, close.reason);
      } else {
        this.notifyClose(connection, 'error');
      }
    }
  }

  private notifyClose(
    connection: RealtimeVoiceSessionConnection,
    outcome: 'completed' | 'error',
  ): void {
    const terminalOutcome = this.lifecycle.close(connection, outcome);
    if (!terminalOutcome) {
      return;
    }
    this.resetTerminalState();
    this.config.onClose?.(terminalOutcome);
  }

  protected sendEvent(event: { type: string; [key: string]: unknown }, detail?: string): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      const { type } = event;
      const payload = JSON.stringify(event);
      ws.send(payload);
      // Observers report a sent frame, so nested control cannot overtake it.
      this.config.onEvent?.({ direction: 'client', type, ...(detail ? { detail } : {}) });
    }
  }

  protected acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean {
    return this.lifecycle.acceptsEvents(connection);
  }

  protected isTransportOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected rotateExpiredSession(): void {
    this.reconnectReason = 'max-duration';
    this.activeConnectionReason = 'max-duration';
    this.config.onEvent?.({
      direction: 'server',
      type: 'session.rotation',
      detail: 'reason=max-duration',
    });
    this.ws?.close(1000, 'max-duration rotation');
  }

  protected failToolCallSessionLimit(
    error: Error,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    const ws = this.ws;
    if (ws) {
      this.failConnection(error, ws, connection, {
        code: 1008,
        reason: 'Tool-call session limit exceeded',
      });
    }
  }
}
