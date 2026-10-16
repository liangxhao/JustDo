import '@/libs/openclaw-chat/components/chat-avatar.css';

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
  return <div ref={root} aria-hidden="true" className="h-8 w-8 shrink-0" />;
}
