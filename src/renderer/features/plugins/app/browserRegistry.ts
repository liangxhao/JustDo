import { type ComponentType, createElement, type ReactNode } from 'react';

import { UiStyleScopeBoundary } from '@/shared/dom/styleScope';

import type { AppServices } from '../../../../../plugins/sdk/app-plugin-sdk/application';
import type {
  AppBrowserContribution,
  AppBrowserHost,
  AppBrowserModule,
  AppComposerMode,
  AppSessionPresentation,
  AppViewContext,
} from '../../../../../plugins/sdk/app-plugin-sdk/browser';
import type {
  AppPluginBridge,
  AppPluginSnapshot,
} from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import { isAppIdentifier, isAppWireValue } from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppHistoryPresentationModule } from '../../../../../plugins/sdk/app-plugin-sdk/history-presentation';
import { registerMessagePresentation } from './messagePresentation';
import { AppUiStateStore } from './uiState';

export interface AppView extends AppBrowserContribution {
  pluginId: string;
  epoch: string;
}
export interface AppMode extends AppComposerMode {
  pluginId: string;
  epoch: string;
}
interface Instance {
  snapshot: AppPluginSnapshot;
  controller: AbortController;
  dispose?: () => void;
  releases: (() => void)[];
}
interface BrowserServices {
  t(key: string): string;
  translations(
    id: string,
    dictionaries: { en: Record<string, string>; zh: Record<string, string> },
  ): () => void;
  components: Record<string, ComponentType<Record<string, unknown>>>;
  renderHistory(input: Record<string, unknown>): ReactNode;
  openWorkspace?(input: {
    pluginId: string;
    epoch: string;
    contributionId: string;
    sessionId: string;
    selection?: unknown;
  }): void;
  application?: AppServices;
}

/** Same-world trusted UI; contribution lifetime follows the exact Main business epoch. */
export class AppBrowserRegistry {
  private readonly historyPresentations = new Map<string, { hash: string; release?: () => void }>();
  private readonly uiStates = new Map<string, { hash: string; store: AppUiStateStore }>();
  private readonly instances = new Map<string, Instance>();
  private readonly listeners = new Set<() => void>();
  private views: AppView[] = [];
  private modes: AppMode[] = [];
  private presentations: {
    pluginId: string;
    resolve(sessionKey: string): { visible: boolean; label?: string } | undefined;
  }[] = [];
  private sessionPresentations: {
    pluginId: string;
    resolve(sessionId: string): AppSessionPresentation | undefined;
  }[] = [];
  private readonly sessionActivity = new Map<string, ReadonlySet<string>>();
  private contextRevision = 0;
  private readonly navigationListeners = new Set<() => void>();
  private revision = 0;
  private updates = 0;
  private workspaceRequests: {
    pluginId: string;
    epoch: string;
    contributionId: string;
    sessionId: string;
    selection?: unknown;
  }[] = [];
  private disposed = false;
  private unsubscribe?: () => void;
  constructor(
    private readonly bridge: AppPluginBridge,
    private readonly services: BrowserServices,
    private readonly load: (url: string) => Promise<AppBrowserModule> = url =>
      import(/* @vite-ignore */ url),
    private readonly loadPresentation: (
      url: string,
    ) => Promise<AppHistoryPresentationModule> = url => import(/* @vite-ignore */ url),
  ) {}

