/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0e14',
        panel: '#12161f',
        panel2: '#171c28',
        line: '#232a38',
        up: '#22c55e',
        down: '#ef4444',
        accent: '#38bdf8',
        warn: '#f59e0b',
      },
    },
  },
  plugins: [],
};
