import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { live } from 'lit/directives/live.js';

import { i18nService } from '@/services/i18n';

/** A local media reader; removing a message also releases its playback resource. */
export class MessageMedia extends LitElement {
  static properties = { src: {}, kind: {}, label: {}, failed: { state: true } };
  declare src: string;
  declare kind: 'audio' | 'video';
  declare label: string;
  declare private failed: boolean;
  constructor() {
    super();
    this.src = '';
    this.kind = 'audio';
    this.label = '';
    this.failed = false;
  }
  createRenderRoot() {
    return this;
  }
  protected willUpdate(changes: PropertyValues) {
    if (changes.has('src')) this.failed = false;
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.querySelectorAll('audio,video').forEach(element => {
        const media = element as HTMLMediaElement;
        media.pause();
        media.removeAttribute('src');
        media.load();
      });
    });
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }
  render() {
    return html`<figure class="message-media">
      <figcaption>${this.label}</figcaption>
      ${
        this.failed
          ? html`<p role="status">${i18nService.t('messageMediaFailed')}</p>`
          : this.kind === 'video'
            ? html`<video
                controls
                playsinline
                preload="metadata"
                .src=${live(this.src)}
                aria-label=${this.label}
                @error=${(event: Event) => {
                  if (
                    this.isConnected &&
                    (event.currentTarget as HTMLMediaElement).getAttribute('src') === this.src
                  )
                    this.failed = true;
                }}
              ></video>`
            : html`<audio
                controls
                preload="metadata"
                .src=${live(this.src)}
                aria-label=${this.label}
                @error=${(event: Event) => {
                  if (
                    this.isConnected &&
                    (event.currentTarget as HTMLMediaElement).getAttribute('src') === this.src
                  )
                    this.failed = true;
                }}
              ></audio>`
      }
      ${
        this.failed
          ? html`<button
              type="button"
              @click=${() => {
                this.failed = false;
              }}
            >
              ${i18nService.t('messageMediaRetry')}
            </button>`
          : nothing
      }
    </figure>`;
  }
}
if (!customElements.get('justdo-message-media'))
  customElements.define('justdo-message-media', MessageMedia);