  async start(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe = this.bridge.onChanged(snapshot => {
      this.revision++;
      void this.update(snapshot);
    });
    const revision = this.revision;
    const snapshot = await this.bridge.snapshot();
    if (revision === this.revision) await this.update(snapshot);
  }
  readonly getViews = (): readonly AppView[] => this.views;
  readonly getModes = (): readonly AppMode[] => this.modes;
  readonly getContextRevision = () => this.contextRevision;
  readonly getWorkspaceRequests = () => this.workspaceRequests;
  sessionPresentation(sessionId: string): AppSessionPresentation {
    const presentation = this.sessionPresentations.reduce<AppSessionPresentation>(
      (result, item) => {
        try {
          return { ...result, ...item.resolve(sessionId) };
        } catch {
          return result;
        }
      },
      {},
    );
    return [...this.sessionActivity.values()].some(active => active.has(sessionId))
      ? { ...presentation, status: 'running' }
      : presentation;
  }
  sessionNavigation(sessionId: string) {
    for (const item of this.sessionPresentations) {
      const presentation = item.resolve(sessionId);
      if (!presentation?.anchorSessionId) continue;
      const instance = this.instances.get(item.pluginId);
      if (!instance) continue;
      const epoch = instance.snapshot.epoch;
      return {
        sessionId: presentation.anchorSessionId,
        isCurrent: () =>
          this.instances.get(item.pluginId) === instance && instance.snapshot.epoch === epoch,
        selected: () => {
          if (this.instances.get(item.pluginId) !== instance || !presentation.workspace) return;
          this.workspaceRequests = [
            ...this.workspaceRequests.filter(request => request.pluginId !== item.pluginId),
            {
              pluginId: item.pluginId,
              epoch,
              sessionId: presentation.anchorSessionId!,
              ...presentation.workspace,
            },
          ].slice(-64);
          this.changed();
        },
      };
    }
    return { sessionId, isCurrent: () => true, selected: () => undefined };
  }
  acknowledgeWorkspaceRequest(request: (typeof this.workspaceRequests)[number]): void {
    this.workspaceRequests = this.workspaceRequests.filter(item => item !== request);
    this.changed();
  }
  interactionPresentation(sessionKey: unknown) {
    if (typeof sessionKey !== 'string') return undefined;
    for (const contribution of this.presentations) {
      try {
        const result = contribution.resolve(sessionKey);
        if (result) return result;
      } catch {
        /* Retired contexts cannot acquire new interactions. */
      }
    }
    return undefined;
  }
  readonly dismissPages = () => {
    this.navigationListeners.forEach(listener => {
      try {
        listener();
      } catch {
        /* A retired contribution does not own navigation. */
      }
    });
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed(): void {
    this.listeners.forEach(listener => listener());
  }
  async update(snapshots: AppPluginSnapshot[]): Promise<void> {
    if (this.disposed) return;
    const update = ++this.updates;
    for (const [id, state] of this.uiStates) {
      if (
        !snapshots.some(
          snapshot =>
            snapshot.id === id && snapshot.hash === state.hash && snapshot.installed === true,
        )
      )
        this.uiStates.delete(id);
    }
    // Withdrawal is synchronous. A slow pure entry must never retain business UI.
    const presentationUpdate = this.updateHistoryPresentations(snapshots);
    const active = snapshots.filter(item => item.state === 'active');
    for (const [id, instance] of this.instances) {
      const next = active.find(item => item.id === id);
      if (!next || next.epoch !== instance.snapshot.epoch || next.hash !== instance.snapshot.hash)
        this.retire(id, instance);
    }
    for (const snapshot of active) {
      if (this.disposed || update !== this.updates) return;
      if (this.instances.has(snapshot.id)) continue;
      const base = `/assets/app-plugins/${snapshot.hash}/${snapshot.epoch}/`;
      if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(snapshot.epoch)) continue;
      if (
        !/^[a-f0-9]{64}$/u.test(snapshot.hash) ||
        !snapshot.browserEntry?.startsWith(base) ||
        !/^[a-zA-Z0-9_./-]+\.(?:mjs|js)$/u.test(snapshot.browserEntry) ||
        snapshot.browserEntry.includes('..')
      )
        continue;
      const instance: Instance = { snapshot, controller: new AbortController(), releases: [] };
      this.instances.set(snapshot.id, instance);
      const current = () =>
        this.instances.get(snapshot.id) === instance && !instance.controller.signal.aborted;
      const assertCurrent = () => {
        if (!current()) throw new Error('appPluginRetired');
      };
      try {
        const module = await this.load(snapshot.browserEntry);
        assertCurrent();
        if (typeof module.register !== 'function') throw new Error('appPluginIncompatible');
        const host: AppBrowserHost = {
          plugin: snapshot,
          signal: instance.controller.signal,
          uiState: {
            get: key => {
              assertCurrent();
              return this.uiState(snapshot).get(key);
            },
            set: (key, value) => {
              assertCurrent();
              this.uiState(snapshot).set(key, value);
            },
          },
          onEvent: (name, listener) => {
            assertCurrent();
            if (!isAppIdentifier(name)) throw new Error('appPluginInvalidRequest');
            const release =
              this.bridge.onEvent?.(event => {
                if (
                  !current() ||
                  event?.id !== snapshot.id ||
                  event.hash !== snapshot.hash ||
                  event.epoch !== snapshot.epoch ||
                  event.name !== name ||
                  !isAppWireValue(event.payload)
                )
                  return;
                listener(event.payload as never);
              }) ?? (() => undefined);
            instance.releases.push(release);
            return release;
          },
          invoke: async (command, ...args) => {
            assertCurrent();
            if (!snapshot.commands?.includes(command)) throw new Error('appPluginInvalidRequest');
            const result = await this.bridge.invoke({
              id: snapshot.id,
              epoch: snapshot.epoch,
              command,
              args,
            });
            assertCurrent();
            return result as never;
          },
          registerView: contribution => {
            assertCurrent();
            if (
              !snapshot.slots?.includes(contribution.slot) ||
              (contribution.order !== undefined && !Number.isFinite(contribution.order)) ||
              (contribution.detailsPresentation !== undefined &&
                (contribution.slot !== 'session.details' ||
                  typeof contribution.detailsPresentation !== 'function')) ||
              this.views.some(view => view.pluginId === snapshot.id && view.id === contribution.id)
            )
              throw new Error('appPluginInvalidRequest');
            const view: AppView = {
              ...contribution,
              pluginId: snapshot.id,
              epoch: snapshot.epoch,
              icon: scopedNode(snapshot.id, contribution.icon),
              ...(contribution.detailsPresentation
                ? {
                    detailsPresentation: (sessionId: string) => {
                      assertCurrent();
                      const presentation = contribution.detailsPresentation!(sessionId);
                      assertCurrent();
                      if (!['replace', 'append', 'hidden'].includes(presentation))
                        throw new Error('appPluginInvalidRequest');
                      return presentation;
                    },
                  }
                : {}),
              component: context =>
                scopedNode(
                  snapshot.id,
                  createElement(contribution.component, guardViewContext(context, assertCurrent)),
                ),
            };
            this.views = [...this.views, view];
            this.changed();
            const release = () => {
              this.views = this.views.filter(item => item !== view);
              this.changed();
            };
            instance.releases.push(release);
            return release;
          },
          registerMode: contribution => {
            assertCurrent();
            if (
              !snapshot.slots?.includes('composer.mode') ||
              (contribution.order !== undefined && !Number.isFinite(contribution.order)) ||
              (contribution.group?.order !== undefined &&
                !Number.isFinite(contribution.group.order)) ||
              this.modes.some(mode => mode.pluginId === snapshot.id && mode.id === contribution.id)
            )
              throw new Error('appPluginInvalidRequest');
            const mode: AppMode = {
              ...contribution,
              pluginId: snapshot.id,
              epoch: snapshot.epoch,
              icon: scopedNode(snapshot.id, contribution.icon),
              ...(contribution.group
                ? {
                    group: {
                      ...contribution.group,
                      icon: scopedNode(snapshot.id, contribution.group.icon),
                    },
                  }
                : {}),
              ...(contribution.component
                ? {
                    component: (props: { value: unknown; onChange(value: unknown): void }) =>
                      scopedNode(snapshot.id, createElement(contribution.component!, props)),
                  }
                : {}),
              prepare: async input => {
                assertCurrent();
                const result = await contribution.prepare(input);
                assertCurrent();
                return result;
              },
            };
            this.modes = [...this.modes, mode];
            this.changed();
            const release = () => {
              this.modes = this.modes.filter(item => item !== mode);
              this.changed();
            };
            instance.releases.push(release);
            return release;
          },
          registerTranslations: dictionaries => {
            assertCurrent();
            const release = this.services.translations(snapshot.id, dictionaries);
            instance.releases.push(release);
            return release;
          },
          t: this.services.t,
          components: this.services.components,
          renderHistory: input => {
            assertCurrent();
            return this.services.renderHistory({ ...input, assertCurrent });
          },
          openWorkspace: (contributionId, sessionId, selection) => {
            assertCurrent();
            if (
              !this.views.some(
                view =>
                  view.pluginId === snapshot.id &&
                  view.id === contributionId &&
                  view.slot === 'workspace.tab',
              )
            )
              throw new Error('appPluginInvalidRequest');
            const request = {
              pluginId: snapshot.id,
              epoch: snapshot.epoch,
              contributionId,
              sessionId,
              selection,
            };
            this.workspaceRequests = [
              ...this.workspaceRequests.filter(
                item => item.pluginId !== snapshot.id || item.sessionId !== sessionId,
              ),
              request,
            ].slice(-64);
            this.changed();
            this.services.openWorkspace?.(request);
          },
          application: guardApplicationServices(this.services.application, assertCurrent),
          interactionContextChanged: () => {
            assertCurrent();
            this.contextRevision++;
            this.changed();
          },
          onNavigation: listener => {
            assertCurrent();
            const currentListener = () => {
              assertCurrent();
              listener();
            };
            this.navigationListeners.add(currentListener);
            const release = () => {
              this.navigationListeners.delete(currentListener);
            };
            instance.releases.push(release);
            return release;
          },
          registerInteractionPresentation: resolve => {
            assertCurrent();
            if (!snapshot.slots?.includes('interactions.presentation'))
              throw new Error('appPluginInvalidRequest');
            const contribution = {
              pluginId: snapshot.id,
              resolve: (key: string) => {
                assertCurrent();
                return resolve(key);
              },
            };
            this.presentations.push(contribution);
            const release = () => {
              this.presentations = this.presentations.filter(item => item !== contribution);
              this.contextRevision++;
              this.changed();
            };
            instance.releases.push(release);
            return release;
          },
          registerSessionPresentation: resolve => {
            assertCurrent();
            if (!snapshot.slots?.includes('session.presentation'))
              throw new Error('appPluginInvalidRequest');
            const contribution = {
              pluginId: snapshot.id,
              resolve: (id: string) => {
                assertCurrent();
                return resolve(id);
              },
            };
            this.sessionPresentations.push(contribution);
            const release = () => {
              this.sessionPresentations = this.sessionPresentations.filter(
                item => item !== contribution,
              );
              this.contextRevision++;
              this.changed();
            };
            instance.releases.push(release);
            return release;
          },
          publishSessionActivity: sessionIds => {
            assertCurrent();
            if (
              !snapshot.slots?.includes('session.presentation') ||
              !Array.isArray(sessionIds) ||
              sessionIds.length > 16_384 ||
              sessionIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)
            )
              throw new Error('appPluginInvalidRequest');
            const active = new Set(sessionIds);
            const previous = this.sessionActivity.get(snapshot.id);
            if (previous?.size === active.size && [...active].every(id => previous.has(id))) return;
            this.sessionActivity.set(snapshot.id, active);
            this.contextRevision++;
            this.changed();
          },
          registerMessagePresentation: presentation => {
            assertCurrent();
            if (!snapshot.slots?.includes('messages.presentation'))
              throw new Error('appPluginInvalidRequest');
            const release = registerMessagePresentation(snapshot.id, {
              replyMirror: message => {
                assertCurrent();
                return presentation.replyMirror?.(message) === true;
              },
              text: source => {
                assertCurrent();
                return presentation.text?.(source) ?? source;
              },
              nativeInput: message => {
                assertCurrent();
                return presentation.nativeInput?.(message);
              },
            });
            instance.releases.push(release);
            return release;
          },
        };
        const dispose = module.register(host);
        if (dispose && typeof (dispose as { then?: unknown }).then === 'function') {
          void Promise.resolve(dispose).catch((): undefined => undefined);
          throw new Error('App browser registration must be synchronous');
        }
        if (typeof dispose === 'function') instance.dispose = dispose;
        if (
          snapshot.browserStyle?.startsWith(base) &&
          !snapshot.browserStyle.includes('..') &&
          snapshot.browserStyle.endsWith('.css')
        ) {
          const style = document.createElement('link');
          style.rel = 'stylesheet';
          style.href = snapshot.browserStyle;
          document.head.appendChild(style);
          instance.releases.push(() => style.remove());
        }
        assertCurrent();
      } catch {
        if (current()) {
          console.error('[AppPlugins] Browser registration failed:', snapshot.id);
          this.retire(snapshot.id, instance);
        }
      }
    }
    await presentationUpdate;
  }
  private async updateHistoryPresentations(snapshots: AppPluginSnapshot[]): Promise<void> {
    const admitted = snapshots.filter(snapshot => {
      const base = `/assets/app-plugins/${snapshot.hash}/presentation/`;
      return (
        snapshot.installed === true &&
        isAppIdentifier(snapshot.id) &&
        /^[a-f0-9]{64}$/u.test(snapshot.hash) &&
        snapshot.presentationEntry?.startsWith(base) &&
        /^[a-zA-Z0-9_./-]+\.(?:mjs|js)$/u.test(snapshot.presentationEntry) &&
        !snapshot.presentationEntry.includes('..')
      );
    });
    for (const [id, instance] of this.historyPresentations) {
      if (!admitted.some(snapshot => snapshot.id === id && snapshot.hash === instance.hash)) {
        this.historyPresentations.delete(id);
        instance.release?.();
      }
    }
    await Promise.all(
      admitted.map(async snapshot => {
        if (this.historyPresentations.has(snapshot.id)) return;
        const instance = { hash: snapshot.hash, release: undefined as (() => void) | undefined };
        this.historyPresentations.set(snapshot.id, instance);
        const current = () =>
          !this.disposed && this.historyPresentations.get(snapshot.id) === instance;
        try {
          const module = await this.loadPresentation(snapshot.presentationEntry!);
          if (!current()) return;
          if (Object.keys(module).some(key => key !== 'presentation'))
            throw new Error('appPluginIncompatible');
          const value = module.presentation;
          if (
            !value ||
            typeof value !== 'object' ||
            Object.keys(value).some(
              key => !['text', 'nativeInput', 'replyMirror', 'translations'].includes(key),
            ) ||
            ['text', 'nativeInput', 'replyMirror'].some(
              key =>
                value[key as keyof typeof value] !== undefined &&
                typeof value[key as keyof typeof value] !== 'function',
            )
          )
            throw new Error('appPluginIncompatible');
          const releases: (() => void)[] = [];
          instance.release = () =>
            releases
              .splice(0)
              .reverse()
              .forEach(release => release());
          if (value.translations) {
            if (!validDictionaries(value.translations)) throw new Error('appPluginInvalidRequest');
            // Copy only bounded static data, never retain an old host/t resolver.
            releases.push(
              this.services.translations(`presentation:${snapshot.id}`, {
                en: { ...value.translations.en },
                zh: { ...value.translations.zh },
              }),
            );
          }
          releases.push(
            registerMessagePresentation(`presentation:${snapshot.id}`, {
              text: source => {
                if (!current()) return source;
                const result = value.text?.(source);
                return current() && typeof result === 'string' ? result : source;
              },
              replyMirror: message => {
                if (!current()) return false;
                const result = value.replyMirror?.(message);
                return current() && result === true;
              },
              nativeInput: message => {
                if (!current()) return;
                const input = value.nativeInput?.(message);
                if (
                  !current() ||
                  !input ||
                  typeof input.senderLabelKey !== 'string' ||
                  typeof input.senderId !== 'string' ||
                  input.senderLabelKey.length > 128 ||
                  input.senderId.length > 256
                )
                  return;
                return {
                  senderLabel: this.services.t(input.senderLabelKey),
                  senderId: input.senderId,
                };
              },
            }),
          );
        } catch {
          if (current()) {
            this.historyPresentations.delete(snapshot.id);
            instance.release?.();
          }
        }
      }),
    );
  }
  private uiState(snapshot: AppPluginSnapshot): AppUiStateStore {
    if (snapshot.installed !== true) throw new Error('appPluginUnavailable');
    let state = this.uiStates.get(snapshot.id);
    if (!state || state.hash !== snapshot.hash) {
      state = { hash: snapshot.hash, store: new AppUiStateStore() };
      this.uiStates.set(snapshot.id, state);
    }
    return state.store;
  }
  private retire(id: string, instance: Instance): void {
    this.instances.delete(id);
    instance.controller.abort();
    try {
      void Promise.resolve(instance.dispose?.()).catch((): undefined => undefined);
    } catch {
      /* A failed plugin must not prevent shell cleanup. */
    }
    instance.releases
      .splice(0)
      .reverse()
      .forEach(release => {
        try {
          release();
        } catch {
          /* Continue cleanup. */
        }
      });
    this.views = this.views.filter(view => view.pluginId !== id);
    this.modes = this.modes.filter(mode => mode.pluginId !== id);
    this.presentations = this.presentations.filter(item => item.pluginId !== id);
    this.sessionPresentations = this.sessionPresentations.filter(item => item.pluginId !== id);
    this.workspaceRequests = this.workspaceRequests.filter(item => item.pluginId !== id);
    this.contextRevision++;
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.updates++;
    this.revision++;
    this.unsubscribe?.();
    for (const [id, instance] of this.instances) this.retire(id, instance);
    this.historyPresentations.forEach(instance => instance.release?.());
    this.historyPresentations.clear();
    this.uiStates.clear();
    this.sessionActivity.clear();
    this.listeners.clear();
  }
}

