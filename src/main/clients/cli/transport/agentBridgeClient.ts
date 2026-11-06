import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { version } from '../../../../../package.json';
import {
  AGENT_CLI_BRIDGE_DIRECTORY,
  AgentCliErrorCode,
  type AgentCliErrorFrame,
  AgentCliExitCode,
  agentCliInvalidArgumentsMessage,
  formatAgentCliHelp,
  parseAgentCliArguments,
  usesAgentCliMachineOutput,
} from '../../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../../shared/productMetadata';
import {
  AGENT_BRIDGE_MAX_REQUEST_BYTES,
  AGENT_BRIDGE_METADATA_FILE,
  AGENT_BRIDGE_PROTOCOL_VERSION,
  type AgentBridgeMetadata,
  type AgentBridgeRequest,
  type AgentBridgeResponse,
  decodeAgentBridgeLines,
  encodeAgentBridgeMessage,
  selectAgentBridgeEnvironment,
  validateAgentBridgeCommandArgv,
} from './agentBridgeProtocol';

const CONNECT_TIMEOUT_MS = 5_000;

const CLIENT_MESSAGES = {
  en: {
    hostUnavailable:
      '{productName} is not running. Start {productName} and keep it open or in the tray.',
    refreshBridge: 'Restart {productName} to refresh its local bridge.',
    timeout: 'Timed out connecting to {productName}.',
    requestTooLarge: 'The agent CLI request is too large.',
    responseTooLarge: '{productName} returned an oversized bridge response.',
    invalidResponse: '{productName} returned an invalid bridge response.',
    unknownOutcome:
      'The application bridge disconnected before completion. Execution outcome is unknown.',
  },
  zh: {
    hostUnavailable: '{productName} 未运行，请启动应用并保持打开，也可最小化到托盘。',
    refreshBridge: '请重启 {productName} 以刷新本机后台连接。',
    timeout: '连接 {productName} 超时。',
    requestTooLarge: '命令行请求过大。',
    responseTooLarge: '{productName} 返回的后台响应过大。',
    invalidResponse: '{productName} 返回了无效的后台响应。',
    unknownOutcome: '应用后台连接在完成前断开，执行结果尚未确认。',
  },
} as const;

const clientLanguage = (): 'en' | 'zh' =>
  Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en';

const clientMessage = (key: keyof typeof CLIENT_MESSAGES.en): string =>
  CLIENT_MESSAGES[clientLanguage()][key].replaceAll('{productName}', PRODUCT_NAME);

const isBridgeMetadata = (value: unknown): value is AgentBridgeMetadata => {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<AgentBridgeMetadata>;
  return (
    metadata.version === AGENT_BRIDGE_PROTOCOL_VERSION &&
    typeof metadata.endpoint === 'string' &&
    metadata.endpoint.length > 0 &&
    typeof metadata.token === 'string' &&
    metadata.token.length > 0 &&
    typeof metadata.pid === 'number' &&
    Number.isSafeInteger(metadata.pid) &&
    metadata.pid > 0
  );
};

const isBridgeResponse = (value: unknown): value is AgentBridgeResponse => {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<AgentBridgeResponse>;
  if (response.type === 'stdout' || response.type === 'stderr') {
    return typeof response.data === 'string';
  }
  if (response.type === 'exit') {
    return typeof response.code === 'number' && Number.isInteger(response.code);
  }
  return response.type === 'error' && typeof response.message === 'string';
};

/** A stale PID can deny availability; a live or unreadable PID grants no authority. */
export function isAgentBridgeHostDefinitelyStopped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const writeOutput = (stream: NodeJS.WriteStream, value: string | Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(value, error => (error ? reject(error) : resolve()));
  });

const errorOutput = (
  argv: readonly string[],
  code: AgentCliErrorFrame['error']['code'],
  message: string,
): {
  stream: NodeJS.WriteStream;
  text: string;
} =>
  usesAgentCliMachineOutput(argv)
    ? {
        stream: process.stdout,
        text: `${JSON.stringify({ type: 'error', error: { code, message } })}\n`,
      }
    : { stream: process.stderr, text: `${message}\n` };

