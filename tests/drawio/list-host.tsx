import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import McpServerCard from '../../src/renderer/features/plugins/mcp/McpServerCard';

function List() {
  const [enabled, setEnabled] = useState(true);
  return (
    <main className="mx-auto max-w-3xl p-5">
      <h2 className="mb-3 text-xs font-medium text-secondary">系统内置</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <McpServerCard
          title="draw.io"
          description="离线绘图"
          supportsApps
          group="system"
          visualIndex={0}
          openLabel="draw.io"
          onProbe={() => {}}
          probeDisabled={false}
          probing={false}
          stateAction={
            <button
              role="switch"
              aria-checked={enabled}
              aria-label="启用 draw.io"
              className="text-xs text-primary"
              onClick={() => setEnabled(!enabled)}
            >
              {enabled ? '已启用' : '已关闭'}
            </button>
          }
        />
        <McpServerCard
          title="Workspace"
          description="工作区工具"
          group="system"
          visualIndex={1}
          openLabel="Workspace"
          onProbe={() => {}}
          probeDisabled={false}
          probing={false}
        />
      </div>
    </main>
  );
}
export function mountMcpList() {
  const root = document.createElement('div');
  document.body.append(root);
  createRoot(root).render(<List />);
}