function validDictionaries(
  value: unknown,
): value is { en: Record<string, string>; zh: Record<string, string> } {
  if (!value || typeof value !== 'object' || !isAppWireValue(value)) return false;
  const dictionaries = value as Record<string, unknown>;
  return (
    Object.keys(dictionaries).length === 2 &&
    ['en', 'zh'].every(language => {
      const dictionary = dictionaries[language];
      return (
        dictionary &&
        typeof dictionary === 'object' &&
        !Array.isArray(dictionary) &&
        Object.values(dictionary).every(text => typeof text === 'string')
      );
    }) &&
    Object.keys(dictionaries.en as object)
      .sort()
      .join('\0') ===
      Object.keys(dictionaries.zh as object)
        .sort()
        .join('\0')
  );
}

function scopedNode(scope: string, node: ReactNode): ReactNode {
  return node == null || typeof node === 'boolean' || node === ''
    ? node
    : createElement(UiStyleScopeBoundary, { scope }, node);
}

function guardApplicationServices(
  input: AppServices | undefined,
  assertCurrent: () => void,
): AppServices {
  const wrap = (value: unknown, owner?: object): unknown =>
    typeof value === 'function'
      ? (...args: unknown[]) => {
          assertCurrent();
          const result: unknown = Reflect.apply(value, owner, args);
          return result instanceof Promise
            ? result.then(next => {
                assertCurrent();
                return next;
              })
            : result;
        }
      : value && typeof value === 'object'
        ? new Proxy(value, { get: (target, key) => wrap(Reflect.get(target, key), target) })
        : value;
  const services = wrap(input ?? {}) as AppServices;
  return {
    ...services,
    sessions: {
      ...services.sessions,
      loadSession: (id, options) =>
        services.sessions.loadSession(id, {
          canSelect: () => {
            try {
              assertCurrent();
              return options?.canSelect?.() ?? true;
            } catch {
              return false;
            }
          },
          onSelected: () => {
            assertCurrent();
            options?.onSelected?.();
          },
        }),
    },
  };
}

