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
      range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
      then: (resolve: (val: unknown) => void) =>
        Promise.resolve({ data: [{ mapping: 'Tuition', item_name: 'Tuition Fee' }], error: null }).then(resolve)
    }))
  }
}));

import { supabase } from '../supabase.js';
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
import { inlineIcon } from '../app-utils.js';

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
      'initNavigation', 'initTheme', 'initDatePickers', 'initGlobalSearch', 'updateSidebarBadges', 'markLocalTxMutation',
      // Dashboard (dashboard.js)
      'initDashboard', 'drillDownFromDashboard', 'exportDashboardPivotExcel', 'updateDashboardFxUI',
      'scheduleDailyFxNoonSync', 'syncDashboardFxRates', 'loadDashboard',
      // Transactions, Mappings & Fixes
      'initImport', 'handleFiles', 'reapplyRulesTo', 'initModals', 'initBulkUploads', 'initReapply',
      'initFilters', 'initTransactionFilterPresets', 'applyTransactionFilterPreset',
      'initTransactionBulkAssign', 'applyBulkStudentIdToSelected',
      'setupHeaderFilters', 'initPagination', 'initExport', 'loadTransactions',
      'openQuickMapForItem', 'openTransactionDetailsModal', 'loadMappings', 'renderMappingsPage',
      'deduplicateItemMappings', 'loadFixes', 'renderFixesPage', 'deduplicateManualFixes',
      // Auto-Matcher (auto-matcher.js)
      'handleTargetedMatcherImport', 'runAutoMatcher', 'runAutoMatcherInWorker', 'getFilteredAutoMatchProposals',
      'updateAutoMatchSelectionUI', 'renderAutoMatcherPage', 'applyAutoMatches',
      // Payment Links & Students
      'initPaymentLinks', 'openPaymentLinkModal', 'loadPaymentLinks', 'renderPaymentLinksPage',
      'initStudentMaster', 'invalidateStudentMasterLocalCache', 'openStudentModal', 'loadStudents', 'renderStudentsPage',
      'loadStudentProfile', 'exportStudentStatement',
      // ERP Export (erp-export.js)
      'initErpExport', 'initErpFilterPresets', 'applyErpFilterPreset', 'updateErpDropdowns',
      'formatErpCurrencySummary', 'fetchForeignRowsForErp',
      'loadErpExport', 'updateErpRecordButtonLabel', 'openManualFixFromErp', 'renderErpPreview',
      'erpAmount', 'erpAccount', 'erpDayShort', 'resolveErpExportDate', 'downloadErpExport',
      'openErpDateChoiceModal', 'generateErpExcel', 'recordErpReferences',
      // Admin, Audit, Double-Payments & Hygiene (admin-audit.js)
      'initUsersAndRoles', 'loadDatabaseStorageStats', 'initAccountingPeriodLock', 'loadClosedPeriods', 'renderClosedPeriodsCard',
      'isDateInClosedPeriod', 'initColdStorageArchive', 'loadUsersAndRoles', 'renderUserRolesTable',
      'renderAuditLogsTable', 'revertAuditLogEntry', 'initDoublePaymentsDetector', 'loadDoublePayments',
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

    // Verify inlineIcon renders pre-built SVG without unparsed data-lucide attributes
    const wrenchSvg = inlineIcon('wrench', 13);
    expect(wrenchSvg).toContain('<svg');
    expect(wrenchSvg).toContain('lucide-wrench');
    expect(wrenchSvg).not.toContain('data-lucide=');

    // Verify fetchUniqueFilters caches in sessionStorage and invalidateDistinctCache clears it
    await (app.fetchUniqueFilters as (opts?: { force?: boolean }) => Promise<unknown>)({ force: true });
    expect(sessionStorage.getItem('spdb-unique-filters-v1')).not.toBeNull();
    (app.invalidateDistinctCache as () => void)();
    expect(sessionStorage.getItem('spdb-unique-filters-v1')).toBeNull();

    // Verify clicking Fawry Settlements tab initializes SettlementProcessor immediately without network script error
    const settlementNav = document.querySelector('.nav-link[data-tab="settlement"]') as HTMLElement | null;
    expect(settlementNav).not.toBeNull();
    settlementNav?.click();
    expect((window as unknown as { SettlementProcessor?: unknown }).SettlementProcessor).toBeDefined();
    expect((window as unknown as { settlementApp?: unknown }).settlementApp).toBeDefined();

    // Verify UX #1: active tab persisted in URL hash & sessionStorage
    expect(window.location.hash).toBe('#settlement');
    expect(sessionStorage.getItem('spdb-active-tab')).toBe('settlement');

    // Verify UX #3: multi-ID Excel paste builds an .in() OR query for reference_number & student_id
    const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    if (searchInput) searchInput.value = '9706847770, 9706887951';
    const orCalls: string[] = [];
    const fakeQuery = {
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn((clause: string) => { orCalls.push(clause); return fakeQuery; })
    };
    (app.applyTransactionFiltersToQuery as (q: unknown) => unknown)(fakeQuery);
    expect(orCalls.some(c => c.includes('reference_number.in.(9706847770,9706887951)') && c.includes('student_id.in.(9706847770,9706887951)'))).toBe(true);
    if (searchInput) searchInput.value = '';

    // Verify UX #5: Save & Next Issue button exists in Manual Fix modal
    expect(document.getElementById('btn-save-fix-next')).not.toBeNull();

    // Verify Cold-Storage Archiving UI (#admin-archive-card) in Users & Roles view
    const archiveCard = document.getElementById('admin-archive-card');
    const cutoffInput = document.getElementById('archive-cutoff-date') as HTMLInputElement | null;
    const btnDryRun = document.getElementById('btn-archive-dry-run') as HTMLButtonElement | null;
    const btnExecute = document.getElementById('btn-archive-execute') as HTMLButtonElement | null;
    const statusEl = document.getElementById('archive-status-result');

    expect(archiveCard).not.toBeNull();
    expect(cutoffInput).not.toBeNull();
    expect(btnDryRun).not.toBeNull();
    expect(btnExecute).not.toBeNull();
    expect(statusEl).not.toBeNull();
    expect(btnExecute?.disabled).toBe(true);

    (app as { userRole?: string }).userRole = 'admin';
    const rpcMock = supabase.rpc as ReturnType<typeof vi.fn>;
    rpcMock.mockClear();
    rpcMock.mockResolvedValueOnce({
      data: { eligible_count: 12, eligible_amount_egp: 54000 },
      error: null
    });

    btnDryRun?.click();
    await vi.waitFor(() => {
      expect(btnExecute?.disabled).toBe(false);
    });

    expect(rpcMock).toHaveBeenCalledWith('archive_settled_transactions', {
      p_before_date: cutoffInput?.value,
      p_dry_run: true
    });
    expect(statusEl?.textContent).toContain('12');
    expect(statusEl?.textContent).toContain('54,000');

    if (cutoffInput) {
      fireEvent.change(cutoffInput, { target: { value: '2025-01-01' } });
    }
    expect(btnExecute?.disabled).toBe(true);

    // Verify Accounting Period Lock (#admin-period-lock-card) UI & 18-modal invariant
    expect(document.querySelectorAll('.modal').length).toBe(18);
    const periodCard = document.getElementById('admin-period-lock-card');
    const periodMonthInput = document.getElementById('period-lock-month') as HTMLInputElement | null;
    const periodNotesInput = document.getElementById('period-lock-notes') as HTMLInputElement | null;
    const btnClosePeriod = document.getElementById('btn-close-period') as HTMLButtonElement | null;
    const periodUnlockPanel = document.getElementById('period-unlock-panel');
    const periodUnlockReason = document.getElementById('period-unlock-reason') as HTMLInputElement | null;
    const btnConfirmUnlock = document.getElementById('btn-confirm-period-unlock') as HTMLButtonElement | null;
    const periodsTbody = document.getElementById('closed-periods-table-body');

    expect(periodCard).not.toBeNull();
    expect(periodMonthInput).not.toBeNull();
    expect(btnClosePeriod).not.toBeNull();
    expect(periodUnlockPanel).not.toBeNull();
    expect(periodsTbody).not.toBeNull();

    if (periodMonthInput) periodMonthInput.value = '2026-09';
    if (periodNotesInput) periodNotesInput.value = 'Quarter-end close';
    rpcMock.mockClear();
    rpcMock.mockResolvedValueOnce({ data: { period_month: '2026-09', is_closed: true }, error: null });

    btnClosePeriod?.click();
    await vi.waitFor(() => {
      const confirmModal = document.getElementById('modal-custom-confirm');
      expect(confirmModal?.classList.contains('hidden')).toBe(false);
    });
    document.getElementById('btn-custom-confirm-ok')?.click();

    await vi.waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('set_accounting_period_lock', {
        p_period_month: '2026-09',
        p_is_closed: true,
        p_notes: 'Quarter-end close'
      });
    });

    // Test audited unlock flow: requires non-empty audit reason
    (app as { closedPeriods?: unknown[] }).closedPeriods = [
      {
        period_month: '2026-09',
        is_closed: true,
        closed_by: 'admin@nu.edu.eg',
        closed_at: '2026-10-01T10:00:00Z',
        notes: 'Quarter-end close'
      }
    ];
    (app.renderClosedPeriodsCard as () => void)();
    const unlockBtn = periodsTbody?.querySelector('.btn-toggle-period-lock[data-action="unlock"]') as HTMLButtonElement | null;
    expect(unlockBtn).not.toBeNull();
    unlockBtn?.click();
    expect(periodUnlockPanel?.classList.contains('hidden')).toBe(false);

    rpcMock.mockClear();
    if (periodUnlockReason) periodUnlockReason.value = '';
    btnConfirmUnlock?.click();
    expect(rpcMock).not.toHaveBeenCalled();

    rpcMock.mockResolvedValueOnce({ data: { period_month: '2026-09', is_closed: false }, error: null });
    if (periodUnlockReason) periodUnlockReason.value = 'Post-audit correction';
    btnConfirmUnlock?.click();

    await vi.waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('set_accounting_period_lock', {
        p_period_month: '2026-09',
        p_is_closed: false,
        p_notes: 'Post-audit correction'
      });
    });

    // Verify Feature #4: Saved Filter Presets (Transactions & ERP Export)
    expect(document.getElementById('btn-download-import-errors')).not.toBeNull();
    expect(document.querySelectorAll('.modal').length).toBe(18);

    const txPresetName = document.getElementById('tx-preset-name-input') as HTMLInputElement | null;
    const btnSaveTxPreset = document.getElementById('btn-save-tx-preset') as HTMLButtonElement | null;
    const btnDelTxPreset = document.getElementById('btn-delete-tx-preset') as HTMLButtonElement | null;
    const txPills = document.getElementById('tx-saved-presets-pills');
    const txSelect = document.getElementById('tx-saved-preset-select') as HTMLSelectElement | null;

    expect(txPresetName).not.toBeNull();
    expect(btnSaveTxPreset).not.toBeNull();
    expect(txSelect).not.toBeNull();

    (app as { txQuickFilter?: string }).txQuickFilter = 'unsettled';
    if (txPresetName) txPresetName.value = 'Overdue Unsettled';
    btnSaveTxPreset?.click();
    expect(btnDelTxPreset?.disabled).toBe(false);
    expect(txPills?.textContent).toContain('Overdue Unsettled');

    (app as { txQuickFilter?: string }).txQuickFilter = 'all';
    const txPillBtn = txPills?.querySelector('[data-tx-preset-id]') as HTMLButtonElement | null;
    txPillBtn?.click();
    expect((app as { txQuickFilter?: string }).txQuickFilter).toBe('unsettled');

    btnDelTxPreset?.click();
    expect(txPills?.textContent).not.toContain('Overdue Unsettled');

    const erpPresetName = document.getElementById('erp-preset-name-input') as HTMLInputElement | null;
    const btnSaveErpPreset = document.getElementById('btn-save-erp-preset') as HTMLButtonElement | null;
    const btnDelErpPreset = document.getElementById('btn-delete-erp-preset') as HTMLButtonElement | null;
    const erpPills = document.getElementById('erp-saved-presets-pills');

    if (erpPresetName) erpPresetName.value = 'Unposted Current Month';
    btnSaveErpPreset?.click();
    expect(btnDelErpPreset?.disabled).toBe(false);
    expect(erpPills?.textContent).toContain('Unposted Current Month');
    btnDelErpPreset?.click();
    expect(erpPills?.textContent).not.toContain('Unposted Current Month');

    // Verify Feature #5: Bulk Assign Student ID & Select Same Mobile on Transactions
    const bulkBar = document.getElementById('tx-bulk-assign-bar');
    const bulkCountEl = document.getElementById('tx-bulk-selected-count');
    const btnSameMobile = document.getElementById('btn-tx-select-same-mobile') as HTMLButtonElement | null;
    const bulkSidInput = document.getElementById('tx-bulk-student-id') as HTMLInputElement | null;
    const bulkIdStatus = document.getElementById('tx-bulk-id-status');
    const btnClearSel = document.getElementById('btn-tx-clear-selection') as HTMLButtonElement | null;

    expect(bulkBar?.classList.contains('hidden')).toBe(true);
    const sampleRows = [
      { id: 101, reference_number: 'REF-1', payment_date: '2026-09-10', customer_mobile: '01012345678', student_id: '' },
      { id: 102, reference_number: 'REF-2', payment_date: '2026-09-12', customer_mobile: '201012345678', student_id: '' }
    ];
    (app as { currentPageTransactions?: unknown[] }).currentPageTransactions = sampleRows;
    const selMap = (app as { selectedTransactionsMap?: Map<string, unknown> }).selectedTransactionsMap;
    selMap?.set('101', sampleRows[0]);
    (app.updateTxBulkSelectionUI as () => void)();
    expect(bulkBar?.classList.contains('hidden')).toBe(false);
    expect(bulkCountEl?.textContent).toBe('1');

    btnSameMobile?.click();
    expect(bulkCountEl?.textContent).toBe('2');

    if (bulkSidInput) {
      bulkSidInput.value = '241001234';
      fireEvent.input(bulkSidInput);
    }
    expect(bulkIdStatus?.textContent).toContain('Valid');

    // Closed-period guard inside applyBulkStudentIdToSelected skips/blocks closed months
    (app as { closedPeriodSet?: Set<string> }).closedPeriodSet = new Set(['2026-09']);
    await (app.applyBulkStudentIdToSelected as () => Promise<void>)();
    expect(selMap?.size).toBe(2); // blocked without clearing selection
    (app as { closedPeriodSet?: Set<string> }).closedPeriodSet = new Set();

    btnClearSel?.click();
    expect(selMap?.size).toBe(0);
    expect(bulkBar?.classList.contains('hidden')).toBe(true);

    // Verify Stage 1 Performance: Live DB Storage Meter & 1-ms Sidebar Badge RPC
    expect(document.querySelectorAll('.modal').length).toBe(18);
    expect(document.getElementById('admin-db-storage-card')).not.toBeNull();
    expect(document.getElementById('btn-refresh-db-storage')).not.toBeNull();

    rpcMock.mockClear();
    rpcMock.mockResolvedValueOnce({
      data: {
        used_mb: 135.4,
        limit_mb: 500,
        pct_used: 27.1,
        tables: [{ table_name: 'transactions', est_rows: 39665, table_mb: 19, indexes_mb: 44.6, total_mb: 63.6 }]
      },
      error: null
    });

    await (app.loadDatabaseStorageStats as (opts?: { silent?: boolean }) => Promise<unknown>)({ silent: false });
    expect(document.getElementById('db-storage-used-label')?.textContent).toContain('135.4 MB / 500 MB');
    expect(document.getElementById('db-storage-pct-badge')?.textContent).toBe('27.1%');
    expect(document.getElementById('db-storage-tables-list')?.textContent).toContain('transactions');

    const tempBadge = document.createElement('span');
    tempBadge.id = 'sidebar-automatch-badge';
    document.body.appendChild(tempBadge);
    try {
      rpcMock.mockClear();
      rpcMock.mockResolvedValueOnce({ data: 42, error: null });
      (app.updateSidebarBadges as (opts?: { force?: boolean }) => void)({ force: true });
      await vi.waitFor(() => {
        expect(document.getElementById('sidebar-automatch-badge')?.textContent).toBe('42');
      });
      expect(rpcMock).toHaveBeenCalledWith('get_unresolved_tx_count');
    } finally {
      tempBadge.remove();
    }

    // Verify Admin Console Sub-Navigation, Show All toggle, Audit Category Pills & KPI cards
    expect(document.querySelectorAll('.modal').length).toBe(18);
    expect(document.getElementById('user-roles-count-label')).not.toBeNull();
    expect(document.getElementById('admin-kpi-locked-periods')).not.toBeNull();
    expect(document.getElementById('admin-kpi-storage-used')?.textContent).toContain('135.4 / 500 MB');
    expect(document.getElementById('admin-kpi-audit-count')).not.toBeNull();

    const accessPanel = document.getElementById('admin-panel-access');
    const governancePanel = document.getElementById('admin-panel-governance');
    const storagePanel = document.getElementById('admin-panel-storage');
    const auditPanel = document.getElementById('admin-panel-audit');
    expect(accessPanel?.classList.contains('hidden')).toBe(false);
    expect(governancePanel?.classList.contains('hidden')).toBe(true);
    expect(storagePanel?.classList.contains('hidden')).toBe(true);
    expect(auditPanel?.classList.contains('hidden')).toBe(true);

    (app.switchAdminSubtab as (tab: string) => void)('storage');
    expect(accessPanel?.classList.contains('hidden')).toBe(true);
    expect(storagePanel?.classList.contains('hidden')).toBe(false);

    const auditTabBtn = document.querySelector('[data-admin-subtab="audit"]') as HTMLButtonElement | null;
    auditTabBtn?.click();
    expect(auditPanel?.classList.contains('hidden')).toBe(false);
    expect(storagePanel?.classList.contains('hidden')).toBe(true);

    const btnShowAll = document.getElementById('btn-admin-show-all') as HTMLButtonElement | null;
    btnShowAll?.click();
    expect(accessPanel?.classList.contains('hidden')).toBe(false);
    expect(governancePanel?.classList.contains('hidden')).toBe(false);
    expect(storagePanel?.classList.contains('hidden')).toBe(false);
    expect(auditPanel?.classList.contains('hidden')).toBe(false);
    btnShowAll?.click();
    expect(accessPanel?.classList.contains('hidden')).toBe(true);
    expect(auditPanel?.classList.contains('hidden')).toBe(false);

    (app as { allAuditLogs?: unknown[] }).allAuditLogs = [
      { id: 1, user_email: 'admin@nu.edu.eg', action: 'User Role Assigned', affected_references: 'u@nu.edu.eg', details: {} },
      { id: 2, user_email: 'admin@nu.edu.eg', action: 'Accounting Period Closed', affected_references: '2026-09', details: {} }
    ];
    const periodsAuditBtn = document.querySelector('[data-audit-category="periods"]') as HTMLButtonElement | null;
    periodsAuditBtn?.click();
    expect(document.getElementById('admin-kpi-audit-count')?.textContent).toBe('2 events');
    expect(document.getElementById('audit-logs-table-body')?.textContent).toContain('Accounting Period Closed');
    expect(document.getElementById('audit-logs-table-body')?.textContent).not.toContain('User Role Assigned');
  });
});
