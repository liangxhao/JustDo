import { sidePanelText as t } from './sidepanel-i18n.js';
import { toolDisplayTitle } from './sidepanel-state.js';

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** This view only describes admitted activity. It never decides a run's outcome. */
export function createRunActivityView(element) {
  const document = element.ownerDocument;
  const icon = document.createElement('span');
  icon.className = 'run-activity-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✦';
  const text = document.createElement('div');
  text.className = 'run-activity-text';
  const label = document.createElement('span');
  label.className = 'run-activity-label';
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  const detail = document.createElement('span');
  detail.className = 'run-activity-detail';
  const elapsed = document.createElement('span');
  elapsed.className = 'run-activity-elapsed';
  elapsed.setAttribute('aria-live', 'off');
  elapsed.setAttribute('aria-label', t('elapsed'));
  text.append(label, detail);
  element.append(icon, text, elapsed);
  element.setAttribute('aria-label', t('runActivity'));
  let current = null;
  let timer = null;

  function updateClock() {
    if (!current) return;
    const now = Date.now();
    const activity = current.activity;
    elapsed.textContent = formatElapsed(now - (activity?.startedAt ?? current.startedAt));
    const parts = [];
    const progress = activity?.progress;
    if (progress?.name) parts.push(toolDisplayTitle(progress.name));
    if (Number.isSafeInteger(progress?.receivedChars) && progress.receivedChars >= 0) {
      parts.push(t('receivedChars', { count: progress.receivedChars.toLocaleString() }));
    }
    if (Number.isSafeInteger(progress?.outputChars) && progress.outputChars >= 0) {
      parts.push(t('outputChars', { count: progress.outputChars.toLocaleString() }));
    }
    if (typeof progress?.summary === 'string' && progress.summary.trim()) {
      const summary = progress.summary.trim();
      parts.push(summary.length > 240 ? `${summary.slice(0, 239)}…` : summary);
    }
    if (activity?.stage === 'retrying') {
      if (
        Number.isSafeInteger(activity.retryAttempt) &&
        Number.isSafeInteger(activity.maxRetries)
      ) {
        parts.push(t('retryCount', { attempt: activity.retryAttempt, total: activity.maxRetries }));
      }
      if (Number.isFinite(activity.retryAt) && activity.retryAt > now) {
        parts.push(t('retryIn', { seconds: Math.ceil((activity.retryAt - now) / 1000) }));
      }
    }
    const quiet = now - (activity?.lastAgentEventAt ?? current.startedAt);
    if (activity && quiet >= 20_000)
      parts.push(t('lastUpdate', { seconds: Math.floor(quiet / 1000) }));
    detail.textContent = parts.join(' · ');
    detail.hidden = !parts.length;
    detail.title = detail.textContent;
  }

  return {
    render(activity, fallback = null) {
      if (!activity && !fallback) {
        current = null;
        element.classList.add('hidden');
        if (timer !== null) clearInterval(timer);
        timer = null;
        return;
      }
      const previous = current;
      current = {
        activity,
        startedAt: fallback?.startedAt ?? previous?.startedAt ?? Date.now(),
      };
      const stage = fallback?.stage ?? activity?.stage ?? 'checking';
      const nextLabel = t(stage);
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
      element.dataset.stage = stage;
      element.classList.remove('hidden');
      updateClock();
      if (timer === null) timer = setInterval(updateClock, 1000);
    },
    dispose() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      current = null;
    },
  };
}
