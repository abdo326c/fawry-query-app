// @vitest-environment jsdom
import { expect, test, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const appDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
const uiChromeSrc = fs.readFileSync(path.join(appDir, 'ui-chrome.js'), 'utf8');

vi.mock('../supabase.js', () => {
    const chain = () => {
        const q = {};
        for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'or', 'not', 'ilike', 'order', 'update', 'upsert', 'delete', 'is']) {
            q[m] = vi.fn(() => q);
        }
        q.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        q.range = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
        q.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        q.insert = vi.fn().mockResolvedValue({ data: null, error: null });
        q.then = (resolve) => resolve({ data: [], error: null });
        return q;
    };
    return {
        supabase: {
            auth: {
                getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
                onAuthStateChange: vi.fn(),
                signOut: vi.fn()
            },
            rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
            from: vi.fn(() => chain())
        }
    };
});

async function bootApp() {
    document.documentElement.innerHTML = html.toString();
    window.lucide = { createIcons: () => {} };
    new Function(uiChromeSrc)();
    await import('../app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    return window.app;
}

const open = (id) => document.getElementById(id).classList.remove('hidden');
const isOpen = (id) => !document.getElementById(id).classList.contains('hidden');
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

beforeEach(() => {
    vi.useRealTimers();
});

test('Escape closes only the topmost modal (z-index, then latest opened)', async () => {
    await bootApp();
    open('modal-tx-details'); // z 10020
    open('modal-fix');        // z 10025
    pressEscape();
    expect(isOpen('modal-fix')).toBe(false);
    expect(isOpen('modal-tx-details')).toBe(true);
    pressEscape();
    expect(isOpen('modal-tx-details')).toBe(false);

    // Same z-index: the most recently opened wins
    open('modal-student'); // z 10025
    open('modal-link');    // z 10025
    document.getElementById('modal-student').classList.add('hidden');
    await Promise.resolve(); // let the MutationObserver record the close
    open('modal-student');
    pressEscape();
    expect(isOpen('modal-student')).toBe(false);
    expect(isOpen('modal-link')).toBe(true);

    // × buttons route through the shared closeModal
    document.querySelector('#modal-link .btn-close').click();
    expect(isOpen('modal-link')).toBe(false);
}, 20000);

test('Fawry import window cannot be closed mid-import and always refreshes after an import', async () => {
    const app = await bootApp();
    const toast = document.getElementById('toast-container');
    toast.innerHTML = '';
    const loadSpy = vi.spyOn(app, 'loadTransactions').mockImplementation(() => {});

    open('modal-import');
    app.isImporting = true;
    pressEscape();
    document.querySelector('#modal-import .btn-close').click();
    document.getElementById('modal-import').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isOpen('modal-import')).toBe(true);
    expect(toast.textContent).toContain('Import in progress');

    // Import finished: closing with Escape (not Done) still runs the post-import refresh
    app.isImporting = false;
    app._importNeedsRefresh = true;
    expect(loadSpy).not.toHaveBeenCalled();
    pressEscape();
    expect(isOpen('modal-import')).toBe(false);
    const callsAfterImport = loadSpy.mock.calls.length;
    expect(callsAfterImport).toBeGreaterThan(0);

    // Reopen without importing and close: no refresh
    open('modal-import');
    window.closeModal('modal-import');
    expect(loadSpy.mock.calls.length).toBe(callsAfterImport);
}, 20000);

test('Global search Escape closes the search only, not the modal behind it', async () => {
    await bootApp();
    open('modal-tx-details');
    document.getElementById('btn-open-global-search').click();
    const overlay = document.getElementById('global-search-overlay');
    expect(overlay.classList.contains('active')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(overlay.classList.contains('active')).toBe(false);
    expect(isOpen('modal-tx-details')).toBe(true);
}, 20000);

test('Save & Next is accountant-only and Ctrl+Enter never clicks a hidden button', async () => {
    const app = await bootApp();
    app.userRole = 'viewer';
    app.applyRolePermissionsToUI();
    const nextBtn = document.getElementById('btn-save-fix-next');
    expect(nextBtn.style.display).toBe('none');

    const clickSpy = vi.fn();
    nextBtn.addEventListener('click', clickSpy);
    open('modal-fix');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(clickSpy).not.toHaveBeenCalled();
}, 20000);

test('Payment link Save ignores a second click while the first save is running', async () => {
    const app = await bootApp();
    const { supabase } = await import('../supabase.js');
    let resolveInsert;
    const insert = vi.fn(() => new Promise(r => { resolveInsert = r; }));
    const origFrom = supabase.from;
    supabase.from = vi.fn((table) => (table === 'payment_links' ? { insert } : origFrom(table)));
    vi.spyOn(app, 'logAudit').mockResolvedValue();
    vi.spyOn(app, 'loadPaymentLinks').mockImplementation(() => {});
    try {
        open('modal-link');
        document.getElementById('link-id').value = '';
        document.getElementById('link-name').value = 'Tuition';
        document.getElementById('link-url').value = 'https://example.test/pay/ABC123';
        const btn = document.getElementById('btn-save-link');
        btn.click();
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); // even if disabled-state is bypassed
        expect(insert).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(true);
        resolveInsert({ error: null });
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(btn.disabled).toBe(false);
    } finally {
        supabase.from = origFrom;
    }
}, 20000);

test('Malformed URL hash does not throw when restoring the tab', async () => {
    const app = await bootApp();
    window.location.hash = '#"]bad';
    expect(() => app.restoreActiveTabFromUrl()).not.toThrow();
    expect(app.findNavLinkForTab('"]bad')).toBeNull();
    expect(app.findNavLinkForTab('dashboard')).not.toBeNull();
    window.location.hash = '';
}, 20000);

