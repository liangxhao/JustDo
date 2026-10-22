import type {
  LocalSpeechModelKind,
  LocalSpeechModelStatus,
} from '@shared/speech/localSpeechModels';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export function useLocalSpeechModels() {
  const [statuses, setStatuses] = useState<LocalSpeechModelStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const revision = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const apply = useCallback((status: LocalSpeechModelStatus) => {
    if (active.current)
      setStatuses(current => [...current.filter(candidate => candidate.id !== status.id), status]);
  }, []);

  useEffect(() => {
    active.current = true;
    const generation = ++revision.current;
    const changed = new Map<string, LocalSpeechModelStatus>();
    setLoading(true);
    setError('');
    const unsubscribe = window.electron.localSpeechModels.onChanged(status => {
      if (!active.current || generation !== revision.current) return;
      changed.set(status.id, status);
      apply(status);
    });
    void window.electron.localSpeechModels
      .list()
      .then(result => {
        if (!active.current || generation !== revision.current) return;
        setSupported(result.supported);
        setStatuses([
          ...result.models.filter(status => !changed.has(status.id)),
          ...changed.values(),
        ]);
      })
      .catch(() => {
        if (active.current && generation === revision.current)
          setError(i18nService.t('voiceModelLoadFailed'));
      })
      .finally(() => {
        if (active.current && generation === revision.current) setLoading(false);
      });
    return () => {
      active.current = false;
      unsubscribe();
    };
  }, [apply, refresh]);

  const run = (operation: 'install' | 'remove', kind: LocalSpeechModelKind, id: string) => {
    const generation = revision.current;
    setError('');
    void window.electron.localSpeechModels[operation](kind, id)
      .then(result => {
        if (!active.current || generation !== revision.current) return;
        apply(result.status);
      })
      .catch(() => {
        if (active.current && generation === revision.current)
          setError(i18nService.t('voiceModelDownloadFailed'));
      });
  };
  return {
    statuses,
    loading,
    supported,
    error,
    retry: () => setRefresh(current => current + 1),
    install: (kind: LocalSpeechModelKind, id: string) => run('install', kind, id),
    remove: (kind: LocalSpeechModelKind, id: string) => run('remove', kind, id),
  };
}
