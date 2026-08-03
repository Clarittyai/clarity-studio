import type { Config } from 'tailwindcss';
import { clarittyPreset } from '@claritty-studio/design';

export default {
  presets: [clarittyPreset as never],
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
} satisfies Config;
