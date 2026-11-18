import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

function copyRootStaticAssetsPlugin() {
  return {
    name: 'copy-root-static-assets',
    closeBundle() {
      const rootDir = import.meta.dirname;
      const outDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(outDir)) return;

      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (/\.(?:js|css|png|svg|ico)$/i.test(entry.name) || entry.name === 'manifest.json') {
          fs.copyFileSync(
            path.join(rootDir, entry.name),
            path.join(outDir, entry.name)
          );
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), copyRootStaticAssetsPlugin()],
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
          if (id.endsWith('/settlement.js') || id.endsWith('\\settlement.js')) {
            return 'feature-settlement';
          }
        }
      }
    }
  },
  test: {
    environment: 'jsdom'
  }
});
