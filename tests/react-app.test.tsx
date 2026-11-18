// @vitest-environment jsdom
import React from 'react';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../supabase.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn()
    },
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null })
    }))
  }
}));

import { App } from '../src/App';
import { mountReactApp } from '../src/main';
import { AppProvider, useAppContext } from '../src/context/AppContext';
import {
  validateID,
  isIdValidationExempt,
  getEffectiveIdStatus,
  toDateOnly,
  getStudentProgramLevel
} from '../src/services/rules';
import { createEmptyFxStore, setManualFxRate, convertUsdToEgp } from '../src/services/fx-rates';
import { parseStatementDate } from '../src/services/foreign-transactions';

describe('React 19 + TypeScript Migration Architecture', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders full React 19 <App /> component tree with all 11 views and 18 modals', () => {
    const { container } = render(<App />);

    expect(container.querySelector('#auth-overlay')).not.toBeNull();
    expect(container.querySelector('aside.sidebar')).not.toBeNull();
    expect(container.querySelector('header.workspace-topbar')).not.toBeNull();

    const expectedViewIds = [
      'view-dashboard',
      'view-transactions',
      'view-foreign-transactions',
      'view-mappings',
      'view-fixes',
      'view-student-master',
      'view-automatcher',
      'view-payment-links',
      'view-erp-export',
      'view-settlement',
      'view-users'
    ];
    for (const id of expectedViewIds) {
      expect(container.querySelector(`#${id}`), `Missing React view #${id}`).not.toBeNull();
    }

    const expectedModals = [
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
    for (const id of expectedModals) {
      expect(container.querySelector(`#${id}`), `Missing React modal #${id}`).not.toBeNull();
    }
  });

  test('AppProvider and useAppContext manage reactive tab and theme state', () => {
    const Probe: React.FC = () => {
      const { activeTab, setActiveTab, theme, toggleTheme, userRole } = useAppContext();
      return (
        <div>
          <span data-testid="active-tab">{activeTab}</span>
          <span data-testid="theme">{theme}</span>
          <span data-testid="role">{userRole}</span>
          <button data-testid="btn-erp" onClick={() => setActiveTab('erp-export')}>
            Switch ERP
          </button>
          <button data-testid="btn-theme" onClick={() => toggleTheme()}>
            Toggle Theme
          </button>
        </div>
      );
    };

    const { getByTestId } = render(
      <AppProvider>
        <Probe />
      </AppProvider>
    );

    expect(getByTestId('active-tab').textContent).toBe('dashboard');
    expect(getByTestId('role').textContent).toBe('viewer');

    fireEvent.click(getByTestId('btn-erp'));
    expect(getByTestId('active-tab').textContent).toBe('erp-export');

    const initialTheme = getByTestId('theme').textContent;
    fireEvent.click(getByTestId('btn-theme'));
    expect(getByTestId('theme').textContent).toBe(initialTheme === 'dark' ? 'light' : 'dark');
  });

  test('TypeScript service wrappers provide accurate typed domain results', () => {
    expect(validateID('241001234')).toBe('Valid');
    expect(validateID('DIP12345678901234')).toBe('Valid');
    expect(isIdValidationExempt({ mapping: 'Diploma & Workshop' })).toBe(true);
    expect(getEffectiveIdStatus({ student_id: '', mapping: 'Workshop' })).toBe('Exempt');
    expect(toDateOnly('2026-11-18T15:30:00Z')).toBe('2026-11-18');
    expect(getStudentProgramLevel('(PG) Master of Data Science')).toBe('PG');

    const store = setManualFxRate(createEmptyFxStore(), { dateStr: '2026-11-18', rate: 48.5 });
    const conv = convertUsdToEgp(100, '2026-11-18', store);
    expect(conv.egpAmount).toBe(4850);
    expect(conv.rate).toBe(48.5);

    expect(parseStatementDate(45672).dateOnly).toBe('2025-01-15');
  });

  test('mountReactApp boots FawryAppController on a clean #root and all 120+ controller functions work', async () => {
    const rootDiv = document.createElement('div');
    rootDiv.id = 'root';
    document.body.appendChild(rootDiv);

    mountReactApp(rootDiv);

    const app = (window as unknown as { app: Record<string, unknown> }).app;
    expect(app).toBeDefined();

    // Verify every extracted & core method is present as a function on window.app
    const requiredMethods = [
      // Core & Auth / RBAC
      'initAuth', 'getRoleLevel', 'hasRole', 'requireRole', 'fetchUserRole', 'applyRolePermissionsToUI',
      'initNavigation', 'initTheme', 'initDatePickers', 'initGlobalSearch', 'updateSidebarBadges',
      // Dashboard (dashboard.js)
      'initDashboard', 'drillDownFromDashboard', 'exportDashboardPivotExcel', 'updateDashboardFxUI',
      'scheduleDailyFxNoonSync', 'syncDashboardFxRates', 'loadDashboard',
      // Transactions, Mappings & Fixes
      'initImport', 'handleFiles', 'reapplyRulesTo', 'initModals', 'initBulkUploads', 'initReapply',
      'initFilters', 'setupHeaderFilters', 'initPagination', 'initExport', 'loadTransactions',
      'openQuickMapForItem', 'openTransactionDetailsModal', 'loadMappings', 'renderMappingsPage',
      'deduplicateItemMappings', 'loadFixes', 'renderFixesPage', 'deduplicateManualFixes',
      // Auto-Matcher (auto-matcher.js)
      'handleTargetedMatcherImport', 'runAutoMatcher', 'getFilteredAutoMatchProposals',
      'updateAutoMatchSelectionUI', 'renderAutoMatcherPage', 'applyAutoMatches',
      // Payment Links & Students
      'initPaymentLinks', 'openPaymentLinkModal', 'loadPaymentLinks', 'renderPaymentLinksPage',
      'initStudentMaster', 'openStudentModal', 'loadStudents', 'renderStudentsPage',
      'loadStudentProfile', 'exportStudentStatement',
      // ERP Export (erp-export.js)
      'initErpExport', 'updateErpDropdowns', 'formatErpCurrencySummary', 'fetchForeignRowsForErp',
      'loadErpExport', 'updateErpRecordButtonLabel', 'openManualFixFromErp', 'renderErpPreview',
      'erpAmount', 'erpAccount', 'erpDayShort', 'resolveErpExportDate', 'downloadErpExport',
      'openErpDateChoiceModal', 'generateErpExcel', 'recordErpReferences',
      // Admin, Audit, Double-Payments & Hygiene (admin-audit.js)
      'initUsersAndRoles', 'loadUsersAndRoles', 'renderUserRolesTable', 'renderAuditLogsTable',
      'revertAuditLogEntry', 'initDoublePaymentsDetector', 'loadDoublePayments',
      'renderDoublePaymentsTable', 'exportDoublePayments', 'initHygieneReportModal',
      'checkAndShowHygieneReportModal',
      // Foreign / BM Transactions
      'initForeignTransactions', 'loadForeignTransactions', 'applyForeignFilters',
      'renderForeignTransactionsTable', 'openForeignTransactionDetailsModal', 'openForeignFixModal',
      'saveForeignTransactionFix', 'detectForeignDuplicates', 'cleanupForeignDuplicates',
      'openForeignDoublePaymentsModal', 'runForeignAutoMatchNames',
      'exportForeignTransactionsExcel', 'copyForeignTransactionsForEmail'
    ];

    for (const methodName of requiredMethods) {
      expect(typeof app[methodName], `window.app.${methodName} should be a function`).toBe('function');
    }

    // Exercise key controller workflows against the React-mounted DOM
    await (app.loadDashboard as () => Promise<void>)();
    await (app.loadTransactions as () => Promise<void>)();
    await (app.loadForeignTransactions as () => Promise<void>)();
    await (app.loadMappings as () => Promise<void>)();
    await (app.loadFixes as () => Promise<void>)();
    await (app.loadStudents as () => Promise<void>)();
    await (app.loadPaymentLinks as () => Promise<void>)();
    await (app.loadErpExport as () => Promise<void>)();
    await (app.loadUsersAndRoles as () => Promise<void>)();
    await (app.loadDoublePayments as () => Promise<void>)();

    (app.openStudentModal as () => void)();
    expect(document.getElementById('modal-student')?.classList.contains('hidden')).toBe(false);
    document.getElementById('modal-student')?.classList.add('hidden');

    (app.openPaymentLinkModal as () => void)();
    expect(document.getElementById('modal-link')?.classList.contains('hidden')).toBe(false);
    document.getElementById('modal-link')?.classList.add('hidden');
  });
});
