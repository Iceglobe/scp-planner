import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
      },
      colors: {
        brand: {
          50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0',
          500: '#22c55e', 600: '#166534', 700: '#14532d',
        },
        navy: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe',
          600: '#1e3a5f', 700: '#162e4d',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
