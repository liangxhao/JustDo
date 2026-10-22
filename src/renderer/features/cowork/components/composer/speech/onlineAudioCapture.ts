export const ONLINE_ASR_SAMPLE_RATE = 8_000;

export function floatToG711Ulaw(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const pcm16 = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    let sign = 0;
    let magnitude = pcm16;
    if (magnitude < 0) {
      sign = 0x80;
      magnitude = -magnitude;
    }
    magnitude = Math.min(magnitude, 32635) + 0x84;
    let exponent = 7;
    let mask = 0x4000;
    while ((magnitude & mask) === 0 && exponent > 0) {
      exponent -= 1;
      mask >>= 1;
    }
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    bytes[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export class OnlineAsrAudioPump {
  private context: AudioContext | null = null;
  private resumePromise: Promise<void> | null = null;
  private sources: MediaStreamAudioSourceNode[] = [];
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  prepare(): void {
    this.stop();
    const context = new AudioContext({ sampleRate: ONLINE_ASR_SAMPLE_RATE });
    if (context.sampleRate !== ONLINE_ASR_SAMPLE_RATE) {
      void context.close();
      throw new Error('Browser audio does not support the required 8 kHz input format.');
    }
    this.context = context;
    this.resumePromise = context.state === 'running' ? Promise.resolve() : context.resume();
  }

  async start(streams: MediaStream[], onSamples: (samples: Float32Array) => void): Promise<void> {
    if (!this.context) this.prepare();
    const context = this.context;
    if (!context) throw new Error('Online audio capture is unavailable.');
    await this.resumePromise;
    if (context.state !== 'running') {
      this.stop();
      throw new Error('Online audio capture could not start.');
    }
    this.processor = context.createScriptProcessor(4096, 1, 1);
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = event => onSamples(event.inputBuffer.getChannelData(0));
    this.sources = streams.map(stream => {
      const source = context.createMediaStreamSource(stream);
      source.connect(this.processor!);
      return source;
    });
    this.processor.connect(this.sink);
    this.sink.connect(context.destination);
  }

  stop(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.sink?.disconnect();
    this.sink = null;
    this.sources.forEach(source => source.disconnect());
    this.sources = [];
    void this.context?.close();
    this.context = null;
    this.resumePromise = null;
  }
}