export async function runAgentBridgeClient(
  userDataPath: string,
  argv: string[],
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<number> {
  const command = parseAgentCliArguments(argv);
  if (!validateAgentBridgeCommandArgv(argv)) {
    const output = errorOutput(
      argv,
      AgentCliErrorCode.InvalidArguments,
      agentCliInvalidArgumentsMessage(clientLanguage()),
    );
    await writeOutput(output.stream, output.text);
    return AgentCliExitCode.InvalidArguments;
  }
  if (command?.kind === 'help' || command?.kind === 'version') {
    await writeOutput(
      process.stdout,
      command.kind === 'help'
        ? formatAgentCliHelp(PRODUCT_NAME, clientLanguage())
        : `${PRODUCT_NAME} ${version}\n`,
    );
    return AgentCliExitCode.Success;
  }
  const metadataPath = path.join(
    userDataPath,
    AGENT_CLI_BRIDGE_DIRECTORY,
    AGENT_BRIDGE_METADATA_FILE,
  );
  let parsedMetadata: unknown;
  try {
    if (fs.statSync(metadataPath).size > 4096) throw new Error('Invalid bridge metadata.');
    parsedMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    const output = errorOutput(
      argv,
      missing ? AgentCliErrorCode.HostUnavailable : AgentCliErrorCode.BridgeError,
      missing ? clientMessage('hostUnavailable') : clientMessage('refreshBridge'),
    );
    await writeOutput(output.stream, output.text);
    return missing ? AgentCliExitCode.HostUnavailable : AgentCliExitCode.BridgeError;
  }
  if (!isBridgeMetadata(parsedMetadata)) {
    const output = errorOutput(argv, AgentCliErrorCode.BridgeError, clientMessage('refreshBridge'));
    await writeOutput(output.stream, output.text);
    return AgentCliExitCode.BridgeError;
  }
  const metadata = parsedMetadata;
  if (isAgentBridgeHostDefinitelyStopped(metadata.pid)) {
    const output = errorOutput(
      argv,
      AgentCliErrorCode.HostUnavailable,
      clientMessage('hostUnavailable'),
    );
    await writeOutput(output.stream, output.text);
    return AgentCliExitCode.HostUnavailable;
  }
  return new Promise(resolve => {
    const socket = net.createConnection(metadata.endpoint);
    let buffer = '';
    const streaming = argv[0] === 'app-server' || argv[0] === 'acp';
    const inputDecoder = new StringDecoder('utf8');
    const input = (chunk: Buffer): void => {
      if (
        !socket.write(encodeAgentBridgeMessage({ type: 'stdin', data: inputDecoder.write(chunk) }))
      )
        process.stdin.pause();
    };
    const eof = (): void => {
      socket.write(encodeAgentBridgeMessage({ type: 'eof' }));
    };
    socket.on('drain', () => {
      if (streaming && !finished) process.stdin.resume();
    });
    const decoder = new StringDecoder('utf8');
    let finished = false;
    let connected = false;
    let responseRejected = false;
    let failureReported = false;
    let pendingWrites = 0;
    let requestedCode: number | null = null;
    const finish = (): void => {
      if (finished || requestedCode === null || pendingWrites > 0) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.off('data', input);
      process.stdin.off('end', eof);
      if (streaming) process.stdin.pause();
      socket.destroy();
      resolve(requestedCode);
    };
    const requestFinish = (code: number): void => {
      requestedCode ??= code;
      finish();
    };
    const fail = (
      code: number,
      errorCode: AgentCliErrorFrame['error']['code'],
      message: string,
    ): void => {
      if (failureReported || requestedCode !== null) return;
      failureReported = true;
      responseRejected = true;
      const output = errorOutput(argv, errorCode, message);
      pendingWrites += 1;
      output.stream.write(output.text, () => {
        pendingWrites -= 1;
        requestFinish(code);
      });
    };
    const relay = (stream: NodeJS.WriteStream, data: string): void => {
      pendingWrites += 1;
      const writable = stream.write(Buffer.from(data, 'base64'), () => {
        pendingWrites -= 1;
        if (!finished && pendingWrites === 0) socket.resume();
        finish();
      });
      if (!writable) socket.pause();
    };
    const timer = setTimeout(() => {
      fail(
        AgentCliExitCode.HostUnavailable,
        AgentCliErrorCode.HostUnavailable,
        clientMessage('timeout'),
      );
    }, timeoutMs);

    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      const request: AgentBridgeRequest = {
        type: 'request',
        version: AGENT_BRIDGE_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        token: metadata.token,
        argv,
        cwd: process.cwd(),
        env: selectAgentBridgeEnvironment(argv, process.env),
      };
      const frame = encodeAgentBridgeMessage(request);
      if (Buffer.byteLength(frame) > AGENT_BRIDGE_MAX_REQUEST_BYTES) {
        fail(
          AgentCliExitCode.InvalidArguments,
          AgentCliErrorCode.InvalidArguments,
          clientMessage('requestTooLarge'),
        );
        return;
      }
      socket.write(frame);
      if (streaming) {
        process.stdin.on('data', input);
        process.stdin.once('end', eof);
        process.stdin.resume();
      }
    });
    socket.on('data', chunk => {
      if (responseRejected) return;
      if (Buffer.byteLength(buffer) + chunk.length > AGENT_BRIDGE_MAX_REQUEST_BYTES) {
        fail(
          AgentCliExitCode.BridgeError,
          AgentCliErrorCode.BridgeError,
          clientMessage('responseTooLarge'),
        );
        return;
      }
      buffer += decoder.write(chunk);
      try {
        const decoded = decodeAgentBridgeLines(buffer);
        buffer = decoded.remainder;
        for (const raw of decoded.messages) {
          if (!isBridgeResponse(raw)) throw new Error('Invalid bridge response.');
          const response = raw;
          if (response.type === 'stdout') relay(process.stdout, response.data);
          else if (response.type === 'stderr') relay(process.stderr, response.data);
          else if (response.type === 'exit') requestFinish(response.code);
          else if (response.type === 'error') {
            fail(AgentCliExitCode.BridgeError, AgentCliErrorCode.BridgeError, response.message);
          }
        }
      } catch {
        fail(
          AgentCliExitCode.BridgeError,
          AgentCliErrorCode.BridgeError,
          clientMessage('invalidResponse'),
        );
      }
    });
    socket.once('error', () => {
      if (connected)
        fail(
          AgentCliExitCode.BridgeError,
          AgentCliErrorCode.BridgeError,
          clientMessage('unknownOutcome'),
        );
      else
        fail(
          AgentCliExitCode.HostUnavailable,
          AgentCliErrorCode.HostUnavailable,
          clientMessage('hostUnavailable'),
        );
    });
    socket.once('close', () => {
      if (failureReported) return;
      if (requestedCode !== null) requestFinish(requestedCode);
      else if (streaming && process.stdin.readableEnded && !buffer)
        requestFinish(AgentCliExitCode.Success);
      else
        fail(
          AgentCliExitCode.BridgeError,
          AgentCliErrorCode.BridgeError,
          clientMessage('unknownOutcome'),
        );
    });
  });
}
