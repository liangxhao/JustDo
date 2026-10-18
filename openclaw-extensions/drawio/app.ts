import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

declare global {
  interface Window {
    DIAGRAM_ASSET_BASE: string;
  }
}

const app = new App({ name: 'draw.io', version: '1.0.0' });
const editor = document.querySelector<HTMLIFrameElement>('#editor')!;
const title = document.querySelector<HTMLElement>('#title')!;
const status = document.querySelector<HTMLElement>('#status')!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
const base = new URL(window.DIAGRAM_ASSET_BASE);
let xml = '';
let name = 'Diagram';
let ready = false;
let busy = false;
let pending:
  | {
      format: 'drawio' | 'png' | 'svg';
      id: string;
      phase: 'committing' | 'exporting';
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
let contextTimer: ReturnType<typeof setTimeout> | undefined;
const zh = () => (app.getHostContext()?.locale ?? navigator.language).startsWith('zh');
const text = (cn: string, en: string) => (zh() ? cn : en);
const updateButtons = () => {
  for (const button of buttons) button.disabled = !ready || !xml || busy;
};
const post = (data: object) => editor.contentWindow?.postMessage(JSON.stringify(data), '*'); // Opaque nested sandbox; source is checked on receipt.
const load = () => {
  if (ready && xml) post({ action: 'load', xml, autosave: 1, title: name, saveAndExit: '0' });
};
const updateContext = () => {
  clearTimeout(contextTimer);
  if (
    new TextEncoder().encode(xml).length > 1024 * 1024 ||
    !app.getHostCapabilities()?.updateModelContext
  )
    return;
  contextTimer = setTimeout(() => {
    void app
      .updateModelContext({
        content: [{ type: 'text', text: `Current draw.io diagram (${name}):\n${xml}` }],
      })
      .catch(() => undefined);
  }, 1000);
};
async function download(format: 'drawio' | 'png' | 'svg', data: string) {
  if (busy) return;
  busy = true;
  updateButtons();
  status.textContent = '';
  try {
    const mimeType =
      format === 'drawio'
        ? 'application/vnd.jgraph.mxfile'
        : `image/${format === 'svg' ? 'svg+xml' : 'png'}`;
    const uri = `file:///${encodeURIComponent(name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'Diagram')}.${format}`;
    const contents =
      format === 'drawio'
        ? [{ uri, mimeType, text: data }]
        : [{ uri, mimeType, blob: data.split(',')[1] }];
    if (
      format !== 'drawio' &&
      !new RegExp(`^data:${mimeType.replace('+', '\\+')};base64,`).test(data)
    )
      throw new Error('Invalid export');
    const result = await app.downloadFile({
      contents: contents.map(resource => ({ type: 'resource' as const, resource })),
    });
    if (result.isError && !(result._meta as { canceled?: boolean } | undefined)?.canceled)
      throw new Error('Download failed');
    if (!result.isError && format === 'drawio' && xml === data)
      post({ action: 'status', message: '', modified: false });
  } catch {
    status.textContent = text('保存失败，请重试', 'Could not save. Try again.');
  } finally {
    busy = false;
    updateButtons();
  }
}

window.addEventListener('message', event => {
  if (
    event.source !== editor.contentWindow ||
    (event.origin !== 'null' && event.origin !== base.origin) ||
    typeof event.data !== 'string'
  )
    return;
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  if (data.event === 'init') {
    ready = true;
    load();
    updateButtons();
  } else if (data.event === 'diagram-export' && ['drawio', 'png', 'svg'].includes(data.format)) {
    document
      .querySelector<HTMLButtonElement>(`#${data.format === 'drawio' ? 'save' : data.format}`)
      ?.click();
  } else if (data.event === 'autosave' || data.event === 'save') {
    if (typeof data.xml !== 'string' || data.xml.length > 1024 * 1024) return;
    xml = data.xml;
    updateContext();
    if (data.event === 'save') void download('drawio', xml);
  } else if (
    data.event === 'diagram-committed' &&
    pending?.phase === 'committing' &&
    data.requestId === pending.id
  ) {
    pending.phase = 'exporting';
    post({
      action: 'export',
      format: pending.format === 'drawio' ? 'xml' : pending.format,
      requestId: pending.id,
      currentPage: true,
      embedImages: true,
      embedFonts: false,
      border: 16,
      scale: 2,
    });
  } else if (data.event === 'export' && pending?.phase === 'exporting') {
    let request;
    try {
      request = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
    } catch {
      return;
    }
    if (
      request?.requestId !== pending.id ||
      data.format !== (pending.format === 'drawio' ? 'xml' : pending.format)
    )
      return;
    const format = pending.format;
    clearTimeout(pending.timer);
    pending = undefined;
    busy = false;
    if (format === 'drawio' && typeof data.xml === 'string') {
      xml = data.xml;
      void download(format, xml);
    } else if (typeof data.data === 'string') void download(format, data.data);
  }
});

for (const format of ['drawio', 'png', 'svg'] as const)
  document
    .querySelector(`#${format === 'drawio' ? 'save' : format}`)!
    .addEventListener('click', () => {
      if (pending || busy || !ready) return;
      const id = crypto.randomUUID();
      busy = true;
      updateButtons();
      pending = {
        format,
        id,
        phase: 'committing',
        timer: setTimeout(() => {
          pending = undefined;
          busy = false;
          updateButtons();
          status.textContent = text('导出失败，请重试', 'Could not export. Try again.');
        }, 30_000),
      };
      post({ action: 'diagram-commit', requestId: id });
    });
app.ontoolresult = result => {
  const diagram = result.structuredContent as Record<string, unknown> | undefined;
  if (!diagram || typeof diagram.xml !== 'string') {
    if (result.isError) status.textContent = text('图表生成失败', 'Could not create diagram');
    return;
  }
  xml = diagram.xml;
  name = typeof diagram.title === 'string' ? diagram.title : 'Diagram';
  title.textContent = name;
  load();
  updateButtons();
};
app.onteardown = async () => {
  clearTimeout(contextTimer);
  if (pending) clearTimeout(pending.timer);
  return {};
};
const syncHostStyle = () => {
  const context = app.getHostContext();
  applyDocumentTheme(context?.theme ?? 'light');
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (ready) post({ action: 'diagram-theme', dark: app.getHostContext()?.theme === 'dark' });
};
app.onhostcontextchanged = syncHostStyle;
void app.connect().then(() => {
  syncHostStyle();
  document.querySelector('#save')!.textContent = text('保存', 'Save');
  document.documentElement.lang = zh() ? 'zh' : 'en';
  const url = new URL('editor/index.html', base);
  url.search = new URLSearchParams({
    embed: '1',
    proto: 'json',
    offline: '1',
    stealth: '1',
    lockdown: '1',
    local: '1',
    plugins: '0',
    ui: 'min',
    spin: '1',
    libraries: '1',
    noSaveBtn: '1',
    noExitBtn: '1',
    saveAndExit: '0',
    modified: 'unsavedChanges',
    lang: zh() ? 'zh' : 'en',
    dark: app.getHostContext()?.theme === 'dark' ? '1' : '0',
  }).toString();
  editor.src = url.href;
});
