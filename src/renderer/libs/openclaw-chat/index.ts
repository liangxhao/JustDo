/**
 * OpenClaw Chat — Public API
 * Exports the Lit custom element, gateway client, and chat controller.
 */

// Register the Lit custom element
import './components/justdo-chat';

export { JustDoChatElement } from './components/justdo-chat';
export { GatewayClient } from './gateway/client';
export { ChatController } from './gateway/chat-controller';
export type { ChatState } from './gateway/chat-controller';
