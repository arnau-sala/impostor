import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env.VITE_BASE_PATH && process.env.VITE_BASE_PATH !== '' ? process.env.VITE_BASE_PATH : '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '0.0.0.0', // Permite conexiones desde otros dispositivos en la red local
    port: 5173,
  },
});










