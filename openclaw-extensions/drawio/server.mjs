import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createEditorResource, validateDiagram } from './editor-resource.mjs';
export { startAssets, validateDiagram } from './editor-resource.mjs';
const URI = 'ui://drawio/editor';
const MIME = 'text/html;profile=mcp-app';

export function createDiagramServer(resource) {
  const server = new Server(
    { name: 'drawio', version: '1.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Create and edit diagrams locally with create_diagram. Supply uncompressed draw.io XML with positioned vertices and edges. The result displays an interactive editor in the conversation. All assets and exports work offline.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'create_diagram',
        title: 'draw.io',
        description:
          'Create an editable, offline draw.io diagram in the conversation. Use for flowcharts, architecture, UML, ER, process and network diagrams. Supply mxfile or mxGraphModel XML with root cells 0/1, geometry, vertices and edges. Use rounded shapes, restrained colors, readable spacing and orthogonal connectors. Chinese labels are supported. Users can edit, save .drawio and export PNG/SVG directly.',
        inputSchema: {
          type: 'object',
          properties: {
            xml: { type: 'string', description: 'Uncompressed draw.io XML, maximum 1 MiB.' },
            title: { type: 'string', description: 'Short diagram title.' },
          },
          required: ['xml'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: URI } },
      },
      {
        name: 'open_editor',
        title: 'draw.io',
        description: 'Open a blank offline draw.io editor from the application menu.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: {
          ui: { resourceUri: URI, visibility: ['app'] },
          'openai/ui': { entrypoints: [{ type: 'global' }] },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === 'open_editor') {
      return {
        content: [],
        structuredContent: {
          title: 'draw.io',
          xml: '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
        },
      };
    }
    if (params.name !== 'create_diagram') throw new Error('Unknown tool');
    try {
      const diagram = validateDiagram(params.arguments);
      return {
        content: [{ type: 'text', text: `Created diagram: ${diagram.title}` }],
        structuredContent: diagram,
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: URI, name: 'draw.io', mimeType: MIME }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== URI) throw new Error('Unknown resource');
    return resource.read();
  });
  return server;
}

export async function main() {
  // __dirname is provided by the CJS build; no source/node_modules are required at runtime.
  const resource = await createEditorResource(__dirname);
  const server = createDiagramServer(resource);
  const close = () => {
    resource.close();
    void server.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  process.stdin.once('end', close);
  await server.connect(new StdioServerTransport());
}

if (process.env.DIAGRAM_SERVER_TEST !== '1')
  main().catch(() => {
    console.error('[DiagramEditor] Startup failed');
    process.exitCode = 1;
  });
