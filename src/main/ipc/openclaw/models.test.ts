import { beforeEach, describe, expect, test, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { OpenClawModelsIpc } from '../../../shared/openclaw/models';
import { normalizeOpenClawModelChoices, registerOpenClawModelHandlers } from './models';

describe('normalizeOpenClawModelChoices', () => {
  test('retains model choices without forwarding runtime retry state', () => {
    const models = normalizeOpenClawModelChoices([
      {
        id: 'configured-model',
        name: 'Configured model',
        provider: 'acme',
        available: false,
        unavailableReason: 'cooldown',
        unavailableUntil: 123,
        input: ['text', 'image'],
      },
    ]);

    expect(models).toEqual([
      {
        id: 'configured-model',
        name: 'Configured model',
        provider: 'acme',
        available: false,
        input: ['text', 'image'],
      },
    ]);
  });

  test('drops malformed rows and private or unknown fields', () => {
    expect(
      normalizeOpenClawModelChoices([
        null,
        { id: 'missing-provider', name: 'Missing provider' },
        {
          id: ' gpt-5 ',
          name: ' GPT 5 ',
          provider: ' openai ',
          available: false,
          unavailableReason: 'missing-auth',
          contextWindow: 128_000,
          input: ['text', 'image', 'future-kind', 1],
          privateRoute: 'secret',
        },
      ]),
    ).toEqual([
      {
        id: 'gpt-5',
        name: 'GPT 5',
        provider: 'openai',
        available: false,
        unavailableReason: 'missing-auth',
        contextWindow: 128_000,
        input: ['text', 'image'],
      },
    ]);
  });
});

describe('registerOpenClawModelHandlers', () => {
  beforeEach(() => handlers.clear());

  test('requests the agent-scoped provider config catalog', async () => {
    const requestGateway = vi.fn().mockResolvedValue({
      models: [
        {
          id: 'gpt-5',
          name: 'GPT 5',
          provider: 'openai',
          available: true,
          contextWindow: 128_000,
        },
      ],
    });
    const client = {};
    const runtime = { getGatewayClient: () => client, requestGateway };
    registerOpenClawModelHandlers({ getRuntime: () => runtime as never });

    const result = await handlers.get(OpenClawModelsIpc.List)?.({}, { agentId: 'writer' });

    expect(requestGateway).toHaveBeenCalledWith(
      'models.list',
      { agentId: 'writer', view: 'provider-config' },
      { assertBeforeSend: expect.any(Function) },
    );
    expect(result).toEqual({
      success: true,
      models: [
        expect.objectContaining({ id: 'gpt-5', available: true, contextWindow: 128_000 }),
      ],
    });
  });

  test('falls back without models when the runtime is unavailable', async () => {
    registerOpenClawModelHandlers({ getRuntime: () => null });

    await expect(handlers.get(OpenClawModelsIpc.List)?.({})).resolves.toEqual({
      success: false,
      models: [],
      error: 'OpenClaw runtime is not available',
    });
  });

  test('returns a safe empty result when the Gateway request fails', async () => {
    const client = {};
    const runtime = {
      getGatewayClient: () => client,
      requestGateway: vi.fn().mockRejectedValue(new Error('gateway disconnected')),
    };
    registerOpenClawModelHandlers({ getRuntime: () => runtime as never });

    await expect(handlers.get(OpenClawModelsIpc.List)?.({}, { agentId: ' ' })).resolves.toEqual({
      success: false,
      models: [],
      error: 'gateway disconnected',
    });
  });

  test('does not start Gateway to read model metadata while disconnected', async () => {
    const requestGateway = vi.fn();
    const runtime = { getGatewayClient: () => null, requestGateway };
    registerOpenClawModelHandlers({ getRuntime: () => runtime as never });

    await expect(handlers.get(OpenClawModelsIpc.List)?.({})).resolves.toMatchObject({
      success: false,
      models: [],
    });
    expect(requestGateway).not.toHaveBeenCalled();
  });

  test('discards a late catalog response from a replaced Gateway connection', async () => {
    let client = {};
    const response = Promise.withResolvers<{ models: unknown[] }>();
    const runtime = { getGatewayClient: () => client, requestGateway: () => response.promise };
    registerOpenClawModelHandlers({ getRuntime: () => runtime as never });

    const result = handlers.get(OpenClawModelsIpc.List)?.({});
    client = {};
    response.resolve({ models: [{ id: 'old', name: 'Old', provider: 'builtin_models' }] });

    await expect(result).resolves.toMatchObject({ success: false, models: [] });
  });
});
