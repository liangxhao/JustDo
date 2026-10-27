import {
  LOCAL_ASR_DEFAULT_MODEL_ID,
  type LocalAsrLanguage,
  type LocalAsrModelId,
} from '@shared/speech/localAsr';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { LOCAL_TTS_MODEL_ID, type LocalTtsModelId } from '@shared/speech/localTts';

export interface LocalSpeechModelVoice {
  readonly id: string;
  /** Exact upstream speaker name; this is independent of the native numeric ID. */
  readonly name: string;
  readonly displayName?: string;
  /** Published speaker language classification, rather than a model language restriction. */
  readonly language?: 'zh' | 'en';
  readonly gender?: 'female' | 'male';
  readonly accent?: 'en-US' | 'en-GB';
}

export interface LocalSpeechModelCatalogEntry {
  readonly id: LocalAsrModelId | LocalTtsModelId;
  readonly kind: LocalSpeechModelKind;
  readonly name: string;
  readonly descriptionKey: string;
  /** Languages exposed by the application, rather than an upstream capability claim. */
  readonly languages: readonly Exclude<LocalAsrLanguage, 'auto'>[];
  readonly engine: string;
  readonly quantization?: 'INT8';
  readonly voices: readonly LocalSpeechModelVoice[];
}

// Verified snapshot of build/runtimes/local-tts/win-x64/
// kokoro-int8-multi-lang-v1_1/model.int8.onnx metadata_props.id2speaker.
// Language, gender and accent use the published speaker-prefix table:
// https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html
// Keep the native index order: all 103 voices are available to speech consumers.
const KOKORO_SPEAKER_NAMES = `
af_maple af_sol bf_vale
zf_001 zf_002 zf_003 zf_004 zf_005 zf_006 zf_007 zf_008
zf_017 zf_018 zf_019 zf_021 zf_022 zf_023 zf_024 zf_026 zf_027 zf_028
zf_032 zf_036 zf_038 zf_039 zf_040 zf_042 zf_043 zf_044 zf_046 zf_047
zf_048 zf_049 zf_051 zf_059 zf_060 zf_067 zf_070 zf_071 zf_072 zf_073
zf_074 zf_075 zf_076 zf_077 zf_078 zf_079 zf_083 zf_084 zf_085 zf_086
zf_087 zf_088 zf_090 zf_092 zf_093 zf_094 zf_099
zm_009 zm_010 zm_011 zm_012 zm_013 zm_014 zm_015 zm_016 zm_020 zm_025
zm_029 zm_030 zm_031 zm_033 zm_034 zm_035 zm_037 zm_041 zm_045 zm_050
zm_052 zm_053 zm_054 zm_055 zm_056 zm_057 zm_058 zm_061 zm_062 zm_063
zm_064 zm_065 zm_066 zm_068 zm_069 zm_080 zm_081 zm_082 zm_089 zm_091
zm_095 zm_096 zm_097 zm_098 zm_100
`
  .trim()
  .split(/\s+/);

// Verified snapshot of build/runtimes/local-tts/win-x64/
// vits-icefall-zh-aishell3/speakers.txt. Line order maps directly to native speaker IDs 0–173.
// These source labels do not include names, gender or speaking-style metadata.
const AISHELL3_SPEAKER_NAMES = `
SSB0005 SSB0009 SSB0011 SSB0012 SSB0016 SSB0018 SSB0033 SSB0038 SSB0043 SSB0057
SSB0073 SSB0080 SSB0112 SSB0122 SSB0133 SSB0139 SSB0145 SSB0149 SSB0193 SSB0197
SSB0200 SSB0241 SSB0246 SSB0261 SSB0267 SSB0273 SSB0287 SSB0288 SSB0299 SSB0307
SSB0309 SSB0315 SSB0316 SSB0323 SSB0338 SSB0339 SSB0341 SSB0342 SSB0354 SSB0366
SSB0375 SSB0379 SSB0380 SSB0382 SSB0385 SSB0393 SSB0394 SSB0395 SSB0407 SSB0415
SSB0426 SSB0427 SSB0434 SSB0435 SSB0470 SSB0482 SSB0502 SSB0534 SSB0535 SSB0539
SSB0544 SSB0565 SSB0570 SSB0578 SSB0588 SSB0590 SSB0594 SSB0599 SSB0601 SSB0603
SSB0606 SSB0607 SSB0609 SSB0614 SSB0623 SSB0629 SSB0631 SSB0632 SSB0666 SSB0668
SSB0671 SSB0686 SSB0700 SSB0710 SSB0720 SSB0723 SSB0737 SSB0746 SSB0748 SSB0751
SSB0758 SSB0760 SSB0762 SSB0778 SSB0780 SSB0784 SSB0786 SSB0794 SSB0817 SSB0851
SSB0863 SSB0871 SSB0887 SSB0913 SSB0915 SSB0919 SSB0935 SSB0966 SSB0987 SSB1008
SSB1020 SSB1024 SSB1050 SSB1055 SSB1056 SSB1064 SSB1072 SSB1091 SSB1096 SSB1100
SSB1108 SSB1115 SSB1125 SSB1131 SSB1136 SSB1138 SSB1161 SSB1203 SSB1204 SSB1218
SSB1221 SSB1253 SSB1320 SSB1341 SSB1366 SSB1377 SSB1383 SSB1385 SSB1392 SSB1393
SSB1408 SSB1431 SSB1437 SSB1448 SSB1555 SSB1563 SSB1567 SSB1575 SSB1585 SSB1593
SSB1607 SSB1624 SSB1625 SSB1630 SSB1650 SSB1670 SSB1684 SSB1686 SSB1699 SSB1711
SSB1759 SSB1806 SSB1828 SSB1831 SSB1832 SSB1837 SSB1846 SSB1863 SSB1878 SSB1891
SSB1918 SSB1935 SSB1939 SSB1956
`
  .trim()
  .split(/\s+/);

