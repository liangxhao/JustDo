import { Directive, directive } from 'lit/directive.js';

/** Share a recovered result for the lifetime of one rendered native tool row. */
export class ToolResultScope {
  private recoveredText: string | undefined;
  private readonly subscribers = new Set<() => void>();

  get text(): string | undefined {
    return this.recoveredText;
  }

  complete(text: string): void {
    if (text === this.recoveredText) return;
    this.recoveredText = text;
    for (const subscriber of this.subscribers) subscriber();
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
}

class ToolResultScopeDirective extends Directive {
  private identityKey: string | undefined;
  private scope: ToolResultScope | undefined;

  render(identityKey: string, content: (scope: ToolResultScope) => unknown): unknown {
    if (!this.scope || this.identityKey !== identityKey) {
      this.identityKey = identityKey;
      this.scope = new ToolResultScope();
    }
    return content(this.scope);
  }
}

export const withToolResultScope = directive(ToolResultScopeDirective);
