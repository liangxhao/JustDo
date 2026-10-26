import { EventEmitter } from 'node:events';

import { afterEach, expect, it } from 'vitest';

import {
  captureBackgroundBrowserRequest,
  isBackgroundBrowserGuest,
  registerBackgroundBrowserGuest,
} from './backgroundBrowserGuestRegistry';

let nextId = 1;
const releases: Array<() => void> = [];
const createGuest = (storagePath = 'C:/profiles/default') => {
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    id: nextId++,
    session: { storagePath } as Electron.Session,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      guest.emit('destroyed');
    },
  }) as unknown as Electron.WebContents & { destroy: () => void };
  return guest;
};
afterEach(() => {
  for (const release of releases.splice(0)) release();
});
const register = (guest: Electron.WebContents) => {
  const registration = registerBackgroundBrowserGuest(guest);
  releases.push(registration.release);
  return registration;
};

it('classifies only exact Main-registered objects and leaves profile workers unbound to a run', () => {
  const guest = createGuest();
  register(guest);
  expect(isBackgroundBrowserGuest(guest)).toBe(true);
  expect(isBackgroundBrowserGuest({ ...guest } as Electron.WebContents)).toBe(false);
  expect(isBackgroundBrowserGuest(null)).toBe(false);
  expect(captureBackgroundBrowserRequest(guest.session, {})).toBeNull();
  expect(captureBackgroundBrowserRequest(guest.session, { webContentsId: -1 })).toBeNull();
  expect(captureBackgroundBrowserRequest(guest.session, { webContentsId: guest.id })?.()).toBe(
    true,
  );
});

it('rejects forged identity, a different profile and contradictory source IDs', () => {
  const guest = createGuest();
  const other = createGuest('C:/profiles/other');
  register(guest);
  expect(captureBackgroundBrowserRequest(other.session, { webContentsId: guest.id })?.()).toBe(
    false,
  );
  expect(
    captureBackgroundBrowserRequest(guest.session, {
      webContentsId: guest.id,
      webContents: other,
    })?.(),
  ).toBe(false);
  expect(
    captureBackgroundBrowserRequest(guest.session, {
      webContentsId: other.id,
      webContents: guest,
    })?.(),
  ).toBe(false);
});

it('accepts stable persistent-session identity across Electron wrapper recreation', () => {
  const guest = createGuest();
  register(guest);
  const wrapper = { storagePath: guest.session.storagePath } as Electron.Session;
  expect(captureBackgroundBrowserRequest(wrapper, { webContents: guest })?.()).toBe(true);
});

it('revokes an already-captured DNS admission synchronously before actual destruction', () => {
  const guest = createGuest();
  const registration = register(guest);
  const admission = captureBackgroundBrowserRequest(guest.session, { webContentsId: guest.id });
  expect(admission?.()).toBe(true);
  registration.revoke();
  expect(admission?.()).toBe(false);
  expect(isBackgroundBrowserGuest(guest)).toBe(true);
  expect(captureBackgroundBrowserRequest(guest.session, { webContents: guest })?.()).toBe(false);
});

it('keeps late downloads and delayed source IDs classified as revoked after destruction', () => {
  const guest = createGuest();
  register(guest);
  const admission = captureBackgroundBrowserRequest(guest.session, { webContents: guest });
  guest.destroy();
  expect(admission?.()).toBe(false);
  expect(isBackgroundBrowserGuest(guest)).toBe(true);
  expect(captureBackgroundBrowserRequest(guest.session, { webContentsId: guest.id })?.()).toBe(
    false,
  );
  expect(captureBackgroundBrowserRequest(guest.session, { webContents: guest })?.()).toBe(false);
});

it('never retargets a captured admission to another live page in the shared profile', () => {
  const guest = createGuest();
  const registration = register(guest);
  const admission = captureBackgroundBrowserRequest(guest.session, { webContents: guest });
  registration.release();
  const next = createGuest();
  register(next);
  expect(admission?.()).toBe(false);
  expect(captureBackgroundBrowserRequest(next.session, { webContents: next })?.()).toBe(true);
  expect(() => registerBackgroundBrowserGuest(guest)).toThrow('already registered');
});
