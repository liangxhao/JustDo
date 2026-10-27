import { parseManagedOutgoingMediaSource } from '@shared/openclaw/assistantMedia';
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { live } from 'lit/directives/live.js';

import { i18nService } from '@/services/i18n';

/** A local media reader; removing a message also releases its playback resource. */
export class MessageMedia extends LitElement {
  static properties = {
    src: {},
    kind: {},
    label: {},
    sessionKey: {},
    failed: { state: true },
    loading: { state: true },
    playbackSrc: { state: true },
  };
  declare src: string;
  declare kind: 'audio' | 'video';
  declare label: string;
  declare sessionKey: string;
  declare private failed: boolean;
  declare private loading: boolean;
  declare private playbackSrc: string;
  private sourceGeneration = 0;
  private needsPreparation = true;
  private releasePlayback: (() => void) | null = null;
  constructor() {
    super();
    this.src = '';
    this.kind = 'audio';
    this.label = '';
    this.sessionKey = '';
    this.failed = false;
    this.loading = false;
    this.playbackSrc = '';
  }
  createRenderRoot() {
    return this;
  }
  protected willUpdate(changes: PropertyValues) {
    if (!this.isConnected) return;
    if (
      this.needsPreparation ||
      changes.has('src') ||
      changes.has('kind') ||
      changes.has('sessionKey')
    ) {
      this.prepareSource();
    }
  }
  private prepareSource() {
    this.needsPreparation = false;
    const generation = ++this.sourceGeneration;
    this.stopMedia();
    this.releasePlayback?.();
    this.releasePlayback = null;
    this.failed = false;
    this.loading = false;
    this.playbackSrc = '';
    if (!this.src.startsWith('/api/chat/media/outgoing/')) {
      this.playbackSrc = this.src;
      return;
    }
    const sessionKey =
      this.sessionKey && parseManagedOutgoingMediaSource(this.src, this.sessionKey);
    const ownerWindow = this.ownerDocument.defaultView;
    const engine = ownerWindow?.mediaPlayback ?? ownerWindow?.electron?.openclaw?.engine;
    if (!sessionKey || !engine?.prepareAssistantMediaPlayback) {
      this.failed = true;
      return;
    }
    this.loading = true;
    void engine
      .prepareAssistantMediaPlayback({ source: this.src, sessionKey, kind: this.kind })
      .then(result => {
        if (!result.success) {
          if (generation === this.sourceGeneration && this.isConnected) this.failed = true;
          return;
        }
        const release = () => {
          void engine.releaseAssistantMediaPlayback({ url: result.url }).catch(() => {});
        };
        if (generation !== this.sourceGeneration || !this.isConnected) {
          release();
          return;
        }
        this.releasePlayback = release;
        this.playbackSrc = result.url;
      })
      .catch(() => {
        if (generation === this.sourceGeneration && this.isConnected) this.failed = true;
      })
      .finally(() => {
        if (generation === this.sourceGeneration && this.isConnected) this.loading = false;
      });
  }
  private stopMedia() {
    this.querySelectorAll('audio,video').forEach(element => {
      const media = element as HTMLMediaElement;
      media.pause();
      media.removeAttribute('src');
      media.load();
    });
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.sourceGeneration += 1;
      this.releasePlayback?.();
      this.releasePlayback = null;
      this.needsPreparation = true;
      this.playbackSrc = '';
      this.stopMedia();
    });
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }
  render() {
    if (!this.isConnected) return nothing;
    return html`<figure class="message-media">
      <figcaption>${this.label}</figcaption>
      ${
        this.failed
          ? html`<p role="status">${i18nService.t('messageMediaFailed')}</p>`
          : this.loading
            ? html`<p role="status">${i18nService.t('messageMediaLoading')}</p>`
            : this.kind === 'video'
              ? html`<video
                  controls
                  tabindex="0"
                  playsinline
                  preload="metadata"
                  .src=${live(this.playbackSrc)}
                  aria-label=${this.label}
                  @error=${(event: Event) => {
                    if (
                      this.isConnected &&
                      (event.currentTarget as HTMLMediaElement).getAttribute('src') ===
                        this.playbackSrc
                    )
                      this.failed = true;
                  }}
                ></video>`
              : html`<audio
                  controls
                  tabindex="0"
                  preload="metadata"
                  .src=${live(this.playbackSrc)}
                  aria-label=${this.label}
                  @error=${(event: Event) => {
                    if (
                      this.isConnected &&
                      (event.currentTarget as HTMLMediaElement).getAttribute('src') ===
                        this.playbackSrc
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
                this.prepareSource();
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
