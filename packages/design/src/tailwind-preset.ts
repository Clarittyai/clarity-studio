/**
 * The Clarity Tailwind preset.
 *
 * Hand-written rather than generated — parsing a TS config that imports plugins
 * is a fragile way to obtain values you can simply read. The trade is that a
 * hand-written file can drift, so `scripts/sync.mjs` asserts the load-bearing
 * constants against upstream on every CI run and fails if they move.
 *
 * Colours resolve through the CSS custom properties in `tokens.css`, which are
 * generated. That means light and dark mode need no work here: a token has a
 * value in both, and every colour below follows it.
 */

import type { Config } from 'tailwindcss';

/** `hsl(var(--x))`, so one token drives light and dark. */
const token = (name: string) => `hsl(var(--${name}))`;

export const clarityPreset: Omit<Config, 'content'> = {
  darkMode: ['class'],

  future: {
    // Gates every `hover:` behind `@media (hover: hover)`. Without it a hover
    // style sticks after a tap on a touchscreen and the UI looks broken in a
    // way that is very hard to attribute.
    hoverOnlyWhenSupported: true,
  },

  theme: {
    // Replaces Tailwind's defaults rather than extending them, matching the
    // platform. `md` is 920px, not 768 — it is where the bottom nav becomes a
    // sidebar, and Tailwind's default would put that break in the wrong place.
    screens: {
      sm: '640px',
      md: '920px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },

    extend: {
      colors: {
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('popover-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        // The one brand colour the whole UI leans on: #5B7FFF.
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        success: token('success'),
        warning: token('warning'),
        info: token('info'),
        // An always-dark surface for terminals and log panes — identical in
        // both themes, because a light terminal is nobody's idea of a good time.
        'surface-deep': token('surface-deep'),
        status: {
          success: token('status-success'),
          error: token('status-error'),
          running: token('status-running'),
          idle: token('status-idle'),
        },
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: '1rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
      },

      fontFamily: {
        sans: [
          'var(--font-sans)',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: ['SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', 'monospace'],
      },

      boxShadow: {
        glass: '0 8px 32px 0 rgba(31, 38, 135, 0.1)',
        lift: '0 10px 40px -10px rgba(0, 0, 0, 0.1)',
        'lift-lg': '0 20px 60px -15px rgba(0, 0, 0, 0.15)',
      },

      // Named rather than numeric, so a new overlay cannot be quietly slipped
      // above the navigation by picking a bigger number.
      zIndex: {
        nav: '50',
        sidebar: '55',
        overlay: '60',
        popover: '70',
        dropdown: '80',
        'sheet-backdrop': '90',
        sheet: '100',
      },

      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 200ms ease-out',
        scaleIn: 'scaleIn 160ms ease-out',
        // For a "running" status dot. Slow on purpose: a fast blink in the
        // corner of the eye reads as an alarm.
        pulseDot: 'pulseDot 1.8s ease-in-out infinite',
      },
    },
  },
};

export default clarityPreset;
