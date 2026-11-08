import type { RealtimeVoiceBridge, RealtimeVoiceEvent, RealtimeVoiceSession } from '@shared/speech/realtimeVoice';

import { openRealtimeVoiceAudio, type RealtimeVoiceAudio } from './realtimeVoiceAudio';
import { publishRealtimeVoiceTimeline } from './realtimeVoiceEvents';

export interface RealtimeVoiceViewState {
  phase: 'idle' | 'starting' | 'connecting' | 'active' | 'ending' | 'error' | 'unknown';
  activity: 'listening' | 'responding';
  microphoneMuted: boolean;
  speakerMuted: boolean;
  userCaption: string;
  assistantCaption: string;
  turnId?: string;
}
const initialState = (): RealtimeVoiceViewState => ({ phase: 'idle', activity: 'listening', microphoneMuted: false,
  speakerMuted: false, userCaption: '', assistantCaption: '' });
interface Call {
  generation: number;
  requestId: string;
  productSessionId: string;
  session?: RealtimeVoiceSession;
  earlySource?: RealtimeVoiceSession['source'];
  earlyFailure?: boolean;
  timelineOpened?: boolean;
  audio?: RealtimeVoiceAudio;
  cancelled: boolean;
  ready: boolean;
  started: boolean;
  queued: number;
  sending: Promise<void>;
  finalCaptions: Set<'userCaption' | 'assistantCaption'>;
  readyTimeout?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  outputGeneration: number;
  outputTurnId?: string;
}
const sameSource = (left: RealtimeVoiceSession['source'], right: RealtimeVoiceSession['source']) =>
  left.productSessionId === right.productSessionId && left.sessionKey === right.sessionKey && left.sessionId === right.sessionId;

