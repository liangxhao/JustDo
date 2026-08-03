/**
 * Callback server for locally hosted OpenClaw extensions.
 *
 * OpenClaw's ask-user-question plugin calls /askuser for user confirmation dialogs.
 * Binds to 127.0.0.1 only (local traffic).
 */
import http from 'http';
import net from 'net';

import type {
  AskUserRequest,
  AskUserResponse,
} from '../../../shared/openclaw/extensions';
import { parseAskUserQuestions } from '../../../shared/openclaw/extensions';
import { AskUserRequestBroker } from './askUserRequestBroker';

export type { AskUserRequest, AskUserResponse } from '../../../shared/openclaw/extensions';

const log = (level: string, msg: string) => {
  const formatted = `[OpenClawExtensionCallback][${level}] ${msg}`;
  if (level === 'ERROR') {
    console.error(formatted);
  } else if (level === 'WARN') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
};

export class OpenClawExtensionCallbackServer {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly secret: string;
  private readonly askUserBroker = new AskUserRequestBroker();
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(secret: string) {
    this.secret = secret;
  }

  get port(): number | null {
    return this.server?.listening ? this._port : null;
  }

  get callbackUrl(): string | null {
    const port = this.port;
    return port ? `http://127.0.0.1:${port}/mcp/execute` : null;
  }

  get askUserCallbackUrl(): string | null {
    const port = this.port;
    return port ? `http://127.0.0.1:${port}/askuser` : null;
  }

  /**
   * Register a callback that fires when an AskUserQuestion request arrives.
   * The callback should show a modal and eventually call resolveAskUser().
   */
  onAskUser(callback: (request: AskUserRequest) => void): void {
    this.askUserBroker.onRequest(callback);
  }

  /**
   * Register a callback that fires when an AskUser request is dismissed (timeout or resolved).
   * The callback should close the modal in the renderer.
   */
  onAskUserDismiss(callback: (requestId: string) => void): void {
    this.askUserBroker.onDismiss(callback);
  }

  /**
   * Resolve a pending AskUserQuestion request (called when user clicks in the modal).
   */
  resolveAskUser(requestId: string, response: AskUserResponse): boolean {
    return this.askUserBroker.resolve(requestId, response);
  }

  getPendingAskUserRequest(requestId: string): AskUserRequest | null {
    return this.askUserBroker.get(requestId);
  }

  listPendingAskUserRequests(): AskUserRequest[] {
    return this.askUserBroker.list();
  }

  /**
   * Start the HTTP callback server on a free port.
   */
  start(): Promise<number> {
    return this.enqueueLifecycle(() => this.startInternal());
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private async startInternal(): Promise<number> {
    if (this.server?.listening && this._port) return this._port;

    const port = await this.findFreePort();

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      let listening = false;

      srv.on('error', err => {
        log('ERROR', `HTTP server error: ${err.message}`);
        if (!listening) {
          reject(err);
        }
      });
      srv.once('close', () => {
        if (this.server === srv) {
          this.server = null;
          this._port = null;
        }
      });

      srv.listen(port, '127.0.0.1', () => {
        listening = true;
        this._port = port;
        this.server = srv;
        log('INFO', `Extension callback server listening on http://127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  private async stopInternal(): Promise<void> {
    this.askUserBroker.cancelAll();
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    this._port = null;

    return new Promise(resolve => {
      const forceCloseTimer = setTimeout(() => {
        srv.closeAllConnections?.();
      }, 2000);
      srv.close(() => {
        clearTimeout(forceCloseTimer);
        log('INFO', 'Extension callback server stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Verify secret token (accept either header name)
    const authHeader = req.headers['x-ask-user-secret'];
    if (authHeader !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.url?.startsWith('/askuser')) {
      await this.handleAskUser(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleAskUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const input = JSON.parse(body) as { questions?: unknown[]; sessionKey?: unknown };
      log(
        'INFO',
        `AskUser request received, questions=${Array.isArray(input.questions) ? input.questions.length : 0}`,
      );

      const questions = parseAskUserQuestions(input.questions);
      if (!questions) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid "questions" field' }));
        return;
      }

      const pending = this.askUserBroker.request(
        questions,
        typeof input.sessionKey === 'string' ? input.sessionKey : undefined,
      );
      const cancelPending = () => {
        this.askUserBroker.cancel(pending.requestId);
      };
      req.once('aborted', cancelPending);
      res.once('close', cancelPending);
      const userResponse = await pending.response;
      req.removeListener('aborted', cancelPending);
      res.removeListener('close', cancelPending);
      if (res.destroyed || res.writableEnded) return;
      log('INFO', `AskUser resolved, behavior=${userResponse.behavior}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(userResponse));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `AskUser request error: ${errMsg}`);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'deny' }));
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.once('listening', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.listen(0, '127.0.0.1');
    });
  }
}
