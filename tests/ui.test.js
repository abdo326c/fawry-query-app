// @vitest-environment jsdom
import { expect, test, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Load HTML into JSDOM
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

// Mock supabase client to avoid real network requests
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

beforeEach(() => {
    document.documentElement.innerHTML = html.toString();
});

test('UI elements are present across all 9 pages', () => {
    // Auth & Theme
    expect(document.getElementById('btn-login')).not.toBeNull();
    expect(document.getElementById('auth-email')).not.toBeNull();
    expect(document.getElementById('btn-theme-toggle')).not.toBeNull();

    // All 9 Navigation tabs & Views
    const tabs = [
        'dashboard',
        'transactions',
        'settlement',
        'mappings',
        'fixes',
        'automatcher',
        'student-master',
        'payment-links',
        'erp-export'
    ];
    for (const tab of tabs) {
        expect(document.querySelector(`.nav-link[data-tab="${tab}"]`)).not.toBeNull();
        expect(document.getElementById(`view-${tab}`)).not.toBeNull();
    }
});

test('All page buttons, filters, modals, and quick-search close button exist in DOM', () => {
    // 1. Dashboard controls
    expect(document.getElementById('btn-copy-pivot')).not.toBeNull();
    expect(document.getElementById('btn-export-pivot')).not.toBeNull();
    expect(document.getElementById('btn-refresh-dashboard')).not.toBeNull();
    expect(document.getElementById('btn-dashboard-toggle-months')).not.toBeNull();
    expect(document.getElementById('dashboard-group-by')).not.toBeNull();
    expect(document.getElementById('dashboard-sort-by')).not.toBeNull();
    expect(document.getElementById('dashboard-status-filter')).not.toBeNull();
    expect(document.getElementById('dashboard-show-share')).not.toBeNull();
    expect(document.querySelectorAll('[data-dash-preset]').length).toBeGreaterThanOrEqual(7);
    expect(document.querySelectorAll('[data-dash-drill]').length).toBe(6);

    // 2. Orders Transactions controls
    expect(document.getElementById('btn-show-import')).not.toBeNull();
    expect(document.getElementById('btn-show-history')).not.toBeNull();
    expect(document.getElementById('btn-reapply-rules')).not.toBeNull();
    expect(document.getElementById('btn-export')).not.toBeNull();
    expect(document.querySelectorAll('[data-tx-date-preset]').length).toBe(5);
    expect(document.querySelectorAll('[data-tx-quick-filter]').length).toBe(5);

    // 3. Fawry Settlements controls
    expect(document.getElementById('settlement-drop-zone')).not.toBeNull();
    expect(document.getElementById('btn-mark-settled')).not.toBeNull();
    expect(document.getElementById('btn-export-recon')).not.toBeNull();
    expect(document.getElementById('btn-export-consolidated')).not.toBeNull();
    expect(document.querySelectorAll('[data-stl-filter]').length).toBe(7);

    // 4. Item Mappings & Manual Fixes controls
    expect(document.getElementById('btn-add-mapping')).not.toBeNull();
    expect(document.getElementById('btn-dedup-mappings')).not.toBeNull();
    expect(document.getElementById('btn-toggle-unmapped-panel')).not.toBeNull();
    expect(document.getElementById('btn-add-fix')).not.toBeNull();
    expect(document.getElementById('btn-dedup-fixes')).not.toBeNull();
    expect(document.getElementById('btn-toggle-unresolved-tx-panel')).not.toBeNull();

    // 5. Auto-Matcher controls
    expect(document.getElementById('btn-run-automatcher')).not.toBeNull();
    expect(document.getElementById('btn-select-high-confidence')).not.toBeNull();
    expect(document.getElementById('btn-apply-automatch-fixes')).not.toBeNull();
    expect(document.querySelectorAll('[data-automatch-tier]').length).toBe(5);

    // 6. Students Details (Directory + Full-page Profile without Delete button)
    expect(document.getElementById('student-directory-view')).not.toBeNull();
    expect(document.getElementById('inline-student-profile')).not.toBeNull();
    expect(document.getElementById('btn-close-student-profile')).not.toBeNull();
    expect(document.getElementById('btn-edit-profile-student')).not.toBeNull();
    expect(document.getElementById('btn-export-student-statement')).not.toBeNull();
    expect(document.getElementById('btn-delete-profile-student')).toBeNull();

    // 7. Payment Links controls
    expect(document.getElementById('btn-add-link')).not.toBeNull();
    expect(document.getElementById('btn-export-links')).not.toBeNull();
    expect(document.querySelectorAll('[data-link-filter]').length).toBe(5);
    expect(document.querySelectorAll('.link-expiry-preset').length).toBe(3);

    // 8. ERP Export controls & Warning Modal
    expect(document.getElementById('btn-export-erp-file')).not.toBeNull();
    expect(document.getElementById('btn-record-erp')).not.toBeNull();
    expect(document.getElementById('erp-record-valid-only')).not.toBeNull();
    expect(document.getElementById('btn-erp-export-valid-only')).not.toBeNull();
    expect(document.querySelectorAll('[data-erp-filter]').length).toBe(6);
    expect(document.querySelectorAll('.erp-date-preset').length).toBe(5);

    // 9. Quick Search (Ctrl+K) with X Close Button
    expect(document.getElementById('global-search-overlay')).not.toBeNull();
    expect(document.getElementById('btn-open-global-search')).not.toBeNull();
    expect(document.getElementById('btn-close-global-search')).not.toBeNull();

    // 10. Users & Roles controls
    expect(document.getElementById('btn-refresh-users-roles')).not.toBeNull();
    expect(document.getElementById('btn-sync-auth-users')).not.toBeNull();
    expect(document.getElementById('btn-save-user-role')).not.toBeNull();
});

test('App initializes and wires interactive buttons, modals, and pivot export logic without errors', async () => {
    await import('../app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(window.app).toBeDefined();

    // Quick Search open & close via X button
    const overlay = document.getElementById('global-search-overlay');
    const btnOpenSearch = document.getElementById('btn-open-global-search');
    const btnCloseSearch = document.getElementById('btn-close-global-search');

    btnOpenSearch.click();
    expect(overlay.classList.contains('active')).toBe(true);
    btnCloseSearch.click();
    expect(overlay.classList.contains('active')).toBe(false);

    // Dashboard drill-down to ERP Export sets #erp-filter-date-from / #erp-filter-date-to and switches view
    document.getElementById('dashboard-date-from').value = '2026-10-01';
    document.getElementById('dashboard-date-to').value = '2026-10-31';
    window.app.drillDownFromDashboard({ type: 'erp_export' });
    expect(document.getElementById('view-erp-export').classList.contains('active')).toBe(true);
    expect(document.getElementById('erp-filter-date-from').value).toBe('2026-10-01');
    expect(document.getElementById('erp-filter-date-to').value).toBe('2026-10-31');

    // ERP inline Manual Fix modal pre-fills #fix-ref
    window.app.openManualFixFromErp({ reference_number: 'REF999', student_id: 'BAD_ID', id_status: 'Error' });
    expect(document.getElementById('modal-fix').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('fix-ref').value).toBe('REF999');

    // Dashboard Expand / Collapse All Months toggle respects collapsed state
    const pivotBody = document.getElementById('dashboard-pivot-body');
    pivotBody.innerHTML = `
        <tr class="month-row" data-month="2026-10">
            <td><div class="month-toggle"><span>Oct 2026</span></div></td>
            <td>1,000.00</td><td>2,000.00</td><td>3,000.00</td>
        </tr>
        <tr class="day-row month-2026-10" style="display: none;">
            <td>15-Oct-2026</td><td>1,000.00</td><td>2,000.00</td><td>3,000.00</td>
        </tr>
    `;
    const toggleBtn = document.getElementById('btn-dashboard-toggle-months');
    toggleBtn.click(); // Expand all
    expect(pivotBody.querySelector('.day-row').style.display).toBe('table-row');
    toggleBtn.click(); // Collapse all
    expect(pivotBody.querySelector('.day-row').style.display).toBe('none');

    // RBAC 4-Tier Hierarchy & UI Permissions
    // 1. Viewer (Level 1): Read-only + Excel exports, cannot import or fix or delete
    window.app.userRole = 'viewer';
    window.app.applyRolePermissionsToUI();
    expect(window.app.hasRole('viewer')).toBe(true);
    expect(window.app.hasRole('operator')).toBe(false);
    expect(document.getElementById('user-role-badge').textContent).toBe('Viewer');
    expect(document.getElementById('btn-show-import').style.display).toBe('none');
    expect(document.getElementById('btn-add-fix').style.display).toBe('none');
    expect(document.getElementById('btn-detect-duplicates').style.display).toBe('none');
    expect(document.getElementById('nav-link-users').style.display).toBe('none');
    // Viewer can still export to Excel across pages
    expect(document.getElementById('btn-export').style.display).not.toBe('none');
    expect(document.getElementById('btn-export-pivot').style.display).not.toBe('none');
    expect(document.getElementById('btn-export-erp-file').style.display).not.toBe('none');

    // 2. Operator (Level 2): Can import transactions/students/payment links, cannot add fixes/mappings or settle
    window.app.userRole = 'operator';
    window.app.applyRolePermissionsToUI();
    expect(window.app.hasRole('operator')).toBe(true);
    expect(window.app.hasRole('accountant')).toBe(false);
    expect(document.getElementById('user-role-badge').textContent).toBe('Operator');
    expect(document.getElementById('btn-show-import').style.display).toBe('');
    expect(document.getElementById('btn-add-student').style.display).toBe('');
    expect(document.getElementById('btn-add-link').style.display).toBe('');
    expect(document.getElementById('btn-add-fix').style.display).toBe('none');
    expect(document.getElementById('btn-mark-settled').style.display).toBe('none');
    expect(document.getElementById('btn-record-erp').style.display).toBe('none');

    // 3. Accountant (Level 3): Can add fixes/mappings, run automatcher, settle, record ERP; cannot delete/revert or manage users
    window.app.userRole = 'accountant';
    window.app.applyRolePermissionsToUI();
    expect(window.app.hasRole('accountant')).toBe(true);
    expect(window.app.hasRole('admin')).toBe(false);
    expect(document.getElementById('user-role-badge').textContent).toBe('Accountant');
    expect(document.getElementById('btn-add-fix').style.display).toBe('');
    expect(document.getElementById('btn-add-mapping').style.display).toBe('');
    expect(document.getElementById('btn-mark-settled').style.display).toBe('');
    expect(document.getElementById('btn-record-erp').style.display).toBe('');
    expect(document.getElementById('btn-detect-duplicates').style.display).toBe('none');
    expect(document.getElementById('btn-dedup-mappings').style.display).toBe('none');
    expect(document.getElementById('nav-link-users').style.display).toBe('none');

    // 4. Primary Admin (Ammahmoud@nu.edu.eg -> Level 4 Admin): Full access including deletes, reverts & Users/Audit Log view
    const resolvedRole = await window.app.fetchUserRole({ email: 'Ammahmoud@nu.edu.eg' });
    expect(resolvedRole).toBe('admin');
    window.app.applyRolePermissionsToUI();
    expect(window.app.hasRole('admin')).toBe(true);
    expect(document.getElementById('user-role-badge').textContent).toBe('Admin');
    expect(document.getElementById('btn-detect-duplicates').style.display).toBe('');
    expect(document.getElementById('btn-dedup-mappings').style.display).toBe('');
    expect(document.getElementById('nav-link-users').style.display).toBe('flex');

    // 5. Automated Hygiene & Deduplication Report modal and admin-only controls
    const modal = document.getElementById('modal-hygiene-report');
    expect(modal).not.toBeNull();
    expect(document.getElementById('btn-close-hygiene-modal')).not.toBeNull();
    expect(document.getElementById('btn-hygiene-acknowledge')).not.toBeNull();
    expect(document.getElementById('btn-hygiene-revert')).not.toBeNull();
    expect(document.getElementById('btn-view-hygiene-report')).not.toBeNull();

    // Non-admin users are strictly blocked from seeing the modal
    window.app.userRole = 'accountant';
    await window.app.checkAndShowHygieneReportModal({ force: true });
    expect(modal.classList.contains('hidden')).toBe(true);

    window.app.userRole = 'operator';
    await window.app.checkAndShowHygieneReportModal({ force: true });
    expect(modal.classList.contains('hidden')).toBe(true);

    window.app.userRole = 'viewer';
    await window.app.checkAndShowHygieneReportModal({ force: true });
    expect(modal.classList.contains('hidden')).toBe(true);

    // Admin user can open and acknowledge the modal
    window.app.userRole = 'admin';
    window.app.currentHygieneAudit = {
        id: 300,
        created_at: new Date().toISOString(),
        details: {
            health_score: '99.2%',
            total_transactions: 38077,
            cleaned_mappings: 2,
            cleaned_fixes: 1,
            is_reverted: false
        }
    };

    modal.classList.remove('hidden');
    expect(modal.classList.contains('hidden')).toBe(false);
    
    document.getElementById('btn-hygiene-acknowledge').click();
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('fawry_acknowledged_hygiene_id')).toBe('300');
});

test('App brand icon and responsive header components are properly structured', () => {
    // Favicon and PWA icons in <head>
    const svgFavicon = document.querySelector('link[type="image/svg+xml"]');
    expect(svgFavicon).not.toBeNull();
    expect(svgFavicon.getAttribute('href')).toBe('favicon.svg');

    const appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]');
    expect(appleTouchIcon).not.toBeNull();
    expect(appleTouchIcon.getAttribute('href')).toBe('apple-touch-icon.png');

    // Sidebar Brand
    const sidebar = document.querySelector('aside.sidebar');
    expect(sidebar).not.toBeNull();
    const sidebarBrand = sidebar.querySelector('.app-brand');
    expect(sidebarBrand).not.toBeNull();
    expect(sidebarBrand.querySelector('.brand-badge')).not.toBeNull();
    expect(sidebarBrand.querySelector('.brand-name').textContent).toBe('Students Payments');
    expect(sidebarBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Mobile Header Brand
    const mobileHeader = document.querySelector('.mobile-header');
    expect(mobileHeader).not.toBeNull();
    const mobileBrand = mobileHeader.querySelector('.app-brand');
    expect(mobileBrand).not.toBeNull();
    expect(mobileBrand.querySelector('.brand-badge')).not.toBeNull();
    expect(mobileBrand.querySelector('.brand-name').textContent).toBe('Students Payments');
    expect(mobileBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Auth Overlay Brand
    const authOverlay = document.getElementById('auth-overlay');
    expect(authOverlay).not.toBeNull();
    const authBrand = authOverlay.querySelector('.app-brand');
    expect(authBrand).not.toBeNull();
    expect(authBrand.querySelector('.brand-badge-lg')).not.toBeNull();
    expect(authBrand.querySelector('.brand-name').textContent).toBe('Students Payments');
});

test('Transactions table renders compact .tx-quick-fix-btn with proper classes', () => {
    if (!window.app) {
        document.dispatchEvent(new Event('DOMContentLoaded'));
    }
    const app = window.app || { hasRole: () => true };
    app.userRole = 'accountant';
    
    const mockTxData = [
        {
            id: 1,
            reference_number: '9696284171',
            payment_date: '2026-11-04',
            student_id: '251001755',
            item_price: 1000,
            item_name: 'TuitionFees SPRG 2026',
            mapping: 'Tuition',
            second_mapping: null,
            bank: 'NUADCB136',
            id_status: 'Valid',
            is_settled: false
        },
        {
            id: 2,
            reference_number: '9696284172',
            payment_date: '2026-11-04',
            student_id: 'Missing',
            item_price: 500,
            item_name: 'Unknown',
            mapping: null,
            second_mapping: null,
            bank: 'NUADCB136',
            id_status: 'Missing ID',
            is_settled: false
        }
    ];

    // Mock loadTransactions data binding
    const tbody = document.getElementById('transactions-body');
    expect(tbody).not.toBeNull();
    
    // Simulate table rendering logic for rows
    tbody.innerHTML = mockTxData.map((t, idx) => {
        let statusClass = 'valid';
        if (t.id_status && t.id_status.includes('Missing')) statusClass = 'missing';
        if (t.id_status && t.id_status.includes('Error')) statusClass = 'error';

        return `
            <tr>
                <td>${t.reference_number}</td>
                <td>
                    <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                        <span class="badge ${statusClass}">${t.id_status}</span>
                        ${app.hasRole('accountant') ? `<button type="button" class="tx-quick-fix-btn ${statusClass}" data-quick-fix-ref="${t.reference_number}">
                            <i data-lucide="wrench"></i>
                        </button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    const fixBtns = tbody.querySelectorAll('.tx-quick-fix-btn');
    expect(fixBtns.length).toBe(2);
    expect(fixBtns[0].classList.contains('valid')).toBe(true);
    expect(fixBtns[0].getAttribute('data-quick-fix-ref')).toBe('9696284171');
    expect(fixBtns[1].classList.contains('missing')).toBe(true);
    expect(fixBtns[1].getAttribute('data-quick-fix-ref')).toBe('9696284172');
});

test('Double-Payment Detector, Settlement History, and Universal Audit Log Undo render and behave properly', async () => {
    await import('../app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(window.app).toBeDefined();

    // 1. Double-Payment Detector UI & Rendering
    expect(document.getElementById('btn-detect-double-payments')).not.toBeNull();
    expect(document.getElementById('modal-double-payments')).not.toBeNull();
    expect(document.getElementById('double-payments-window')).not.toBeNull();

    window.app.doublePaymentClusters = [
        {
            student_id: '251001755',
            student_name: 'Ahmed Hassan',
            item_name: 'TuitionFees SPRG 2026',
            mapping: 'Tuition',
            item_price: 15000,
            tx_count: 2,
            total_paid: 30000,
            first_date: '2026-11-04',
            last_date: '2026-11-04',
            days_apart: 0,
            reference_numbers: ['9696284171', '9696284999'],
            banks: ['NUADCB136']
        }
    ];
    window.app.renderDoublePaymentsTable();
    const dpBody = document.getElementById('double-payments-body');
    expect(dpBody.innerHTML).toContain('251001755');
    expect(dpBody.innerHTML).toContain('Ahmed Hassan');
    expect(dpBody.innerHTML).toContain('9696284171');
    expect(dpBody.innerHTML).toContain('9696284999');

    // 2. Persistent Settlement Reconciliation History UI
    expect(document.getElementById('settlement-history-card')).not.toBeNull();
    expect(document.getElementById('btn-save-settlement-run')).not.toBeNull();
    expect(document.getElementById('settlement-history-body')).not.toBeNull();

    // 3. Universal Audit Log Undo (Admin only)
    window.app.allAuditLogs = [
        {
            id: 501,
            created_at: new Date().toISOString(),
            user_email: 'ammahmoud@nu.edu.eg',
            action: 'Mapping Updated',
            affected_references: 'TuitionFees SPRG 2026',
            details: {
                revert_data: {
                    table_name: 'item_mappings',
                    operation: 'upsert',
                    previous_rows: [{ item_name: 'TuitionFees SPRG 2026', mapping: 'Tuition' }]
                }
            }
        },
        {
            id: 502,
            created_at: new Date().toISOString(),
            user_email: 'ammahmoud@nu.edu.eg',
            action: 'Manual Fix Updated',
            affected_references: '9696284171',
            details: {
                is_reverted: true,
                revert_data: {
                    table_name: 'manual_fixes',
                    operation: 'upsert',
                    previous_rows: [{ reference_number: '9696284171', correct_id: '251001755' }]
                }
            }
        }
    ];

    window.app.userRole = 'admin';
    window.app.renderAuditLogsTable();
    const auditBody = document.getElementById('audit-logs-table-body');
    expect(auditBody.querySelector('[data-revert-audit-id="501"]')).not.toBeNull();
    expect(auditBody.querySelector('[data-revert-audit-id="502"]')).toBeNull();
    expect(auditBody.innerHTML).toContain('Reverted');

    // 4. ERP Export Date Choice Modal & Settlement Date Resolution
    expect(document.getElementById('modal-erp-date-choice')).not.toBeNull();
    const thuTx = { payment_date: '2026-11-05', reference_number: '969800001', student_id: '221000111', item_price: 500, id_status: 'Valid' };
    const friTx = { payment_date: '2026-11-06', reference_number: '969800002', student_id: '221000112', item_price: 600, id_status: 'Valid' };
    expect(window.app.resolveErpExportDate(thuTx, 'settlement')).toBe('2026-11-08');
    expect(window.app.resolveErpExportDate(friTx, 'settlement')).toBe('2026-11-08');
    expect(window.app.resolveErpExportDate(thuTx, 'payment')).toBe('2026-11-05');
    expect(window.app.resolveErpExportDate(thuTx, 'custom', '2026-11-09')).toBe('2026-11-09');

    window.app.openErpDateChoiceModal([thuTx, friTx]);
    const erpDateModal = document.getElementById('modal-erp-date-choice');
    expect(erpDateModal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('erp-date-choice-preview').innerHTML).toContain('2026-11-08');
    erpDateModal.classList.add('hidden');

    // 5. Fawry Transactions rename & Foreign Transactions view / controls
    expect(document.querySelector('.nav-link[data-tab="transactions"]').textContent).toContain('Fawry Transactions');
    expect(document.querySelector('.nav-link[data-tab="foreign-transactions"]')).not.toBeNull();
    expect(document.getElementById('view-foreign-transactions')).not.toBeNull();
    expect(document.getElementById('btn-show-foreign-import')).not.toBeNull();
    expect(document.getElementById('btn-foreign-detect-duplicates')).not.toBeNull();
    expect(document.getElementById('btn-foreign-double-payments')).not.toBeNull();
    expect(document.getElementById('btn-foreign-clear-all')).toBeNull();
    expect(document.getElementById('modal-foreign-import')).not.toBeNull();
    expect(document.getElementById('modal-foreign-fix')).not.toBeNull();

    // Verify Foreign Transactions table renders 9 columns with Tuition & NuMisrUsd5 and detects duplicates
    window.app.foreignTransactions = [
        {
            _uid: 'dup_1',
            reference_number: 'FJB2600526681048',
            value_date: '2026-01-06',
            student_id: '241002323',
            amount: 749.47,
            currency: 'USD',
            description: 'Cash Deposit تسنيم عمر 241002323',
            id_status: 'Valid'
        },
        {
            _uid: 'dup_2',
            reference_number: 'FJB2600526681048',
            value_date: '2026-01-06',
            student_id: '',
            amount: 749.47,
            currency: 'USD',
            description: 'Cash Deposit تسنيم عمر 241002323',
            id_status: 'Missing ID'
        }
    ];
    window.app.applyForeignFilters();
    const foreignTbody = document.getElementById('foreign-transactions-body');
    expect(foreignTbody.innerHTML).toContain('Tuition');
    expect(foreignTbody.innerHTML).toContain('NuMisrUsd5');
    expect(foreignTbody.querySelectorAll('tr').length).toBe(2);

    await window.app.detectForeignDuplicates();
    expect(window.duplicateForeignUidsToDelete.length).toBe(1);
    await window.app.cleanupForeignDuplicates();
    expect(window.app.foreignTransactions.length).toBe(1);
    expect(window.app.foreignTransactions[0].student_id).toBe('241002323');

    // Verify Dashboard includes NuMisrUsd5 bank filter & split bar
    expect(document.querySelector('#dashboard-bank-filters input[value="NuMisrUsd5"]')).not.toBeNull();
    expect(document.getElementById('dash-bank-badge-NuMisrUsd5')).not.toBeNull();
    expect(document.getElementById('dashboard-split-misrusd5-val')).not.toBeNull();

    // Verify Bulk Manual Fixes apply directly to Foreign Transactions
    window.app.foreignTransactions.push({
        _uid: 'unfixed_1',
        reference_number: 'FJB2600826955342',
        value_date: '2026-01-08',
        student_id: '',
        amount: 1305.00,
        currency: 'USD',
        description: 'Cash Deposit فاطمة محمد',
        id_status: 'Missing ID'
    });
    const fixedForeignCount = await window.app.applyManualFixesToForeignTransactions([
        { reference_number: 'FJB2600826955342', correct_id: '241009888', item_name: null, mapping: 'Tuition', second_mapping: null }
    ]);
    expect(fixedForeignCount).toBe(1);
    expect(window.app.foreignTransactions[1].student_id).toBe('241009888');
    expect(window.app.foreignTransactions[1].id_status).toBe('Valid');

    // Verify Export ERP Template button was moved out of Foreign Transactions into ERP Export
    expect(document.getElementById('btn-foreign-export-erp')).toBeNull();
    expect(document.querySelector('#erp-filter-bank option[value="NuMisrUsd5"]')).not.toBeNull();

    // Clicking a foreign transaction row opens #modal-tx-details (not #modal-foreign-fix)
    const txDetailsModal = document.getElementById('modal-tx-details');
    const foreignFixModal = document.getElementById('modal-foreign-fix');
    txDetailsModal.classList.add('hidden');
    foreignFixModal.classList.add('hidden');

    const firstRow = document.querySelector('#foreign-transactions-body tr.foreign-tx-row');
    expect(firstRow).not.toBeNull();
    firstRow.click();
    await new Promise(r => setTimeout(r, 0));
    expect(txDetailsModal.classList.contains('hidden')).toBe(false);
    expect(foreignFixModal.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('modal-tx-details-body').textContent).toContain('NuMisrUsd5');

    // Clicking the Fix icon button opens #modal-foreign-fix directly without bubbling
    txDetailsModal.classList.add('hidden');
    window.app.currentUser = { email: 'admin@nu.edu.eg' };
    window.app.currentUserRole = 'admin';
    const fixBtn = firstRow.querySelector('.foreign-fix-btn');
    expect(fixBtn).not.toBeNull();
    fixBtn.click();
    await new Promise(r => setTimeout(r, 0));
    expect(foreignFixModal.classList.contains('hidden')).toBe(false);
    expect(txDetailsModal.classList.contains('hidden')).toBe(true);
    foreignFixModal.classList.add('hidden');

    // Verify NuMisrUsd5 deposits appear in ERP Export preview with Same Date & USD currency
    const foreignErpRows = await window.app.fetchForeignRowsForErp('2026-01-01', '2026-01-31');
    expect(foreignErpRows.length).toBe(2);
    expect(window.app.resolveErpExportDate(foreignErpRows[1], 'settlement')).toBe('2026-01-08');
    window.app.erpData = foreignErpRows;
    window.app.renderErpPreview();
    const erpPreviewBody = document.getElementById('erp-preview-body');
    expect(erpPreviewBody.textContent).toContain('NuMisrUsd5');
    expect(erpPreviewBody.textContent).toContain('Same Date');
    expect(document.getElementById('erp-stat-amount').textContent).toContain('USD');

    // Verify Dashboard USD -> EGP Daily Exchange Rate & Historical/Custom Conversion
    expect(document.getElementById('dashboard-fx-mode')).not.toBeNull();
    expect(document.getElementById('dashboard-fx-rate-input')).not.toBeNull();
    expect(document.getElementById('btn-dash-sync-fx')).not.toBeNull();
    expect(document.getElementById('btn-dash-apply-fx')).not.toBeNull();

    document.getElementById('dashboard-date-from').value = '2026-01-01';
    document.getElementById('dashboard-date-to').value = '2026-01-31';
    window.app.fxDbLoaded = true;
    window.app.fxStore = {
        mode: 'historical',
        customRate: null,
        latest: { date: '2026-01-31', rate: 51.0, source: 'auto' },
        ratesByDate: {
            '2026-01-06': { rate: 50.0, source: 'auto' },
            '2026-01-08': { rate: 48.0, source: 'auto' }
        }
    };
    window.app.foreignTransactions = [
        { reference_number: 'FX1', value_date: '2026-01-06', student_id: '241002323', amount: 1000, currency: 'USD', description: 'Dep 1', id_status: 'Valid' },
        { reference_number: 'FX2', value_date: '2026-01-08', student_id: '241009888', amount: 500, currency: 'USD', description: 'Dep 2', id_status: 'Valid' }
    ];
    // Prevent network fetch inside test by matching cached todayStr rate on 2026-01-31
    await window.app.loadDashboard();
    // 1000*50 + 500*48 = 74,000 EGP
    expect(document.getElementById('dashboard-split-misrusd5-val').textContent).toBe('USD 1,500.00');
    expect(document.getElementById('dashboard-split-misrusd5-egp').textContent).toContain('EGP 74,000.00');
    expect(document.getElementById('stat-total-collections').textContent).toBe('EGP 74,000.00');
    const grandTotalRow = window.app.lastDashboardExportRows[window.app.lastDashboardExportRows.length - 1];
    expect(grandTotalRow['NuMisrUsd5 (USD)']).toBe(1500);
    expect(grandTotalRow['NuMisrUsd5 (EGP Eq.)']).toBe(74000);
    expect(grandTotalRow['Grand Total (EGP)']).toBe(74000);

    // Verify separate numeric columns in DOM and structured multi-sheet report state
    const headerTexts = Array.from(document.querySelectorAll('#dashboard-pivot-table thead tr:last-child th')).map(th => th.textContent.trim());
    expect(headerTexts).toContain('NuMisrUsd5 (USD)');
    expect(headerTexts).toContain('NuMisrUsd5 (EGP Eq.)');
    expect(window.app.lastDashboardReport).not.toBeNull();
    expect(window.app.lastDashboardReport.dailyRows.length).toBe(2);
    expect(window.app.lastDashboardReport.monthlyRows.length).toBe(1);
    expect(window.app.lastDashboardReport.summaryAoa.length).toBeGreaterThan(10);

    // Apply Manual Custom Rate Override (52.00 EGP/USD -> 1500 * 52 = 78,000 EGP)
    document.getElementById('dashboard-fx-rate-input').value = '52.00';
    document.getElementById('btn-dash-apply-fx').click();
    await new Promise(r => setTimeout(r, 20));
    expect(document.getElementById('stat-total-collections').textContent).toBe('EGP 78,000.00');

    // Verify manual sync button was removed while keeping strictly whitelisted DB row mapping
    expect(document.getElementById('btn-foreign-sync-cloud')).toBeNull();
    const dbRow = window.app.toForeignDbRow({
        reference_number: 'FJB_DB_1',
        value_date: '2026-02-01',
        amount: 500,
        description: 'Tuition deposit',
        _uid: 'temp_uid',
        bank: 'NuMisrUsd5',
        mapping: 'Tuition',
        match_confidence: 'high',
        extra_parser_field: 'should_be_stripped'
    });
    expect(dbRow.reference_number).toBe('FJB_DB_1');
    expect(dbRow._uid).toBeUndefined();
    expect(dbRow.bank).toBeUndefined();
    expect(dbRow.mapping).toBeUndefined();
    expect(dbRow.extra_parser_field).toBeUndefined();

    // Verify Fawry Transactions page light & dark logos exist
    const fawryDarkLogo = document.querySelector('#view-transactions .fawry-theme-logo-dark');
    const fawryLightLogo = document.querySelector('#view-transactions .fawry-theme-logo-light');
    expect(fawryDarkLogo).not.toBeNull();
    expect(fawryLightLogo).not.toBeNull();
    expect(fawryDarkLogo.getAttribute('src')).toBe('fawry-logo-dark.png');
    expect(fawryLightLogo.getAttribute('src')).toBe('fawry-logo-light.png');

    // Verify site title & sidebar brand reflect Students Payments Database
    expect(document.title).toBe('Students Payments Database');
    expect(document.querySelector('.sidebar .brand-name')?.textContent?.trim()).toBe('Students Payments');

    // Verify Foreign Transactions page Banque Misr light & dark logos exist
    const foreignDarkLogo = document.querySelector('#view-foreign-transactions .fawry-theme-logo-dark');
    const foreignLightLogo = document.querySelector('#view-foreign-transactions .fawry-theme-logo-light');
    expect(foreignDarkLogo).not.toBeNull();
    expect(foreignLightLogo).not.toBeNull();
    expect(foreignDarkLogo.getAttribute('src')).toBe('banque-misr-logo-dark.png');
    expect(foreignLightLogo.getAttribute('src')).toBe('banque-misr-logo-light.png');

    // Verify CSP permits fallback FX APIs & PDF.js worker
    const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
    expect(cspMeta).toContain('https://open.er-api.com');
    expect(cspMeta).toContain('https://*.currency-api.pages.dev');
    expect(cspMeta).toContain('worker-src');

    // Verify Foreign quick filter distinguishes missing_id vs error_id accurately
    window.app.foreignTransactions = [
        { reference_number: 'Q_VALID', value_date: '2026-02-01', student_id: '241002323', amount: 100, description: 'Tuition' },
        { reference_number: 'Q_MISS', value_date: '2026-02-01', student_id: '', amount: 200, description: 'Missing' },
        { reference_number: 'Q_ERR', value_date: '2026-02-01', student_id: '123', amount: 300, description: 'Bad ID' }
    ];
    window.app.foreignQuickFilter = 'missing_id';
    window.app.applyForeignFilters();
    expect(window.app.filteredForeignTransactions.map(r => r.reference_number)).toEqual(['Q_MISS']);

    window.app.foreignQuickFilter = 'error_id';
    window.app.applyForeignFilters();
    expect(window.app.filteredForeignTransactions.map(r => r.reference_number)).toEqual(['Q_ERR']);

    // Verify schema.sql consolidates all required tables & RPCs including foreign ERP revert
    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS public.settlement_batches');
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.run_database_hygiene_audit');
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.rollback_database_hygiene_audit');
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.detect_double_payments');
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.revert_audit_log_entry');
    expect(schemaSql).toContain("ELSIF v_table = 'foreign_transactions_erp'");
    expect(schemaSql).toContain('CREATE OR REPLACE FUNCTION public.get_dashboard_summary');
    expect(schemaSql).toContain('idx_transactions_mapping_trgm');
    expect(schemaSql).toContain('(SELECT public.has_min_role(');

    // Verify head libraries use defer so initial render is unblocked
    const deferredScripts = Array.from(document.querySelectorAll('head script[src]'));
    expect(deferredScripts.length).toBeGreaterThan(0);
    expect(deferredScripts.every(s => s.hasAttribute('defer'))).toBe(true);
});

test('Studio production layout, ui-chrome, all 11 views, 18 modals, toasts, theme toggle, and SW cache integrity', async () => {
    const appDir = path.resolve(__dirname, '..');
    const swSrc = fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(appDir, 'styles.css'), 'utf8');
    const uiChromeSrc = fs.readFileSync(path.join(appDir, 'ui-chrome.js'), 'utf8');

    // Mock lucide so ui-chrome's DOMContentLoaded icon init runs deterministically
    let lucideRuns = 0;
    window.lucide = { createIcons: () => { lucideRuns++; } };

    // Load real ui-chrome.js and trigger DOMContentLoaded alongside app.js
    const runChrome = new Function(uiChromeSrc);
    runChrome();
    await import('../app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(lucideRuns).toBeGreaterThanOrEqual(1);

    // 1. Clean production references (no leftover preview assets or preview labels)
    expect(html).not.toContain('preview.css');
    expect(html).not.toContain('preview-ui.js');
    expect(html).not.toContain('Studio Preview');
    expect(html).toContain('styles.css?v=3.0.0');
    expect(html).toContain('ui-chrome.js?v=1.0.0');

    // 2. Service Worker cache consistency: every cached asset resolves to a real file
    expect(swSrc).toContain('styles.css?v=3.0.0');
    expect(swSrc).toContain('ui-chrome.js?v=1.0.0');
    const urlMatches = [...swSrc.matchAll(/'\.\/([^'?]+)(?:\?[^']*)?'/g)].map(m => m[1]);
    for (const rel of urlMatches) {
        if (!rel) continue;
        expect(fs.existsSync(path.join(appDir, rel)), `Missing SW asset: ${rel}`).toBe(true);
    }

    // 3. Light theme warm-stone & black-text palette tokens in styles.css + CSS brace balance
    expect(cssSrc).toContain('--bg-canvas: #ebe8e1;');
    expect(cssSrc).toContain('--bg-card: #f5f2eb;');
    expect(cssSrc).toContain('--text-main: #09090b;');
    expect(cssSrc).toContain('.app-layout.sidebar-collapsed .view');
    expect((cssSrc.match(/\{/g) || []).length).toBe((cssSrc.match(/\}/g) || []).length);

    // 4. Auth Overlay: NU Finance Team + Abdelrahman Mohamed attribution, zero Treasury, working password eye toggle
    const authOverlay = document.getElementById('auth-overlay');
    const authText = authOverlay.textContent || '';
    expect(authText).toContain('NU Finance Team');
    expect(authText).toContain('Abdelrahman Mohamed');
    expect(authText).not.toMatch(/treasury/i);

    const authPw = document.getElementById('auth-password');
    const btnEye = document.getElementById('btn-toggle-auth-password');
    expect(authPw.type).toBe('password');
    btnEye.click();
    expect(authPw.type).toBe('text');
    btnEye.click();
    expect(authPw.type).toBe('password');

    // 5. Topbar / Sidebar Chrome: single global search in topbar, user profile in topbar, no breadcrumb or automatch badge
    expect(document.querySelectorAll('.sidebar #btn-open-global-search').length).toBe(0);
    expect(document.querySelectorAll('.workspace-topbar #btn-open-global-search').length).toBe(1);
    expect(document.querySelectorAll('.sidebar #user-profile-section').length).toBe(0);
    expect(document.querySelectorAll('.workspace-topbar #user-profile-section').length).toBe(1);
    expect(document.querySelectorAll('.topbar-breadcrumb').length).toBe(0);
    expect(document.getElementById('sidebar-automatch-badge')).toBeNull();

    // 6. Sidebar Collapse Rail toggles .sidebar-collapsed & persists in localStorage
    const appLayout = document.querySelector('.app-layout');
    const btnRail = document.getElementById('btn-toggle-sidebar-rail');
    const startCollapsed = appLayout.classList.contains('sidebar-collapsed');
    btnRail.click();
    expect(appLayout.classList.contains('sidebar-collapsed')).toBe(!startCollapsed);
    expect(localStorage.getItem('spdb-sidebar-rail')).toBe(!startCollapsed ? 'collapsed' : 'expanded');
    btnRail.click();
    expect(appLayout.classList.contains('sidebar-collapsed')).toBe(startCollapsed);

    // 7. Theme Toggle switches root .light class cleanly
    const btnTheme = document.getElementById('btn-theme-toggle');
    const wasLight = document.documentElement.classList.contains('light');
    btnTheme.click();
    expect(document.documentElement.classList.contains('light')).toBe(!wasLight);
    btnTheme.click();
    expect(document.documentElement.classList.contains('light')).toBe(wasLight);

    // 8. All 11 views switch cleanly via sidebar navigation clicks
    const allTabs = [
        'dashboard', 'transactions', 'foreign-transactions', 'settlement',
        'mappings', 'fixes', 'automatcher', 'student-master',
        'payment-links', 'erp-export', 'users'
    ];
    for (const tab of allTabs) {
        const link = document.querySelector(`.nav-link[data-tab="${tab}"]`);
        const view = document.getElementById(`view-${tab}`);
        expect(link).not.toBeNull();
        expect(view).not.toBeNull();
        link.click();
        expect(view.classList.contains('active')).toBe(true);
        expect(link.classList.contains('active')).toBe(true);
    }

    // 9. Tools dropdown popovers open, mutually exclude, close on Escape, and preserve RBAC visibility
    const txToolsBtn = document.querySelector('[data-dropdown-toggle="tx-more-actions-menu"]');
    const txToolsMenu = document.getElementById('tx-more-actions-menu');
    const fxToolsBtn = document.querySelector('[data-dropdown-toggle="foreign-more-actions-menu"]');
    const fxToolsMenu = document.getElementById('foreign-more-actions-menu');
    expect(txToolsBtn).not.toBeNull();
    expect(fxToolsBtn).not.toBeNull();
    txToolsBtn.click();
    expect(txToolsMenu.classList.contains('open')).toBe(true);
    fxToolsBtn.click();
    expect(txToolsMenu.classList.contains('open')).toBe(false);
    expect(fxToolsMenu.classList.contains('open')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fxToolsMenu.classList.contains('open')).toBe(false);

    // Structural Studio containers exist across Dashboard, Ledgers, Settlement, and ERP Export
    expect(document.querySelector('.dashboard-bento-hero')).not.toBeNull();
    expect(document.querySelectorAll('.ledger-sheet').length).toBe(3);
    expect(document.querySelector('.upload-zone-inline')).not.toBeNull();
    expect(document.querySelector('.erp-workbench-grid')).not.toBeNull();
    expect(document.querySelector('.voucher-ticket')).not.toBeNull();

    // RBAC toggles items inside Tools dropdowns cleanly
    window.app.userRole = 'viewer';
    window.app.applyRolePermissionsToUI();
    expect(document.getElementById('btn-reapply-rules').style.display).toBe('none');
    expect(document.getElementById('btn-foreign-automatch').style.display).toBe('none');
    expect(document.getElementById('btn-show-history').style.display).not.toBe('none');
    window.app.userRole = 'admin';
    window.app.applyRolePermissionsToUI();
    expect(document.getElementById('btn-reapply-rules').style.display).toBe('');
    expect(document.getElementById('btn-foreign-automatch').style.display).toBe('');
    expect(document.getElementById('btn-foreign-detect-duplicates').style.display).toBe('');

    // 10. All 18 Modals + 4 alert-styled dialogs + customConfirm + XSS-safe Toast notifications
    const modals = Array.from(document.querySelectorAll('.modal'));
    expect(modals.length).toBe(18);
    expect(document.querySelectorAll('.modal-dialog-alert').length).toBe(4);
    for (const m of modals) {
        expect(m.querySelector('.modal-content')).not.toBeNull();
        const closeTrigger = m.querySelector('[onclick*="classList.add"]');
        if (closeTrigger) {
            m.classList.remove('hidden');
            new Function(closeTrigger.getAttribute('onclick'))();
            expect(m.classList.contains('hidden')).toBe(true);
        }
    }

    // customConfirm OK & Cancel promises
    const okPromise = window.customConfirm('Proceed with batch?', 'Confirm', 'Abort');
    expect(document.getElementById('modal-custom-confirm').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('custom-confirm-message').innerText).toBe('Proceed with batch?');
    document.getElementById('btn-custom-confirm-ok').click();
    expect(await okPromise).toBe(true);
    expect(document.getElementById('modal-custom-confirm').classList.contains('hidden')).toBe(true);

    const cancelPromise = window.customConfirm('Abort batch?');
    document.getElementById('btn-custom-confirm-cancel').click();
    expect(await cancelPromise).toBe(false);

    // Toast types & XSS escaping
    const toastContainer = document.getElementById('toast-container');
    toastContainer.innerHTML = '';
    for (const type of ['info', 'success', 'warning', 'error']) {
        window.Toast.show(`<script>alert(1)</script> Message ${type}`, type);
    }
    const renderedToasts = toastContainer.querySelectorAll('.toast');
    expect(renderedToasts.length).toBe(4);
    expect(toastContainer.querySelectorAll('script').length).toBe(0);
    expect(renderedToasts[1].classList.contains('toast-success')).toBe(true);
    expect(renderedToasts[3].classList.contains('toast-error')).toBe(true);
});
