/**
 * Tailwind CSS v3 plugin — bridges --justdo-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 * Also provides legacy claude.* aliases for backward compatibility.
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

        // === Legacy claude.* aliases (map to --justdo-* for backward compat) ===
        claude: {
          bg:                'var(--justdo-background)',
          surface:           'var(--justdo-surface)',
          surfaceHover:      'var(--justdo-surface-raised)',
          surfaceMuted:      'var(--justdo-surface-raised)',
          surfaceInset:      'var(--justdo-surface-raised)',
          border:            'var(--justdo-border)',
          borderLight:       'var(--justdo-border-subtle)',
          text:              'var(--justdo-text-primary)',
          textSecondary:     'var(--justdo-text-secondary)',
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            'var(--justdo-background)',
          darkSurface:       'var(--justdo-surface)',
          darkSurfaceHover:  'var(--justdo-surface-raised)',
          darkSurfaceMuted:  'var(--justdo-surface-raised)',
          darkSurfaceInset:  'var(--justdo-surface-raised)',
          darkBorder:        'var(--justdo-border)',
          darkBorderLight:   'var(--justdo-border-subtle)',
          darkText:          'var(--justdo-text-primary)',
          darkTextSecondary: 'var(--justdo-text-secondary)',
          // Accent
          accent:            'var(--justdo-primary)',
          accentHover:       'var(--justdo-primary-hover)',
          accentLight:       'var(--justdo-primary)',
          accentMuted:       'var(--justdo-primary-muted)',
        },
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
