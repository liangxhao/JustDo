// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { scenarioContentKind } from '../../../openclaw-extensions/interactive-ui/scenario/content-kind';
import { scenarioLabels } from '../../../openclaw-extensions/interactive-ui/scenario/labels';
import { scenarioRuntime } from '../../../openclaw-extensions/interactive-ui/scenario/runtime';
import {
  calculateScenario,
  parseScenario,
} from '../../../openclaw-extensions/interactive-ui/scenario/schema';

const listeners: EventListener[] = [];
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const listener of listeners.splice(0)) window.removeEventListener('message', listener);
  document.body.replaceChildren();
  delete (globalThis as typeof globalThis & { openclaw?: unknown }).openclaw;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('defers responsive chart redraws outside ResizeObserver delivery and releases pending frames', () => {
  let resized!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  let paint!: FrameRequestCallback;
  const request = vi.fn((callback: FrameRequestCallback) => {
    paint = callback;
    return 7;
  });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  mount();
  const svg = document.querySelector('.chart svg')!;
  const chart = svg.parentElement!;
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ width: 278 } as DOMRect);
  resized();
  resized();
  expect(request).toHaveBeenCalledOnce();
  expect(svg.getAttribute('viewBox')).toBe('0 0 650 230');
  paint(0);
  expect(svg.getAttribute('viewBox')).toBe('0 0 278 230');
  expect(document.getElementById('chart-end')!.getAttribute('x')).toBe('254');
  resized();
  window.dispatchEvent(new Event('pagehide'));
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(7);
});

function mount() {
  const scenario = parseScenario(
    JSON.stringify({
      version: 1,
      language: 'en',
      summary: 'Delivery',
      tasks: [{ label: 'Implementation', hours: 448 }],
      dailyRate: 700,
      budget: 80000,
      deadline: 21,
      people: 6,
      focus: 6,
    }),
  );
  document.body.innerHTML = scenarioContentKind.composeDocument({
    source: JSON.stringify(scenario),
    title: 'Delivery',
    resourceUrls: { '/__interactive_ui__/scenario.js': '/scenario.js' },
    promptGranted: false,
  });
  const send = vi.fn(() => Promise.resolve(true));
  Object.assign(globalThis, { openclaw: { prompt: { send } } });
  const follow = document.getElementById('follow') as HTMLButtonElement;
  let activate!: (event: Event) => void;
  const add = follow.addEventListener.bind(follow);
  vi.spyOn(follow, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'click' && typeof listener === 'function')
      activate = listener as (event: Event) => void;
    add(type, listener, options);
  });
  const listen = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'message' && typeof listener === 'function')
      listeners.push(listener as EventListener);
    listen(type, listener, options);
  });
  scenarioRuntime({ scenario, labels: scenarioLabels.en, promptGranted: false }, calculateScenario);
  const policy = (available: boolean) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: { type: 'openclaw:scenario-draft-policy', available },
      }),
    );
  return { send, follow, policy, activate: () => activate({ isTrusted: true } as Event) };
}

it('calculates locally and starts with collapsed secondary information and one primary action', () => {
  const { send } = mount();
  expect(document.getElementById('duration-value')!.textContent).toBe('18');
  expect(document.getElementById('cost-value')!.textContent).toContain('75,600');
  const team = document.getElementById('team') as HTMLInputElement;
  team.value = '8';
  team.dispatchEvent(new Event('input'));
  expect(document.getElementById('duration-value')!.textContent).toBe('14');
  expect(document.getElementById('cost-value')!.textContent).toContain('78,400');
  expect(send).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('details')].every(detail => !detail.open)).toBe(true);
  expect(document.querySelector('.intro')).toBeNull();
  expect(document.querySelectorAll('#follow')).toHaveLength(1);
});

it('keeps the action label stable, rejects synthetic clicks and allows retry after a bridge failure', async () => {
  const { send, follow, policy, activate } = mount();
  expect(follow.textContent).toBe(scenarioLabels.en.follow);
  policy(true);
  follow.click();
  expect(send).not.toHaveBeenCalled();
  send.mockRejectedValueOnce(new Error('Synthetic failure'));
  activate();
  activate();
  expect(send).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(follow.disabled).toBe(false));
  expect(document.getElementById('follow-error')!.hidden).toBe(false);
  activate();
  await vi.waitFor(() => expect(follow.disabled).toBe(false));
  expect(send).toHaveBeenCalledTimes(2);
  expect(document.getElementById('follow-error')!.hidden).toBe(true);
  policy(false);
  activate();
  expect(follow.disabled).toBe(true);
  expect(follow.textContent).toBe(scenarioLabels.en.follow);
  expect(send).toHaveBeenCalledTimes(2);
});
