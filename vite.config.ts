import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        react: path.resolve(import.meta.dirname, 'react.html')
      },
      external: [/^https?:\/\//]
    }
  },
  test: {
    environment: 'jsdom'
  }
});
