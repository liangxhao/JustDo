import type {
  AskUserAnswers,
  AskUserQuestion,
} from '../../../shared/openclaw/extensions';

export type ExtensionInteractionResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
};

export type ExtensionInteractionResponse = {
  handled: boolean;
  behavior?: 'allow' | 'deny';
  answers?: AskUserAnswers;
  questions?: AskUserQuestion[];
};

export type ExtensionInteractionHandler = (
  requestId: string,
  result: ExtensionInteractionResult,
) => ExtensionInteractionResponse;

export class ExtensionInteractionRouter {
  private readonly handlers: ExtensionInteractionHandler[] = [];

  register(handler: ExtensionInteractionHandler): void {
    this.handlers.push(handler);
  }

  respond(requestId: string, result: ExtensionInteractionResult): ExtensionInteractionResponse {
    for (const handler of this.handlers) {
      const response = handler(requestId, result);
      if (response.handled) return response;
    }
    return { handled: false };
  }
}
