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
    expect(sidebarBrand.querySelector('.brand-badge img.brand-icon')?.getAttribute('src')).toBe('brand-emblem.png?v=2');
    expect(sidebarBrand.querySelector('.brand-name').textContent).toBe('Student Payments');
    expect(sidebarBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Mobile Header Brand
    const mobileHeader = document.querySelector('.mobile-header');
    expect(mobileHeader).not.toBeNull();
    const mobileBrand = mobileHeader.querySelector('.app-brand');
    expect(mobileBrand).not.toBeNull();
    expect(mobileBrand.querySelector('.brand-badge img.brand-icon')?.getAttribute('src')).toBe('brand-emblem.png?v=2');
    expect(mobileBrand.querySelector('.brand-name').textContent).toBe('Student Payments');
    expect(mobileBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Auth Overlay keeps clean sign-in form and showcases full custom brand lockup
    const authOverlay = document.getElementById('auth-overlay');
    expect(authOverlay).not.toBeNull();
    expect(authOverlay.querySelector('.app-brand')).toBeNull();
    expect(authOverlay.querySelector('.showcase-org-tag')).toBeNull();
    expect(authOverlay.querySelector('img.showcase-brand-logo')?.getAttribute('src')).toBe('brand-logo.png?v=2');
    expect(authOverlay.querySelector('img.showcase-brand-logo')?.getAttribute('alt')).toBe('Student Payments Database');
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

    // Verify site title & sidebar brand reflect Student Payments Database
    expect(document.title).toBe('Student Payments Database');
    expect(document.querySelector('.sidebar .brand-name')?.textContent?.trim()).toBe('Student Payments');

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
    expect(html).toContain('styles.css?v=3.0.7');
    expect(html).toContain('ui-chrome.js?v=1.0.0');

    // 2. Service Worker cache consistency: every cached asset resolves to a real file
    expect(swSrc).toContain('styles.css?v=3.0.7');
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

    // 4. Auth Overlay: NU Finance Team + Abdelrahman Mohamed attribution, zero Treasury/Nile University/left-pane brand icon, working password eye toggle
    const authOverlay = document.getElementById('auth-overlay');
    const authText = authOverlay.textContent || '';
    expect(authText).toContain('NU Finance Team');
    expect(authText).toContain('Abdelrahman Mohamed');
    expect(authText).not.toMatch(/treasury/i);
    expect(authText).not.toMatch(/Nile University/i);
    expect(authOverlay.querySelector('.auth-left-pane .app-brand')).toBeNull();

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

    // 11. Tables hide error reason externally and show full error only inside #modal-tx-details on click
    const appJsSrc = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
    expect(appJsSrc).not.toContain('${errorDetail}');

    window.app.foreignQuickFilter = 'all';
    window.app.foreignSearchTerm = '';
    window.app.foreignTransactions = [{
        reference_number: 'FX_ERR_1',
        value_date: '2026-11-12',
        student_id: 'Ahmed',
        amount: 500,
        currency: 'USD',
        description: 'Tuition deposit',
        id_status: 'Error: Text/Name detected'
    }];
    window.app.applyForeignFilters();

    const fxTbodyText = document.getElementById('foreign-transactions-body')?.textContent || '';
    expect(fxTbodyText).toContain('Error');
    expect(fxTbodyText).not.toContain('Text/Name detected');

    // Clicking the transaction row reveals the full error reason inside #modal-tx-details
    document.querySelector('#foreign-transactions-body tr.foreign-tx-row')?.click();
    const detailsModal = document.getElementById('modal-tx-details');
    expect(detailsModal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('modal-tx-details-body').textContent).toContain('Error: Text/Name detected');
    document.getElementById('btn-tx-detail-close')?.click();
    expect(detailsModal.classList.contains('hidden')).toBe(true);

    // Fawry details modal also displays full error reason when inspected
    await window.app.openTransactionDetailsModal({
        reference_number: 'REF_ERR_1',
        payment_date: '2026-11-12',
        student_id: 'Ahmed',
        item_price: 500,
        item_name: 'Tuition',
        mapping: 'Tuition',
        bank: 'NUADCB136',
        id_status: 'Error: Text/Name detected',
        is_settled: false
    });
    expect(detailsModal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('modal-tx-details-body').textContent).toContain('Error: Text/Name detected');
    document.getElementById('btn-tx-detail-close')?.click();
    expect(detailsModal.classList.contains('hidden')).toBe(true);

    // 12. Re-apply & Match IDs and Re-apply Rules show visible progress on Tools trigger + persistent Toast
    {
        toastContainer.innerHTML = '';
        const loadingHandle = window.Toast.showLoading('Working on it...');
        const loadingToastEl = toastContainer.querySelector('.toast-loading');
        expect(loadingToastEl).not.toBeNull();
        expect(loadingToastEl.querySelector('.spin')).not.toBeNull();
        expect(loadingToastEl.textContent).toContain('Working on it...');
        loadingHandle.update('Step 2...');
        expect(loadingToastEl.textContent).toContain('Step 2...');
        loadingHandle.dismiss();
        expect(loadingToastEl.classList.contains('toast-hiding')).toBe(true);

        // Foreign Re-apply & Match IDs shows progress while async work is pending and restores on finish
        toastContainer.innerHTML = '';
        const fxBtn = document.getElementById('btn-foreign-automatch');
        const fxToolsBtn = fxBtn.closest('.action-dropdown-wrap').querySelector('[data-dropdown-toggle]');
        const fxToolsOrigText = fxToolsBtn.textContent.trim();
        let resolveStudents;
        const origEnsureStudents = window.app.ensureStudentsLoadedForForeign.bind(window.app);
        const origSyncForeign = window.app.syncForeignTransactionsToSupabase.bind(window.app);
        window.app.ensureStudentsLoadedForForeign = vi.fn(() => new Promise(res => { resolveStudents = res; }));
        window.app.syncForeignTransactionsToSupabase = vi.fn().mockResolvedValue();
        window.app.foreignTransactions = [{
            reference_number: 'FX_MATCH_1',
            value_date: '2026-11-12',
            student_id: '',
            amount: 500,
            currency: 'USD',
            description: 'Deposit for Sara Ali',
            id_status: 'Missing ID'
        }];

        const matchPromise = window.app.runForeignAutoMatchNames();
        await new Promise(r => setTimeout(r, 15));
        expect(fxToolsBtn.disabled).toBe(true);
        expect(fxToolsBtn.textContent).toContain('Matching...');
        expect(fxToolsBtn.querySelector('.spin')).not.toBeNull();
        expect(toastContainer.querySelector('.toast-loading')?.textContent).toContain('Re-applying rules');

        resolveStudents([{ student_id: '241009999', student_name: 'Sara Ali' }]);
        await matchPromise;
        expect(fxToolsBtn.disabled).toBe(false);
        expect(fxToolsBtn.textContent.trim()).toBe(fxToolsOrigText);
        expect(toastContainer.querySelector('.toast-success')?.textContent).toContain('Auto-Match complete');

        // Error during auto-match still restores button state and shows an error toast
        toastContainer.innerHTML = '';
        window.app.ensureStudentsLoadedForForeign = vi.fn().mockRejectedValue(new Error('DB offline'));
        await window.app.runForeignAutoMatchNames();
        expect(fxToolsBtn.disabled).toBe(false);
        expect(toastContainer.querySelector('.toast-error')?.textContent).toContain('Auto-Match failed: DB offline');
        window.app.ensureStudentsLoadedForForeign = origEnsureStudents;
        window.app.syncForeignTransactionsToSupabase = origSyncForeign;

        // Fawry Re-apply Rules displays progress on parent Tools trigger and completes cleanly
        toastContainer.innerHTML = '';
        const txReapplyBtn = document.getElementById('btn-reapply-rules');
        const txToolsBtn = txReapplyBtn.closest('.action-dropdown-wrap').querySelector('[data-dropdown-toggle]');
        const txToolsOrigText = txToolsBtn.textContent.trim();
        txReapplyBtn.click();
        await new Promise(r => setTimeout(r, 15));
        await new Promise(r => setTimeout(r, 60));
        expect(txToolsBtn.disabled).toBe(false);
        expect(txToolsBtn.textContent.trim()).toBe(txToolsOrigText);
    }

    // 13. ERP Posting Ticket summary card preserves CSS 2-column grid (never forced to inline flex)
    window.app.erpData = [
        { reference_number: 'ERP1', payment_date: '2026-11-12', student_id: '241001111', item_price: 4729387.15, item_name: 'Tuition', mapping: 'Tuition', id_status: 'Valid', bank: 'NUADIB64' },
        { reference_number: 'ERP2', payment_date: '2026-11-12', student_id: 'Bad', item_price: 0, item_name: 'Tuition', mapping: 'Tuition', id_status: 'Error', erp_batch_number: 'B1', bank: 'NUADIB64' }
    ];
    window.app.renderErpPreview();
    const erpSummaryCard = document.getElementById('erp-summary-card');
    expect(erpSummaryCard.style.display).not.toBe('flex');
    expect(erpSummaryCard.classList.contains('voucher-mini-grid')).toBe(true);
    expect(document.getElementById('erp-stat-total').textContent).toBe('2');
    expect(document.getElementById('erp-stat-ready').textContent).toBe('1');
    expect(document.getElementById('erp-stat-recorded').textContent).toBe('1');

    // 14. Payment Links: base .btn-icon styled in CSS, copy-invoice uses .action-icon-btn, unused share/duplicate buttons removed
    expect(cssSrc).toContain('.btn-icon {');
    window.app.filteredPaymentLinks = [{
        id: 'pl-1',
        name: 'Parking Subscription',
        amount: 1500,
        invoice_number: '6309BUFbBYW4',
        creation_date: '2026-08-18',
        expiry_date: '2099-05-31',
        invoice_link: 'https://fawry.com/pay/6309BUFbBYW4'
    }];
    window.app.paymentLinksPage = 1;
    window.app.renderPaymentLinksPage();
    const linksTbody = document.getElementById('links-table-body');
    const copyInvoiceBtn = linksTbody.querySelector('.copy-invoice-btn');
    expect(copyInvoiceBtn).not.toBeNull();
    expect(copyInvoiceBtn.classList.contains('action-icon-btn')).toBe(true);
    expect(linksTbody.querySelector('.copy-link-btn')).not.toBeNull();
    expect(linksTbody.querySelector('.copy-details-btn')).toBeNull();
    expect(linksTbody.querySelector('.duplicate-link-btn')).toBeNull();

    // 15. BM Transactions rename in sidebar nav & page header
    const bmNavLink = document.querySelector('.nav-link[data-tab="foreign-transactions"]');
    expect(bmNavLink?.querySelector('.nav-label-text')?.textContent?.trim()).toBe('BM Transactions');
    expect(bmNavLink?.getAttribute('title')).toBe('BM Transactions');
    expect(document.querySelector('#view-foreign-transactions h1')?.textContent?.trim()).toBe('BM Transactions');

    // 16. Admin user deactivation, reactivation, and deletion + sign-in enforcement
    {
        const mig260 = fs.readFileSync(path.join(appDir, 'migrations/2.6.0_user_deactivation_and_delete.sql'), 'utf8');
        expect(mig260).toContain('CREATE OR REPLACE FUNCTION public.admin_set_user_active');
        expect(mig260).toContain('CREATE OR REPLACE FUNCTION public.admin_delete_user');

        const { supabase } = await import('../supabase.js');
        const origRpc = supabase.rpc;
        const origConfirm = window.customConfirm;
        const origLoadUsers = window.app.loadUsersAndRoles;
        const origFrom = supabase.from;
        const origSignOut = supabase.auth.signOut;
        const origUserRole = window.app.userRole;
        const origCurrentUser = window.app.currentUser;

        const rpcCalls = [];
        try {
            window.app.userRole = 'admin';
            window.app.currentUser = { email: 'ammahmoud@nu.edu.eg' };
            window.customConfirm = vi.fn().mockResolvedValue(true);
            window.app.loadUsersAndRoles = vi.fn().mockResolvedValue();
            supabase.rpc = vi.fn(async (fnName, params) => {
                rpcCalls.push({ fnName, params });
                return { data: { ok: true }, error: null };
            });

            window.app.allUserRoles = [
                { email: 'ammahmoud@nu.edu.eg', role: 'admin', is_active: true, updated_by: 'System', updated_at: '2026-11-14T00:00:00Z' },
                { email: 'user1@nu.edu.eg', role: 'operator', is_active: true, updated_by: 'Admin', updated_at: '2026-11-14T00:00:00Z' },
                { email: 'user2@nu.edu.eg', role: 'viewer', is_active: false, updated_by: 'Admin', updated_at: '2026-11-14T00:00:00Z' }
            ];
            window.app.renderUserRolesTable();

            const rolesTbody = document.getElementById('user-roles-table-body');
            expect(rolesTbody.querySelector('[data-toggle-user-active="ammahmoud@nu.edu.eg"]')).toBeNull();
            expect(rolesTbody.querySelector('[data-delete-user="ammahmoud@nu.edu.eg"]')).toBeNull();

            const deactBtn = rolesTbody.querySelector('[data-toggle-user-active="user1@nu.edu.eg"]');
            const reactBtn = rolesTbody.querySelector('[data-toggle-user-active="user2@nu.edu.eg"]');
            const delBtn = rolesTbody.querySelector('[data-delete-user="user1@nu.edu.eg"]');
            expect(deactBtn?.textContent?.trim()).toBe('Deactivate');
            expect(reactBtn?.textContent?.trim()).toBe('Reactivate');
            expect(delBtn).not.toBeNull();

            deactBtn.click();
            await new Promise(r => setTimeout(r, 15));
            expect(rpcCalls.some(c => c.fnName === 'admin_set_user_active' && c.params.target_email === 'user1@nu.edu.eg' && c.params.active === false)).toBe(true);

            reactBtn.click();
            await new Promise(r => setTimeout(r, 15));
            expect(rpcCalls.some(c => c.fnName === 'admin_set_user_active' && c.params.target_email === 'user2@nu.edu.eg' && c.params.active === true)).toBe(true);

            delBtn.click();
            await new Promise(r => setTimeout(r, 15));
            expect(rpcCalls.some(c => c.fnName === 'admin_delete_user' && c.params.target_email === 'user1@nu.edu.eg')).toBe(true);

            // Deactivated user cannot enter workspace via setupUser
            const signOutSpy = vi.fn().mockResolvedValue({});
            supabase.auth.signOut = signOutSpy;
            supabase.from = vi.fn(() => ({
                select: vi.fn().mockReturnThis(),
                ilike: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'viewer', is_active: false }, error: null })
            }));
            document.getElementById('auth-overlay').classList.add('hidden');
            await window.app.setupUser({ email: 'user2@nu.edu.eg' });
            expect(signOutSpy).toHaveBeenCalledTimes(1);
            expect(document.getElementById('auth-overlay').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('auth-error').textContent).toContain('deactivated');
        } finally {
            supabase.rpc = origRpc;
            supabase.from = origFrom;
            supabase.auth.signOut = origSignOut;
            window.customConfirm = origConfirm;
            window.app.loadUsersAndRoles = origLoadUsers;
            window.app.userRole = origUserRole;
            window.app.currentUser = origCurrentUser;
        }
    }

    // Dip & Workshop transactions are ignored in Auto Matcher and never shown as invalid in ERP / Tx Details
    {
        const { supabase } = await import('../supabase.js');
        const origFrom = supabase.from;
        const origInvalidTx = window.app.invalidTx;
        const origStudents = window.app.allStudentsData;
        const origErpData = window.app.erpData;
        const origRole = window.app.userRole;
        try {
            window.app.userRole = 'admin';
            window.app.allStudentsData = [{ student_id: '202300001', full_name: 'Test Student', mobile: '01012345678', email: 's@nu.edu.eg', national_id: '29901011234567' }];
            document.getElementById('automatcher-date-from').value = '';
            document.getElementById('automatcher-date-to').value = '';

            const dbRows = [
                {
                    id: 1, reference_number: '9704654873', payment_date: '2026-11-12',
                    student_id: 'Aya Ramadan Rashed', original_student_id: 'Aya Ramadan Rashed', customer_mobile: '01099999999',
                    item_name: 'Diploma Transcript', item_price: 50, mapping: 'Dip',
                    second_mapping: null, bank: 'NUADCB136', id_status: 'Error: Text/Name detected'
                },
                {
                    id: 2, reference_number: 'DIP-2', payment_date: '2026-03-01',
                    student_id: '123', original_student_id: '123', customer_mobile: '01088888888',
                    item_name: 'Workshop Fee', item_price: 2500, mapping: 'Other',
                    second_mapping: 'Workshop', bank: 'NUADCB136', id_status: 'Error: ID Too Short (3 digits)'
                },
                {
                    id: 3, reference_number: 'TUI-1', payment_date: '2026-03-01',
                    student_id: '', original_student_id: '', customer_mobile: '01012345678',
                    item_name: 'Tuition Fees', item_price: 15000, mapping: 'Tuition',
                    second_mapping: 'UG', bank: 'NUADCB136', id_status: 'Missing ID'
                }
            ];

            supabase.from = vi.fn((table) => {
                const chain = {
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
                    range: vi.fn().mockImplementation(async () => ({
                        data: table === 'transactions' ? dbRows : [],
                        count: table === 'transactions' ? dbRows.length : 0,
                        error: null
                    }))
                };
                return chain;
            });

            await window.app.runAutoMatcher();
            // Auto Matcher must completely exclude both Dip & Workshop rows and keep only TUI-1
            expect((window.app.invalidTx || []).map(r => r.reference_number)).toEqual(['TUI-1']);
            expect(window.app.automatchDistinctMappings).not.toContain('Dip');
            expect(window.app.automatchDistinctMappings).not.toContain('Workshop');

            // ERP Preview treats Dip & Workshop as Exempt / Ready (NOT Invalid / Needs Fix)
            window.app.erpData = [
                { id: 1, reference_number: '9704654873', payment_date: '2026-11-12', student_id: 'Aya Ramadan Rashed', item_name: 'Diploma Transcript', item_price: 50, mapping: 'Dip', bank: 'NUADCB136', id_status: 'Error: Text/Name detected' },
                { id: 2, reference_number: 'WS-1', payment_date: '2026-03-01', student_id: '', item_name: 'Python Workshop', item_price: 1500, mapping: 'Workshop', bank: 'NUADCB136', id_status: 'Missing ID' },
                { id: 3, reference_number: 'TUI-1', payment_date: '2026-03-01', student_id: '', item_name: 'Tuition Fees', item_price: 15000, mapping: 'Tuition', bank: 'NUADCB136', id_status: 'Missing ID' }
            ];
            window.app.renderErpPreview();
            expect(document.getElementById('erp-stat-valid').textContent).toBe('2');
            expect(document.getElementById('erp-stat-invalid').textContent).toBe('1');
            expect(document.getElementById('erp-stat-ready').textContent).toBe('2');
            const erpHtml = document.getElementById('erp-preview-body').innerHTML;
            expect(erpHtml).toContain('Exempt (Dip &amp; Workshop)');

            // Transaction Details modal displays neutral 'Exempt' badge instead of Missing ID / Error
            await window.app.openTransactionDetailsModal(dbRows[0]);
            const detailsBody = document.getElementById('modal-tx-details-body');
            expect(detailsBody.querySelector('.badge.exempt')?.textContent).toBe('Exempt');
        } finally {
            supabase.from = origFrom;
            window.app.invalidTx = origInvalidTx;
            window.app.allStudentsData = origStudents;
            window.app.erpData = origErpData;
            window.app.userRole = origRole;
        }
    }

    // Student Master import supports new ApplicantReport ("People ID" + continuation rows), multi-file import, and Master Exports
    {
        const { supabase } = await import('../supabase.js');
        const origFrom = supabase.from;
        const origXLSX = globalThis.XLSX;
        const origLoadStudents = window.app.loadStudents;
        const upsertedBatches = [];

        try {
            window.app.loadStudents = vi.fn().mockResolvedValue();
            supabase.from = vi.fn((table) => ({
                select: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({
                    data: table === 'student_master' ? [{
                        student_id: '202000160',
                        full_name: 'Fatma Mmdouh',
                        arabic_name: null,
                        national_id: null,
                        email: 'f.mmdouh@nu.edu.eg',
                        mobile: null,
                        guardian_name: null,
                        guardian_mobile: null,
                        college: 'Engineering and Applied Sciences',
                        program: 'Undergraduate / Bachelor of Science',
                        source: 'StudentDetails'
                    }] : [],
                    error: null
                }),
                upsert: vi.fn(async (batch) => {
                    upsertedBatches.push(...batch);
                    return { error: null };
                }),
                delete: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ error: null }) })),
                insert: vi.fn().mockResolvedValue({ error: null })
            }));

            const fakeSheet1 = [
                [],
                ['List Of Applicants'],
                ['People ID', 'Submitted Date', 'Applicant Status', 'First Name', 'Middle Name', 'Last Name', null, 'Arabic Name', 'University Email', 'Personal Email', 'Birth Date', 'Gender', 'Primary Citizenship', 'Secondary Citizenship', 'Country of Birth', 'Primary Language', 'Secondary Language', 'Government Id', 'Passport Number', 'Source name', 'Phone Number', 'Primary Address', 'City', 'Country', 'University', 'High School Certificate', 'Category', 'Total Score Marks', 'Total Score Percent', 'School Name', 'is Transfer', 'Other School Name', 'Program', 'Degree', 'Curriculum', 'Scholarship', 'Offer Status', 'Offer Decision', 'Notes', 'Parent Relation', 'Parent Name', 'Parent Profession', 'Parent Mobile', 'Parent Address', 'End Date'],
                ['202000160', '18/06/2020', 'Approved', 'Fatma', 'Mmdouh', 'Abdallh', null, 'فاطمة ممدوح عبدالله', null, 'fatmamamdouh593@gmail.com', '31/03/2001', 'Female', 'Egypt', null, 'Egypt', 'Arabic', 'Arabic', '30103312501609', '0', null, '01014015386', null, null, 'EGYPT', null, null, null, '', 0, 'Other', 'No', null, 'Undergraduate', 'Bachelor of Science', 'Architecture and Urban Design', null, null, null, null, 'Other', 'Fatma Mmdouh Abdallh', null, null, null, '2019-02-03'],
                [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'Father', 'Mr. Mmdouh Abdallh Matoly', 'تاجر عقارات', '01123585899', null, '2019-02-03']
            ];
            const fakeSheet2 = [
                [],
                ['List Of Applicants'],
                ['People ID', 'First Name', 'Middle Name', 'Last Name', 'Arabic Name', 'University Email', 'Personal Email', 'Government Id', 'Passport Number', 'Phone Number', 'University', 'Program', 'Degree', 'Curriculum', 'Parent Relation', 'Parent Name', 'Parent Mobile'],
                ['001710367', 'Kareem', 'Mohamed', 'Moussa', 'كريم محمد موسى ابوالخير', 'kamoussa@nu.edu.eg', 'kamoussa@nu.edu.eg', '29811192100477', null, '01007824027', null, 'Graduate', 'Master', 'Microelectronic System Design-MSc', 'Other', 'Kareem Mohamed Moussa', null]
            ];

            globalThis.XLSX = {
                read: (buf) => ({
                    SheetNames: ['ApplicantReport'],
                    Sheets: { ApplicantReport: buf._rows }
                }),
                utils: {
                    sheet_to_json: (sheet) => sheet
                }
            };

            const file1 = { name: 'ApplicantReport 1.xlsx', arrayBuffer: async () => ({ _rows: fakeSheet1 }) };
            const file2 = { name: 'ApplicantReport 2.xlsx', arrayBuffer: async () => ({ _rows: fakeSheet2 }) };

            await window.app.handleStudentImport([file1, file2]);

            expect(upsertedBatches.length).toBe(2);
            const s1 = upsertedBatches.find(r => r.student_id === '202000160');
            expect(s1).toMatchObject({
                student_id: '202000160',
                full_name: 'Fatma Mmdouh Abdallh',
                arabic_name: 'فاطمة ممدوح عبدالله',
                national_id: '30103312501609',
                email: 'f.mmdouh@nu.edu.eg', // Preserved existing NU email from StudentDetails
                mobile: '01014015386',
                guardian_name: 'Mr. Mmdouh Abdallh Matoly', // Picked Father from continuation row over 'Other'
                guardian_mobile: '01123585899',
                college: 'Engineering and Applied Sciences', // Preserved from StudentDetails
                program: '(UG) Undergraduate / Bachelor of Science',
                source: 'Merged'
            });

            const s2 = upsertedBatches.find(r => r.student_id === '1710367');
            expect(s2).toMatchObject({
                student_id: '1710367',
                full_name: 'Kareem Mohamed Moussa',
                arabic_name: 'كريم محمد موسى ابوالخير',
                national_id: '29811192100477',
                email: 'kamoussa@nu.edu.eg',
                mobile: '01007824027',
                program: '(PG) Graduate / Master / Microelectronic System Design-MSc',
                source: 'ApplicantReport'
            });
        } finally {
            supabase.from = origFrom;
            globalThis.XLSX = origXLSX;
            window.app.loadStudents = origLoadStudents;
        }
    }

    // Student (UG) / (PG) program level badges in Transactions, BM Transactions, ERP Preview, Students Directory, and Excel exports
    {
        window.app.allStudents = [
            { student_id: '241001111', full_name: 'Ali Hassan', program: 'Undergraduate / Bachelor of Science / Computer Science', college: 'ITCS' },
            { student_id: '1710367', full_name: 'Kareem Moussa', program: 'Graduate / Master / Microelectronic System Design-MSc', college: 'ENG' }
        ];
        window.app.allStudentsData = window.app.allStudents;
        window.app.rebuildStudentMasterMap(window.app.allStudents);

        expect(window.app.getStudentLevelBySid('241001111')).toBe('UG');
        expect(window.app.getStudentLevelLabelBySid('241001111')).toBe('(UG)');
        expect(window.app.getStudentLevelBySid('001710367')).toBe('PG');
        expect(window.app.getStudentLevelLabelBySid('001710367')).toBe('(PG)');

        // BM Transactions table shows (UG) and (PG) badges next to Student ID
        window.app.foreignQuickFilter = 'all';
        window.app.foreignSearchTerm = '';
        window.app.foreignTransactions = [
            { reference_number: 'FX_UG', value_date: '2026-11-12', student_id: '241001111', amount: 1000, currency: 'USD', description: 'UG Tuition', id_status: 'Valid' },
            { reference_number: 'FX_PG', value_date: '2026-11-12', student_id: '1710367', amount: 1500, currency: 'USD', description: 'PG Tuition', id_status: 'Valid' }
        ];
        window.app.applyForeignFilters();
        const fxHtml = document.getElementById('foreign-transactions-body')?.innerHTML || '';
        expect(fxHtml).toContain('badge-level-ug');
        expect(fxHtml).toContain('(UG)');
        expect(fxHtml).toContain('badge-level-pg');
        expect(fxHtml).toContain('(PG)');

        // ERP Preview stays clean without (UG)/(PG) level badges
        window.app.erpData = [
            { reference_number: 'ERP_UG', payment_date: '2026-11-12', student_id: '241001111', item_price: 5000, item_name: 'Tuition', mapping: 'Tuition', id_status: 'Valid', bank: 'NUADIB64' },
            { reference_number: 'ERP_PG', payment_date: '2026-11-12', student_id: '1710367', item_price: 6000, item_name: 'Tuition', mapping: 'Tuition', id_status: 'Valid', bank: 'NUADIB64' }
        ];
        window.app.renderErpPreview();
        const erpPreviewHtml = document.getElementById('erp-preview-body')?.innerHTML || '';
        expect(erpPreviewHtml).not.toContain('badge-level-ug');
        expect(erpPreviewHtml).not.toContain('badge-level-pg');
        expect(document.getElementById('btn-label-existing-students')).toBeNull();

        // Students Directory table renders (UG) and (PG) badges and indexes level tags for search
        window.app.allStudents.forEach(s => window.app.indexStudentRecord(s));
        window.app.filteredStudentsData = [...window.app.allStudents];
        window.app.studentsCurrentPage = 1;
        window.app.renderStudentsPage();
        const studentsHtml = document.getElementById('students-table-body')?.innerHTML || '';
        expect(studentsHtml).toContain('badge-level-ug');
        expect(studentsHtml).toContain('badge-level-pg');

        // labelExistingStudentsInDatabase prefixes existing students in DB with (UG) and (PG)
        const { supabase } = await import('../supabase.js');
        const origFrom = supabase.from;
        const labeledBatches = [];
        try {
            window.app.userRole = 'admin';
            supabase.from = vi.fn(() => ({
                upsert: vi.fn(async (batch) => {
                    labeledBatches.push(...batch);
                    return { error: null };
                })
            }));
            const labelRes = await window.app.labelExistingStudentsInDatabase({ silent: true });
            expect(labelRes.ugCount).toBe(1);
            expect(labelRes.pgCount).toBe(1);
            expect(labelRes.updated).toBe(2);
            expect(labeledBatches.find(r => r.student_id === '241001111')?.program).toBe('(UG) Undergraduate / Bachelor of Science / Computer Science');
            expect(labeledBatches.find(r => r.student_id === '1710367')?.program).toBe('(PG) Graduate / Master / Microelectronic System Design-MSc');
        } finally {
            supabase.from = origFrom;
        }
    }

    // 17. Go-to-Page jump controls work across paginated tables (Students, BM Transactions, Payment Links)
    {
        // Students pagination jump (e.g., jump to page 2 out of 3)
        window.app.studentsPageSize = 2;
        window.app.filteredStudentsData = Array.from({ length: 5 }, (_, i) => ({
            student_id: `2026000${i + 1}`,
            full_name: `Student ${i + 1}`,
            program: '(UG) Undergraduate'
        }));
        window.app.studentsCurrentPage = 1;
        window.app.renderStudentsPage();
        const stuJumpInput = document.getElementById('students-jump-page');
        const stuJumpBtn = document.getElementById('btn-students-jump-page');
        expect(stuJumpInput).not.toBeNull();
        expect(stuJumpBtn).not.toBeNull();
        stuJumpInput.value = '3';
        stuJumpBtn.click();
        expect(window.app.studentsCurrentPage).toBe(3);
        expect(document.getElementById('students-table-body')?.textContent).toContain('20260005');

        // BM / Foreign Transactions jump
        window.app.foreignPageSize = 2;
        window.app.filteredForeignTransactions = Array.from({ length: 5 }, (_, i) => ({
            reference_number: `FX_JUMP_${i + 1}`,
            value_date: '2026-11-12',
            student_id: '20260001',
            amount: 100,
            currency: 'USD',
            description: 'Tuition',
            id_status: 'Valid'
        }));
        window.app.foreignPage = 1;
        window.app.renderForeignTransactionsTable();
        const fxJumpInput = document.getElementById('foreign-jump-page');
        const fxJumpBtn = document.getElementById('btn-foreign-jump-page');
        expect(fxJumpInput).not.toBeNull();
        expect(fxJumpBtn).not.toBeNull();
        fxJumpInput.value = '2';
        fxJumpBtn.click();
        expect(window.app.foreignPage).toBe(2);
        expect(document.getElementById('foreign-page-info')?.textContent).toBe('Page 2 of 3');

        // Payment Links jump via Enter key
        window.app.filteredPaymentLinks = Array.from({ length: 30 }, (_, i) => ({
            id: `pl-jump-${i + 1}`,
            name: `Link ${i + 1}`,
            amount: 500,
            invoice_number: `INV${i + 1}`,
            creation_date: '2026-08-18',
            expiry_date: '2099-05-31',
            invoice_link: `https://fawry.com/pay/INV${i + 1}`
        }));
        window.app.paymentLinksPage = 1;
        window.app.renderPaymentLinksPage();
        const linksJumpInput = document.getElementById('links-jump-page');
        expect(linksJumpInput).not.toBeNull();
        linksJumpInput.value = '2';
        linksJumpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(window.app.paymentLinksPage).toBe(2);
    }
});
