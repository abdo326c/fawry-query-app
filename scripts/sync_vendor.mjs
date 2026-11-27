#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const nodeModulesDir = path.join(rootDir, 'node_modules');
const vendorDir = path.join(rootDir, 'vendor');

const VENDOR_ASSETS = [
  ['lucide/dist/umd/lucide.min.js', 'lucide.min.js'],
  ['tom-select/dist/js/tom-select.complete.min.js', 'tom-select.complete.min.js'],
  ['tom-select/dist/css/tom-select.css', 'tom-select.css'],
  ['flatpickr/dist/flatpickr.min.js', 'flatpickr.min.js'],
  ['flatpickr/dist/flatpickr.min.css', 'flatpickr.min.css'],
  ['flatpickr/dist/themes/dark.css', 'flatpickr-dark.css'],
  ['flatpickr/dist/themes/light.css', 'flatpickr-light.css'],
  ['papaparse/papaparse.min.js', 'papaparse.min.js'],
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['fuse.js/dist/fuse.min.js', 'fuse.min.js'],
  ['xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js'],
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs']
];

export function syncVendorAssets() {
  fs.mkdirSync(vendorDir, { recursive: true });
  let copied = 0;
  for (const [srcRel, destName] of VENDOR_ASSETS) {
    const srcPath = path.join(nodeModulesDir, srcRel);
    const destPath = path.join(vendorDir, destName);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing vendor asset source: ${srcPath}. Run "npm install" first.`);
    }
    fs.copyFileSync(srcPath, destPath);
    copied++;
  }
  return copied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const count = syncVendorAssets();
  console.log(`✓ Synced ${count} local vendor asset(s) to vendor/.`);
}
