import type { Config } from 'tailwindcss';
import { clarityPreset } from '@clarity-studio/design';

export default {
  presets: [clarityPreset as never],
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
} satisfies Config;
