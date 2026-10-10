// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acceptWidgetDraft, widgetFrameInteractable } from './draft';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function focusedFrame(doc = document) {
  const frame = doc.createElement('iframe');
  doc.body.append(frame);
  frame.focus();
  vi.spyOn(doc, 'hasFocus').mockReturnValue(true);
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    width: 500,
    height: 400,
    top: 10,
    bottom: 410,
    left: 10,
    right: 510,
  } as DOMRect);
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  return frame;
}

describe('native widget draft admission', () => {
  it('uses only the frame owner viewport and activation across workspace documents', () => {
    const workspace = document.createElement('iframe');
    document.body.append(workspace);
    const owner = workspace.contentWindow!;
    const frame = focusedFrame(workspace.contentDocument!);
    const activation = { isActive: false };
    Object.defineProperty(owner.navigator, 'userActivation', { value: activation });
    expect(acceptWidgetDraft(frame, 'Analyze', 'workspace')).toBeUndefined();
    activation.isActive = true;
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    vi.stubGlobal('innerHeight', 5);
    vi.stubGlobal('innerWidth', 5);
    expect(acceptWidgetDraft(frame, 'Analyze', 'workspace')).toBe('Analyze');
    Object.defineProperty(owner, 'innerHeight', { value: 5, configurable: true });
    expect(widgetFrameInteractable(frame)).toBe(false);
    Object.defineProperty(owner, 'innerHeight', { value: 768 });
    Object.defineProperty(owner, 'innerWidth', { value: 5 });
    expect(widgetFrameInteractable(frame)).toBe(false);
  });

  it('rejects commands, oversized data, stale focus and absence of real transient activation', () => {
    const frame = focusedFrame();
    expect(acceptWidgetDraft(frame, ' /run', 'commands')).toBeUndefined();
    expect(acceptWidgetDraft(frame, '!run', 'commands')).toBeUndefined();
    expect(acceptWidgetDraft(frame, 'x'.repeat(4001), 'commands')).toBeUndefined();
    expect(acceptWidgetDraft(frame, 'Analyze', 'commands')).toBe('Analyze');
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    expect(acceptWidgetDraft(frame, 'Analyze', 'commands')).toBeUndefined();
    frame.remove();
    expect(acceptWidgetDraft(frame, 'Analyze', 'commands')).toBeUndefined();
  });

  it('accepts at most ten requests in ten minutes per original document/connection', () => {
    const frame = focusedFrame();
    for (let i = 0; i < 10; i++)
      expect(acceptWidgetDraft(frame, 'Analyze', 'rate', 1_000)).toBe('Analyze');
    expect(acceptWidgetDraft(frame, 'Analyze', 'rate', 1_001)).toBeUndefined();
    expect(acceptWidgetDraft(frame, 'Analyze', 'rate', 601_001)).toBe('Analyze');
  });
});
