import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Hive palette
        honey: {
          50:  '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          300: '#FCD34D',
          400: '#FBBF24',
          500: '#FFC107',  // primary
          600: '#D97706',
          700: '#B45309',
          800: '#92400E',
          900: '#78350F',
        },
        burnt: {
          400: '#FB923C',
          500: '#FF6B1A',  // accent (running)
          600: '#EA580C',
          700: '#C2410C',
        },
        hive: {
          bg:      '#0A0A0A',
          surface: '#141414',
          border:  '#1F1F1F',
          muted:   '#2A2A2A',
          text:    '#FAFAFA',
          subtle:  '#A1A1AA',
        },
      },
      backgroundImage: {
        'hex-grid': "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='100' viewBox='0 0 56 100'%3E%3Cpath d='M28 0L56 16.18v32.36L28 64.72 0 48.54V16.18z' fill='none' stroke='%23FFC107' stroke-opacity='0.05' stroke-width='1'/%3E%3C/svg%3E\")",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
