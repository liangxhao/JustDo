export const LOCAL_ASR_SAMPLE_RATE = 16_000;
const IMPORTED_AUDIO_CHUNK_SECONDS = 30;

function downmixAudioBuffer(audio: AudioBuffer): Float32Array {
  const channelCount = audio.numberOfChannels;
  const mono = new Float32Array(audio.length);
  const channels = Array.from({ length: channelCount }, (_, index) => audio.getChannelData(index));
  for (let frame = 0; frame < audio.length; frame += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[frame] ?? 0;
    mono[frame] = Math.max(-1, Math.min(1, sample / Math.max(1, channelCount)));
  }
  return mono;
}

/**
 * Normalize browser audio to the mono 16 kHz input used by the local ASR models.
 * sherpa-onnx can resample internally, but normalizing here bounds IPC payloads
 * and avoids browser/codec-specific sample-rate behavior.
 */
export function normalizeAudioForLocalAsr(audio: AudioBuffer): Float32Array {
  const mono = downmixAudioBuffer(audio);
  if (audio.sampleRate === LOCAL_ASR_SAMPLE_RATE || mono.length === 0) return mono;

  const targetLength = Math.max(
    1,
    Math.round((mono.length * LOCAL_ASR_SAMPLE_RATE) / audio.sampleRate),
  );
  const output = new Float32Array(targetLength);
  const sourceFramesPerTarget = audio.sampleRate / LOCAL_ASR_SAMPLE_RATE;
  for (let targetIndex = 0; targetIndex < targetLength; targetIndex += 1) {
    const sourceStart = targetIndex * sourceFramesPerTarget;
    const sourceEnd = Math.min(mono.length, (targetIndex + 1) * sourceFramesPerTarget);
    const firstFrame = Math.floor(sourceStart);
    const lastFrame = Math.ceil(sourceEnd);
    let weightedSample = 0;
    let totalWeight = 0;
    for (let sourceIndex = firstFrame; sourceIndex < lastFrame; sourceIndex += 1) {
      const weight = Math.max(
        0,
        Math.min(sourceEnd, sourceIndex + 1) - Math.max(sourceStart, sourceIndex),
      );
      weightedSample += (mono[sourceIndex] ?? 0) * weight;
      totalWeight += weight;
    }
    output[targetIndex] = totalWeight > 0 ? weightedSample / totalWeight : 0;
  }
  return output;
}

export function encodeAudioBufferToWav(audio: AudioBuffer): Uint8Array {
  const samples = normalizeAudioForLocalAsr(audio);
  const frameCount = samples.length;
  const bytes = new Uint8Array(44 + frameCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, LOCAL_ASR_SAMPLE_RATE, true);
  view.setUint32(28, LOCAL_ASR_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, frameCount * 2, true);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = samples[frame] ?? 0;
    view.setInt16(44 + frame * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

export async function recordedAudioToWav(blob: Blob): Promise<Uint8Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    return encodeAudioBufferToWav(decoded);
  } finally {
    await context.close();
  }
}

/** Keep imported audio within a fixed recognition window, independent of capture preferences. */
export async function recordedAudioToWavChunks(blob: Blob): Promise<Uint8Array[]> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const framesPerChunk = Math.max(
      1,
      Math.floor(decoded.sampleRate * IMPORTED_AUDIO_CHUNK_SECONDS),
    );
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < decoded.length; offset += framesPerChunk) {
      const frameCount = Math.min(framesPerChunk, decoded.length - offset);
      const chunk = context.createBuffer(decoded.numberOfChannels, frameCount, decoded.sampleRate);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        chunk.copyToChannel(
          decoded.getChannelData(channel).subarray(offset, offset + frameCount),
          channel,
        );
      }
      chunks.push(encodeAudioBufferToWav(chunk));
    }
    return chunks;
  } finally {
    await context.close();
  }
}
