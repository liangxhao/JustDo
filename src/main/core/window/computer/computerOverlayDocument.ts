import { createHash } from 'node:crypto';

export type ComputerOverlayFrame = {
  x: number;
  y: number;
  cursor: boolean;
  badge: boolean;
  pulse: number;
};

const script = `
const cursor = document.getElementById('cursor');
const badge = document.getElementById('badge');
const pulse = document.getElementById('pulse');
let lastPulse = 0;
window.renderComputerOverlay = frame => {
  cursor.hidden = !frame.cursor;
  badge.hidden = !frame.badge;
  cursor.style.transform = 'translate(' + frame.x + 'px,' + frame.y + 'px)';
  if (frame.pulse !== lastPulse) {
    lastPulse = frame.pulse;
    if (frame.cursor) {
      pulse.style.left = frame.x + 'px';
      pulse.style.top = frame.y + 'px';
      pulse.getAnimations().forEach(animation => animation.cancel());
      pulse.animate([
        { opacity: .85, transform: 'translate(-50%,-50%) scale(.4)' },
        { opacity: 0, transform: 'translate(-50%,-50%) scale(1.7)' }
      ], { duration: 600, easing: 'ease-out' });
    }
  }
};
`;

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );

/** Immutable app-owned drawing surface. No preload, network, input or Node access. */
export function computerOverlayDocument(label: string): string {
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;user-select:none}
[hidden]{display:none!important}
#edge{position:fixed;inset:0;border:2px solid rgba(104,139,255,.55);box-shadow:inset 0 0 20px rgba(100,120,255,.16);border-radius:6px}
#badge{position:fixed;left:50%;top:18px;transform:translateX(-50%);display:flex;align-items:center;gap:9px;padding:9px 15px;border:1px solid rgba(150,169,255,.65);border-radius:24px;background:rgba(22,28,48,.94);color:#f4f6ff;font:13px/18px 'Segoe UI',sans-serif;box-shadow:0 4px 20px #0003;white-space:nowrap}
#badge:before{content:'';width:7px;height:7px;border-radius:50%;background:#9aafff;box-shadow:0 0 9px #94adff}
#cursor{position:fixed;left:0;top:0;width:0;height:0;will-change:transform}
#halo{position:absolute;left:-31px;top:-31px;width:62px;height:62px;border:1px solid #99b2ff77;border-radius:50%;background:radial-gradient(circle,#8ba8ff44 0%,#8ba8ff1a 48%,#8ba8ff00 72%);box-shadow:0 0 18px #8ba8ff33}
svg{position:absolute;left:-3px;top:-3px;width:33px;height:43px;filter:drop-shadow(0 2px 3px #17204488)}
#pulse{position:fixed;width:58px;height:58px;border:2px solid #aec1ff;border-radius:50%;opacity:0;box-shadow:0 0 10px #94aaff77}
</style></head><body><div id="edge"></div><div id="badge" hidden>${escapeHtml(label)}</div>
<div id="pulse"></div><div id="cursor" hidden><div id="halo"></div><svg viewBox="0 0 33 43" aria-hidden="true"><path d="M3 3 L3 32 L11 25 L17 39 L23 36 L17 23 L28 23 Z" fill="#f7f9ff" stroke="#536fc6" stroke-width="2" stroke-linejoin="round"/></svg></div>
<script>${script}</script></body></html>`;
}
