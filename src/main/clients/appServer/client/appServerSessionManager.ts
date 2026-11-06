import type { ExternalAgentBackendFactory } from '../../shared/externalAgentBackend';
import type { ExternalClientResources } from '../../shared/externalClientResources';
import { createCodexAppServerBackend } from './codexAppServerBackend';
import { CodexAppServerEventHub } from './codexAppServerEventHub';
import { CodexAppServerSession } from './codexAppServerSession';

interface Options {
  backend: Pick<ExternalAgentBackendFactory, 'connect'>;
  createResources: () => ExternalClientResources;
  getHome?: () => string;
}

export interface AppServerSessionConnection {
  receiveRaw: CodexAppServerSession['receiveRaw'];
  receive: CodexAppServerSession['receive'];
  close: CodexAppServerSession['close'];
}

/** One profile's app-server sessions, shared by stdio and native WebSocket ingress. */
export class AppServerSessionManager {
  private readonly sessions = new Set<CodexAppServerSession>();
  private readonly closing = new Set<Promise<void>>();
  private readonly events = new CodexAppServerEventHub();

  constructor(private readonly options: Options) {}

  loadedThreadIds(): string[] {
    return [...new Set([...this.sessions].flatMap(session => session.ownedThreadIds()))];
  }

  connect(
    cwd: string,
    env: Record<string, string>,
    send: (message: unknown) => void,
  ): AppServerSessionConnection {
    const session = new CodexAppServerSession(
      createCodexAppServerBackend(this.options.backend.connect(), { cwd, codexHome: env.CODEX_HOME }),
      send,
      {
        home: this.options.getHome?.() ?? cwd,
        resources: this.options.createResources(),
        hub: this.events,
        getLoadedThreadIds: () => this.loadedThreadIds(),
      },
    );
    this.sessions.add(session);
    return {
      receiveRaw: session.receiveRaw,
      receive: session.receive,
      close: reason => this.closeSession(session, reason),
    };
  }

  private closeSession(session: CodexAppServerSession, reason?: Error): Promise<void> {
    this.sessions.delete(session);
    const drain = session.close(reason);
    this.closing.add(drain);
    const release = () => this.closing.delete(drain);
    void drain.then(release, release);
    return drain;
  }

  /** Explicit profile-wide shutdown; individual transports close only their own peers. */
  async stop(): Promise<void> {
    for (const session of this.sessions) void this.closeSession(session).catch(() => {});
    await Promise.allSettled([...this.closing]);
  }
}