test('Toast durations: errors/warnings 8s with a close button, success/info 3s; shared date formatter', async () => {
    const { Toast, TOAST_DURATIONS, formatDateTime } = await import('../app-utils.js');
    expect(TOAST_DURATIONS.error).toBe(8000);
    expect(TOAST_DURATIONS.warning).toBe(8000);
    expect(TOAST_DURATIONS.success).toBe(3000);
    expect(TOAST_DURATIONS.info).toBe(3000);

    document.documentElement.innerHTML = html.toString();
    vi.useFakeTimers();
    const container = document.getElementById('toast-container');
    container.innerHTML = '';
    Toast.show('ok', 'success');
    Toast.show('bad', 'error');
    vi.advanceTimersByTime(3100);
    expect(container.querySelector('.toast-success')?.classList.contains('toast-hiding')).toBe(true);
    expect(container.querySelector('.toast-error').classList.contains('toast-hiding')).toBe(false);
    container.querySelector('.toast-error .toast-close').click();
    expect(container.querySelector('.toast-error').classList.contains('toast-hiding')).toBe(true);
    vi.useRealTimers();

    expect(formatDateTime(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05 09:07');
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('garbage', '—')).toBe('—');
});

test('Multi-ID paste beyond 150 IDs warns instead of truncating silently', async () => {
    const app = await bootApp();
    const container = document.getElementById('toast-container');
    container.innerHTML = '';
    const ids = Array.from({ length: 160 }, (_, i) => `REF${1000 + i}`).join(', ');
    document.getElementById('search-input').value = ids;
    const q = {};
    for (const m of ['or', 'in', 'eq', 'gte', 'lte', 'neq', 'ilike', 'not', 'is']) q[m] = vi.fn(() => q);
    app.applyTransactionFiltersToQuery(q);
    expect(container.textContent).toContain('Only the first 150 of 160 IDs were searched');
}, 20000);

test('Strict CSP uses self-hosted vendor scripts with zero supabase.co or unsafe-inline script-src', () => {
    const reactHtml = fs.readFileSync(path.resolve(__dirname, '../react.html'), 'utf8');
    for (const doc of [html, reactHtml]) {
        expect(doc).toContain("script-src 'self';");
        expect(doc).not.toContain('supabase.co');
        expect(doc).not.toContain('cdn.sheetjs.com');
        expect(doc).not.toContain('cdnjs.cloudflare.com');
        expect(doc).toContain('vendor/lucide.min.js');
    }
    expect(html).not.toMatch(/\sonclick="/);
});

test('Deep-link hash routing, selected rows sum, drawer prev/next nav, and Morning Checklist work together', async () => {
    const app = await bootApp();

    // 1. Deep-link route parsing & building
    const parsed = app.parseHashRoute('#transactions?q=231000123&qf=unmapped');
    expect(parsed.tab).toBe('transactions');
    expect(parsed.params.get('q')).toBe('231000123');
    expect(parsed.params.get('qf')).toBe('unmapped');
    app.applyRouteParams('transactions', parsed.params);
    expect(document.getElementById('search-input').value).toBe('231000123');
    expect(app.txQuickFilter).toBe('unmapped');
    expect(app.buildCurrentRouteHash('transactions')).toContain('q=231000123');

    // 2. Selected rows live EGP sum
    app.selectedTransactionsMap.set('1', { id: 1, item_price: 1250.5 });
    app.selectedTransactionsMap.set('2', { id: 2, item_price: 749.5 });
    app.updateTxBulkSelectionUI();
    expect(document.getElementById('tx-bulk-selected-count').textContent).toBe('2');
    expect(document.getElementById('tx-bulk-selected-sum').textContent).toBe('EGP 2,000.00');

    // 3. Side-by-side detail drawer Prev/Next navigation
    const rows = [
        { id: 1, reference_number: 'R1', student_id: '231000123', item_price: 100, item_name: 'Tuition', id_status: 'Valid' },
        { id: 2, reference_number: 'R2', student_id: '231000124', item_price: 200, item_name: 'Bus', id_status: 'Valid' }
    ];
    await app.openTransactionDetailsModal(rows[0], { list: rows, index: 0 });
    expect(document.getElementById('modal-tx-details').classList.contains('modal-drawer')).toBe(true);
    expect(document.getElementById('btn-tx-detail-prev').disabled).toBe(true);
    expect(document.getElementById('btn-tx-detail-next').disabled).toBe(false);
    expect(document.getElementById('tx-detail-position').textContent).toBe('1 / 2');
    document.getElementById('btn-tx-detail-next').click();
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('tx-detail-position').textContent).toBe('2 / 2');
    expect(document.getElementById('modal-tx-details-body').textContent).toContain('R2');

    // 4. Morning checklist renders RPC counts & routes on click
    const { supabase } = await import('../supabase.js');
    const origRpc = supabase.rpc;
    supabase.rpc = vi.fn().mockResolvedValue({
        data: {
            unresolved_fawry_count: 5,
            unresolved_foreign_count: 2,
            unmapped_fawry_count: 3,
            unmapped_distinct_items: 2,
            unsettled_fawry_count: 4,
            unsettled_fawry_egp: 1500,
            erp_ready_count: 9
        },
        error: null
    });
    try {
        await app.loadMorningChecklist();
        expect(document.getElementById('checklist-invalid-val').textContent).toBe('7 need fix');
        expect(document.getElementById('checklist-unmapped-val').textContent).toBe('2 item(s)');
        expect(document.getElementById('checklist-erp-val').textContent).toBe('9 ready');
    } finally {
        supabase.rpc = origRpc;
    }
}, 20000);
