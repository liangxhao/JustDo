import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

/** Retry endpoint discovery; the controller owns reconnects after transport creation. */
export function startSubagentGatewayConnection(options: {
  controller: ChatController;
  connect: (controller: ChatController) => Promise<boolean>;
  subscribeProgress?: (listener: (engine: { phase: string }) => void) => () => void;
  onConnecting: () => void;
  onFailure: () => void;
}): () => void {
  let disposed = false;
  let connecting = false;
  let transportStarted = false;
  let reconnectRequested = false;
  let previousPhase: string | undefined;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryDelays = [1_000, 2_000, 4_000];
  const connect = async () => {
    if (disposed || connecting || transportStarted) return;
    connecting = true;
    try {
      transportStarted = await options.connect(options.controller);
    } catch {
      transportStarted = false;
    } finally {
      connecting = false;
    }
    if (disposed) {
      options.controller.disconnect();
      return;
    }
    if (reconnectRequested) {
      reconnectRequested = false;
      options.controller.disconnect();
      transportStarted = false;
      void connect();
      return;
    }
    if (!transportStarted) {
      const delay = retryDelays[attempt++];
      if (delay !== undefined) retryTimer = setTimeout(() => void connect(), delay);
      else options.onFailure();
    }
  };
  const unsubscribe = options.subscribeProgress?.(engine => {
    if (disposed || previousPhase === engine.phase) return;
    const endpointMayHaveChanged = previousPhase !== undefined && previousPhase !== 'running';
    previousPhase = engine.phase;
    if (engine.phase !== 'running' || (transportStarted && !endpointMayHaveChanged)) return;
    clearTimeout(retryTimer);
    attempt = 0;
    options.onConnecting();
    if (connecting) {
      reconnectRequested = true;
      return;
    }
    options.controller.disconnect();
    transportStarted = false;
    void connect();
  });
  options.onConnecting();
  void connect();
  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    unsubscribe?.();
    options.controller.disconnect();
  };
}
