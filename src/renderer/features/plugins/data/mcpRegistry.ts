import { McpRegistryEntry } from '@/features/plugins/types/mcp';

/**
 * Built-in MCP server registry.
 * These are popular, mainstream MCP servers that users can install with one click.
 * Each entry is a template — the user fills in required config (API keys, paths)
 * before it is saved to the database.
 */
export const mcpRegistry: McpRegistryEntry[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'tavily-mcp@latest'],
    requiredEnvKeys: ['TAVILY_API_KEY'],
  },

  {
    id: 'github',
    name: 'GitHub',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    requiredEnvKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    optionalEnvKeys: ['GITLAB_API_URL'],
  },
  {
    id: 'context7',
    name: 'Context7',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@upstash/context7-mcp@latest'],
  },

  {
    id: 'google-drive',
    name: 'Google Drive',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gdrive'],
    optionalEnvKeys: ['GDRIVE_CREDENTIALS_PATH'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    requiredEnvKeys: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@cocal/google-calendar-mcp'],
    requiredEnvKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
  },
  {
    id: 'notion',
    name: 'Notion',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@notionhq/notion-mcp-server'],
    requiredEnvKeys: ['OPENAPI_MCP_HEADERS'],
  },
  {
    id: 'slack',
    name: 'Slack',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'todoist',
    name: 'TodoList',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'todoist-mcp@latest'],
    requiredEnvKeys: ['TODOIST_API_TOKEN'],
  },

  {
    id: 'playwright',
    name: 'Playwright',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@executeautomation/playwright-mcp-server'],
  },

  {
    id: 'canva',
    name: 'Canva',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@iflow-mcp/mattcoatsworth-canva-mcp-server'],
    requiredEnvKeys: ['CANVA_API_KEY'],
  },

  {
    id: 'firecrawl',
    name: 'Firecrawl',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'firecrawl-mcp@latest'],
    requiredEnvKeys: ['FIRECRAWL_API_KEY'],
  },
];