/** Only live captions and media resources; native history remains authoritative. */
export class RealtimeVoiceController {
  private call?: Call;
  private disposed = false;
  private generation = 0;
  private readonly unsubscribe: () => void;
  private state = initialState();
  constructor(private readonly bridge: RealtimeVoiceBridge,
    private readonly changed: (state: RealtimeVoiceViewState) => void,
    private readonly openAudio = openRealtimeVoiceAudio,
  ) { this.unsubscribe = bridge.onEvent(event => this.event(event)); }
  private publish(patch: Partial<RealtimeVoiceViewState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  private publishFor(call: Call, patch: Partial<RealtimeVoiceViewState>) {
    if (this.generation === call.generation) this.publish(patch);
  }
  async start(productSessionId: string, deviceId = ''): Promise<void> {
    if (this.call || this.disposed) return;
    const call: Call = { generation: ++this.generation, requestId: crypto.randomUUID(), productSessionId, cancelled: false, ready: false,
      started: false, queued: 0, sending: Promise.resolve(), finalCaptions: new Set(), outputGeneration: 0 };
    this.call = call;
    this.publish({ ...initialState(), phase: 'starting' });
    try {
      call.audio = await this.openAudio(deviceId);
      if (call.cancelled || this.disposed || this.call !== call) { call.audio.close(); return; }
      const status = await this.bridge.getStatus();
      if (!status.available) throw new Error('Realtime voice is unavailable.');
      if (call.cancelled || this.disposed || this.call !== call) return;
      const session = await this.bridge.start({ requestId: call.requestId, productSessionId });
      call.session = session;
      if (call.cancelled || this.disposed || this.call !== call) {
        await this.bridge.close({ requestId: call.requestId, voiceSessionId: session.voiceSessionId });
        return;
      }
      if (session.source.productSessionId !== productSessionId ||
        (call.earlySource && !sameSource(call.earlySource, session.source)) || call.earlyFailure)
        throw new Error('Realtime voice source or lifecycle changed during admission.');
      call.timelineOpened = true;
      publishRealtimeVoiceTimeline({ type: 'opened', session });
      this.publish({ phase: 'connecting' });
      call.readyTimeout = setTimeout(() => { if (this.call === call && !call.ready) void this.fail(call); }, 20_000);
      if (call.ready) await this.activate(call);
    } catch (error) {
      if (this.call !== call || this.disposed) return;
      const unknown = error instanceof Error && error.message.includes('outcome is unknown');
      const cancelled = call.cancelled;
      await this.closeCall(call);
      this.publishFor(call, { phase: unknown ? 'unknown' : cancelled ? 'idle' : 'error' });
    } finally {
      if (call.cancelled && this.call === call) {
        await this.closeCall(call);
        this.publishFor(call, { phase: 'idle' });
      }
    }
  }
  private async activate(call: Call) {
    if (!call.session || call.cancelled || call.started || this.call !== call) return;
    call.started = true;
    if (call.readyTimeout) clearTimeout(call.readyTimeout);
    await call.audio?.start(audioBase64 => {
      if (this.call !== call || call.cancelled || !call.session) return;
      if (++call.queued > 12) { void this.fail(call); return; }
      call.sending = call.sending.then(async () => {
        if (this.call !== call || call.cancelled || !call.session) return;
        await this.bridge.appendAudio({ requestId: call.requestId,
          voiceSessionId: call.session.voiceSessionId, audioBase64 });
      }).catch(() => { void this.fail(call); }).finally(() => { call.queued -= 1; });
    }, () => { void this.fail(call); });
    if (this.call === call && !call.cancelled) this.publish({ phase: 'active' });
  }
  private event(event: RealtimeVoiceEvent) {
    const call = this.call;
    if (!call || call.cancelled || this.disposed || event.requestId !== call.requestId ||
      !event.source || event.source.productSessionId !== call.productSessionId ||
      (call.session && (event.voiceSessionId !== call.session.voiceSessionId || !sameSource(event.source, call.session.source)))) return;
    if (!call.session) {
      if (!['ready', 'error', 'close'].includes(event.type) ||
        (call.earlySource && !sameSource(call.earlySource, event.source))) return;
      call.earlySource = { ...event.source };
      if (event.type === 'ready') call.ready = true;
      else call.earlyFailure = true;
      return;
    }
    if ((event.type === 'audioDone' || event.type === 'clear') && event.turnId &&
      call.outputTurnId && event.turnId !== call.outputTurnId) return;
    if (event.type === 'transcript' || event.type === 'clear' || event.type === 'responseStarted')
      publishRealtimeVoiceTimeline({ type: 'event', event });
    if (event.turnId) this.publish({ turnId: event.turnId });
    switch (event.type) {
      case 'ready': call.ready = true; void this.activate(call).catch(() => this.fail(call)); break;
      case 'responseStarted':
        call.outputGeneration += 1;
        call.outputTurnId = event.turnId;
        this.publish({ activity: 'responding' });
        break;
      case 'audio':
        if (event.audioBase64) {
          try {
            call.audio?.play(event.audioBase64);
            call.outputGeneration += 1;
            call.outputTurnId = event.turnId ?? call.outputTurnId;
            this.publish({ activity: 'responding' });
          } catch { void this.fail(call); }
        }
        break;
      case 'audioDone': {
        const generation = call.outputGeneration;
        const turnId = call.outputTurnId;
        call.audio?.afterPlayback(() => {
          if (this.call === call && !call.cancelled && call.outputGeneration === generation && call.outputTurnId === turnId)
            this.publish({ activity: 'listening' });
        });
        break;
      }
      case 'mark':
        if (event.markName) call.audio?.afterPlayback(() => {
          if (this.call === call && !call.cancelled && call.session)
            void this.bridge.acknowledgeMark({ requestId: call.requestId,
              voiceSessionId: call.session.voiceSessionId, markName: event.markName! }).catch(() => this.fail(call));
        });
        break;
      case 'clear': this.clearOutput(call); break;
      case 'transcript': {
        const key = event.role === 'user' ? 'userCaption' : 'assistantCaption';
        const text = event.final || event.textMode === 'snapshot' || call.finalCaptions.has(key)
          ? event.text ?? '' : this.state[key] + (event.text ?? '');
        if (event.final) call.finalCaptions.add(key); else call.finalCaptions.delete(key);
        this.publish({ [key]: text.slice(-16_000) });
        break;
      }
      case 'error': void this.fail(call); break;
      case 'close': void this.closeCall(call).then(() => this.publishFor(call, { phase: event.reason === 'completed' ? 'idle' : 'error' })); break;
    }
  }
  setMicrophoneMuted(muted: boolean) { this.call?.audio?.setMicrophoneMuted(muted); this.publish({ microphoneMuted: muted }); }
  setSpeakerMuted(muted: boolean) { this.call?.audio?.setSpeakerMuted(muted); this.publish({ speakerMuted: muted }); }
  private clearOutput(call: Call) {
    call.outputGeneration += 1;
    call.outputTurnId = undefined;
    call.audio?.clear();
    this.publish({ activity: 'listening' });
  }
  async interrupt(): Promise<void> {
    const call = this.call;
    if (!call?.session || call.cancelled || !this.state.turnId) return;
    this.clearOutput(call);
    try { await this.bridge.interrupt({ requestId: call.requestId,
      voiceSessionId: call.session.voiceSessionId, turnId: this.state.turnId }); }
    catch { await this.fail(call); }
  }
  private closeCall(call: Call): Promise<void> {
    if (call.closing) return call.closing;
    call.cancelled = true;
    if (call.session && call.timelineOpened) {
      call.timelineOpened = false;
      publishRealtimeVoiceTimeline({ type: 'ended', session: call.session });
    }
    if (call.readyTimeout) clearTimeout(call.readyTimeout);
    call.audio?.close();
    call.closing = this.bridge.close({ requestId: call.requestId,
      ...(call.session ? { voiceSessionId: call.session.voiceSessionId } : {}) }).catch(() => undefined).then(() => {
        if (this.call === call) this.call = undefined;
      });
    return call.closing;
  }
  private async fail(call: Call) {
    if (this.call !== call || call.cancelled) return;
    await this.closeCall(call);
    this.publishFor(call, { phase: 'error' });
  }
  async end(): Promise<void> {
    const call = this.call;
    if (!call) return;
    this.publish({ phase: 'ending' });
    await this.closeCall(call);
    this.publishFor(call, { phase: 'idle', turnId: undefined });
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.call) void this.closeCall(this.call);
  }
}
