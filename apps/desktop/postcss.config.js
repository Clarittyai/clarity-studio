export default {
  plugins: {
    // Must run before Tailwind: glass.css uses @apply, and @apply is only
    // resolved in the file Tailwind actually processes. Inlining the imports
    // first is what makes the recipes work rather than silently vanish.
    'postcss-import': {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
