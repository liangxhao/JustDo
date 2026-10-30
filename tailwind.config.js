import preset from '@app-plugin/build/theme-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ['./src/renderer/*.html', './src/**/*.{js,ts,jsx,tsx}'],
};
