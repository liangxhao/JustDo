import { html } from 'lit';

export const MCP_APP_LOADING_STYLE = `
  .app-loading {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
  }
  .app-loading .app-loading-indicator {
    box-sizing: border-box;
    flex: none;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: mcp-app-loading-spin 1s linear infinite;
  }
  @keyframes mcp-app-loading-spin {
    to { transform: rotate(360deg); }
  }
`;

export function renderMcpAppLoading(label: string) {
  return html`<span class="app-loading">
    <span class="app-loading-indicator" aria-hidden="true"></span>
    ${label}
  </span>`;
}
