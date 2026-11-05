import { AppServerConnection } from '../../appServer/appServerConnection';
import { CliAppServerBinding, type CliAppServerOptions } from './cliAppServerBinding';
import type { CodexAppServerBackend } from './codexAppServerBackend';

export type { CodexAppServerBackend } from './codexAppServerBackend';

/** Authenticated stdio composition; protocol state belongs to the shared connection. */
export class CodexAppServerSession {
  readonly receiveRaw: AppServerConnection['receiveRaw'];
  readonly receive: AppServerConnection['receive'];
  readonly close: AppServerConnection['close'];
  readonly ownedThreadIds: () => string[];

  constructor(backend: CodexAppServerBackend, send: (message: unknown) => void, options: CliAppServerOptions = {}) {
    let binding!: CliAppServerBinding;
    const connection = new AppServerConnection(
      context => {
        binding = new CliAppServerBinding(backend, context, options);
        return binding;
      },
      send,
    );
    this.receiveRaw = raw => connection.receiveRaw(raw);
    this.receive = raw => connection.receive(raw);
    this.close = reason => connection.close(reason);
    this.ownedThreadIds = () => binding.ownedThreadIds();
  }
}
