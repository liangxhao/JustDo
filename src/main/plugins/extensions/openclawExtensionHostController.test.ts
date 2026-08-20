import { describe, expect, test, vi } from 'vitest';

import { OpenClawExtensionHostController } from './openclawExtensionHostController';

const questions = [
  {
    id: 'deployment',
    question: 'How should this be deployed?',
    options: [
      { id: 'automatic', label: 'Automatic' },
      {
        id: 'custom',
        label: 'Custom',
        input: { label: 'Deployment instructions' },
      },
    ],
  },
];

describe('OpenClawExtensionHostController interaction validation', () => {
  test('allows a valid structured answer', () => {
    const controller = new OpenClawExtensionHostController({
      onAskUser: vi.fn(),
      onAskUserDismiss: vi.fn(),
    });
    const resolve = vi.spyOn(controller, 'resolveAskUser').mockReturnValue(true);
    vi.spyOn(controller, 'getPendingAskUserRequest').mockReturnValue({
      requestId: 'request-1',
      waitPolicy: { mode: 'required' },
      questions,
    });

    const result = controller.respondToInteraction('request-1', {
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: {
          deployment: {
            selected: ['custom'],
            optionInputs: { custom: 'Deploy to staging' },
          },
        },
      },
    });

    expect(resolve).toHaveBeenCalledWith('request-1', {
      behavior: 'allow',
      answers: {
        deployment: {
          selected: ['custom'],
          optionInputs: { custom: 'Deploy to staging' },
        },
      },
    });
    expect(result.handled).toBe(true);
    expect(result.behavior).toBe('allow');
  });

  test('fails closed before resolving malformed answers', () => {
    const controller = new OpenClawExtensionHostController({
      onAskUser: vi.fn(),
      onAskUserDismiss: vi.fn(),
    });
    const resolve = vi.spyOn(controller, 'resolveAskUser').mockReturnValue(true);
    vi.spyOn(controller, 'getPendingAskUserRequest').mockReturnValue({
      requestId: 'request-2',
      waitPolicy: { mode: 'required' },
      questions,
    });

    const result = controller.respondToInteraction('request-2', {
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: { deployment: { selected: ['custom'] } },
      },
    });

    expect(resolve).toHaveBeenCalledWith('request-2', { behavior: 'deny' });
    expect(result).toEqual({ handled: true, behavior: 'deny', questions });
  });

  test('validates answers against the original pending questions', () => {
    const controller = new OpenClawExtensionHostController({
      onAskUser: vi.fn(),
      onAskUserDismiss: vi.fn(),
    });
    const resolve = vi.spyOn(controller, 'resolveAskUser').mockReturnValue(true);
    vi.spyOn(controller, 'getPendingAskUserRequest').mockReturnValue({
      requestId: 'request-3',
      waitPolicy: { mode: 'required' },
      questions,
    });

    const result = controller.respondToInteraction('request-3', {
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            ...questions[0],
            options: questions[0].options.map(option => ({ ...option, input: undefined })),
          },
        ],
        answers: { deployment: { selected: ['custom'] } },
      },
    });

    expect(resolve).toHaveBeenCalledWith('request-3', { behavior: 'deny' });
    expect(result).toEqual({ handled: true, behavior: 'deny', questions });
  });
});
