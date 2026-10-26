import { isSameBrowserSession } from './browserSessionIdentity';

type BackgroundGuest = {
  guest: Electron.WebContents;
  session: Electron.Session;
  revoked: boolean;
  released: boolean;
};

const guests = new WeakMap<Electron.WebContents, BackgroundGuest>();
const activeById = new Map<number, BackgroundGuest>();
// Electron does not recycle WebContents IDs within a process. Keep only the IDs
// after destruction, so a delayed request cannot fall through to sidebar policy.
const knownIds = new Set<number>();

/** Only Main-owned background pages may enter this registry. */
export const registerBackgroundBrowserGuest = (
  guest: Electron.WebContents,
): { revoke: () => void; release: () => void } => {
  if (guest.isDestroyed() || guests.has(guest) || activeById.has(guest.id)) {
    throw new Error('The background browser guest is already registered or unavailable.');
  }
  const entry: BackgroundGuest = {
    guest,
    session: guest.session,
    revoked: false,
    released: false,
  };
  guests.set(guest, entry);
  activeById.set(guest.id, entry);
  knownIds.add(guest.id);
  const release = () => {
    entry.revoked = true;
    entry.released = true;
    if (activeById.get(guest.id) === entry) activeById.delete(guest.id);
    guest.off('destroyed', release);
  };
  guest.once('destroyed', release);
  return {
    revoke: () => {
      entry.revoked = true;
    },
    release,
  };
};

/** Includes revoked/destroyed guests, which must never get sidebar prompts. */
export const isBackgroundBrowserGuest = (guest?: Electron.WebContents | null): boolean =>
  Boolean(guest && guests.has(guest));

/** Captures one exact admission; a later DNS reply cannot authorize a replacement. */
export const captureBackgroundBrowserRequest = (
  browserSession: Electron.Session,
  details: { webContentsId?: number; webContents?: Electron.WebContents },
): (() => boolean) | null => {
  const fromObject = details.webContents ? guests.get(details.webContents) : undefined;
  const id = details.webContentsId ?? details.webContents?.id;
  const entry = (id === undefined ? undefined : activeById.get(id)) ?? fromObject;
  if (!entry && (id === undefined || !knownIds.has(id))) return null;
  if (!entry) return () => false;
  const exactOwner =
    (details.webContents === undefined || details.webContents === entry.guest) &&
    (details.webContentsId === undefined || details.webContentsId === entry.guest.id) &&
    isSameBrowserSession(browserSession, entry.session);
  return () =>
    exactOwner &&
    !entry.revoked &&
    !entry.released &&
    activeById.get(entry.guest.id) === entry &&
    !entry.guest.isDestroyed() &&
    isSameBrowserSession(entry.guest.session, entry.session);
};
