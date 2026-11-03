import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional dev proxy for live market data (Binance public REST).
// The game MUST work without it — MockProvider is the default fallback.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/binance': {
        target: 'https://api.binance.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/binance/, ''),
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
