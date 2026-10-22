import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { DRAWIO_APPLY_TOOL, DRAWIO_SNAPSHOT_TOOL } from './contracts';

declare global {
  interface Window {
    DIAGRAM_ASSET_BASE: string;
  }
}

// Optional presentation only: a host can share this App's toolbar row without
// taking ownership of its actions or exposing any host navigation to the App.
const sharedHeaderKey = 'ui/shared-header';
const app = new App(
  { name: 'draw.io', version: '1.0.0' },
  { experimental: { [sharedHeaderKey]: { version: 1 } } },
);
const editor = document.querySelector<HTMLIFrameElement>('#editor')!;
const title = document.querySelector<HTMLElement>('#title')!;
const status = document.querySelector<HTMLElement>('#status')!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
const base = new URL(window.DIAGRAM_ASSET_BASE);
let xml = '';
let name = 'Diagram';
let ready = false;
let busy = false;
let resultRevision = 0;
let disposed = false;
let diagramId = '';
const snapshots = new Map<string, { xml: string; generation: number }>();
const appliedOperations = new Set<string>();
let canvasRequest:
  | {
      id: string;
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
const validXml = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length > 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(value)
  )
    return false;
  const document = new DOMParser().parseFromString(value, 'application/xml');
  return (
    !document.querySelector('parsererror') &&
    ['mxfile', 'mxGraphModel'].includes(document.documentElement.localName)
  );
};
const requestCanvas = (action: string, data: Record<string, unknown> = {}) => {
  if (!ready || !xml || busy || pending || canvasRequest || disposed || !diagramId)
    throw new Error('Diagram is not ready');
  const revision = resultRevision;
  busy = true;
  updateButtons();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = crypto.randomUUID();
    canvasRequest = {
      id,
      resolve,
      reject,
      timer: setTimeout(() => {
        canvasRequest = undefined;
        reject(new Error('Diagram response unknown; do not replay'));
      }, 10_000),
    };
    post({ ...data, action, requestId: id });
  })
    .then(value => {
      if (disposed || revision !== resultRevision) throw new Error('Diagram editor changed');
      return value;
    })
    .finally(() => {
      busy = false;
      updateButtons();
    });
};
const rememberSnapshot = (value: Record<string, unknown>) => {
  if (!validXml(value.xml) || !Number.isSafeInteger(value.generation))
    throw new Error('Invalid current diagram');
  const contentStamp = crypto.randomUUID();
  if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(contentStamp, { xml: value.xml, generation: value.generation as number });
  xml = value.xml;
  return { diagramId, xml, title: name, contentStamp };
};
let pending:
  | {
      format: 'drawio' | 'png' | 'svg';
      id: string;
      phase: 'committing' | 'exporting';
      timer: ReturnType<typeof setTimeout>;
      context?: { resolve: () => void; reject: (error: Error) => void };
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
const publishContext = async () => {
  clearTimeout(contextTimer);
  if (
    disposed ||
    new TextEncoder().encode(xml).length > 1024 * 1024 ||
    !app.getHostCapabilities()?.updateModelContext
  )
    throw new Error('Diagram context is unavailable');
  await app.updateModelContext({
    content: [{ type: 'text', text: `Current draw.io diagram (${name}):\n${xml}` }],
  });
};
const updateContext = () => {
  clearTimeout(contextTimer);
  if (
    new TextEncoder().encode(xml).length > 1024 * 1024 ||
    !app.getHostCapabilities()?.updateModelContext
  )
    return;
  contextTimer = setTimeout(() => {
    void publishContext().catch(() => undefined);
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
  if (
    (data.event === 'diagram-snapshot' || data.event === 'diagram-applied') &&
    canvasRequest?.id === data.requestId
  ) {
    const request = canvasRequest;
    canvasRequest = undefined;
    clearTimeout(request.timer);
    request.resolve(data);
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
    const context = pending.context;
    clearTimeout(pending.timer);
    pending = undefined;
    busy = false;
    if (context) {
      if (typeof data.xml !== 'string') context.reject(new Error('Invalid diagram export'));
      else {
        xml = data.xml;
        void publishContext().then(context.resolve, context.reject);
      }
      updateButtons();
    } else if (format === 'drawio' && typeof data.xml === 'string') {
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
// Standard App tool: the host discovers this opt-in contract without knowing the
// plugin name, and waits for the actual native context update before first send.
app.registerTool(
  'prepare_context',
  {
    description: 'Commit current editing and publish the current diagram as conversation context.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { 'workspace/prepare-context': true },
  },
  async () => {
    if (!ready || !xml || busy || pending || disposed)
      return { isError: true, content: [{ type: 'text', text: 'Diagram is not ready' }] };
    await new Promise<void>((resolve, reject) => {
      clearTimeout(contextTimer);
      const id = crypto.randomUUID();
      busy = true;
      updateButtons();
      pending = {
        format: 'drawio',
        id,
        phase: 'committing',
        context: { resolve, reject },
        timer: setTimeout(() => {
          pending = undefined;
          busy = false;
          updateButtons();
          reject(new Error('Diagram context preparation timed out'));
        }, 10_000),
      };
      post({ action: 'diagram-commit', requestId: id });
    });
    return { content: [] };
  },
);
app.registerTool(
  DRAWIO_SNAPSHOT_TOOL,
  {
    description: 'Read the current complete diagram after committing node editing.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => ({
    content: [],
    structuredContent: rememberSnapshot(await requestCanvas('diagram-snapshot')),
  }),
);

app.registerTool(
  DRAWIO_APPLY_TOOL,
  {
    description: 'Apply one prepared diagram operation in the current editor, preserving undo.',
    inputSchema: z
      .object({
        operationId: z.string().min(1).max(128),
        diagramId: z.string().max(128),
        baseContentStamp: z.string().max(128),
        xml: z.string().max(1024 * 1024),
        title: z.string().max(200),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async input => {
    const base = snapshots.get(input.baseContentStamp);
    if (
      input.diagramId !== diagramId ||
      !base ||
      appliedOperations.has(input.operationId) ||
      !validXml(input.xml)
    )
      return {
        isError: true,
        content: [{ type: 'text', text: 'Stale or repeated diagram operation' }],
      };
    // Reserve before dispatch. A lost nested-frame response never permits replay.
    if (appliedOperations.size >= 128) throw new Error('Reopen the diagram before further changes');
    appliedOperations.add(input.operationId);
    const result = await requestCanvas('diagram-apply', {
      generation: base.generation,
      expectedXml: base.xml,
      xml: input.xml,
    });
    if (result.status !== 'applied') {
      status.textContent =
        result.status === 'conflict'
          ? text(
              '画布已手动修改，本次修改未应用',
              'The canvas changed. This update was not applied.',
            )
          : text('修改结果待核实，请勿重复应用', 'Update result unknown. Do not apply again.');
      return {
        content: [],
        structuredContent: { operationId: input.operationId, status: result.status },
      };
    }
    name = input.title;
    title.textContent = name;
    const current = rememberSnapshot(result);
    status.textContent = text('已更新，可撤销', 'Updated. Undo is available.');
    updateContext();
    return {
      content: [],
      structuredContent: { operationId: input.operationId, status: 'applied', snapshot: current },
    };
  },
);
app.ontoolresult = async result => {
  const revision = ++resultRevision;
  const diagram = result.structuredContent as Record<string, unknown> | undefined;
  diagramId = typeof diagram?.diagramId === 'string' ? diagram.diagramId : '';
  snapshots.clear();
  if (diagram?.file) {
    xml = '';
    busy = true;
    updateButtons();
    status.textContent = text('正在打开图表…', 'Opening diagram…');
    try {
      const file = diagram.file as Record<string, unknown>;
      if (
        typeof file.name !== 'string' ||
        file.name.length > 255 ||
        !/^[^/\\]+\.drawio$/i.test(file.name) ||
        typeof file.resourceUri !== 'string' ||
        !/^openclaw-file:\/\/[a-f0-9-]{36}$/i.test(file.resourceUri)
      )
        throw new Error('Invalid diagram file reference');
      const resource = await app.readServerResource({
        uri: file.resourceUri,
        _meta: { 'openai/resource': { representation: 'text' } },
      });
      if (disposed || revision !== resultRevision) return;
      const content = resource.contents[0];
      if (
        resource.contents.length !== 1 ||
        content?.uri !== file.resourceUri ||
        !('text' in content) ||
        new TextEncoder().encode(content.text).length > 1024 * 1024 ||
        /<!DOCTYPE|<!ENTITY/i.test(content.text)
      )
        throw new Error('Invalid diagram file');
      const document = new DOMParser().parseFromString(content.text, 'application/xml');
      if (
        document.querySelector('parsererror') ||
        !['mxfile', 'mxGraphModel'].includes(document.documentElement.localName)
      )
        throw new Error('Invalid diagram XML');
      xml = content.text;
      name = file.name.replace(/\.drawio$/i, '');
      title.textContent = file.name;
      status.textContent = '';
      load();
    } catch {
      if (!disposed && revision === resultRevision)
        status.textContent = text(
          '无法打开图表，请确认文件有效且不超过 1 MiB',
          'Could not open diagram. Check that it is valid and no larger than 1 MiB.',
        );
    } finally {
      if (!disposed && revision === resultRevision) {
        busy = false;
        updateButtons();
      }
    }
    return;
  }
  if (!diagram || typeof diagram.xml !== 'string') {
    if (result.isError) status.textContent = text('图表生成失败', 'Could not create diagram');
    return;
  }
  busy = false;
  status.textContent = '';
  xml = diagram.xml;
  name = typeof diagram.title === 'string' ? diagram.title : 'Diagram';
  title.textContent = name;
  load();
  updateButtons();
};
app.onteardown = async () => {
  disposed = true;
  resultRevision++;
  clearTimeout(contextTimer);
  if (canvasRequest) {
    clearTimeout(canvasRequest.timer);
    canvasRequest.reject(new Error('Diagram closed; update result unknown'));
    canvasRequest = undefined;
  }
  if (pending) clearTimeout(pending.timer);
  pending?.context?.reject(new Error('Diagram closed during context preparation'));
  return {};
};
const syncHostStyle = () => {
  const context = app.getHostContext();
  applyDocumentTheme(context?.theme ?? 'light');
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  const layout = context?.[sharedHeaderKey] as Record<string, unknown> | null | undefined;
  const shared =
    layout &&
    Number.isFinite(layout.height) &&
    (layout.height as number) >= 32 &&
    (layout.height as number) <= 64 &&
    ['left', 'right'].every(
      key =>
        Number.isFinite(layout[key]) &&
        (layout[key] as number) >= 0 &&
        (layout[key] as number) <= 4096,
    );
  document.documentElement.toggleAttribute('data-shared-header', Boolean(shared));
  for (const [variable, value] of Object.entries({
    '--app-header-height': shared ? `${layout.height}px` : '46px',
    '--app-header-left': shared ? `${layout.left}px` : '12px',
    '--app-header-right': shared ? `${layout.right}px` : '12px',
  }))
    document.documentElement.style.setProperty(variable, value);
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
