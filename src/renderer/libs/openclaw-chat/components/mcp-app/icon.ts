import type { McpAppIcon } from '@shared/plugins/mcpApps';
import { html, svg } from 'lit';

import { selectMcpAppIcon } from './icons';

export const MCP_APP_ICON_STYLE = `
  .icon-variant{display:flex;width:var(--app-icon-size,16px);height:var(--app-icon-size,16px)}
  .icon-dark{display:none}.icon-variant img,.icon-variant svg{width:100%;height:100%;object-fit:contain}
  :host-context(.dark) .icon-light{display:none}:host-context(.dark) .icon-dark{display:flex}
`;

export function renderMcpAppIcon(
  icons: readonly McpAppIcon[] | undefined,
  failed: readonly string[],
  onError: (src: string) => void,
) {
  return (['light', 'dark'] as const).map(theme => {
    const icon = selectMcpAppIcon(icons, theme, failed);
    return html`<span class=${`icon-variant icon-${theme}`}>
      ${
        icon
          ? html`<img
              src=${icon.src}
              alt=""
              referrerpolicy="no-referrer"
              @error=${() => onError(icon.src)}
            />`
          : svg`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.5"/><rect x="13.75" y="3.75" width="6.5" height="6.5" rx="1.5"/><rect x="3.75" y="13.75" width="6.5" height="6.5" rx="1.5"/><rect x="13.75" y="13.75" width="6.5" height="6.5" rx="1.5"/></svg>`
      }
    </span>`;
  });
}
