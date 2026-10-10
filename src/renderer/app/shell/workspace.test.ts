// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const install = vi.hoisted(() => vi.fn());
vi.mock('@/libs/openclaw-chat/components/native-widget/messaging', () => ({
  installNativeWidgetMessaging: install,
}));

it('publishes the portal root only after the owner-realm sender is installed', async () => {
  document.body.replaceChildren();
  install.mockImplementation(() => {
    expect(document.getElementById('workspace-root')).toBeNull();
  });
  await import('./workspace');
  expect(install).toHaveBeenCalledOnce();
  const root = document.getElementById('workspace-root')!;
  expect(root.ownerDocument).toBe(document);
  expect(root.style.height).toBe('100vh');
  expect(root.style.overflow).toBe('hidden');
  document.body.replaceChildren();
});
