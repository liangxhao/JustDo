/**
 * Tailwind CSS v3 plugin — bridges --gucciai-* CSS variables into Tailwind utility classes.
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
        background:    'var(--gucciai-background)',
        foreground:    'var(--gucciai-foreground)',
        primary: {
          DEFAULT:     'var(--gucciai-primary)',
          foreground:  'var(--gucciai-primary-foreground)',
          hover:       'var(--gucciai-primary-hover)',
          muted:       'var(--gucciai-primary-muted)',
          dark:        'var(--gucciai-primary-hover)',  // backward compat alias
        },
        accent: {
          DEFAULT:     'var(--gucciai-accent)',
          foreground:  'var(--gucciai-accent-foreground)',
        },
        surface: {
          DEFAULT:     'var(--gucciai-surface)',
          foreground:  'var(--gucciai-surface-foreground)',
          raised:      'var(--gucciai-surface-raised)',
          overlay:     'var(--gucciai-surface-overlay)',
          inset:       'var(--gucciai-surface-raised)',  // alias
        },
        border: {
          DEFAULT:     'var(--gucciai-border)',
          subtle:      'var(--gucciai-border-subtle)',
          input:       'var(--gucciai-input-border)',
        },
        muted:         'var(--gucciai-text-muted)',
        destructive: {
          DEFAULT:     'var(--gucciai-destructive)',
          foreground:  'var(--gucciai-destructive-foreground)',
        },
        success:       'var(--gucciai-success)',
        warning:       'var(--gucciai-warning)',

        // === Legacy claude.* aliases (map to --gucciai-* for backward compat) ===
        claude: {
          bg:                'var(--gucciai-background)',
          surface:           'var(--gucciai-surface)',
          surfaceHover:      'var(--gucciai-surface-raised)',
          surfaceMuted:      'var(--gucciai-surface-raised)',
          surfaceInset:      'var(--gucciai-surface-raised)',
          border:            'var(--gucciai-border)',
          borderLight:       'var(--gucciai-border-subtle)',
          text:              'var(--gucciai-text-primary)',
          textSecondary:     'var(--gucciai-text-secondary)',
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            'var(--gucciai-background)',
          darkSurface:       'var(--gucciai-surface)',
          darkSurfaceHover:  'var(--gucciai-surface-raised)',
          darkSurfaceMuted:  'var(--gucciai-surface-raised)',
          darkSurfaceInset:  'var(--gucciai-surface-raised)',
          darkBorder:        'var(--gucciai-border)',
          darkBorderLight:   'var(--gucciai-border-subtle)',
          darkText:          'var(--gucciai-text-primary)',
          darkTextSecondary: 'var(--gucciai-text-secondary)',
          // Accent
          accent:            'var(--gucciai-primary)',
          accentHover:       'var(--gucciai-primary-hover)',
          accentLight:       'var(--gucciai-primary)',
          accentMuted:       'var(--gucciai-primary-muted)',
        },
        secondary: {
          DEFAULT: 'var(--gucciai-text-secondary)',
          dark:    'var(--gucciai-border)',
        },
      },
      borderRadius: {
        theme: 'var(--gucciai-radius)',
      },
    },
  },
});
