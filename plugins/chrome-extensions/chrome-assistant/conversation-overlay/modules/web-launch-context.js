import { WebLaunchLimits } from '../../contracts/webLaunch.ts';
import { createCopyController } from './sidepanel-copy.js';
import { sidePanelText as t } from './sidepanel-i18n.js';
import { renderMarkdownHtml } from './sidepanel-markdown.js';

const contextIcons = {
  webLaunchContextCopy:
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  webLaunchContextEdit: '<path d="m14 6 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
  webLaunchContextPreview:
    '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  webLaunchContextClose: '<path d="m6 6 12 12M18 6 6 18"/>',
};

export function createWebLaunchContext({ document, onEdit, canOpen }) {
  function setIcon(node, key) {
    const label = t(key);
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${contextIcons[key]}</svg>`;
  }
  function iconButton(key, parent) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'icon';
    setIcon(node, key);
    parent.append(node);
    return node;
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = t('webLaunchContext');
  trigger.className = 'web-launch-context-trigger';
  trigger.hidden = true;
  trigger.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.id = 'webLaunchContextDialog';
  dialog.className = 'decision-dialog web-launch-context-dialog';
  trigger.setAttribute('aria-controls', dialog.id);
  const section = document.createElement('section');
  const header = document.createElement('div');
  header.className = 'web-launch-context-header';
  const heading = document.createElement('h2');
  heading.id = 'webLaunchContextHeading';
  heading.tabIndex = -1;
  heading.textContent = t('webLaunchContext');
  dialog.setAttribute('aria-labelledby', heading.id);
  const actions = document.createElement('div');
  actions.className = 'web-launch-context-actions';
  const copy = iconButton('webLaunchContextCopy', actions);
  copy.dataset.copyLabel = 'webLaunchContextCopy';
  const toggle = iconButton('webLaunchContextEdit', actions);
  const dismiss = iconButton('webLaunchContextClose', actions);
  const status = document.createElement('span');
  status.className = 'message-copy-status';
  status.setAttribute('role', 'status');
  actions.append(status);
  header.append(heading, actions);

  const preview = document.createElement('div');
  preview.className = 'web-launch-context-preview markdown-content';
  preview.tabIndex = 0;
  const editor = document.createElement('textarea');
  editor.className = 'web-launch-context-editor';
  editor.setAttribute('aria-label', t('webLaunchContext'));
  editor.maxLength = WebLaunchLimits.contextCharacters;
  editor.rows = 10;
  editor.hidden = true;
  copy.disabled = true;
  section.append(header, preview, editor);
  dialog.append(section);
  document.body.append(dialog);
  const clipboard = createCopyController(dialog);
  let draftText = '';

  function updateCopy() {
    clipboard.invalidate(copy);
    copy.copyText = draftText;
    copy.disabled = !draftText;
  }

  function setEditing(editing) {
    editor.hidden = !editing;
    preview.hidden = editing;
    setIcon(toggle, editing ? 'webLaunchContextPreview' : 'webLaunchContextEdit');
  }

  function showPreview() {
    clipboard.invalidate(preview);
    preview.innerHTML = renderMarkdownHtml(draftText);
    for (const link of preview.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (!/^https?:\/\/[^/]/iu.test(href) || !URL.canParse(href)) link.removeAttribute('href');
    }
    setEditing(false);
    preview.scrollTop = 0;
  }

  function close() {
    if (dialog.open) dialog.close();
    clipboard.invalidate();
    copy.copyText = '';
    copy.disabled = true;
    preview.replaceChildren();
    setEditing(false);
  }

  trigger.addEventListener('click', () => {
    if (trigger.hidden || dialog.open || !canOpen()) return;
    updateCopy();
    showPreview();
    dialog.showModal();
    heading.focus({ preventScroll: true });
  });
  toggle.addEventListener('click', () => {
    if (!dialog.open) return;
    if (!editor.hidden) {
      showPreview();
      return;
    }
    setEditing(true);
    editor.focus();
  });
  dismiss.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  editor.addEventListener('input', () => {
    if (!dialog.open || editor.hidden) return;
    draftText = editor.value;
    updateCopy();
    onEdit();
  });

  return {
    trigger,
    get value() {
      return draftText;
    },
    set value(value) {
      draftText = typeof value === 'string' ? value : '';
      editor.value = draftText;
      if (!dialog.open) return;
      updateCopy();
      if (editor.hidden) showPreview();
    },
    setAvailable(available) {
      if (!available && dialog.open) close();
      trigger.hidden = !available;
    },
    close,
    dispose() {
      close();
      clipboard.dispose();
      draftText = '';
      editor.value = '';
      trigger.remove();
      dialog.remove();
    },
  };
}
