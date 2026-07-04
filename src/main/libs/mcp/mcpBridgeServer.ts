/**
 * McpBridgeServer — lightweight HTTP callback endpoint for the OpenClaw MCP Bridge.
 *
 * OpenClaw's mcp-bridge plugin calls this endpoint to execute MCP tools.
 * OpenClaw's ask-user-question plugin calls /askuser for user confirmation dialogs.
 * Binds to 127.0.0.1 only (local traffic).
 */
import http from 'http';
import net from 'net';

import type {
  AskUserQuestion,
  AskUserRequest,
  AskUserResponse,
} from '../../../shared/openclawExtensions';
import { AskUserRequestBroker } from './askUserRequestBroker';
import type { McpServerManager } from './mcpServerManager';

export type { AskUserRequest, AskUserResponse } from '../../../shared/openclawExtensions';

const log = (level: string, msg: string) => {
  const formatted = `[McpBridge][${level}] ${msg}`;
  if (level === 'ERROR') {
    console.error(formatted);
  } else if (level === 'WARN') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
};

export class McpBridgeServer {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly mcpManager: McpServerManager;
  private readonly secret: string;
  private readonly askUserBroker = new AskUserRequestBroker();

  constructor(mcpManager: McpServerManager, secret: string) {
    this.mcpManager = mcpManager;
    this.secret = secret;
  }

  get port(): number | null {
    return this._port;
  }

  get callbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/mcp/execute` : null;
  }

  get askUserCallbackUrl(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/askuser` : null;
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
  resolveAskUser(requestId: string, response: AskUserResponse): void {
    this.askUserBroker.resolve(requestId, response);
  }

  /**
   * Start the HTTP callback server on a free port.
   */
  async start(): Promise<number> {
    if (this.server) {
      throw new Error('McpBridgeServer is already running');
    }

    const port = await this.findFreePort();

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      srv.on('error', err => {
        log('ERROR', `HTTP server error: ${err.message}`);
        reject(err);
      });

      srv.listen(port, '127.0.0.1', () => {
        this._port = port;
        this.server = srv;
        log('INFO', `McpBridgeServer listening on http://127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  /**
   * Stop the HTTP callback server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise(resolve => {
      this.server!.close(() => {
        log('INFO', 'McpBridgeServer stopped');
        this.server = null;
        this._port = null;
        resolve();
      });
      // Force-close open connections after a short timeout
      setTimeout(() => {
        this.server?.closeAllConnections?.();
      }, 2000);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Verify secret token (accept either header name)
    const authHeader = req.headers['x-mcp-bridge-secret'] || req.headers['x-ask-user-secret'];
    if (authHeader !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.url?.startsWith('/askuser')) {
      await this.handleAskUser(req, res);
      return;
    }

    if (req.url?.startsWith('/mcp/execute')) {
      await this.handleMcpExecute(req, res);
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

      if (!Array.isArray(input.questions) || input.questions.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or empty "questions" field' }));
        return;
      }

      const userResponse = await this.askUserBroker.request(
        input.questions as AskUserQuestion[],
        typeof input.sessionKey === 'string' ? input.sessionKey : undefined,
      );
      log('INFO', `AskUser resolved, behavior=${userResponse.behavior}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(userResponse));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `AskUser request error: ${errMsg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'deny' }));
    }
  }

  private async handleMcpExecute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readBody(req);
      const { server, tool, args } = JSON.parse(body) as {
        server: string;
        tool: string;
        args: Record<string, unknown>;
      };

      if (!server || !tool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "server" or "tool" field' }));
        return;
      }

      const result = await this.mcpManager.callTool(server, tool, args || {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log('ERROR', `Request handling error: ${errMsg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: `Bridge error: ${errMsg}` }],
          isError: true,
        }),
      );
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
