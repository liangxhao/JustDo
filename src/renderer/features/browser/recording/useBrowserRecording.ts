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
import {
  RECORDING_NETWORK_LIMITS,
  type RecordingNetworkCommand,
  RecordingNetworkCoverage,
  type RecordingNetworkCoverageIssue,
  type RecordingNetworkPageRef,
  type RecordingNetworkReply,
} from '@shared/browser/browserRecordingNetwork';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  associateRecordingNetwork,
  type RecordingNetworkAction,
  type RecordingNetworkNavigation,
} from './browserRecordingNetworkAssociation';

type Guest = HTMLElement & {
  send: (channel: string, ...args: unknown[]) => void;
  getURL: () => string;
  getWebContentsId?: () => number;
  capturePage: () => Promise<{ toDataURL: () => string }>;
};
type Options = {
  draftKey: string;
  isOpen: boolean;
  activeTab: BrowserPanelTab | undefined;
  tabs: BrowserPanelTab[];
  guests: React.MutableRefObject<Map<string, Guest>>;
  isInitialNavigationPending?: (targetId: string) => boolean;
};

type NetworkOperation<T = RecordingNetworkCommand> = T extends RecordingNetworkCommand
  ? Omit<T, 'lease' | 'sequence'>
  : never;
type NetworkTarget = {
  targetId: string | undefined;
  page: RecordingNetworkPageRef | null;
  ready: Promise<boolean>;
  cancel: () => void;
  waiting?: boolean;
  retry?: Promise<boolean>;
  retried?: boolean;
};
type PauseReason = 'manual' | 'visibility';
type RecordingStart = Pick<BrowserRecordingSession, 'sessionId' | 'profile'> & {
  settled: Promise<void>;
  lateStart?: true;
};

export const isRecordableBrowserTab = (tab: BrowserPanelTab): boolean =>
  !tab.sourceFilePath && (tab.url === 'about:blank' || /^https?:/.test(tab.url));

