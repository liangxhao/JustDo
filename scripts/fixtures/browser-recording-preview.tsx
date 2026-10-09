// Isolated visual fixture. No Gateway, application store or external websites.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { render } from 'lit';
import type { BrowserRecordingDraft } from '../../src/shared/browser/browserRecording';
import { BrowserRecordingReview } from '../../src/renderer/features/browser/recording/BrowserRecordingReview';
import recordingStyles from '../../src/renderer/features/browser/recording/browserRecording.css?inline';
import { renderBrowserRecording } from '../../src/renderer/libs/openclaw-chat/components/browser-recording-message';
import { i18nService } from '../../src/renderer/services/i18n';
import './browser-recording-preview.css';

i18nService.setLanguage('zh', { persist: false });
const fixture: BrowserRecordingDraft = {
  id: 'preview',
  sessionId: 'preview',
  profile: 'embedded',
  title: '搜索并打开百科词条',
  note: '演示如何搜索关键词，并从结果页打开对应的百科。',
  startedAt: 0,
  images: [],
  steps: [
    {
      id: '1',
      pageId: 'home',
      action: 'openTab',
      at: 0,
      url: 'https://www.example.com/search?source=demonstration&campaign=long-parameter-for-layout-verification',
      title: '搜索首页',
    },
    {
      id: '2',
      pageId: 'home',
      action: 'input',
      at: 1,
      url: 'https://www.example.com/search',
      title: '搜索首页',
      value: '你好啊',
      target: {
        tag: 'input',
        role: 'searchbox',
        name: '搜索关键词',
        selector: '#search-input',
        html: '<input id="search-input" name="q" type="search" placeholder="输入关键词">',
      },
      note: '这里可以替换为你想查询的内容。',
    },
    {
      id: '3',
      pageId: 'results',
      action: 'click',
      at: 2,
      url: 'https://www.example.com/results?q=hello',
      title: '搜索结果',
      target: {
        tag: 'a',
        role: 'link',
        name: '你好啊！2010 — 百科词条',
        selector: 'main > article:nth-of-type(2) > a',
        html: '<a href="https://www.example.com/wiki/hello">你好啊！2010 — 百科词条</a>',
      },
      screenshotFiles: ['step-3.jpg'],
    },
  ],
};
function EditorPreview({ onStatus }: { onStatus: (value: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Isolate from browser extensions that restyle arbitrary websites. Electron's
    // production renderer has no such extensions, and uses the same source CSS.
    const shadow = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = recordingStyles;
    shadow.append(style);
    const mount = document.createElement('div');
    mount.style.height = '100%';
    shadow.append(mount);
    const root = createRoot(mount);
    root.render(
      <BrowserRecordingReview
        draft={fixture}
        onClose={() => onStatus('Closed')}
        onDiscard={() => onStatus('Discarded')}
        onSave={() => onStatus('Saved')}
        saveLabel="recordingAdd"
      />,
    );
    return () => {
      root.unmount();
      mount.remove();
      style.remove();
    };
  }, [onStatus]);
  return <div className="preview-editor" ref={host} />;
}
function Preview() {
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [status, setStatus] = useState('');
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shadow = chat.current!.shadowRoot ?? chat.current!.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = recordingStyles;
    shadow.append(style);
    render(renderBrowserRecording(fixture), shadow);
  }, []);
  return (
    <main className={`preview ${dark ? 'dark' : ''}`}>
      <nav>
        <strong>Recording UI · isolated fixture</strong>
        <button onClick={() => setDark(!dark)}>Light / Dark</button>
        <button onClick={() => setNarrow(!narrow)}>Wide / Narrow</button>
        <span role="status">{status}</span>
      </nav>
      <div
        className="preview-grid"
        style={{ gridTemplateColumns: `${narrow ? 360 : 560}px minmax(280px,440px)` }}
      >
        <EditorPreview onStatus={setStatus} />
        <div className="preview-chat">
          <h2>消息气泡</h2>
          <div ref={chat} />
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
