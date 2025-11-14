import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path para GitHub Pages: usar '/impostor/' en producción, '/' en desarrollo
const base = process.env.NODE_ENV === 'production' ? '/impostor/' : '/';

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










