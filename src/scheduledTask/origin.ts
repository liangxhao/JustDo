import {
  isCronSessionKey,
  isManagedSessionKey,
  parseManagedSessionKey,
} from '../main/libs/openclaw/openclawChannelSessionSync';
import { BindingKind, DeliveryChannel,DeliveryMode, OriginKind } from './constants';

// Re-declare origin/binding types here so common/ doesn't depend on renderer/
// These MUST be kept in sync with src/renderer/types/scheduledTask.ts

export type TaskOriginKind = OriginKind;

export type TaskOrigin =
  | { kind: typeof OriginKind.Legacy }
  | { kind: typeof OriginKind.IM; platform: string; conversationId: string }
  | { kind: typeof OriginKind.Cowork; sessionId: string }
  | { kind: typeof OriginKind.Cron; jobId: string }
  | { kind: typeof OriginKind.Manual };

export type ExecutionBinding =
  | { kind: typeof BindingKind.NewSession }
  | { kind: typeof BindingKind.UISession; sessionId: string }
  | {
      kind: typeof BindingKind.IMSession;
      platform: string;
      conversationId: string;
      sessionId?: string;
    }
  | { kind: typeof BindingKind.SessionKey; sessionKey: string };

/** Minimal ScheduledTask shape needed for inference (avoids importing renderer types) */
interface InferableTask {
  sessionKey?: string | null;
  delivery?: { mode?: string; channel?: string };
  agentId?: string | null;
}

/**
 * Infer origin and binding from a ScheduledTask's wire fields.
 * Used for backward compatibility with tasks that have no stored metadata.
 * Pure function — no side effects.
 */
export function inferOriginAndBinding(task: InferableTask): {
  origin: TaskOrigin;
  binding: ExecutionBinding;
} {
  const sk = (task.sessionKey ?? '').trim();

  // 1. Managed session key: "agent:main:justdo:{sessionId}"
  if (sk && isManagedSessionKey(sk)) {
    const parsed = parseManagedSessionKey(sk);
    if (parsed) {
      const channel = task.delivery?.channel;
      const isIMChannel =
        task.delivery?.mode === DeliveryMode.Announce &&
        typeof channel === 'string' &&
        channel.length > 0 &&
        channel !== DeliveryChannel.Last;

      if (isIMChannel) {
        return {
          origin: { kind: OriginKind.IM, platform: channel!, conversationId: '' },
          binding: {
            kind: BindingKind.IMSession,
            platform: channel!,
            conversationId: '',
            sessionId: parsed.sessionId,
          },
        };
      }

      return {
        origin: { kind: OriginKind.Cowork, sessionId: parsed.sessionId },
        binding: { kind: BindingKind.UISession, sessionId: parsed.sessionId },
      };
    }
  }

  // 2. Cron session key: "cron:{jobId}" or "agent:{agentId}:cron:{jobId}"
  if (sk && isCronSessionKey(sk)) {
    // Extract jobId from cron session key
    const idx = sk.lastIndexOf('cron:');
    const jobId = idx >= 0 ? sk.slice(idx + 'cron:'.length) : sk;
    return {
      origin: { kind: OriginKind.Cron, jobId },
      binding: { kind: BindingKind.SessionKey, sessionKey: sk },
    };
  }

  // 3. Has sessionKey but unknown format → session_key binding
  if (sk) {
    return {
      origin: { kind: OriginKind.Cowork, sessionId: '' },
      binding: { kind: BindingKind.SessionKey, sessionKey: sk },
    };
  }

  // 4. No sessionKey → manual origin
  return {
    origin: { kind: OriginKind.Manual },
    binding: { kind: BindingKind.NewSession },
  };
}
