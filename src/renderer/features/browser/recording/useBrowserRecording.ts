import type { BrowserPanelTab } from '@shared/browser/browser';
import {
  BrowserRecordingChannel,
  type BrowserRecordingSession,
  type BrowserRecordingStep,
  parseRecordingEvent,
  RECORDING_LIMITS,
  RecordingAction,
  recordingPageTitle,
  RecordingScreenshotIssue,
  RecordingStatus,
  recordingUrl,
  serializeRecording,
} from '@shared/browser/browserRecording';
import { useEffect, useRef, useState } from 'react';

type Guest = HTMLElement & {
  send: (channel: string, ...args: unknown[]) => void;
  getURL: () => string;
  capturePage: () => Promise<{ toDataURL: () => string }>;
};
type Options = {
  draftKey: string;
  isOpen: boolean;
  activeTab: BrowserPanelTab | undefined;
  tabs: BrowserPanelTab[];
  guests: React.MutableRefObject<Map<string, Guest>>;
};

export function useBrowserRecording(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [session, setSession] = useState<BrowserRecordingSession | null>(null);
  const ref = useRef(session);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const documents = useRef(new Map<string, { id: string; sequence: number }>());
  const drains = useRef(new Map<string, { requestId: string; resolve: () => void }>());
  const pendingDrain = useRef<Promise<void> | null>(null);
  const starting = useRef(false);
  const startGeneration = useRef(0);
  const leaseOwner = useRef<{ recordingId: string; sessionId: string } | null>(null);
  const captures = useRef(
    new Map<
      string,
      (value: { documentId: string; safe: boolean; revision: number; pageId: string }) => void
    >(),
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  const update = (next: BrowserRecordingSession | null) => {
    ref.current = next;
    if (mounted.current) setSession(next);
  };
  const control = (active: boolean, requestId?: string) => {
    const s = ref.current;
    if (!s) return;
    for (const [id, guest] of current.current.guests.current) {
      try {
        guest.send(BrowserRecordingChannel.Control, {
          recordingId: s.id,
          requestId,
          active: active && id === current.current.activeTab?.targetId,
        });
      } catch {
        /* guest detached */
      }
    }
  };
  const release = (s: BrowserRecordingSession) =>
    window.electron.browser
      .setRecordingLease({
        recordingId: s.id,
        sessionId:
          leaseOwner.current?.recordingId === s.id ? leaseOwner.current.sessionId : s.sessionId,
        profile: s.profile,
        acquire: false,
      })
      .catch(() => false);
  const append = (step: BrowserRecordingStep) => {
    const s = ref.current;
    if (!s || s.status !== RecordingStatus.Recording) return;
    let steps = [...s.steps];
    const last = steps[steps.length - 1];
    if (
      step.action === RecordingAction.DoubleClick &&
      last?.action === RecordingAction.Click &&
      last.pageId === step.pageId &&
      last.target?.selector === step.target?.selector &&
      JSON.stringify(last.target?.scopes ?? []) === JSON.stringify(step.target?.scopes ?? []) &&
      step.at - last.at < 600
    ) {
      steps = steps.slice(0, -1);
    }
    if (steps.length >= RECORDING_LIMITS.steps) return;
    const nextSteps = [...steps, step].sort((a, b) => a.at - b.at);
    const next = {
      ...s,
      steps: nextSteps,
      images: s.images.filter(image => nextSteps.some(item => item.id === image.stepId)),
      screenshotWarning: nextSteps.some(item => item.screenshotIssue),
    };
    try {
      serializeRecording(next);
    } catch {
      update({ ...s, limited: true });
      void stop();
      return;
    }
    update(next);
    if (next.steps.length >= RECORDING_LIMITS.steps) {
      update({ ...next, limited: true });
      void stop();
    }
  };
  const hostStep = (action: BrowserRecordingStep['action'], tab: BrowserPanelTab) => {
    const step = {
      id: crypto.randomUUID(),
      action,
      pageId: tab.targetId,
      at: Date.now() - (ref.current?.startedAt ?? Date.now()),
      url: recordingUrl(tab.url),
      title: recordingPageTitle(tab.title),
    };
    append(step);
    return step;
  };
  const capture = async (step: BrowserRecordingStep, expectedDocument: string | undefined) => {
    const s = ref.current;
    const guest = current.current.guests.current.get(step.pageId);
    if (
      !s ||
      s.status !== RecordingStatus.Recording ||
      !guest ||
      current.current.activeTab?.targetId !== step.pageId
    )
      return;
    const doc = documents.current.get(step.pageId)?.id;
    if (!doc || doc !== expectedDocument) return;
    const url = guest.getURL();
    const warn = (screenshotIssue: BrowserRecordingStep['screenshotIssue']) => {
      const latest = ref.current;
      if (latest?.id !== s.id || latest.status !== RecordingStatus.Recording) return;
      update({
        ...latest,
        screenshotWarning: true,
        steps: latest.steps.map(item =>
          item.id === step.id ? { ...item, screenshotIssue } : item,
        ),
      });
    };
    if (s.images.length >= RECORDING_LIMITS.screenshots) {
      warn(RecordingScreenshotIssue.Limit);
      return;
    }
    let failureReason: BrowserRecordingStep['screenshotIssue'] = RecordingScreenshotIssue.Timeout;
    const checkSafety = () =>
      new Promise<number | null>(resolve => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          captures.current.delete(requestId);
          resolve(null);
        }, 1000);
        captures.current.set(requestId, result => {
          clearTimeout(timer);
          captures.current.delete(requestId);
          failureReason =
            result.safe === false
              ? RecordingScreenshotIssue.Password
              : RecordingScreenshotIssue.Changed;
          resolve(
            result.safe === true &&
              result.documentId === doc &&
              result.pageId === step.pageId &&
              Number.isSafeInteger(result.revision)
              ? result.revision
              : null,
          );
        });
        try {
          guest.send(BrowserRecordingChannel.Capture, requestId);
        } catch {
          clearTimeout(timer);
          captures.current.delete(requestId);
          resolve(null);
        }
      });
    const revision = await checkSafety();
    if (revision === null) {
      warn(failureReason);
      return;
    }
    try {
      const raw = (await guest.capturePage()).toDataURL();
      failureReason = RecordingScreenshotIssue.Timeout;
      const afterRevision = await checkSafety();
      if (afterRevision !== revision) {
        warn(afterRevision === null ? failureReason : RecordingScreenshotIssue.Changed);
        return;
      }
      const image = new Image();
      image.src = raw;
      await image.decode();
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, RECORDING_LIMITS.imageEdge / Math.max(image.width, image.height));
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      const latest = ref.current;
      if (
        !latest ||
        latest.id !== s.id ||
        latest.status !== RecordingStatus.Recording ||
        guest.getURL() !== url ||
        documents.current.get(step.pageId)?.id !== doc ||
        current.current.activeTab?.targetId !== step.pageId ||
        !latest.steps.some(item => item.id === step.id)
      )
        return;
      if (
        latest.images.length >= RECORDING_LIMITS.screenshots ||
        [...latest.images.map(i => i.dataUrl), dataUrl].reduce((n, v) => n + v.length * 0.75, 0) >
          RECORDING_LIMITS.imageBytes
      ) {
        warn(RecordingScreenshotIssue.Limit);
        return;
      }
      update({
        ...latest,
        steps: latest.steps.map(item =>
          item.id === step.id ? { ...item, screenshotIssue: undefined } : item,
        ),
        screenshotWarning: latest.steps.some(item => item.id !== step.id && item.screenshotIssue),
        images: [
          ...latest.images.filter(image => image.stepId !== step.id),
          { stepId: step.id, dataUrl, fileName: `demonstration-${step.id}.jpg` },
        ],
      });
    } catch {
      warn(RecordingScreenshotIssue.Failed);
    }
  };
  const scheduleCapture = (step: BrowserRecordingStep) => {
    clearTimeout(timers.current.get(step.pageId));
    const expectedDocument = documents.current.get(step.pageId)?.id;
    timers.current.set(
      step.pageId,
      setTimeout(() => {
        void capture(step, expectedDocument);
      }, 600),
    );
  };
  const onMessage = (pageId: string, channel: string, raw: unknown) => {
    const s = ref.current;
    if (!s) return;
    if (channel === BrowserRecordingChannel.Capture && raw && typeof raw === 'object') {
      const v = raw as { requestId: string; documentId: string; safe: boolean; revision: number };
      captures.current.get(v.requestId)?.({ ...v, pageId });
      return;
    }
    if (channel === BrowserRecordingChannel.Ready && raw && typeof raw === 'object') {
      const v = raw as {
        recordingId: string;
        documentId: string;
        active?: boolean;
        requestId?: string;
      };
      const pending = drains.current.get(pageId);
      if (v.recordingId === s.id && v.active === false && pending?.requestId === v.requestId)
        pending?.resolve();
      if (
        v.recordingId === s.id &&
        typeof v.documentId === 'string' &&
        !documents.current.has(pageId)
      ) {
        documents.current.set(pageId, { id: v.documentId, sequence: 0 });
        const last = s.steps[s.steps.length - 1];
        if (v.active && last?.pageId === pageId) scheduleCapture(last);
      }
      return;
    }
    if (channel !== BrowserRecordingChannel.Event) return;
    const event = parseRecordingEvent(raw);
    const tab = current.current.tabs.find(t => t.targetId === pageId);
    const doc = documents.current.get(pageId);
    if (
      !event ||
      s.status !== RecordingStatus.Recording ||
      !tab ||
      !doc ||
      event.recordingId !== s.id ||
      doc.id !== event.documentId ||
      event.sequence <= doc.sequence ||
      (tab.profile ?? 'embedded') !== s.profile ||
      (pageId !== current.current.activeTab?.targetId && !drains.current.has(pageId))
    )
      return;
    doc.sequence = event.sequence;
    if (event.action === RecordingAction.Observe) {
      const id = `${event.documentId}:${event.relatedSequence}`;
      const observed = event.interaction?.observed;
      if (observed) {
        const next = {
          ...s,
          steps: s.steps.map(step =>
            step.id === id && !step.sensitive
              ? { ...step, interaction: { ...step.interaction, observed } }
              : step,
          ),
        };
        try {
          serializeRecording(next);
          update(next);
        } catch {
          update({ ...s, limited: true });
        }
      }
      return;
    }
    const step: BrowserRecordingStep = {
      id: `${event.documentId}:${event.sequence}`,
      action: event.action,
      pageId,
      at: Math.max(0, Math.min(Date.now(), event.time ?? Date.now()) - s.startedAt),
      title: event.title ?? recordingPageTitle(tab.title),
      url: event.url ?? recordingUrl(tab.url),
      target: event.target,
      value: event.value,
      sensitive: event.sensitive,
      interaction: event.interaction,
    };
    append(step);
    if (
      [
        RecordingAction.Click,
        RecordingAction.DoubleClick,
        RecordingAction.Select,
        RecordingAction.Input,
        RecordingAction.Key,
        RecordingAction.ContextMenu,
        RecordingAction.Drag,
        RecordingAction.Hover,
      ].includes(event.action as 'click')
    )
      scheduleCapture(step);
  };
  const onReady = (pageId: string) => {
    documents.current.delete(pageId);
    const s = ref.current;
    if (s) {
      try {
        current.current.guests.current.get(pageId)?.send(BrowserRecordingChannel.Control, {
          recordingId: s.id,
          active:
            s.status === RecordingStatus.Recording &&
            current.current.activeTab?.targetId === pageId,
        });
      } catch {
        /* detached */
      }
    }
  };
  const onNavigation = (pageId: string, url: string) => {
    const s = ref.current;
    const tab = current.current.tabs.find(item => item.targetId === pageId);
    if (
      !s ||
      !tab ||
      (tab.profile ?? 'embedded') !== s.profile ||
      (!s.steps.some(step => step.pageId === pageId) &&
        current.current.activeTab?.targetId !== pageId)
    )
      return;
    const last = s.steps[s.steps.length - 1];
    if (
      last?.pageId === pageId &&
      !documents.current.has(pageId) &&
      last.action === RecordingAction.OpenTab &&
      last.url === recordingUrl(url)
    )
      return;
    scheduleCapture(
      hostStep(RecordingAction.Navigate, {
        ...tab,
        url,
        title: tab.url === url ? tab.title : '',
      }),
    );
  };
  const start = async () => {
    if (ref.current || starting.current) return;
    const tab = current.current.activeTab;
    if (!tab || !/^https?:/.test(tab.url)) return;
    starting.current = true;
    const generation = startGeneration.current;
    setBusy(true);
    setFailed(false);
    const s: BrowserRecordingSession = {
      id: crypto.randomUUID(),
      sessionId: current.current.draftKey,
      profile: tab.profile ?? 'embedded',
      startedAt: Date.now(),
      title: '',
      note: '',
      steps: [],
      images: [],
      status: RecordingStatus.Recording,
    };
    try {
      const granted = await window.electron.browser.setRecordingLease({
        recordingId: s.id,
        sessionId: s.sessionId,
        profile: s.profile,
        acquire: true,
      });
      if (!granted) {
        setFailed(true);
        return;
      }
      leaseOwner.current = { recordingId: s.id, sessionId: s.sessionId };
      const activeTab = current.current.activeTab;
      if (
        !mounted.current ||
        generation !== startGeneration.current ||
        current.current.draftKey !== s.sessionId ||
        !current.current.isOpen ||
        !activeTab ||
        !/^https?:/.test(activeTab.url) ||
        (activeTab.profile ?? 'embedded') !== s.profile
      ) {
        await release(s);
        return;
      }
      documents.current.clear();
      update(s);
      control(true);
      scheduleCapture(hostStep(RecordingAction.OpenTab, activeTab));
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const drain = (): Promise<void> => {
    if (pendingDrain.current) return pendingDrain.current;
    const recordingId = ref.current?.id;
    const requestId = crypto.randomUUID();
    const pending = [...documents.current.keys()].map(
      pageId =>
        new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            drains.current.delete(pageId);
            if (ref.current && ref.current.id === recordingId)
              update({ ...ref.current, incomplete: true });
            resolve();
          }, 1000);
          drains.current.set(pageId, {
            requestId,
            resolve: () => {
              clearTimeout(timer);
              drains.current.delete(pageId);
              resolve();
            },
          });
        }),
    );
    const promise = Promise.all(pending).then(() => {
      if (pendingDrain.current === promise) pendingDrain.current = null;
    });
    pendingDrain.current = promise;
    control(false, requestId);
    return promise;
  };
  const pause = async () => {
    if (ref.current?.status !== RecordingStatus.Recording) return;
    const id = ref.current.id;
    await drain();
    if (ref.current?.id === id && ref.current.status === RecordingStatus.Recording) {
      control(false);
      update({ ...ref.current, status: RecordingStatus.Paused });
    }
  };
  const resume = () => {
    const s = ref.current;
    const tab = current.current.activeTab;
    if (
      !s ||
      !tab ||
      current.current.draftKey !== s.sessionId ||
      (tab.profile ?? 'embedded') !== s.profile
    )
      return;
    update({ ...s, status: RecordingStatus.Recording });
    hostStep(RecordingAction.Gap, tab);
    control(true);
  };
  const stop = async () => {
    if (!ref.current || ref.current.status === RecordingStatus.Review) return;
    const id = ref.current.id;
    await drain();
    const s = ref.current;
    if (!s || s.id !== id) return;
    control(false);
    update({ ...s, status: RecordingStatus.Review });
    await release(s);
  };
  const clear = () => {
    control(false);
    for (const drain of drains.current.values()) drain.resolve();
    if (ref.current) void release(ref.current);
    for (const timer of timers.current.values()) clearTimeout(timer);
    update(null);
  };
  // Only explicit home -> temporary -> canonical session promotions may transfer ownership.
  // Ordinary session selection must keep the recording attached to its original session.
  const promoteSession = (fromSessionId: string, toSessionId: string) => {
    if (fromSessionId === toSessionId) return;
    if (starting.current && current.current.draftKey === fromSessionId)
      startGeneration.current += 1;
    const s = ref.current;
    if (s?.sessionId === fromSessionId) update({ ...s, sessionId: toSessionId });
  };
  const previousTabs = useRef(options.tabs);
  const switchSequence = useRef(0);
  const actions = useRef({
    hostStep,
    scheduleCapture,
    stop,
    pause,
    drain,
    control,
    release,
    update,
  });
  actions.current = { hostStep, scheduleCapture, stop, pause, drain, control, release, update };
  useEffect(() => {
    const { hostStep, stop } = actions.current;
    for (const pageId of documents.current.keys()) {
      if (options.tabs.some(tab => tab.targetId === pageId)) continue;
      documents.current.delete(pageId);
      clearTimeout(timers.current.get(pageId));
      timers.current.delete(pageId);
      const pending = drains.current.get(pageId);
      if (pending) {
        if (ref.current) actions.current.update({ ...ref.current, incomplete: true });
        pending.resolve();
      }
    }
    const s = ref.current;
    if (s?.status === RecordingStatus.Recording) {
      for (const tab of previousTabs.current) {
        if (
          !options.tabs.some(t => t.targetId === tab.targetId) &&
          s.steps.some(step => step.pageId === tab.targetId)
        )
          hostStep(RecordingAction.CloseTab, tab);
      }
      if (!options.tabs.length) void stop();
      else if (!pendingDrain.current) actions.current.control(true);
    }
    previousTabs.current = options.tabs;
  }, [options.tabs]);
  useEffect(() => {
    const { pause, drain, hostStep, control } = actions.current;
    const sequence = ++switchSequence.current;
    const s = ref.current;
    if (!s || s.status !== RecordingStatus.Recording) return;
    const tab = current.current.activeTab;
    if (
      !options.isOpen ||
      options.draftKey !== s.sessionId ||
      !tab ||
      (tab.profile ?? 'embedded') !== s.profile
    ) {
      void pause();
      return;
    }
    void (async () => {
      await drain();
      if (
        sequence !== switchSequence.current ||
        ref.current?.id !== s.id ||
        ref.current.status !== RecordingStatus.Recording ||
        !current.current.isOpen ||
        current.current.activeTab?.targetId !== tab.targetId ||
        current.current.draftKey !== ref.current.sessionId ||
        (current.current.activeTab?.profile ?? 'embedded') !== s.profile
      )
        return;
      hostStep(
        s.steps.some(step => step.pageId === tab.targetId)
          ? RecordingAction.SwitchTab
          : RecordingAction.OpenTab,
        tab,
      );
      control(true);
    })();
  }, [options.activeTab?.targetId, options.isOpen, options.draftKey]);
  useEffect(() => {
    const captureTimers = timers.current;
    const timer = setInterval(() => {
      const s = ref.current;
      if (
        s &&
        s.status !== RecordingStatus.Review &&
        Date.now() - s.startedAt >= RECORDING_LIMITS.durationMs
      ) {
        actions.current.update({ ...s, limited: true });
        void actions.current.stop();
      }
    }, 1000);
    mounted.current = true;
    return () => {
      clearInterval(timer);
      mounted.current = false;
      actions.current.control(false);
      if (ref.current) void actions.current.release(ref.current);
      for (const timer of captureTimers.values()) clearTimeout(timer);
    };
  }, []);
  return {
    session,
    busy,
    failed,
    start,
    pause,
    resume,
    stop,
    clear,
    update,
    onMessage,
    onReady,
    onNavigation,
    drain,
    promoteSession,
  };
}