function getGuestId(guest: Guest | undefined): number | undefined {
  try {
    const id = guest?.getWebContentsId?.();
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function withRecordingTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void work.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export function useBrowserRecording(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [session, setSession] = useState<BrowserRecordingSession | null>(null);
  const ref = useRef(session);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [networkStatus, setNetworkStatus] = useState<'waiting' | 'ready' | 'unavailable'>('waiting');
  const documents = useRef(new Map<string, { id: string; sequence: number }>());
  const drains = useRef(new Map<string, { requestId: string; resolve: () => void }>());
  const pendingDrain = useRef<Promise<void> | null>(null);
  const starting = useRef<RecordingStart>();
  const startGeneration = useRef(0);
  const leaseOwner = useRef<{ recordingId: string; sessionId: string } | null>(null);
  const networkSequence = useRef(0);
  const networkTarget = useRef<NetworkTarget>();
  const networkCoverage = useRef(new Set<RecordingNetworkCoverageIssue>());
  const networkActions = useRef<RecordingNetworkAction[]>([]);
  const networkNavigations = useRef<RecordingNetworkNavigation[]>([]);
  const networkPromotions = useRef<Array<{ from: string; to: string }>>([]);
  const domActiveTarget = useRef<string>();
  const pauseReason = useRef<PauseReason>();
  const stopping = useRef<Promise<void>>();
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

  const sendNetwork = async (
    s: BrowserRecordingSession,
    operation: NetworkOperation,
  ): Promise<RecordingNetworkReply | undefined> => {
    const owner = leaseOwner.current;
    if (owner?.recordingId !== s.id) return undefined;
    const sequence = ++networkSequence.current;
    try {
      const reply = await window.electron.browser.recordingNetwork?.({
        ...operation,
        lease: { recordingId: s.id, sessionId: owner.sessionId, profile: s.profile },
        sequence,
      });
      if (
        !reply ||
        reply.status === 'denied' ||
        reply.recordingId !== s.id ||
        reply.sequence !== sequence ||
        networkSequence.current !== sequence ||
        ref.current?.id !== s.id
      ) return undefined;
      return reply;
    } catch {
      return undefined;
    }
  };
  const getNetworkPage = (tab: BrowserPanelTab): RecordingNetworkPageRef | null => {
    const expectedWebContentsId = getGuestId(current.current.guests.current.get(tab.targetId));
    return expectedWebContentsId === undefined ? null : {
      resourceSessionId: tab.resourceSessionId ?? current.current.draftKey,
      targetId: tab.targetId,
      expectedWebContentsId,
    };
  };
  const clearNetworkTarget = (): void => {
    networkTarget.current?.cancel();
    networkTarget.current = undefined;
  };
  const prepareNetwork = (
    s: BrowserRecordingSession,
    tab: BrowserPanelTab,
    start = false,
    retried = false,
  ): Promise<boolean> => {
    if (networkPromotions.current.length && !tab.resourceSessionId) return Promise.resolve(false);
    const page = getNetworkPage(tab);
    const prior = networkTarget.current;
    if (
      !start && !retried && prior?.targetId === tab.targetId &&
      prior.page?.expectedWebContentsId === page?.expectedWebContentsId &&
      prior.page?.resourceSessionId === page?.resourceSessionId
    ) return prior.ready;

    prior?.cancel();
    setNetworkStatus('waiting');
    let cancel = () => {};
    const canceled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    const target: NetworkTarget = {
      targetId: tab.targetId,
      page,
      cancel,
      retried,
      ready: Promise.race([canceled, sendNetwork(s, start
        ? { action: 'start', page }
        : { action: 'setTarget', page, requestedAtMs: Date.now() },
      ).then(reply => {
        if (networkTarget.current !== target || ref.current?.id !== s.id || !mounted.current)
          return false;
        if (reply?.status === 'ready') {
          setNetworkStatus('ready');
          return true;
        }
        target.waiting = reply?.status === 'waiting';
        if (reply?.status !== 'waiting' && reply?.status !== 'stale') {
          setNetworkStatus('unavailable');
          networkCoverage.current.add(RecordingNetworkCoverage.Unavailable);
        }
        return false;
      })]),
    };
    networkTarget.current = target;
    return target.ready;
  };
  const shouldPrepareNavigation = (tab: BrowserPanelTab): boolean => {
    const s = ref.current;
    const owner = s?.status === RecordingStatus.Recording ? s : starting.current;
    return Boolean(owner && current.current.isOpen && !pauseReason.current && !stopping.current &&
      current.current.draftKey === owner.sessionId && (tab.profile ?? 'embedded') === owner.profile &&
      isRecordableBrowserTab(tab));
  };
  const waitForNetworkReady = (pageId: string, timeoutMs?: number, registered = false): Promise<boolean> => {
    const prepare = (): Promise<boolean> => {
      const s = ref.current;
      const { activeTab } = current.current;
      if (!s || activeTab?.targetId !== pageId || !shouldPrepareNavigation(activeTab))
        return Promise.resolve(false);
      const ready = prepareNetwork(s, activeTab);
      const target = networkTarget.current;
      if (!registered || !target?.page || target.retried) return ready;
      return ready.then(result => {
        if (target.retry) return target.retry;
        if (result || !target.waiting || networkTarget.current !== target) return result;
        target.retry = prepareNetwork(s, activeTab, false, true);
        return target.retry;
      });
    };
    const started = starting.current;
    const ready = started ? started.settled.then(prepare) : prepare();
    return timeoutMs === undefined ? ready : withRecordingTimeout(ready, timeoutMs).then(Boolean);
  };
  const markNetworkLateStart = (pageId: string) => {
    const tab = current.current.activeTab;
    if (tab?.targetId !== pageId || !shouldPrepareNavigation(tab)) return;
    if (ref.current?.status === RecordingStatus.Recording) {
      networkCoverage.current.add(RecordingNetworkCoverage.LateStart);
    } else {
      const intent = starting.current;
      if (intent?.sessionId === current.current.draftKey) intent.lateStart = true;
    }
  };
  const closeNetworkTarget = (pageId: string): void => {
    const s = ref.current;
    if (!s || stopping.current || networkTarget.current?.targetId !== pageId) return;
    clearNetworkTarget();
    void sendNetwork(s, { action: 'pause', requestedAtMs: Date.now() });
  };
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
      ((pauseReason.current || stopping.current) && !drains.current.has(pageId)) ||
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
    const webContentsId = getGuestId(current.current.guests.current.get(pageId));
    if (
      webContentsId !== undefined && event.occurredAt !== undefined &&
      networkActions.current.length < RECORDING_LIMITS.steps * 2
    ) {
      networkActions.current.push({
        stepId: step.id,
        webContentsId,
        at: event.occurredAt,
        firstInputAt: event.firstInputAt,
        childFrame: Boolean(event.target?.frameUrl || event.target?.scopes?.some(scope => scope.kind === 'frame')),
      });
    }
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
            !pauseReason.current && !stopping.current && domActiveTarget.current === pageId &&
            current.current.activeTab?.targetId === pageId,
        });
      } catch {
        /* detached */
      }
    }
  };
  const addNetworkNavigation = (
    pageId: string,
    kind: RecordingNetworkNavigation['kind'],
    at: number,
    stepId?: string,
  ) => {
    const webContentsId = getGuestId(current.current.guests.current.get(pageId));
    if (
      webContentsId !== undefined && ref.current?.status === RecordingStatus.Recording &&
      !pauseReason.current && !stopping.current && current.current.activeTab?.targetId === pageId &&
      networkNavigations.current.length < RECORDING_NETWORK_LIMITS.documents * 3
    ) networkNavigations.current.push({ pageId, webContentsId, kind, at, stepId });
  };
  const onNavigation = (pageId: string, url: string, inPage = false) => {
    const at = Date.now();
    const s = ref.current;
    const tab = current.current.tabs.find(item => item.targetId === pageId);
    if (
      !s ||
      s.status !== RecordingStatus.Recording || pauseReason.current || stopping.current ||
      !tab ||
      (tab.profile ?? 'embedded') !== s.profile ||
      url === 'about:blank' ||
      current.current.activeTab?.targetId !== pageId
    )
      return;
    const last = s.steps[s.steps.length - 1];
    if (
      last?.pageId === pageId &&
      !documents.current.has(pageId) &&
      last.action === RecordingAction.OpenTab &&
      last.url === recordingUrl(url)
    ) {
      addNetworkNavigation(pageId, inPage ? 'in-page' : 'commit', at, last.id);
      return;
    }
    const step = hostStep(RecordingAction.Navigate, {
      ...tab,
      url,
      title: tab.url === url ? tab.title : '',
    });
    addNetworkNavigation(pageId, inPage ? 'in-page' : 'commit', at, step.id);
    scheduleCapture(step);
  };
  const onNavigationStart = (pageId: string) => addNetworkNavigation(pageId, 'start', Date.now());
  const start = async () => {
    if (ref.current || starting.current) return;
    const tab = current.current.activeTab;
    if (!tab || !isRecordableBrowserTab(tab)) return;
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
    let settle = () => {};
    const intent: RecordingStart = {
      sessionId: s.sessionId,
      profile: s.profile,
      settled: new Promise(resolve => { settle = resolve; }),
    };
    starting.current = intent;
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
        !isRecordableBrowserTab(activeTab) ||
        (activeTab.profile ?? 'embedded') !== s.profile
      ) {
        await release(s);
        return;
      }
      documents.current.clear();
      networkSequence.current = 0;
      clearNetworkTarget();
      networkCoverage.current.clear();
      if (intent.lateStart) networkCoverage.current.add(RecordingNetworkCoverage.LateStart);
      networkActions.current = [];
      networkNavigations.current = [];
      networkPromotions.current = [];
      domActiveTarget.current = activeTab.targetId;
      pauseReason.current = undefined;
      update(s);
      void prepareNetwork(s, activeTab, true);
      control(true);
      if (activeTab.url !== 'about:blank' && !current.current.isInitialNavigationPending?.(activeTab.targetId))
        scheduleCapture(hostStep(RecordingAction.OpenTab, activeTab));
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      starting.current = undefined;
      settle();
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
  const pause = async (reason: PauseReason = 'manual') => {
    const s = ref.current;
    if (!s || s.status !== RecordingStatus.Recording || stopping.current) return;
    if (pauseReason.current) {
      if (reason === 'manual') pauseReason.current = reason;
      return;
    }
    pauseReason.current = reason;
    domActiveTarget.current = undefined;
    clearNetworkTarget();
    void sendNetwork(s, { action: 'pause', requestedAtMs: Date.now() });
    await drain();
    if (ref.current?.id === s.id && ref.current.status === RecordingStatus.Recording && !stopping.current) {
      control(false);
      update({ ...ref.current, status: RecordingStatus.Paused });
    }
  };
  const resume = () => {
    const s = ref.current;
    const tab = current.current.activeTab;
    if (
      !s ||
      s.status !== RecordingStatus.Paused ||
      !tab ||
      !isRecordableBrowserTab(tab) ||
      !current.current.isOpen ||
      stopping.current ||
      current.current.draftKey !== s.sessionId ||
      (tab.profile ?? 'embedded') !== s.profile
    )
      return;
    pauseReason.current = undefined;
    domActiveTarget.current = tab.targetId;
    update({ ...s, status: RecordingStatus.Recording });
    void prepareNetwork(s, tab);
    hostStep(RecordingAction.Gap, tab);
    control(true);
  };
  const stop = (): Promise<void> => {
    if (stopping.current) return stopping.current;
    const recording = ref.current;
    if (!recording || recording.status === RecordingStatus.Review) return Promise.resolve();
    clearNetworkTarget();
    const network = withRecordingTimeout(sendNetwork(recording, {
      action: 'finish', requestedAtMs: Date.now(),
    }), 1_000);
    const finish = Promise.all([network, drain()]).then(async ([reply]) => {
      const s = ref.current;
      if (!s || s.id !== recording.id) return;
      if (reply?.status !== 'finished')
        networkCoverage.current.add(RecordingNetworkCoverage.Unavailable);
      const capturedNetwork = associateRecordingNetwork(
        s, reply?.status === 'finished' ? reply.snapshot : undefined,
        networkActions.current, networkNavigations.current, networkCoverage.current,
      );
      control(false);
      update({ ...s, status: RecordingStatus.Review, capturedNetwork });
      await release(s);
    }).finally(() => {
      if (stopping.current === finish) stopping.current = undefined;
    });
    stopping.current = finish;
    return finish;
  };
  const clear = () => {
    control(false);
    for (const drain of drains.current.values()) drain.resolve();
    if (ref.current) void release(ref.current);
    for (const timer of timers.current.values()) clearTimeout(timer);
    clearNetworkTarget();
    pauseReason.current = undefined;
    networkPromotions.current = [];
    update(null);
  };
  // Only explicit home -> temporary -> canonical session promotions may transfer ownership.
  // Ordinary session selection must keep the recording attached to its original session.
  const promoteSession = (fromSessionId: string, toSessionId: string) => {
    if (fromSessionId === toSessionId) return;
    if (starting.current && current.current.draftKey === fromSessionId)
      startGeneration.current += 1;
    const s = ref.current;
    if (s?.sessionId !== fromSessionId) return;
    const tab = current.current.activeTab;
    if (tab && !tab.resourceSessionId && s.status !== RecordingStatus.Review && !stopping.current) {
      networkPromotions.current.push({ from: fromSessionId, to: toSessionId });
    }
    update({ ...s, sessionId: toSessionId });
  };
  const prepareNetworkTransfer = (fromSessionId: string, toSessionId: string): Promise<void> | undefined => {
    const s = ref.current;
    const tab = current.current.activeTab;
    const target = tab && !tab.resourceSessionId ? getNetworkPage(tab) : null;
    let reachable = fromSessionId;
    for (const promotion of networkPromotions.current) {
      if (promotion.from === reachable) reachable = promotion.to;
    }
    if (
      !s || s.sessionId !== toSessionId || s.status === RecordingStatus.Review || stopping.current ||
      !target || fromSessionId === toSessionId || reachable !== toSessionId
    ) return undefined;
    clearNetworkTarget();
    return withRecordingTimeout(sendNetwork(s, {
      action: 'transferTarget',
      from: { ...target, resourceSessionId: fromSessionId },
      toSessionId,
      requestedAtMs: Date.now(),
    }), RECORDING_NETWORK_LIMITS.prepareMs).then(reply => {
      if (ref.current?.id === s.id && reply?.status !== 'transferReady') {
        networkCoverage.current.add(RecordingNetworkCoverage.Transfer);
      }
    });
  };
  const completeNetworkTransfer = (toSessionId: string): boolean => {
    if (ref.current?.sessionId !== toSessionId || !networkPromotions.current.length) return false;
    networkPromotions.current = [];
    return true;
  };
  const previousTabs = useRef(options.tabs);
  const activeTabRecordable = options.activeTab ? isRecordableBrowserTab(options.activeTab) : false;
  const activeTabProfile = options.activeTab?.profile;
  const switchSequence = useRef(0);
  const actions = useRef({
    hostStep,
    scheduleCapture,
    stop,
    pause,
    resume,
    prepareNetwork,
    drain,
    control,
    release,
    update,
  });
  actions.current = { hostStep, scheduleCapture, stop, pause, resume, prepareNetwork, drain, control, release, update };
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
      else if (
        !pendingDrain.current && !pauseReason.current && !stopping.current &&
        domActiveTarget.current === current.current.activeTab?.targetId
      ) actions.current.control(true);
    }
    previousTabs.current = options.tabs;
  }, [options.tabs]);
  useLayoutEffect(() => {
    const { pause, resume, prepareNetwork, drain, hostStep, control } = actions.current;
    const sequence = ++switchSequence.current;
    const s = ref.current;
    if (!s || s.status === RecordingStatus.Review || stopping.current) return;
    const tab = current.current.activeTab;
    if (
      !options.isOpen ||
      options.draftKey !== s.sessionId ||
      !tab ||
      !isRecordableBrowserTab(tab) ||
      (tab.profile ?? 'embedded') !== s.profile
    ) {
      void pause('visibility');
      return;
    }
    if (s.status === RecordingStatus.Paused) {
      if (pauseReason.current === 'visibility') resume();
      return;
    }
    if (pauseReason.current || domActiveTarget.current === tab.targetId) return;
    domActiveTarget.current = undefined;
    void prepareNetwork(s, tab);
    void (async () => {
      await drain();
      if (
        sequence !== switchSequence.current ||
        ref.current?.id !== s.id ||
        ref.current.status !== RecordingStatus.Recording ||
        pauseReason.current || stopping.current ||
        !current.current.isOpen ||
        current.current.activeTab?.targetId !== tab.targetId ||
        current.current.draftKey !== ref.current.sessionId ||
        (current.current.activeTab?.profile ?? 'embedded') !== s.profile
      )
        return;
      domActiveTarget.current = tab.targetId;
      const currentTab = current.current.activeTab;
      if (currentTab.url !== 'about:blank' && !current.current.isInitialNavigationPending?.(currentTab.targetId)) {
        hostStep(
          ref.current.steps.some(step => step.pageId === currentTab.targetId)
            ? RecordingAction.SwitchTab
            : RecordingAction.OpenTab,
          currentTab,
        );
      }
      control(true);
    })();
  }, [options.activeTab?.targetId, options.isOpen, options.draftKey, session?.status,
    activeTabRecordable, activeTabProfile]);
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
    networkStatus,
    start,
    pause,
    resume,
    stop,
    clear,
    update,
    onMessage,
    onReady,
    onNavigation,
    onNavigationStart,
    waitForNetworkReady,
    shouldPrepareNavigation,
    markNetworkLateStart,
    closeNetworkTarget,
    prepareNetworkTransfer,
    completeNetworkTransfer,
    drain,
    promoteSession,
  };
}