const LOCAL_SPEECH_MODEL_CATALOG: readonly LocalSpeechModelCatalogEntry[] = [
  {
    id: LOCAL_ASR_DEFAULT_MODEL_ID,
    kind: LocalSpeechModelKind.Asr,
    name: 'SenseVoice Small',
    descriptionKey: 'speechModelDescriptionSenseVoice',
    languages: ['zh', 'en', 'ja', 'ko', 'yue'],
    engine: 'Sherpa ONNX · SenseVoice',
    quantization: 'INT8',
    voices: [],
  },
  {
    id: 'sherpa-onnx-whisper-base',
    kind: LocalSpeechModelKind.Asr,
    name: 'Whisper Base',
    descriptionKey: 'speechModelDescriptionWhisper',
    languages: ['zh', 'en', 'ja', 'ko'],
    engine: 'Sherpa ONNX · Whisper',
    quantization: 'INT8',
    voices: [],
  },
  {
    id: LOCAL_TTS_MODEL_ID,
    kind: LocalSpeechModelKind.Tts,
    name: 'Kokoro v1.1',
    descriptionKey: 'speechModelDescriptionKokoro',
    languages: ['zh', 'en'],
    engine: 'Sherpa ONNX · Kokoro',
    quantization: 'INT8',
    voices: KOKORO_SPEAKER_NAMES.map((name, id) => ({
      id: String(id),
      name,
      language: id < 3 ? 'en' : 'zh',
      gender: id < 58 ? 'female' : 'male',
      ...(id < 3
        ? {
            displayName: ['Maple', 'Sol', 'Vale'][id],
            accent: id < 2 ? ('en-US' as const) : ('en-GB' as const),
          }
        : {}),
    })),
  },
  {
    id: 'vits-icefall-zh-aishell3',
    kind: LocalSpeechModelKind.Tts,
    name: 'AISHELL-3',
    descriptionKey: 'speechModelDescriptionAishell3',
    languages: ['zh'],
    engine: 'Sherpa ONNX · VITS',
    voices: AISHELL3_SPEAKER_NAMES.map((name, id) => ({
      id: String(id),
      name,
      language: 'zh',
    })),
  },
  {
    id: 'vits-piper-en_US-lessac-medium-int8',
    kind: LocalSpeechModelKind.Tts,
    name: 'Piper Lessac',
    descriptionKey: 'speechModelDescriptionPiperLessac',
    languages: ['en'],
    engine: 'Sherpa ONNX · Piper',
    quantization: 'INT8',
    // Verified n_speakers=1 / voice=en-us in the packaged ONNX metadata,
    // and dataset=lessac in en_US-lessac-medium.onnx.json.
    voices: [{ id: '0', name: 'Lessac', language: 'en', accent: 'en-US' }],
  },
];

export const getLocalSpeechModelCatalog = (
  kind: LocalSpeechModelKind,
): readonly LocalSpeechModelCatalogEntry[] =>
  LOCAL_SPEECH_MODEL_CATALOG.filter(model => model.kind === kind);

export const getLocalSpeechModelCatalogEntry = (
  id: string,
): LocalSpeechModelCatalogEntry | undefined =>
  LOCAL_SPEECH_MODEL_CATALOG.find(model => model.id === id);

export const getLocalSpeechVoiceOptions = (
  modelId: string,
  translate: (key: string) => string,
): { value: string; label: string }[] =>
  (getLocalSpeechModelCatalogEntry(modelId)?.voices ?? []).map(voice => {
    const displayName = getLocalSpeechVoiceDisplayName(voice, translate);
    return {
      value: voice.id,
      label: [
        displayName,
        voice.language !== 'zh' ? getLocalSpeechVoiceMetadata(voice, translate) : '',
        voice.name !== displayName ? voice.name : '',
        `#${voice.id}`,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });

export const getLocalSpeechVoiceDisplayName = (
  voice: LocalSpeechModelVoice,
  translate: (key: string) => string,
): string => {
  if (voice.displayName) return voice.displayName;
  if (voice.language === 'zh') {
    const key =
      voice.gender === 'female'
        ? 'voiceSpeakerChineseFemale'
        : voice.gender === 'male'
          ? 'voiceSpeakerChineseMale'
          : 'voiceSpeakerChinese';
    return `${translate(key)} ${voice.name.replace(/^z[fm]_/, '')}`;
  }
  return voice.name;
};

export const getLocalSpeechVoiceMetadata = (
  voice: LocalSpeechModelVoice,
  translate: (key: string) => string,
): string =>
  [
    voice.language === 'en'
      ? translate(
          voice.accent === 'en-US'
            ? 'voiceAccentAmerican'
            : voice.accent === 'en-GB'
              ? 'voiceAccentBritish'
              : 'english',
        )
      : voice.language === 'zh'
        ? translate('chinese')
        : '',
    voice.gender
      ? translate(voice.gender === 'female' ? 'voiceGenderFemale' : 'voiceGenderMale')
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
