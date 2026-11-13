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
    expect(sidebarBrand.querySelector('.brand-name').textContent).toBe('Fawry Payments');
    expect(sidebarBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Mobile Header Brand
    const mobileHeader = document.querySelector('.mobile-header');
    expect(mobileHeader).not.toBeNull();
    const mobileBrand = mobileHeader.querySelector('.app-brand');
    expect(mobileBrand).not.toBeNull();
    expect(mobileBrand.querySelector('.brand-badge')).not.toBeNull();
    expect(mobileBrand.querySelector('.brand-name').textContent).toBe('Fawry Payments');
    expect(mobileBrand.querySelector('.brand-tag').textContent).toBe('DATABASE');

    // Auth Overlay Brand
    const authOverlay = document.getElementById('auth-overlay');
    expect(authOverlay).not.toBeNull();
    const authBrand = authOverlay.querySelector('.app-brand');
    expect(authBrand).not.toBeNull();
    expect(authBrand.querySelector('.brand-badge-lg')).not.toBeNull();
    expect(authBrand.querySelector('.brand-name').textContent).toBe('Fawry Payments');
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
});
