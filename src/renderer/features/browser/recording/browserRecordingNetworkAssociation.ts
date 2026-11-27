import type { BrowserRecordingSession } from '@shared/browser/browserRecording';
import {
  type RecordingNetworkCapture,
  type RecordingNetworkCapturedEntry,
  type RecordingNetworkCoverageIssue,
  RecordingNetworkGroup,
  RecordingNetworkOutcome,
  type RecordingNetworkSnapshot,
  RecordingNetworkType,
} from '@shared/browser/browserRecordingNetwork';

const ACTION_WINDOW_MS = 1_500;
const NAVIGATION_MATCH_MS = 750;

export type RecordingNetworkAction = {
  stepId: string;
  webContentsId: number;
  at: number;
  firstInputAt?: number;
  childFrame: boolean;
};

export type RecordingNetworkNavigation = {
  pageId: string;
  webContentsId: number;
  kind: 'start' | 'commit' | 'in-page';
  at: number;
  stepId?: string;
};

export function associateRecordingNetwork(
  recording: BrowserRecordingSession,
  snapshot: RecordingNetworkSnapshot | undefined,
  recordedActions: readonly RecordingNetworkAction[],
  navigations: readonly RecordingNetworkNavigation[],
  additionalCoverage: ReadonlySet<RecordingNetworkCoverageIssue>,
): RecordingNetworkCapture {
  const steps = new Map(recording.steps.map(step => [step.id, step]));
  const coverage = new Set([...(snapshot?.coverage ?? []), ...additionalCoverage]);
  const committedPages = (snapshot?.segments ?? []).flatMap(segment =>
    segment.documents.flatMap(document =>
      document.loadSequence === undefined || document.committedAtMs === undefined
        ? []
        : [{ segment, document, committedAt: document.committedAtMs }],
    ),
  );
  const commits = navigations.filter(
    navigation => navigation.kind === 'commit' && navigation.stepId && steps.has(navigation.stepId),
  );
  const withinSameNavigation = (
    { segment, committedAt }: (typeof committedPages)[number],
    navigation: RecordingNetworkNavigation,
  ): boolean =>
    segment.pageId === navigation.pageId &&
    segment.webContentsId === navigation.webContentsId &&
    navigation.at >= segment.startedAtMs && navigation.at <= segment.endedAtMs &&
    Math.abs(committedAt - navigation.at) <= NAVIGATION_MATCH_MS;
  const stepsByLoad = new Map<number, string>();
  for (const page of committedPages) {
    const matching = commits.filter(commit => withinSameNavigation(page, commit));
    const stepId = matching[0]?.stepId;
    const loadSequence = page.document.loadSequence;
    if (
      matching.length === 1 &&
      stepId &&
      loadSequence !== undefined &&
      committedPages.filter(other => withinSameNavigation(other, matching[0]!)).length === 1
    ) {
      stepsByLoad.set(loadSequence, stepId);
    }
  }

  // Preserve removed click and sensitive action times as attribution boundaries.
  const actions = [...recordedActions].sort(
    (a, b) => (a.firstInputAt ?? a.at) - (b.firstInputAt ?? b.at),
  );
  const segments = new Map(snapshot?.segments.map(segment => [segment.id, segment]));
  const entries: RecordingNetworkCapturedEntry[] = [];
  const observedReads = new Set<string>();
  for (const observation of snapshot?.entries ?? []) {
    const {
      id, pageId, segmentId, documentId, startedAtMs, withinLoad, loadSequence,
    } = observation;
    const segment = segments.get(segmentId);
    const document = segment?.documents.find(candidate => candidate.id === documentId);
    let stepId: string | undefined;
    let group: RecordingNetworkCapturedEntry['group'] = RecordingNetworkGroup.Unassigned;
    if (
      segment &&
      document &&
      observation.frame !== 'child' &&
      (observation.type === RecordingNetworkType.Fetch || observation.type === RecordingNetworkType.Xhr ||
        observation.type === RecordingNetworkType.EventSource) &&
      document.committedAtMs !== undefined && document.committedAtMs <= startedAtMs &&
      startedAtMs <= (document.endedAtMs ?? segment.endedAtMs)
    ) {
      const documentStartsAt = document.committedAtMs;
      const routeStartsAt = navigations.reduce((latest, navigation) =>
        navigation.pageId === pageId &&
        navigation.webContentsId === segment.webContentsId &&
        navigation.at <= startedAtMs
          ? Math.max(latest, navigation.at)
          : latest, documentStartsAt);
      const eligible = actions.filter(action =>
        action.webContentsId === segment.webContentsId &&
        (action.firstInputAt ?? action.at) <= startedAtMs &&
        (action.firstInputAt ?? action.at) >= Math.max(segment.startedAtMs, routeStartsAt),
      );
      const candidate = eligible[eligible.length - 1];
      const previous = eligible[eligible.length - 2];
      const step = candidate && steps.get(candidate.stepId);
      if (
        candidate && step && step.pageId === pageId &&
        !step.sensitive && !candidate.childFrame &&
        startedAtMs <= candidate.at + ACTION_WINDOW_MS &&
        (!previous || (candidate.firstInputAt ?? candidate.at) > previous.at)
      ) {
        group = RecordingNetworkGroup.Action;
        stepId = candidate.stepId;
      }
    }
    if (group !== RecordingNetworkGroup.Action &&
        (observation.type === RecordingNetworkType.Document || withinLoad) && loadSequence !== undefined) {
      group = RecordingNetworkGroup.Load;
      stepId = stepsByLoad.get(loadSequence);
    }
    if (
      documentId !== undefined && !observation.frame && !observation.urlRedacted && !observation.urlLimited &&
      observation.type !== RecordingNetworkType.Document && observation.outcome === RecordingNetworkOutcome.Complete &&
      (observation.method === 'GET' || observation.method === 'HEAD') &&
      observation.status !== undefined &&
      ((observation.status >= 200 && observation.status < 300) || observation.status === 304)
    ) {
      const key = JSON.stringify([
        segmentId, documentId, group, stepId, group === RecordingNetworkGroup.Load ? loadSequence : undefined,
        observation.type, observation.method, observation.origin, observation.path, observation.search,
        observation.status,
      ]);
      if (observedReads.has(key)) continue;
      observedReads.add(key);
    }
    entries.push({
      id,
      pageId,
      group,
      type: observation.type,
      method: observation.method,
      origin: observation.origin,
      path: observation.path,
      outcome: observation.outcome,
      ...(observation.search === undefined ? {} : { search: observation.search }),
      ...(observation.urlRedacted ? { urlRedacted: true } : {}),
      ...(observation.urlLimited ? { urlLimited: true } : {}),
      ...(observation.status === undefined ? {} : { status: observation.status }),
      ...(observation.failure === undefined ? {} : { failure: observation.failure }),
      ...(group === RecordingNetworkGroup.Load ? { loadSequence } : {}),
      ...(stepId === undefined ? {} : { stepId }),
    });
  }

  return {
    entries,
    coverage: [...coverage],
    omittedCount: snapshot?.omittedCount ?? 0,
  };
}
