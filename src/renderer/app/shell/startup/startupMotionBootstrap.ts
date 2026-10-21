import { prepareStartupEntry, StartupEntryPhase } from './startupMotion';

const screen = document.getElementById('startup-document');
if (screen?.dataset.startupView === 'launch') {
  const frame = screen.querySelector<HTMLElement>('.startup-main');
  if (frame) {
    const dispose = prepareStartupEntry(frame);
    const observer = new MutationObserver(() => {
      if (!screen.isConnected) {
        dispose();
        observer.disconnect();
      } else if (screen.dataset.failed === 'true') {
        dispose();
        frame.dataset.entry = StartupEntryPhase.Open;
        observer.disconnect();
      }
    });
    observer.observe(screen, { attributes: true, attributeFilter: ['data-failed'] });
    if (screen.parentElement) observer.observe(screen.parentElement, { childList: true });
  }
}
