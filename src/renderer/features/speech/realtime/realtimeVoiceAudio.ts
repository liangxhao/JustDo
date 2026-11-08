import { isRealtimeVoiceAudio } from '@shared/speech/realtimeVoice';

export interface RealtimeVoiceAudio {
  start(send: (audio: string) => void, fail: () => void): Promise<void>;
  setMicrophoneMuted(muted: boolean): void;
  setSpeakerMuted(muted: boolean): void;
  play(audio: string): void;
  afterPlayback(callback: () => void): void;
  clear(): void;
  close(): void;
}

export class RealtimePcmEncoder {
  private pending: number[] = [];
  private position = 0;
  constructor(private readonly sourceRate: number) {}
  encode(samples: Float32Array): string {
    this.pending.push(...samples);
    const bytes: number[] = [];
    const step = this.sourceRate / 24000;
    while (this.position + 1 < this.pending.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = this.pending[index] * (1 - fraction) + this.pending[index + 1] * fraction;
      const bounded = Math.max(-1, Math.min(1, value));
      const pcm = Math.round(bounded * (bounded < 0 ? 32768 : 32767));
      bytes.push(pcm & 255, (pcm >> 8) & 255);
      this.position += step;
    }
    const consumed = Math.floor(this.position);
    this.pending = this.pending.slice(consumed);
    this.position -= consumed;
    return bytes.length ? btoa(String.fromCharCode(...bytes)) : '';
  }
}

export async function openRealtimeVoiceAudio(deviceId: string): Promise<RealtimeVoiceAudio> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  } });
  let context: AudioContext;
  try { context = new AudioContext({ sampleRate: 24000 }); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  try {
  const input = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  const output = context.createGain();
  output.connect(context.destination);
  const encoder = new RealtimePcmEncoder(context.sampleRate);
  const sources = new Set<AudioBufferSourceNode>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let scheduledUntil = 0;
  let closed = false;
  let muted = false;
  let muteTailSamples = 0;
  let playbackEpoch = 0;
  const clear = () => {
    playbackEpoch += 1;
    for (const source of sources) { source.onended = null; source.stop(); source.disconnect(); }
    sources.clear();
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
    scheduledUntil = 0;
  };
  return {
    start: async (send, fail) => {
      if (closed) return;
      await context.resume();
      if (closed) return;
      processor.onaudioprocess = event => {
        if (closed || (muted && muteTailSamples <= 0)) return;
        try {
          const samples = event.inputBuffer.getChannelData(0);
          // A bounded silent tail lets server VAD finish the preceding utterance;
          // microphone mute never invokes native response/task cancellation.
          const audio = encoder.encode(muted ? new Float32Array(samples.length) : samples);
          if (muted) muteTailSamples -= samples.length;
          if (audio) send(audio);
        } catch { fail(); }
      };
      stream.getAudioTracks().forEach(track => { track.onended = fail; });
      input.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
    },
    setMicrophoneMuted: value => {
      muted = value;
      muteTailSamples = value ? context.sampleRate : 0;
      stream.getAudioTracks().forEach(track => { track.enabled = !value; });
    },
    setSpeakerMuted: value => { output.gain.value = value ? 0 : 1; },
    play: audio => {
      if (closed || !isRealtimeVoiceAudio(audio)) throw new Error('Invalid realtime PCM audio.');
      const bytes = atob(audio);
      const buffer = context.createBuffer(1, bytes.length / 2, 24000);
      const values = buffer.getChannelData(0);
      for (let index = 0; index < values.length; index += 1) {
        let pcm = bytes.charCodeAt(index * 2) | (bytes.charCodeAt(index * 2 + 1) << 8);
        if (pcm >= 32768) pcm -= 65536;
        values[index] = pcm / 32768;
      }
      const start = Math.max(context.currentTime + 0.01, scheduledUntil);
      if (start - context.currentTime > 3) throw new Error('Realtime playback queue exceeded its limit.');
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); };
      scheduledUntil = start + buffer.duration;
      source.start(start);
    },
    afterPlayback: callback => {
      if (closed) return;
      const target = scheduledUntil;
      const epoch = playbackEpoch;
      const check = () => {
        if (closed || playbackEpoch !== epoch) return;
        const remaining = target - context.currentTime;
        if (remaining <= 0.002) { callback(); return; }
        // A suspended audio clock must not acknowledge inaudible queued audio.
        const timer = setTimeout(() => { timers.delete(timer); check(); },
          Math.max(10, Math.min(1000, remaining * 1000 + 10)));
        timers.add(timer);
      };
      check();
    },
    clear,
    close: () => {
      if (closed) return;
      closed = true;
      processor.onaudioprocess = null;
      stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
      input.disconnect(); processor.disconnect(); silent.disconnect();
      clear(); output.disconnect();
      void context.close();
    },
  };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    await context.close().catch(() => undefined);
    throw error;
  }
}
