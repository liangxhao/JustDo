import { sidePanelText as t } from './sidepanel-i18n.js';

/** Folder choices are transient; Main validates and binds every selection. */
export function createWorkspacePicker(root, options) {
  const doc = root.ownerDocument;
  let context = { threadId: '', draftId: '', cwd: '', recentCwds: [], disabled: true };
  let generation = 0;
  let busy = false;
  let disposed = false;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'workspace-button';
  button.setAttribute('aria-haspopup', 'dialog');
  if (options.anchor) button.setAttribute('role', 'menuitem');
  const icon = paths => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    for (const d of paths) {
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  const caption = doc.createElement('span');
  caption.className = 'workspace-caption';
  caption.textContent = t('workspaceLabel');
  const folder = doc.createElement('span');
  folder.className = 'workspace-folder';
  button.append(icon([
    'M20 6h-7.2a2 2 0 0 1-1.4-.6L9.6 3.6A2 2 0 0 0 8.2 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z',
    'M7 11h10m-2.5-2.5L17 11l-2.5 2.5M17 16H7m2.5-2.5L7 16l2.5 2.5',
  ]), caption, folder, icon(['m6 9 6 6 6-6']));
  const popover = doc.createElement('div');
  popover.className = 'workspace-popover hidden';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', t('workspaceTitle'));
  root.append(button);
  // The composer footer clips overflow; position the menu in the document layer.
  doc.body.append(popover);

  function close(restoreFocus = false) {
    popover.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !button.disabled) (options.anchor ?? button).focus();
  }

  function render() {
    const compact = context.cwd.split(/[\\/]/u).filter(Boolean).pop();
    folder.textContent = compact || t('workspaceTitle');
    button.title = `${t('workspaceChange')}\n${context.cwd}`;
    button.setAttribute('aria-label', `${t('workspaceChange')}: ${context.cwd}`);
    button.disabled = context.disabled || busy;
    if (button.disabled) close();
  }

  async function choose(recentCwd) {
    if (context.disabled || busy || disposed) return;
    close();
    const captured = { ...context };
    const epoch = generation;
    busy = true;
    options.onBusyChange?.(true);
    render();
    const current = () => !disposed && epoch === generation;
    try {
      const selection = await options.request('chrome/workspace/select', {
        ...(captured.threadId
          ? { threadId: captured.threadId, expectedCwd: captured.cwd }
          : { draftId: captured.draftId }),
        ...(recentCwd ? { recentCwd } : {}),
      });
      if (!current() || selection.cancelled) return;
      if (captured.threadId) {
        const result = await options.request('chrome/thread/workspace/set', {
          threadId: captured.threadId,
          expectedCwd: captured.cwd,
          selectionToken: selection.selectionToken,
        });
        if (!current()) return;
        if (!result.success) throw new Error(t(`workspaceFailure_${result.reason}`));
        options.onSelected({ cwd: result.cwd });
      } else {
        options.onSelected({ cwd: selection.cwd, selectionToken: selection.selectionToken });
      }
    } catch (error) {
      if (current()) options.onError?.(error);
    } finally {
      busy = false;
      if (!disposed) {
        options.onBusyChange?.(false);
        render();
      }
    }
  }

  function open() {
    if (button.disabled) return;
    if (!popover.classList.contains('hidden')) return close(true);
    popover.replaceChildren();
    const title = doc.createElement('strong');
    title.textContent = t('workspaceTitle');
    const description = doc.createElement('p');
    description.textContent = t('workspaceDescription');
    const current = doc.createElement('p');
    current.className = 'workspace-current';
    current.textContent = `${t('workspaceCurrent')}: ${context.cwd}`;
    popover.append(title, description, current);
    const browse = doc.createElement('button');
    browse.type = 'button';
    browse.textContent = t('workspaceBrowse');
    browse.addEventListener('click', () => void choose());
    popover.append(browse);
    for (const cwd of [...new Set(context.recentCwds)].filter(cwd => cwd !== context.cwd)) {
      const recent = doc.createElement('button');
      recent.type = 'button';
      recent.textContent = cwd;
      recent.title = cwd;
      recent.addEventListener('click', () => void choose(cwd));
      popover.append(recent);
    }
    popover.classList.remove('hidden');
    const rect = (options.anchor ?? button).getBoundingClientRect();
    const width = Math.min(360, doc.defaultView.innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(rect.left, doc.defaultView.innerWidth - width - 12))}px`;
    popover.style.top = `${Math.max(12, rect.top - popover.offsetHeight - 8)}px`;
    button.setAttribute('aria-expanded', 'true');
    browse.focus();
  }
  const outside = event => { if (!root.contains(event.target) && !popover.contains(event.target)) close(); };
  const resized = () => close();
  const keydown = event => {
    if (popover.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (event.key === 'Tab') {
      const buttons = [...popover.querySelectorAll('button')];
      const index = buttons.indexOf(doc.activeElement);
      if (event.shiftKey && index === 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0]?.focus(); }
    }
  };
  button.addEventListener('click', open);
  doc.addEventListener('pointerdown', outside);
  popover.addEventListener('keydown', keydown);
  doc.defaultView.addEventListener('resize', resized);
  render();
  return {
    update(next) {
      if (JSON.stringify([next.threadId, next.draftId, next.cwd]) !==
          JSON.stringify([context.threadId, context.draftId, context.cwd])) {
        generation += 1;
        close();
      }
      context = { ...next };
      render();
    },
    invalidate() { generation += 1; close(); },
    dispose() {
      disposed = true;
      generation += 1;
      doc.removeEventListener('pointerdown', outside);
      popover.removeEventListener('keydown', keydown);
      doc.defaultView.removeEventListener('resize', resized);
      popover.remove();
      root.replaceChildren();
    },
  };
}
