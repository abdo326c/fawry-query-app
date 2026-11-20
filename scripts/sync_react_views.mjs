#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(import.meta.dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

function normalizeLf(str) {
  return String(str).replace(/\r\n/g, '\n');
}

/**
 * Extracts a balanced HTML element starting from a matching opening tag regex.
 * Returns { outer, inner } or null if not found.
 */
function extractBalancedTag(html, openTagRegex, tagName) {
  const match = openTagRegex.exec(html);
  if (!match) return null;

  const startIdx = match.index;
  const openTagEnd = html.indexOf('>', startIdx);
  if (openTagEnd === -1) return null;

  const tagPattern = new RegExp(`<(\\/)?${tagName}(?:\\s|>)`, 'gi');
  tagPattern.lastIndex = openTagEnd + 1;
  let depth = 1;
  let m;

  while ((m = tagPattern.exec(html)) !== null) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) {
        const closeTagEnd = html.indexOf('>', m.index);
        if (closeTagEnd === -1) return null;
        return {
          outer: html.slice(startIdx, closeTagEnd + 1),
          inner: html.slice(openTagEnd + 1, m.index).replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '')
        };
      }
    } else {
      depth++;
    }
  }
  return null;
}

function mustExtract(html, regex, tagName, label) {
  const res = extractBalancedTag(html, regex, tagName);
  if (!res) {
    throw new Error(`Could not locate balanced <${tagName}> for "${label}" in index.html`);
  }
  return res;
}

const MODAL_IDS = [
  'modal-foreign-import',
  'modal-foreign-fix',
  'modal-import',
  'modal-history',
  'modal-mapping',
  'modal-fix',
  'modal-tx-details',
  'modal-automatch-confirm',
  'modal-name-match-warn',
  'modal-reapply-preview',
  'modal-student',
  'modal-link',
  'modal-erp-warning',
  'modal-erp-date-choice',
  'modal-detect-duplicates',
  'modal-double-payments',
  'modal-hygiene-report',
  'modal-custom-confirm',
  'global-search-overlay'
];

const VIEW_SPECS = [
  { file: 'DashboardView.tsx', name: 'DashboardView', id: 'view-dashboard', className: 'view' },
  { file: 'TransactionsView.tsx', name: 'TransactionsView', id: 'view-transactions', className: 'view active' },
  { file: 'ForeignTransactionsView.tsx', name: 'ForeignTransactionsView', id: 'view-foreign-transactions', className: 'view' },
  { file: 'MappingsView.tsx', name: 'MappingsView', id: 'view-mappings', className: 'view' },
  { file: 'FixesView.tsx', name: 'FixesView', id: 'view-fixes', className: 'view' },
  { file: 'StudentsView.tsx', name: 'StudentsView', id: 'view-student-master', className: 'view' },
  { file: 'AutoMatcherView.tsx', name: 'AutoMatcherView', id: 'view-automatcher', className: 'view' },
  { file: 'PaymentLinksView.tsx', name: 'PaymentLinksView', id: 'view-payment-links', className: 'view' },
  { file: 'ErpExportView.tsx', name: 'ErpExportView', id: 'view-erp-export', className: 'view' },
  { file: 'SettlementView.tsx', name: 'SettlementView', id: 'view-settlement', className: 'view' },
  { file: 'UsersRolesView.tsx', name: 'UsersRolesView', id: 'view-users', className: 'view' }
];

