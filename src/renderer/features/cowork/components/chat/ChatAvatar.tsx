import { nothing, render } from 'lit';
import { useEffect, useRef } from 'react';

import { renderChatAvatar } from '@/libs/openclaw-chat/components/chat-avatar';

/** React adapter for the same avatars used by native chat and graph receipt messages. */
export default function ChatAvatar({
  role,
  peer,
}: {
  role: 'user' | 'assistant';
  peer?: { id: string; label: string; color?: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  const id = peer?.id;
  const label = peer?.label;
  const color = peer?.color;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    render(renderChatAvatar(role, id ? { id, label: label ?? id, color } : undefined), node);
    return () => {
      render(nothing, node);
    };
  }, [role, id, label, color]);
  return (
    <div
      ref={root}
      aria-hidden="true"
      className="h-8 w-8 shrink-0 [&>.chat-avatar]:flex [&>.chat-avatar]:h-8 [&>.chat-avatar]:w-8 [&>.chat-avatar]:items-center [&>.chat-avatar]:justify-center [&>.chat-avatar]:rounded-full [&>.chat-avatar]:text-sm [&>.chat-avatar]:font-semibold [&>.user]:bg-[var(--justdo-chat-user-avatar-bg)] [&>.user]:text-[var(--justdo-chat-user-avatar-text)] [&>.assistant]:bg-[var(--justdo-chat-assistant-avatar-bg)] [&>.assistant]:text-[var(--justdo-chat-assistant-avatar-text)]"
    />
  );
}
