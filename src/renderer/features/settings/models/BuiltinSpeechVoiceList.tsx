import {
  ArrowPathIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useId, useMemo, useState } from 'react';

import {
  getLocalSpeechVoiceDisplayName,
  getLocalSpeechVoiceMetadata,
  type LocalSpeechModelCatalogEntry,
} from '@/features/speech/localSpeechModelCatalog';
import { useBuiltinSpeechVoicePreview } from '@/features/speech/useBuiltinSpeechVoicePreview';
import { i18nService } from '@/services/i18n';

export default function BuiltinSpeechVoiceList({
  model,
  previewAvailable,
}: {
  model: LocalSpeechModelCatalogEntry;
  previewAvailable: boolean;
}) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const [gender, setGender] = useState('');
  const titleId = useId();
  const preview = useBuiltinSpeechVoicePreview(model.id, previewAvailable);
  const { stop } = preview;
  const languages = [...new Set(model.voices.map(voice => voice.language).filter(Boolean))];
  const genders = [...new Set(model.voices.map(voice => voice.gender ?? 'unknown'))];
  const voices = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return model.voices.filter(
      voice =>
        (!language || voice.language === language) &&
        (!gender || (voice.gender ?? 'unknown') === gender) &&
        (!search ||
          [
            getLocalSpeechVoiceDisplayName(voice, i18nService.t.bind(i18nService)),
            getLocalSpeechVoiceMetadata(voice, i18nService.t.bind(i18nService)),
            voice.name,
            `#${voice.id}`,
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(search)),
    );
  }, [gender, language, model.voices, query]);

  useEffect(() => {
    stop();
  }, [gender, language, query, stop]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {i18nService.t('speechModelVoices')}
        </h3>
        <span role="status" className="text-xs tabular-nums text-secondary">
          {voices.length === model.voices.length
            ? voices.length
            : `${voices.length} / ${model.voices.length}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-36 flex-1">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted"
          />
          <input
            type="search"
            aria-label={i18nService.t('speechVoiceSearch')}
            placeholder={i18nService.t('speechVoiceSearch')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        {languages.length > 1 && (
          <select
            aria-label={i18nService.t('speechVoiceLanguageFilter')}
            value={language}
            onChange={event => setLanguage(event.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{i18nService.t('speechVoiceAllLanguages')}</option>
            {languages.map(value => (
              <option key={value} value={value}>
                {i18nService.t(value === 'zh' ? 'chinese' : 'english')}
              </option>
            ))}
          </select>
        )}
        {genders.length > 1 && (
          <select
            aria-label={i18nService.t('speechVoiceGenderFilter')}
            value={gender}
            onChange={event => setGender(event.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{i18nService.t('speechVoiceAllGenders')}</option>
            {genders.map(value => (
              <option key={value} value={value}>
                {i18nService.t(
                  value === 'female'
                    ? 'voiceGenderFemale'
                    : value === 'male'
                      ? 'voiceGenderMale'
                      : 'speechVoiceGenderUnknown',
                )}
              </option>
            ))}
          </select>
        )}
      </div>
      <div
        role="region"
        aria-labelledby={titleId}
        tabIndex={0}
        className="max-h-72 overflow-y-auto rounded-xl border border-border p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        {voices.length ? (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {voices.map(voice => {
              const name = getLocalSpeechVoiceDisplayName(voice, i18nService.t.bind(i18nService));
              const active = preview.active?.voiceId === voice.id;
              const loading = active && preview.active?.phase === 'loading';
              const action = i18nService.t(
                active ? 'speechVoiceStopPreview' : 'speechVoicePreview',
              );
              const metadata = getLocalSpeechVoiceMetadata(voice, i18nService.t.bind(i18nService));
              return (
                <li
                  key={voice.id}
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 ${active ? 'bg-primary-muted' : 'bg-background'}`}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs font-medium text-foreground"
                      title={[name, metadata].filter(Boolean).join(' · ')}
                    >
                      {name}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-secondary">
                      {voice.language === 'en' && <span>{metadata} · </span>}
                      <code>
                        {voice.name} · #{voice.id}
                      </code>
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!previewAvailable}
                    aria-label={`${action}: ${name}`}
                    title={
                      previewAvailable
                        ? `${action}: ${name}`
                        : i18nService.t('speechVoicePreviewNeedsModel')
                    }
                    onClick={() => (active ? preview.stop() : void preview.play(voice))}
                    className="shrink-0 rounded-lg p-1.5 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-40"
                  >
                    {loading ? (
                      <ArrowPathIcon
                        aria-hidden="true"
                        className="h-4 w-4 animate-spin motion-reduce:animate-spin"
                      />
                    ) : active ? (
                      <StopIcon aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <PlayIcon aria-hidden="true" className="h-4 w-4" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-secondary">
            {i18nService.t('speechVoiceNoResults')}
          </p>
        )}
      </div>
      {preview.failed && (
        <p role="alert" className="text-xs text-red-500">
          {i18nService.t('speechVoicePreviewFailed')}
        </p>
      )}
      <p className="text-[11px] text-secondary">{i18nService.t('speechVoiceStyleHint')}</p>
    </section>
  );
}
