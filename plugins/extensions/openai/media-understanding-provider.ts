import type { MediaUnderstandingProvider } from 'openclaw/plugin-sdk/media-understanding';

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: 'openai',
  capabilities: ['image', 'audio'],
  defaultModels: { image: 'gpt-6-astra' },
  autoPriority: { image: 20 },
  async describeImage(req) {
    const { describeImageWithModel } = await import('openclaw/plugin-sdk/media-understanding');
    return describeImageWithModel(req);
  },
  async describeImages(req) {
    const { describeImagesWithModel } = await import('openclaw/plugin-sdk/media-understanding');
    return describeImagesWithModel(req);
  },
  async transcribeAudio(req) {
    const { transcribeOpenAiAudio } = await import('./audio-transcription.js');
    return transcribeOpenAiAudio(req);
  },
  async transcribeAudioWithContext(context) {
    const { transcribeOpenAiAudioWithContext } = await import('./audio-transcription.js');
    return transcribeOpenAiAudioWithContext(context);
  },
};
