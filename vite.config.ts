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
      external: [/^https?:\/\//],
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('src/components/')) {
            return 'react-views';
          }
          if (id.endsWith('/dashboard.js') || id.endsWith('\\dashboard.js')) {
            return 'feature-dashboard';
          }
          if (id.endsWith('/erp-export.js') || id.endsWith('\\erp-export.js')) {
            return 'feature-erp';
          }
          if (id.endsWith('/auto-matcher.js') || id.endsWith('\\auto-matcher.js')) {
            return 'feature-automatcher';
          }
          if (id.endsWith('/admin-audit.js') || id.endsWith('\\admin-audit.js')) {
            return 'feature-admin';
          }
        }
      }
    }
  },
  test: {
    environment: 'jsdom'
  }
});
