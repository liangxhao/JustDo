import { AppServerConnection } from '../../appServer/appServerConnection';
import { CliAppServerBinding } from './cliAppServerBinding';
import type { CodexAppServerBackend } from './codexAppServerBackend';

export type { CodexAppServerBackend } from './codexAppServerBackend';

/** Authenticated stdio composition; protocol state belongs to the shared connection. */
export class CodexAppServerSession {
  readonly receiveRaw: AppServerConnection['receiveRaw'];
  readonly receive: AppServerConnection['receive'];
  readonly close: AppServerConnection['close'];

  constructor(backend: CodexAppServerBackend, send: (message: unknown) => void) {
    const connection = new AppServerConnection(
      context => new CliAppServerBinding(backend, context),
      send,
    );
    this.receiveRaw = raw => connection.receiveRaw(raw);
    this.receive = raw => connection.receive(raw);
    this.close = reason => connection.close(reason);
  }
}
