// Product components with synthetic data; no Gateway, user state, or credentials.
import { createRoot } from 'react-dom/client';
import { type ComponentProps, useState } from 'react';

import ComposerFeatureMenu from '../../src/renderer/features/cowork/components/composer/ComposerFeatureMenu';
import { buildAgentTeamFeature } from '../../src/renderer/features/cowork/components/composer/AgentTeamSelector';
import { buildSwarmWorkflowComposerFeature } from '../../src/renderer/features/cowork/components/composer/swarmWorkflowComposerFeature';
import { useMcpAppTabs } from '../../src/renderer/features/cowork/components/display/useMcpAppTabs';
import {
  type McpAppComposerMenu,
  McpAppsControls,
} from '../../src/renderer/features/cowork/components/mcpApps/McpAppsControls';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app-session';
import { i18nService } from '../../src/renderer/services/i18n';
import { McpAppMethod, type NativeAppQuestion } from '../../src/shared/plugins/mcpApps';

const calls: Array<{ method: string; params?: unknown }> = [];
const fixture = window as unknown as {
  fixtureCalls: typeof calls;
  fixtureQuestion: (shown: boolean) => void;
};
fixture.fixtureCalls = calls;
let questions: NativeAppQuestion[] = [];
const listeners = new Set<() => void>();
Object.assign(window, {
  electron: {
    mcpApps: {
      questions: async () => ({ success: true, value: questions }),
      onQuestionsChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      resolveQuestion: async (params: unknown) => {
        calls.push({ method: 'resolve', params });
        questions = [];
        return { success: true, value: {} };
      },
    },
  },
});
fixture.fixtureQuestion = shown => {
  questions = shown
    ? [
        {
          id: 'choice',
          status: 'pending',
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 300_000,
          questions: [
            {
              questionId: 'destination',
              header: '工作区',
              question: '选择保存位置',
              allowEmpty: false,
              options: [
                { label: '个人空间', value: 'personal' },
                { label: '团队空间', value: 'team' },
              ],
            },
          ],
        },
      ]
    : [];
  for (const listener of listeners) listener();
};
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === McpAppMethod.Discover)
      return {
        servers: [
          {
            serverName: 'drawio',
            label: 'draw.io',
            entrypoints: [
              {
                title: 'draw.io',
                toolName: 'open_editor',
                resourceUri: 'ui://drawio/editor',
                entrypoint: { type: 'global' },
              },
            ],
          },
          {
            serverName: 'planner',
            label: '项目日历',
            mentionTool: 'search',
            settings: { readTool: 'read', updateTool: 'update' },
            entrypoints: [
              {
                title: '日程',
                toolName: 'calendar',
                resourceUri: 'ui://planner/calendar',
                entrypoint: { type: 'global', quickAction: { title: '新建日程' } },
              },
              {
                title: '任务看板',
                toolName: 'board',
                resourceUri: 'ui://planner/board',
                entrypoint: { type: 'thread' },
              },
              {
                title: '编辑文档',
                toolName: 'editor',
                resourceUri: 'ui://planner/editor',
                entrypoint: { type: 'file', extensions: ['.md'] },
              },
            ],
          },
        ],
      };
    if (method === McpAppMethod.Settings && (params as { action: string }).action === 'read')
      return {
        schema: {
          type: 'object',
          properties: {
            workspace: { type: 'string', title: '默认工作区', enum: ['个人空间', '团队空间'] },
            limit: { type: 'integer', title: '每页显示', minimum: 1, maximum: 100 },
            notifications: { type: 'boolean', title: '日程提醒' },
          },
          required: ['workspace', 'limit'],
        },
        values: { workspace: '个人空间', limit: 20, notifications: true },
      };
    if (method === McpAppMethod.Mention)
      return {
        resources: [
          {
            type: 'resource_link',
            uri: 'planner://project',
            name: '春季发布计划',
            mimeType: 'text/plain',
          },
        ],
      };
    return {};
  },
};
const apps = new McpAppSession(() => ({
  client: client as never,
  generation: 1,
  sessionKey: 'agent:a:fixture',
  sessionId: 'incarnation',
  agentId: 'a',
  isCurrent: () => true,
}));
apps.reportContext('selection', '春季发布计划', { updateId: 'selected' });
const controlProps: ComponentProps<typeof McpAppsControls> = {
  apps,
  sessionId: 'fixture',
  canDraft: () => true,
  filePath: 'E:/fixture/notes.md',
  onOnboard: async () => undefined,
  addDraft: async text => {
    calls.push({ method: 'draft', params: text });
    return true;
  },
  prepare: async () => ({
    apps,
    sessionKey: 'agent:a:fixture',
    isCurrent: () => true,
    canDraft: () => true,
    addDraft: async () => true,
  }),
};
const pluginFeatures = [
  buildSwarmWorkflowComposerFeature({ selectSwarmWorkflow: () => undefined }),
  buildAgentTeamFeature(undefined, () => undefined),
].map(item => ({ ...item, section: i18nService.t('composerPlugins') }));
function ProductFixture() {
  const [menu, setMenu] = useState<McpAppComposerMenu | null>(null);
  const [activeId, select] = useState<string | null>(null);
  const tabs = useMcpAppTabs('fixture', select, () => undefined);
  return (
    <div
      className={`grid min-w-0 grid-cols-1 ${tabs.tabs.length ? 'md:grid-cols-2' : ''}`}
      style={{ minHeight: 600 }}
    >
      <main id="chat" className="flex min-w-0 flex-col justify-end">
        <McpAppsControls {...controlProps} onMenuChange={setMenu} />
        <div className="rounded-2xl border-t border-border p-3">
          <textarea
            aria-label="消息"
            placeholder="发送消息"
            className="min-h-16 w-full resize-none bg-transparent p-2 outline-none"
          />
          <ComposerFeatureMenu
            items={[...(menu?.items ?? []), ...pluginFeatures]}
            label="添加"
            backLabel="返回"
          />
        </div>
      </main>
      {tabs.tabs.length > 0 && (
        <aside id="app-workspace" className="flex min-w-0 flex-col border-l border-border">
          <nav className="flex items-center border-b border-border px-3" aria-label="应用标签">
            {tabs.tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={tab.onSelect}
                className="p-2 text-xs"
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="relative min-w-0 flex-1" style={{ minHeight: 480 }}>
            {tabs.panels(activeId)}
          </div>
        </aside>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<ProductFixture />);
