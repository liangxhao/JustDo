import { ipcRenderer } from 'electron';

import {
  BROWSER_CREDENTIAL_PASSWORD_LIMIT,
  BROWSER_CREDENTIAL_USERNAME_LIMIT,
  BROWSER_GUEST_CREDENTIALS_CHECK_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_SUBMIT_CHANNEL,
  type BrowserImportedCredential,
} from '../../shared/browser/browser';

const isEditable = (field: HTMLInputElement): boolean =>
  field.isConnected && !field.matches(':disabled') && !field.readOnly;

const hasAutocompleteToken = (field: HTMLInputElement, token: string): boolean =>
  (field.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).includes(token);

const isVisible = (field: HTMLInputElement): boolean =>
  field.checkVisibility({ opacityProperty: true, visibilityProperty: true });

const isLoginPassword = (field: HTMLInputElement): boolean =>
  field.type === 'password' &&
  isEditable(field) &&
  isVisible(field) &&
  !hasAutocompleteToken(field, 'new-password') &&
  !hasAutocompleteToken(field, 'one-time-code');

const findLoginFields = (form: HTMLFormElement) => {
  const fields = Array.from(form.elements).filter(field => field instanceof HTMLInputElement);
  const passwords = fields.filter(
    field => field.type === 'password' && !field.matches(':disabled'),
  );
  const password = passwords[0];
  if (passwords.length !== 1 || !password || !isLoginPassword(password)) return null;

  const precedingFields = fields.slice(0, fields.indexOf(password));
  const accounts = fields.filter(
    field =>
      ['email', 'text', 'tel'].includes(field.type) &&
      !field.matches(':disabled') &&
      !hasAutocompleteToken(field, 'one-time-code') &&
      isVisible(field),
  );
  const username =
    accounts.find(field => hasAutocompleteToken(field, 'username')) ??
    accounts.findLast(field => precedingFields.includes(field));
  return { password, username };
};

const setNativeInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

type CredentialOffer = {
  id: string;
  url: string;
  origin: string;
  form: HTMLFormElement | null;
  password: HTMLInputElement;
  username: HTMLInputElement | undefined;
  account: string | null;
};

const isCurrentOffer = (offer: CredentialOffer): boolean => {
  if (location.href !== offer.url || offer.password.value || offer.password.form !== offer.form)
    return false;
  if (!offer.form) return isLoginPassword(offer.password);
  const fields = findLoginFields(offer.form);
  return (
    fields?.password === offer.password &&
    fields.username === offer.username &&
    (fields.username?.value || null) === offer.account
  );
};

export const installBrowserGuestCredentials = (): void => {
  if (
    window.top !== window ||
    !/^https?:$/.test(location.protocol) ||
    window.origin !== location.origin
  )
    return;

  let pendingOffer: CredentialOffer | null = null;
  let inFlightOffer: CredentialOffer | null = null;
  const dismissOffer = () => {
    if (!pendingOffer) return;
    ipcRenderer.sendToHost(BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL, null);
    pendingOffer = null;
  };
  const offerFill = async (target: EventTarget | null): Promise<void> => {
    if (!(target instanceof HTMLInputElement) || target.value || !isLoginPassword(target)) return;
    const form = target.form;
    const fields = form ? findLoginFields(form) : null;
    if (form && fields?.password !== target) return;
    if (inFlightOffer?.password === target && isCurrentOffer(inFlightOffer)) return;
    dismissOffer();
    const offer: CredentialOffer = {
      id: crypto.getRandomValues(new Uint32Array(4)).join('-'),
      url: location.href,
      origin: location.origin,
      form,
      password: target,
      username: fields?.username,
      account: fields?.username?.value || null,
    };
    pendingOffer = offer;
    inFlightOffer = offer;
    try {
      const available = await ipcRenderer.invoke(
        BROWSER_GUEST_CREDENTIALS_CHECK_CHANNEL,
        offer.origin,
        offer.account,
      );
      if (pendingOffer !== offer) return;
      if (available === true && isCurrentOffer(offer)) {
        ipcRenderer.sendToHost(BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL, offer.id);
      } else {
        dismissOffer();
      }
    } catch {
      if (pendingOffer === offer) dismissOffer();
    } finally {
      if (inFlightOffer === offer) inFlightOffer = null;
    }
  };

  ipcRenderer.on(
    BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL,
    async (_event, id: unknown, confirmed: unknown) => {
      const offer = pendingOffer;
      if (!offer || id !== offer.id || inFlightOffer === offer) return;
      if (confirmed !== true || !isCurrentOffer(offer)) {
        pendingOffer = null;
        return;
      }
      inFlightOffer = offer;
      try {
        const credential = (await ipcRenderer.invoke(
          BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
          offer.origin,
          offer.account,
        )) as BrowserImportedCredential | null;
        if (!credential || pendingOffer !== offer || !isCurrentOffer(offer)) return;
        pendingOffer = null;
        const { username, password } = offer;
        if (username && !username.value && isEditable(username)) {
          setNativeInputValue(username, credential.username);
          if (!isCurrentOffer({ ...offer, account: credential.username || null })) return;
        }
        setNativeInputValue(password, credential.password);
      } catch {
        // A detached guest or unavailable store must not interfere with manual sign-in.
      } finally {
        if (pendingOffer === offer) pendingOffer = null;
        if (inFlightOffer === offer) inFlightOffer = null;
      }
    },
  );

  document.addEventListener(
    'pointerdown',
    event => {
      if (event.isTrusted && event.button === 0) void offerFill(event.target);
    },
    true,
  );
  document.addEventListener(
    'focusin',
    event => {
      if (!event.isTrusted) return;
      if (pendingOffer && event.target !== pendingOffer.password) dismissOffer();
      void offerFill(event.target);
    },
    true,
  );
  document.addEventListener(
    'input',
    event => {
      if (
        pendingOffer &&
        (event.target === pendingOffer.password || event.target === pendingOffer.username)
      ) {
        dismissOffer();
      }
    },
    true,
  );
  window.addEventListener('pagehide', dismissOffer);

  window.addEventListener(
    'submit',
    event => {
      if (
        !event.isTrusted ||
        !navigator.userActivation.isActive ||
        !(event.target instanceof HTMLFormElement)
      )
        return;
      const fields = findLoginFields(event.target);
      if (!fields) return;
      const username = fields.username?.value ?? '';
      const password = fields.password.value;
      if (
        !password ||
        password.length > BROWSER_CREDENTIAL_PASSWORD_LIMIT ||
        username.length > BROWSER_CREDENTIAL_USERNAME_LIMIT
      )
        return;
      ipcRenderer.send(
        BROWSER_GUEST_CREDENTIALS_SUBMIT_CHANNEL,
        location.origin,
        username,
        password,
      );
    },
    true,
  );
};
