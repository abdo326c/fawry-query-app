// Smoke tests verifying the production Vite build output (dist/), backup integrity hashing,
// and consolidated v2.11.3 governance & archiving schema definitions.
import { describe, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeFileSha256 } from '../scripts/backup_to_drive.js';
import { syncOrCheckReactViews } from '../scripts/sync_react_views.mjs';

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

describe('Production dist/ Bundle, Governance & Disaster Recovery Smoke Tests', () => {
  test('dist/ build output contains index.html, react.html, and every referenced local JS/CSS asset', () => {
    expect(fs.existsSync(distDir), 'Run npm run build before dist smoke test').toBe(true);

    for (const entryHtml of ['index.html', 'react.html']) {
      const htmlPath = path.join(distDir, entryHtml);
      expect(fs.existsSync(htmlPath), `Missing dist/${entryHtml}`).toBe(true);
      const content = fs.readFileSync(htmlPath, 'utf8');

      // Verify every local /assets/... or ./file referenced by <script src> / <link href> exists in dist/
      const refs = [...content.matchAll(/(?:src|href)="(\/assets\/[^"?]+|\.?\/?[^":?]+\.(?:js|css|json|png|svg|ico))(?:\?[^"]*)?"/g)]
        .map(m => m[1])
        .filter(u => !u.startsWith('http://') && !u.startsWith('https://'));

      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const rel = ref.replace(/^\/+/, '').replace(/^\.\//, '');
        expect(fs.existsSync(path.join(distDir, rel)), `Missing dist asset "${rel}" referenced in ${entryHtml}`).toBe(true);
      }
    }
  });

  test('every Service Worker cached asset exists inside dist/ so Vercel deployments never 404', () => {
    const swPath = path.join(distDir, 'sw.js');
    expect(fs.existsSync(swPath)).toBe(true);
    const swSrc = fs.readFileSync(swPath, 'utf8');
    const cachedAssets = [...swSrc.matchAll(/'\.\/([^'?]+)(?:\?[^']*)?'/g)].map(m => m[1]).filter(Boolean);

    expect(cachedAssets.length).toBeGreaterThan(10);
    for (const rel of cachedAssets) {
      expect(fs.existsSync(path.join(distDir, rel)), `Missing SW asset in dist/: ${rel}`).toBe(true);
    }

    // Critical runtime assets & extracted domain modules
    for (const critical of [
      'settlement.js',
      'ui-chrome.js',
      'automatcher.worker.js',
      'foreign-ui.js',
      'payment-links-ui.js',
      'students-ui.js',
      'mappings-fixes-ui.js',
      'manifest.json'
    ]) {
      expect(fs.existsSync(path.join(distDir, critical)), `Missing critical dist/${critical}`).toBe(true);
    }
    const manifestJson = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
    expect(manifestJson.name).toBeTruthy();
  });

  test('backup integrity helper computes deterministic 64-character SHA-256 checksums', () => {
    const tmpFile = path.join(os.tmpdir(), `fawry_sha256_test_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpFile, 'fawry-backup-integrity-check', 'utf8');
      const h1 = computeFileSha256(tmpFile);
      const h2 = computeFileSha256(tmpFile);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
      expect(h1).toBe(h2);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('v2.11.3 migration and schema.sql define table-driven primary admin, executive analytics, and cold-storage archive', () => {
    const migSql = fs.readFileSync(path.join(rootDir, 'migrations/2.11.3_governance_and_analytics.sql'), 'utf8');
    const schemaSql = fs.readFileSync(path.join(rootDir, 'schema.sql'), 'utf8');

    expect(migSql).toContain('is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migSql).toContain('CREATE TABLE IF NOT EXISTS public.transactions_archive');
    expect(migSql).toContain('CREATE OR REPLACE FUNCTION public.archive_settled_transactions');
    expect(migSql).toContain("'prev_period'");
    expect(migSql).toContain("'levels'");

    expect(schemaSql).toContain('is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS public.transactions_archive');
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.archive_settled_transactions');
  });

  test('src/components React views and modals stay 100% synced with index.html', () => {
    const { drifted, total } = syncOrCheckReactViews({ checkOnly: true });
    expect(total).toBe(15);
    expect(drifted).toEqual([]);
  });

  test('scripts/database_hygiene.js accurately reports conflicting_case_mappings and leaves identical duplicates uncleaned', () => {
    const hygieneSrc = fs.readFileSync(path.join(rootDir, 'scripts/database_hygiene.js'), 'utf8');
    expect(hygieneSrc).toContain('Conflicting Case Mappings');
    expect(hygieneSrc).toContain('data.conflicting_case_mappings');
    expect(hygieneSrc).toContain('| **Identical Duplicate Transactions** | ${data.identical_tx_duplicates || 0} | — |');
    expect(hygieneSrc).toContain('| **Conflicting Case Mappings** | ${data.conflicting_case_mappings || 0} | Manual review |');
  });
});
