import { sidePanelText as t } from './sidepanel-i18n.js';

const COPY_STATE = Object.freeze({ COPIED: 'copied', FAILED: 'failed' });
const COPY_FEEDBACK_MS = 2000;

/** Delegated clipboard actions; no copied body or feedback survives its display scope. */
export function createCopyController(container) {
  const states = new Map();
  let disposed = false;

  const textFor = button => button.classList.contains('message-copy')
    ? button.copyText || ''
    : button.closest('.code-block')?.querySelector('pre > code')?.textContent || '';
  const labelFor = button => t(button.classList.contains('message-copy') ? 'copyAnswer' : 'copyCode');
  const statusFor = button => button.parentElement?.querySelector('.message-copy-status, .code-copy-status');

  function reset(button) {
    const state = states.get(button);
    if (state?.timer) clearTimeout(state.timer);
    states.delete(button);
    button.removeAttribute('data-copy-state');
    button.title = labelFor(button);
    const status = statusFor(button);
    if (status) status.textContent = '';
  }

  async function onClick(event) {
    const button = event.target.closest?.('.message-copy, .code-copy');
    if (disposed || !button || !container.contains(button)) return;
    const text = textFor(button);
    if (!text.trim()) return;
    reset(button);
    const state = {};
    states.set(button, state);
    const isCurrent = () => !disposed && states.get(button) === state &&
      button.isConnected && container.contains(button) && textFor(button) === text;
    try {
      await container.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      if (!isCurrent()) return;
      button.dataset.copyState = COPY_STATE.COPIED;
      button.title = t('copied');
      const status = statusFor(button);
      if (status) status.textContent = t('copied');
      state.timer = setTimeout(() => {
        if (isCurrent()) reset(button);
      }, COPY_FEEDBACK_MS);
    } catch {
      if (!isCurrent()) return;
      button.dataset.copyState = COPY_STATE.FAILED;
      button.title = t('copyFailed');
      const status = statusFor(button);
      if (status) status.textContent = t('copyFailed');
    }
  }

  container.addEventListener('click', onClick);
  return {
    invalidate(root = container) {
      for (const button of states.keys())
        if (root === button || root.contains(button)) reset(button);
    },
    prune() {
      for (const button of states.keys()) if (!container.contains(button)) reset(button);
    },
    dispose() {
      disposed = true;
      container.removeEventListener('click', onClick);
      for (const button of states.keys()) reset(button);
    },
  };
}
