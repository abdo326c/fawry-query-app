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
});
