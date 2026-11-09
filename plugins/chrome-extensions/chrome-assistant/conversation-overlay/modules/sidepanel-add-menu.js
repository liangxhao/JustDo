/** The composer plus menu shares the document layer with other transient menus. */
export function createComposerAddMenu(trigger, menu, options) {
  const doc = trigger.ownerDocument;
  const fileButton = menu.querySelector('#attachFiles');
  let disposed = false;
  const isOpen = () => !menu.classList.contains('hidden');
  function close(restoreFocus = false) {
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled) trigger.focus();
  }
  function open() {
    if (disposed || trigger.disabled) return;
    if (isOpen()) return close(true);
    fileButton.disabled = trigger.disabled;
    menu.classList.remove('hidden');
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(320, doc.defaultView.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, doc.defaultView.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, rect.top - menu.offsetHeight - 8)}px`;
    trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  const attach = () => { close(); options.onAttach(); };
  const choose = event => { if (event.target.closest('.workspace-button')) close(); };
  const outside = event => { if (!trigger.contains(event.target) && !menu.contains(event.target)) close(); };
  const resized = () => close();
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(doc.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  trigger.addEventListener('click', open);
  fileButton.addEventListener('click', attach);
  menu.addEventListener('click', choose);
  menu.addEventListener('keydown', keydown);
  doc.addEventListener('pointerdown', outside);
  doc.defaultView.addEventListener('resize', resized);
  return {
    close,
    update() { if (trigger.disabled) close(); },
    dispose() {
      disposed = true;
      close();
      trigger.removeEventListener('click', open);
      fileButton.removeEventListener('click', attach);
      menu.removeEventListener('click', choose);
      menu.removeEventListener('keydown', keydown);
      doc.removeEventListener('pointerdown', outside);
      doc.defaultView.removeEventListener('resize', resized);
    },
  };
}
