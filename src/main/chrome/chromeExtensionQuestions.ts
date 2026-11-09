import {
  AskUserInteractionEvent,
  parseAskUserRequest,
} from '../../shared/cowork/interactions/askUserQuestion';
import { CoworkInteractionKind } from '../../shared/cowork/interactions/interactions';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import type { CoworkSession } from '../data/coworkStore';
import type { OpenClawRuntimeAdapter } from '../engine/openclaw/openclawRuntimeAdapter';
import { buildManagedSessionKey } from '../openclaw/sessions/openclawSessionKeys';
import type { ChromeExtensionQuestion, ChromeExtensionQuestionResponse } from './chromeAppServerTypes';

interface Dependencies {
  getSession: (sessionId: string) => CoworkSession;
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

const sessionIdentity = (session: CoworkSession) => JSON.stringify([
  session.id, session.source, session.agentId, session.cwd, session.nativeSessionKey,
  session.historyBinding, session.nativeParentSessionId, session.handoffSource,
]);

/** Chrome is another view of native pending questions, never their persistence or execution owner. */
export class ChromeExtensionQuestions {
  constructor(private readonly deps: Dependencies) {}

  private capture(sessionId: string, assertPeerCurrent: () => void) {
    assertPeerCurrent();
    const session = this.deps.getSession(sessionId);
    if (session.source !== CoworkSessionSource.ChromeExtension || session.nativeParentSessionId || session.handoffSource)
      throw new Error('Questions are unavailable for this conversation.');
    const identity = sessionIdentity(session);
    const runtime = this.deps.getRuntime();
    const client = runtime?.getGatewayClient();
    const generation = runtime?.getGatewayClientGeneration();
    if (!runtime || !client) throw new Error('OpenClaw runtime is unavailable.');
    const sessionKey = session.nativeSessionKey ?? session.historyBinding?.sessionKey ??
      buildManagedSessionKey(session.id, session.agentId);
    const assertCurrent = () => {
      assertPeerCurrent();
      if (this.deps.getRuntime() !== runtime || runtime.getGatewayClient() !== client ||
        runtime.getGatewayClientGeneration() !== generation || sessionIdentity(this.deps.getSession(sessionId)) !== identity)
        throw new Error('The question connection changed.');
    };
    return { session, sessionKey, runtime, client, assertCurrent };
  }

  private async pending(sessionId: string, assertPeerCurrent: () => void) {
    const binding = this.capture(sessionId, assertPeerCurrent);
    const interactions = await binding.runtime.listPendingStructuredQuestions();
    binding.assertCurrent();
    const candidates = interactions.flatMap(interaction => {
      const origin = interaction.request.origin;
      if (interaction.sessionId !== sessionId ||
        interaction.request.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION ||
        !origin?.available || origin.ownerSessionId !== sessionId || origin.pluginId) return [];
      const request = parseAskUserRequest({ requestId: interaction.request.requestId, ...interaction.request.toolInput });
      const source = request?.source;
      if (!request || !source || source.ownerPluginId || source.sessionKey !== binding.sessionKey ||
        (source.agentId !== undefined && source.agentId !== binding.session.agentId) ||
        origin.sessionKey !== source.sessionKey || origin.nativeSessionId !== source.nativeSessionId ||
        origin.runId !== source.runId || origin.toolCallId !== source.toolCallId ||
        (binding.session.historyBinding && binding.session.historyBinding.nativeSessionId !== source.nativeSessionId)) return [];
      return [{ request, interaction }];
    });
    if (!candidates.length) return { ...binding, requests: [] };
    const description = await binding.client.request<{ session?: {
      key?: string; sessionId?: string; lifecycleRevision?: string | null;
    } }>('sessions.describe', { key: binding.sessionKey });
    binding.assertCurrent();
    const requests = candidates.filter(({ request }) => {
      const source = request.source!;
      return description.session?.key === source.sessionKey && description.session.sessionId === source.nativeSessionId &&
        (source.lifecycleRevision === undefined || description.session.lifecycleRevision === source.lifecycleRevision);
    });
    return { ...binding, requests };
  }

  async list(sessionId: string, assertCurrent: () => void): Promise<ChromeExtensionQuestion[]> {
    const pending = await this.pending(sessionId, assertCurrent);
    return pending.requests.map(({ request }) => ({
      requestId: request.requestId, questions: request.questions, waitPolicy: request.waitPolicy,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      ...(request.createdAt !== undefined ? { createdAt: request.createdAt } : {}),
    }));
  }

  async respond(sessionId: string, requestId: string, response: ChromeExtensionQuestionResponse, assertCurrent: () => void): Promise<void> {
    const pending = await this.pending(sessionId, assertCurrent);
    if (!pending.requests.some(entry => entry.request.requestId === requestId))
      throw new Error('The question is no longer available in this conversation.');
    await pending.runtime.resolveAskUserInteraction(requestId, response, { assertCurrent: pending.assertCurrent });
  }

  async subscribe(sessionId: string, listener: () => void): Promise<() => void> {
    this.deps.getSession(sessionId);
    const runtime = this.deps.getRuntime();
    if (!runtime) throw new Error('OpenClaw runtime is unavailable.');
    let disposed = false;
    const changed = (event?: { sessionId?: string }) => {
      if (disposed || this.deps.getRuntime() !== runtime || event?.sessionId && event.sessionId !== sessionId) return;
      try { this.deps.getSession(sessionId); } catch { return; }
      listener();
    };
    runtime.on(AskUserInteractionEvent.Changed, changed);
    runtime.on('gatewayReady', changed);
    runtime.on('gatewayDisconnected', changed);
    return () => {
      disposed = true;
      runtime.off(AskUserInteractionEvent.Changed, changed);
      runtime.off('gatewayReady', changed);
      runtime.off('gatewayDisconnected', changed);
    };
  }
}
