import { html, svg, type TemplateResult } from 'lit';

import { FILE_ICON_SHAPES } from '@/shared/components/icons/fileTypes/fileTypeDefinitions';
import { getWorkspaceFileIconAppearance } from '@/shared/components/icons/fileTypes/workspaceFileIcons';

/** Reuse the same file type, color and vector shapes as the workspace and Summary. */
export function renderMessageFileIcon(fileName: string): TemplateResult {
  const appearance = getWorkspaceFileIconAppearance(fileName);
  const shape = appearance.iconKind ? FILE_ICON_SHAPES[appearance.iconKind] : undefined;
  return html`
    <span
      class="message-attachment__icon"
      aria-hidden="true"
      data-file-icon-kind=${appearance.kind}
      style=${`color: ${appearance.color}`}
    >
      ${
        appearance.glyph
          ? html`<span class="message-attachment__glyph">${appearance.glyph}</span>`
          : shape
            ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                ${svg`<path stroke-linecap="round" stroke-linejoin="round" d=${shape.path}></path>`}
                ${
                  shape.text
                    ? svg`<text
                    x="12" y="17.5" text-anchor="middle" fill="currentColor" stroke="none"
                    font-size=${shape.textSize} font-weight="bold" font-family="Arial, sans-serif"
                  >${shape.text}</text>`
                    : ''
                }
              </svg>`
            : ''
      }
    </span>
  `;
}
