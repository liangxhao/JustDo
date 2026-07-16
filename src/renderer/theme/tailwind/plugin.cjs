/**
 * Tailwind CSS v3 plugin — bridges --justdo-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 */
const plugin = require('tailwindcss/plugin');

module.exports = plugin(function () {
  // The plugin itself is a no-op; we only extend the theme below.
}, {
  theme: {
    extend: {
      colors: {
        // === Semantic theme colors (driven by CSS variables) ===
        background:    'var(--justdo-background)',
        foreground:    'var(--justdo-foreground)',
        primary: {
          DEFAULT:     'var(--justdo-primary)',
          foreground:  'var(--justdo-primary-foreground)',
          hover:       'var(--justdo-primary-hover)',
          muted:       'var(--justdo-primary-muted)',
          dark:        'var(--justdo-primary-hover)',  // backward compat alias
        },
        accent: {
          DEFAULT:     'var(--justdo-accent)',
          foreground:  'var(--justdo-accent-foreground)',
        },
        surface: {
          DEFAULT:     'var(--justdo-surface)',
          foreground:  'var(--justdo-surface-foreground)',
          raised:      'var(--justdo-surface-raised)',
          overlay:     'var(--justdo-surface-overlay)',
          inset:       'var(--justdo-surface-raised)',  // alias
        },
        border: {
          DEFAULT:     'var(--justdo-border)',
          subtle:      'var(--justdo-border-subtle)',
          input:       'var(--justdo-input-border)',
        },
        muted:         'var(--justdo-text-muted)',
        destructive: {
          DEFAULT:     'var(--justdo-destructive)',
          foreground:  'var(--justdo-destructive-foreground)',
        },
        success:       'var(--justdo-success)',
        warning:       'var(--justdo-warning)',

        chat: {
          user:        'var(--justdo-chat-user)',
          'user-fg':   'var(--justdo-chat-user-foreground)',
          bot:         'var(--justdo-chat-bot)',
          'bot-fg':    'var(--justdo-chat-bot-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--justdo-text-secondary)',
          dark:    'var(--justdo-border)',
        },
      },
      borderRadius: {
        theme: 'var(--justdo-radius)',
      },
    },
  },
});
