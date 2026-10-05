import { nothing, render } from 'lit';
import { useLayoutEffect, useRef } from 'react';

import { chatStyles } from '@/libs/openclaw-chat/components/justdo-chat.styles';
import { renderMessageDiagram } from '@/libs/openclaw-chat/components/mermaidRenderer';
import {
  handleMessageDiagramToggle,
  handleMessageImageClick,
  handleMessageImageContextMenu,
} from '@/libs/openclaw-chat/components/message-content-interactions';
import { renderMessageBlock } from '@/libs/openclaw-chat/components/message-render';
import { RichMessageControls } from '@/libs/openclaw-chat/components/rich-message-controls';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

/** Reuse canonical chat rendering, including native rich cards and their interactions. */
export function UserMessageContent({
  message,
  workingDirectory,
  compact = false,
}: {
  message: GatewayMessage;
  workingDirectory?: string;
  compact?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<RichMessageControls | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current!;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      chatStyles.map(style => style.cssText).join('\n') +
      `
      :host { height: auto; overflow: visible; background: transparent; }
      .chat-group { margin: 0; padding: 0; }
      .chat-group__avatar { display: none; }
      .chat-group__content { width: 100%; max-width: 100%; min-width: 0; }
      :host(.compact) {
        --justdo-chat-user-bg: var(--justdo-chat-user);
        --justdo-chat-user-text: var(--justdo-chat-user-foreground);
        --justdo-chat-text: var(--justdo-text-primary);
        --justdo-chat-text-secondary: var(--justdo-text-secondary);
        --justdo-chat-border: var(--justdo-border);
        --justdo-chat-code-bg: var(--justdo-surface-raised);
        --justdo-chat-bg: var(--justdo-surface);
        --justdo-chat-accent: var(--justdo-primary);
        font-size: 13px;
      }
      :host(.compact) .chat-bubble--user { max-width: 100%; padding: 9px 12px; }
    `;
    const content = document.createElement('div');
    root.append(style, content);
    contentRef.current = content;
    const controls = new RichMessageControls(root, () => {});
    controlsRef.current = controls;
    const onClick = (event: Event) => {
      if (!handleMessageImageClick(event)) handleMessageDiagramToggle(event);
    };
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape' && controls.close()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const syncTheme = () => {
      host.classList.toggle('dark', document.documentElement.classList.contains('dark'));
      root.querySelectorAll<HTMLElement>('.mermaid-block').forEach(block => {
        delete block.dataset.mermaidRendered;
        void renderMessageDiagram(block);
      });
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    root.addEventListener('contextmenu', handleMessageImageContextMenu);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    return () => {
      themeObserver.disconnect();
      root.removeEventListener('contextmenu', handleMessageImageContextMenu);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      controls.dispose();
      controlsRef.current = null;
      render(nothing, content);
      root.replaceChildren();
      contentRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    render(
      renderMessageBlock(
        {
          kind: 'group',
          key: 'user-content',
          role: 'user',
          timestamp: 0,
          isStreaming: false,
          messages: [{ key: 'user-content', message }],
        },
        { showAvatar: false, showFooter: false, workingDirectory },
      ),
      contentRef.current,
    );
    controlsRef.current?.sync();
    contentRef.current.querySelectorAll<HTMLElement>('.mermaid-block').forEach(block => {
      void renderMessageDiagram(block);
    });
  }, [message, workingDirectory]);
  return <div ref={hostRef} className={compact ? 'compact' : undefined} data-user-message />;
}
