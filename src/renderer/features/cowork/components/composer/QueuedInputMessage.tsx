import { nothing, render } from 'lit';
import { useLayoutEffect, useRef } from 'react';

import { chatStyles } from '@/libs/openclaw-chat/components/justdo-chat.styles';
import { renderMessageDiagram } from '@/libs/openclaw-chat/components/mermaidRenderer';
import { handleMessageDiagramToggle, handleMessageImageClick, handleMessageImageContextMenu } from '@/libs/openclaw-chat/components/message-content-interactions';
import { renderMessageBlock } from '@/libs/openclaw-chat/components/message-render';
import { RichMessageControls } from '@/libs/openclaw-chat/components/rich-message-controls';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

/** Reuse canonical chat rendering, including native rich cards and their interactions. */
export function QueuedInputMessage({ message, workingDirectory }: {
  message: GatewayMessage;
  workingDirectory?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<RichMessageControls | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current!;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = chatStyles.map(style => style.cssText).join('\n') + `
      :host { height: auto; overflow: visible; background: transparent; }
      .chat-group { margin: 0; padding: 0; }
      .chat-group__avatar { display: none; }
      .chat-group__content { width: 100%; max-width: 100%; min-width: 0; }
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
    const themeObserver = new MutationObserver(() => {
      root.querySelectorAll<HTMLElement>('.mermaid-block').forEach(block => {
        delete block.dataset.mermaidRendered;
        void renderMessageDiagram(block);
      });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
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
    render(renderMessageBlock({
      kind: 'group', key: 'queued-detail', role: 'user', timestamp: 0,
      isStreaming: false, messages: [{ key: 'queued-detail', message }],
    }, { showAvatar: false, showFooter: false, workingDirectory }), contentRef.current);
    controlsRef.current?.sync();
    contentRef.current.querySelectorAll<HTMLElement>('.mermaid-block').forEach(block => {
      void renderMessageDiagram(block);
    });
  }, [message, workingDirectory]);
  return <div ref={hostRef} data-queued-message />;
}