function guardViewContext(context: AppViewContext, assertCurrent: () => void): AppViewContext {
  const guard =
    <A extends unknown[], R>(operation: (...args: A) => R) =>
    (...args: A): R => {
      assertCurrent();
      return operation(...args);
    };
  return {
    ...context,
    ...(context.onClose ? { onClose: guard(context.onClose) } : {}),
    ...(context.onInspectSession ? { onInspectSession: guard(context.onInspectSession) } : {}),
    ...(context.page ? { page: { setVisible: guard(context.page.setVisible) } } : {}),
    ...(context.openWorkspace ? { openWorkspace: guard(context.openWorkspace) } : {}),
    ...(context.onOpenSubtask ? { onOpenSubtask: guard(context.onOpenSubtask) } : {}),
    ...(context.draft
      ? { draft: { append: guard(context.draft.append), focus: guard(context.draft.focus) } }
      : {}),
    ...(context.navigation
      ? {
          navigation: {
            ...(context.navigation.revision === undefined
              ? {}
              : { revision: context.navigation.revision }),
            showChat: guard(context.navigation.showChat),
            requestTransition: guard(options =>
              context.navigation!.requestTransition({
                ...options,
                canCommit: () => {
                  try {
                    assertCurrent();
                    return options?.canCommit?.() ?? true;
                  } catch {
                    return false;
                  }
                },
              }),
            ),
          },
        }
      : {}),
    ...(context.submitUserTurn
      ? {
          submitUserTurn: {
            ...context.submitUserTurn,
            assertReady: guard(context.submitUserTurn.assertReady),
            send: guard(input =>
              context.submitUserTurn!.send({
                ...input,
                assertCurrent: () => {
                  assertCurrent();
                  input.assertCurrent?.();
                },
              }),
            ),
          },
        }
      : {}),
  };
}