export function generateExpectedComponentFiles(htmlText = indexHtml) {
  const outputs = new Map();

  const auth = mustExtract(htmlText, /<div\b[^>]*\bid="auth-overlay"[^>]*>/i, 'div', 'auth-overlay');
  outputs.set(
    'src/components/AuthOverlay.tsx',
    `import React from 'react';
import { StaticHtmlBlock } from './StaticHtmlBlock';

const AUTH_HTML = ${JSON.stringify(normalizeLf(auth.inner))};

export const AuthOverlay: React.FC = () => (
  <StaticHtmlBlock tag="div" id="auth-overlay" className="auth-overlay" html={AUTH_HTML} />
);
`
  );

  const mobileHeader = mustExtract(htmlText, /<div\b[^>]*\bclass="mobile-header"[^>]*>/i, 'div', 'mobile-header');
  const sidebar = mustExtract(htmlText, /<aside\b[^>]*\bclass="sidebar"[^>]*>/i, 'aside', 'sidebar');
  outputs.set(
    'src/components/Sidebar.tsx',
    `import React from 'react';
import { StaticHtmlBlock } from './StaticHtmlBlock';

const MOBILE_HEADER_HTML = ${JSON.stringify(normalizeLf(mobileHeader.inner))};
const SIDEBAR_HTML = ${JSON.stringify(normalizeLf(sidebar.inner))};

export const Sidebar: React.FC = () => (
  <>
    <StaticHtmlBlock tag="div" className="mobile-header" html={MOBILE_HEADER_HTML} />
    <div id="sidebar-backdrop" className="sidebar-backdrop" />
    <StaticHtmlBlock tag="aside" className="sidebar" html={SIDEBAR_HTML} />
  </>
);
`
  );

  const topbar = mustExtract(htmlText, /<header\b[^>]*\bclass="workspace-topbar"[^>]*>/i, 'header', 'workspace-topbar');
  outputs.set(
    'src/components/TopHeader.tsx',
    `import React from 'react';
import { StaticHtmlBlock } from './StaticHtmlBlock';

const TOPBAR_HTML = ${JSON.stringify(normalizeLf(topbar.inner))};

export const TopHeader: React.FC = () => (
  <StaticHtmlBlock tag="header" className="workspace-topbar" html={TOPBAR_HTML} />
);
`
  );

  for (const v of VIEW_SPECS) {
    const viewSection = mustExtract(
      htmlText,
      new RegExp(`<section\\b[^>]*\\bid="${v.id}"[^>]*>`, 'i'),
      'section',
      v.id
    );
    outputs.set(
      `src/components/views/${v.file}`,
      `import React from 'react';
import { StaticHtmlBlock } from '../StaticHtmlBlock';

const VIEW_HTML = ${JSON.stringify(normalizeLf(viewSection.inner))};

export const ${v.name}: React.FC = () => (
  <StaticHtmlBlock tag="section" id="${v.id}" className="${v.className}" html={VIEW_HTML} />
);
`
    );
  }

  const modalsChunks = MODAL_IDS.map((id) =>
    normalizeLf(mustExtract(htmlText, new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`, 'i'), 'div', id).outer)
  );
  outputs.set(
    'src/components/modals/AppModals.tsx',
    `import React from 'react';
import { StaticHtmlBlock } from '../StaticHtmlBlock';

const MODALS_HTML = ${JSON.stringify(modalsChunks.join('\n\n'))};

export const AppModals: React.FC = () => (
  <StaticHtmlBlock tag="div" id="app-modals-root" html={MODALS_HTML} />
);
`
  );

  return outputs;
}

export function syncOrCheckReactViews({ checkOnly = false } = {}) {
  const expected = generateExpectedComponentFiles();
  const drifted = [];

  for (const [relPath, content] of expected.entries()) {
    const absPath = path.join(rootDir, relPath);
    const current = fs.existsSync(absPath) ? normalizeLf(fs.readFileSync(absPath, 'utf8')) : null;
    if (current !== normalizeLf(content)) {
      drifted.push(relPath);
      if (!checkOnly) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf8');
      }
    }
  }

  return { drifted, total: expected.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const checkOnly = process.argv.includes('--check');
  const { drifted, total } = syncOrCheckReactViews({ checkOnly });
  if (checkOnly) {
    if (drifted.length > 0) {
      console.error(`❌ React view drift detected against index.html in ${drifted.length} file(s):`);
      drifted.forEach(f => console.error(`   - ${f}`));
      console.error('Run "npm run sync:views" to update src/components/ from index.html.');
      process.exit(1);
    }
    console.log(`✓ All ${total} React view/modal/chrome files are in sync with index.html.`);
  } else {
    console.log(`✓ Synced ${total} React component files (${drifted.length} updated).`);
  }
}
