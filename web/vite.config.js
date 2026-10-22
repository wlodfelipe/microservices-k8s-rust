import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento o Vite faz o papel do nginx: /api → gateway, /ops → ops.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.GATEWAY_URL || 'http://127.0.0.1:8080', ws: true },
      '/ops': process.env.OPS_URL || 'http://127.0.0.1:8090',
    },
  },
});
