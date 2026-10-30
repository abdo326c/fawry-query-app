import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';
import {
    validateID,
    fetchAll,
    fetchByIn,
    recomputeTransactions,
    updateRuleFields,
    diffTransaction,
    buildMappingLookup,
    normalizeItemName,
    originalItemName,
    isLockedTransaction,
    escapeHTML,
    toDateOnly,
    dateToExcelSerial
} from './rules.js';

// Helper to run async task functions with bounded concurrency
async function runConcurrent(tasks, concurrency = 4) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
        results.push(...batch);
    }
    return results;
}

// Promise-based confirm dialog using the in-page modal
window.customConfirm = function(message, okText = 'OK', cancelText = 'Cancel') {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-custom-confirm');
        const msgEl = document.getElementById('custom-confirm-message');
        const btnOk = document.getElementById('btn-custom-confirm-ok');
        const btnCancel = document.getElementById('btn-custom-confirm-cancel');
        
        msgEl.innerText = message;
        btnOk.innerText = okText;
        btnCancel.innerText = cancelText;
        
        const cleanup = () => {
            modal.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            window.removeEventListener('keydown', onKeyDown);
        };
        
        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onCancel();
            }
        };
        
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        window.addEventListener('keydown', onKeyDown);
        
        modal.classList.remove('hidden');
    });
};

window.escapeHTML = escapeHTML;

// Shared utility: format money
function formatMoney(num) {
    return parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shared utility: sanitize user input for Supabase .or() filter strings
function sanitizeForFilter(str) {
    if (!str) return '';
    return String(str).replace(/[,)(%\\"*]/g, '').trim();
}

class Toast {
    static show(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        let iconName = 'info';
        if (type === 'success') iconName = 'check-circle';
        if (type === 'error') iconName = 'alert-circle';
        if (type === 'warning') iconName = 'alert-triangle';
        
        toast.innerHTML = `
            <i data-lucide="${iconName}" class="toast-icon"></i>
            <div class="toast-content">${escapeHTML(msg)}</div>
        `;
        
        container.appendChild(toast);
        if (window.lucide) lucide.createIcons({ root: toast });
        
        setTimeout(() => {
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Export it so csv-processor can use it if needed, or attach to window
window.Toast = Toast;

class App {
    constructor() {
        this.currentUser = null;
        this.currentPage = 1;
        this.pageSize = 10;
        
        this.headerFilters = {
            transactions: {},
            automatch: {}
        };
        this.uniqueLists = { mapping: [], item_name: [] };
        this.automatchDistinctMappings = [];
        this.automatchDistinctItems = [];
        this.invalidTx = [];
        this.currentProfileStudent = null;
        
        this.isImporting = false;
        this.initTheme();
        this.initDatePickers();

        this.initNavigation();
        this.initGlobalSearch();
        this.setupPrintButton();
        this.initImport();
        this.initModals();
        this.initBulkUploads();
        this.initFilters();
        this.initPagination();
        this.initExport();
        this.initReapply();
        this.initPaymentLinks();
        this.initErpExport();
        this.initDashboard();
        this.initStudentMaster();
        this.initHistory();
        this.initAuth();
    }

    async initAuth() {
        // Handle Session State
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            this.setupUser(session.user);
        }

        supabase.auth.onAuthStateChange((event, session) => {
            if (session) {
                if (!this.currentUser || this.currentUser.id !== session.user.id) {
                    this.setupUser(session.user);
                }
            } else if (event === 'SIGNED_OUT') {
                this.currentUser = null;
                document.getElementById('auth-overlay').classList.remove('hidden');
                document.getElementById('user-profile-section').style.display = 'none';
                if (this.realtimeChannel) {
                    supabase.removeChannel(this.realtimeChannel);
                    this.realtimeChannel = null;
                }
                this.allTransactions = [];
                this.allMappings = [];
                this.allManualFixes = [];
                this.allStudents = [];
            }
        });

        // Form Submission
        document.getElementById('auth-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('auth-email').value;
            const pass = document.getElementById('auth-password').value;
            const btn = document.getElementById('btn-login');
            const errDiv = document.getElementById('auth-error');
            
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Signing in...';
            btn.disabled = true;
            errDiv.style.display = 'none';
            
            const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
            if (error) {
                errDiv.innerText = error.message;
                errDiv.style.display = 'block';
                btn.innerHTML = '<i data-lucide="log-in"></i> Sign In';
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            } else {
                Toast.show('Successfully signed in', 'success');
                btn.innerHTML = '<i data-lucide="log-in"></i> Sign In';
                btn.disabled = false;
            }
        });

        // Logout
        document.getElementById('btn-logout').addEventListener('click', async () => {
            await supabase.auth.signOut();
            Toast.show('Signed out', 'info');
        });
    }

    setupUser(user) {
        this.currentUser = user;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('user-profile-section').style.display = 'flex';
        document.getElementById('user-email-display').innerText = user.email;
        this.fetchUniqueFilters();
        this.loadTransactions();
        this.updateSidebarBadges();
        this.stripDatabaseTransactionTimes();
        this.deduplicateItemMappings({ silent: true });
        // ERP Export data is loaded when that tab is opened (see initNavigation)
        this.initRealtime();
    }

    /**
     * Checks if any database transactions have a time component in payment_date
     * and strips it in-place to pure YYYY-MM-DD without shifting the calendar date.
     */
    async stripDatabaseTransactionTimes() {
        try {
            // Only needed if payment_date is stored as text/timestamp with > 10 chars
            const rows = await fetchAll('transactions', 'id, payment_date', null, 'id');
            const byDate = new Map();
            for (const r of rows) {
                if (!r.payment_date) continue;
                const raw = String(r.payment_date).trim();
                const clean = toDateOnly(raw);
                if (clean && raw !== clean) {
                    if (!byDate.has(clean)) byDate.set(clean, []);
                    byDate.get(clean).push(r.id);
                }
            }
            if (byDate.size === 0) return 0;

            const tasks = [];
            for (const [cleanDate, ids] of byDate.entries()) {
                for (let i = 0; i < ids.length; i += 200) {
                    const chunk = ids.slice(i, i + 200);
                    tasks.push(async () => {
                        const { error } = await supabase.from('transactions').update({ payment_date: cleanDate }).in('id', chunk);
                        if (error) throw error;
                        return chunk.length;
                    });
                }
            }
            const counts = await runConcurrent(tasks, 4);
            const totalCleaned = counts.reduce((a, b) => a + b, 0);
            if (totalCleaned > 0) {
                this.loadTransactions();
            }
            return totalCleaned;
        } catch (err) {
            console.warn('Date normalization check skipped:', err.message);
            return 0;
        }
    }

    /**
     * Scans all item_mappings in the database and fixes:
     * 1. Whitespace/casing duplicate item_name rows (merges fields and deletes duplicates)
     * 2. Untrimmed or double-spaced item_name / adjusted_item_name / mapping / second_mapping values
     * 3. Chained duplicates where a rule's item_name is another rule's adjusted_item_name
     *    (folds the edits back into the original rule and removes the redundant chained rule)
     * 4. Self-renames where adjusted_item_name is identical to item_name
     */
    async deduplicateItemMappings({ silent = true } = {}) {
        try {
            const rawMappings = await fetchAll('item_mappings', '*', null, 'item_name');
            if (!rawMappings || rawMappings.length === 0) {
                if (!silent) Toast.show('No item mappings found in database.', 'info');
                return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
            }

            const normKey = (s) => normalizeItemName(s).toLowerCase();
            const cleanOrNull = (s) => {
                const c = normalizeItemName(s);
                return c ? c : null;
            };

            const keysToDelete = new Set();
            const rowsToUpsertMap = new Map(); // canonical item_name -> row
            const affectedItemNames = new Set();
            const affectedRenamedNames = new Set();
            let mergedCount = 0;
            let chainedCount = 0;

            // Pass 1: Group by normalized item_name (catches whitespace/case duplicates)
            const groups = new Map();
            for (const row of rawMappings) {
                const k = normKey(row.item_name);
                if (!k) continue;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(row);
            }

            const canonicalByNormKey = new Map();
            for (const [k, group] of groups.entries()) {
                // Prefer the row whose item_name is already trimmed and has the most populated fields
                group.sort((a, b) => {
                    const aTrimmed = a.item_name === normalizeItemName(a.item_name) ? 1 : 0;
                    const bTrimmed = b.item_name === normalizeItemName(b.item_name) ? 1 : 0;
                    if (aTrimmed !== bTrimmed) return bTrimmed - aTrimmed;
                    const aScore = (a.mapping ? 2 : 0) + (a.second_mapping ? 1 : 0) + (a.adjusted_item_name ? 1 : 0);
                    const bScore = (b.mapping ? 2 : 0) + (b.second_mapping ? 1 : 0) + (b.adjusted_item_name ? 1 : 0);
                    return bScore - aScore;
                });

                const canonicalName = normalizeItemName(group[0].item_name);
                let mergedAdjusted = null;
                let mergedMapping = null;
                let mergedSecond = null;

                for (const r of group) {
                    if (r.adjusted_item_name) affectedRenamedNames.add(String(r.adjusted_item_name).trim());
                    const adj = cleanOrNull(r.adjusted_item_name);
                    if (adj && normKey(adj) !== k && !mergedAdjusted) mergedAdjusted = adj;
                    const map1 = cleanOrNull(r.mapping);
                    if (map1 && !mergedMapping) mergedMapping = map1;
                    const map2 = cleanOrNull(r.second_mapping);
                    if (map2 && !mergedSecond) mergedSecond = map2;
                }

                const canonicalRow = {
                    item_name: canonicalName,
                    adjusted_item_name: mergedAdjusted,
                    mapping: mergedMapping,
                    second_mapping: mergedSecond
                };
                canonicalByNormKey.set(k, canonicalRow);

                const primary = group[0];
                const primaryChanged =
                    primary.item_name !== canonicalRow.item_name ||
                    (primary.adjusted_item_name || null) !== canonicalRow.adjusted_item_name ||
                    (primary.mapping || null) !== canonicalRow.mapping ||
                    (primary.second_mapping || null) !== canonicalRow.second_mapping;

                if (group.length > 1 || primaryChanged) {
                    if (group.length > 1) mergedCount += group.length - 1;
                    else mergedCount += 1;
                    for (const r of group) {
                        affectedItemNames.add(r.item_name);
                        if (r.item_name !== canonicalName) {
                            keysToDelete.add(r.item_name);
                        }
                    }
                    affectedItemNames.add(canonicalName);
                    if (mergedAdjusted) affectedRenamedNames.add(mergedAdjusted);
                    rowsToUpsertMap.set(canonicalName, canonicalRow);
                }
            }

            // Pass 2: Detect chained duplicates where Rule B's item_name is Rule A's adjusted_item_name
            // (happens when an edit was entered for the adjusted item name instead of the original item name)
            const adjustedOwnerMap = new Map(); // normKey(adjusted_item_name) -> canonicalRow (Rule A)
            for (const [k, row] of canonicalByNormKey.entries()) {
                if (row.adjusted_item_name) {
                    const adjKey = normKey(row.adjusted_item_name);
                    if (adjKey && adjKey !== k) {
                        adjustedOwnerMap.set(adjKey, row);
                    }
                }
            }

            for (const [k, rowB] of canonicalByNormKey.entries()) {
                const ownerA = adjustedOwnerMap.get(k);
                if (!ownerA || ownerA === rowB) continue;

                // Fold rowB's edits into the original rule ownerA
                let nextAdjusted = rowB.adjusted_item_name || ownerA.adjusted_item_name;
                if (nextAdjusted && normKey(nextAdjusted) === normKey(ownerA.item_name)) {
                    nextAdjusted = null;
                }
                const nextMapping = rowB.mapping || ownerA.mapping || null;
                const nextSecond = rowB.second_mapping || ownerA.second_mapping || null;

                ownerA.adjusted_item_name = nextAdjusted;
                ownerA.mapping = nextMapping;
                ownerA.second_mapping = nextSecond;

                rowsToUpsertMap.set(ownerA.item_name, ownerA);
                rowsToUpsertMap.delete(rowB.item_name);
                keysToDelete.add(rowB.item_name);

                affectedItemNames.add(ownerA.item_name);
                affectedItemNames.add(rowB.item_name);
                affectedRenamedNames.add(rowB.item_name);
                if (nextAdjusted) affectedRenamedNames.add(nextAdjusted);
                chainedCount++;
            }

            const deleteList = Array.from(keysToDelete);
            const upsertList = Array.from(rowsToUpsertMap.values());

            if (deleteList.length === 0 && upsertList.length === 0) {
                if (!silent) Toast.show('No duplicate or chained item mappings found – all rules are clean!', 'success');
                return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
            }

            for (let i = 0; i < deleteList.length; i += 200) {
                const chunk = deleteList.slice(i, i + 200);
                const { error } = await supabase.from('item_mappings').delete().in('item_name', chunk);
                if (error) throw error;
            }

            for (let i = 0; i < upsertList.length; i += 500) {
                const chunk = upsertList.slice(i, i + 500);
                const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                if (error) throw error;
            }

            this.mappingSuggestCache = null;
            const affectedTxRows = await this.fetchTransactionsForItemNames(Array.from(affectedItemNames), Array.from(affectedRenamedNames));
            const reapplyRes = await this.reapplyRulesTo(affectedTxRows);

            await this.logAudit('Item Mappings Deduplicated', `${mergedCount + chainedCount} rule(s) cleaned`, {
                duplicates_merged: mergedCount,
                chained_folded: chainedCount,
                transactions_updated: reapplyRes.updated
            });

            if (!silent) {
                Toast.show(
                    `Cleaned ${mergedCount + chainedCount} duplicate/chained mapping(s). ${this.reapplySummary(reapplyRes)}`,
                    'success'
                );
                await this.loadMappings();
            }
            return { mergedCount, chainedCount, txUpdated: reapplyRes.updated };
        } catch (err) {
            if (!silent) Toast.show('Error fixing mapping duplicates: ' + err.message, 'error');
            else console.warn('Mapping deduplication check skipped:', err.message);
            return { mergedCount: 0, chainedCount: 0, txUpdated: 0 };
        }
    }

    initRealtime() {
        if (this.realtimeChannel) return;
        this.realtimeChannel = supabase.channel('table-db-changes')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'transactions' },
                (payload) => {
                    console.log('Realtime update received!', payload);
                    
                    // Throttle reloads to prevent spamming the database
                    if (this.realtimeTimeout) clearTimeout(this.realtimeTimeout);
                    this.realtimeTimeout = setTimeout(() => {
                        // Refresh the active view dynamically
                        const views = document.querySelectorAll('.view.active');
                        if (views.length > 0) {
                            const activeId = views[0].id;
                            if (activeId === 'view-transactions') {
                                Toast.show('New activity detected. Refreshing data...', 'info');
                                this.loadTransactions();
                            } else if (activeId === 'view-dashboard') {
                                this.loadDashboard();
                            } else if (activeId === 'view-erp-export') {
                                this.loadErpExport();
                            }
                        }
                        this.updateSidebarBadges();
                    }, 2000); // Wait 2s after last event before refreshing
                }
            )
            .subscribe();
    }

    initTheme() {
        const btnToggle = document.getElementById('btn-theme-toggle');
        if (!btnToggle) return;

        const htmlEl = document.documentElement;
        const iconEl = document.getElementById('theme-icon');
        const textEl = document.getElementById('theme-text');
        const fpThemeEl = document.getElementById('flatpickr-theme');

        // Check local storage or system preference
        let savedTheme = null;
        try { savedTheme = localStorage.getItem('fawry-theme'); } catch (e) { /* storage unavailable */ }
        const saveTheme = (t) => { try { localStorage.setItem('fawry-theme', t); } catch (e) { /* ignore */ } };
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;

        if (savedTheme === 'light' || (!savedTheme && prefersLight)) {
            htmlEl.classList.remove('dark');
            htmlEl.classList.add('light');
            if(iconEl) iconEl.setAttribute('data-lucide', 'moon');
            if(textEl) textEl.innerText = 'Dark Mode';
            if (fpThemeEl) fpThemeEl.href = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/themes/light.css";
        } else {
            htmlEl.classList.add('dark');
            if(iconEl) iconEl.setAttribute('data-lucide', 'sun');
            if(textEl) textEl.innerText = 'Light Mode';
            if (fpThemeEl) fpThemeEl.href = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/themes/dark.css";
        }

        btnToggle.addEventListener('click', () => {
            const isLight = htmlEl.classList.contains('light');
            if (isLight) {
                htmlEl.classList.remove('light');
                htmlEl.classList.add('dark');
                saveTheme('dark');
                if(iconEl) iconEl.setAttribute('data-lucide', 'sun');
                if(textEl) textEl.innerText = 'Light Mode';
                if (fpThemeEl) fpThemeEl.href = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/themes/dark.css";
            } else {
                htmlEl.classList.remove('dark');
                htmlEl.classList.add('light');
                saveTheme('light');
                if(iconEl) iconEl.setAttribute('data-lucide', 'moon');
                if(textEl) textEl.innerText = 'Dark Mode';
                if (fpThemeEl) fpThemeEl.href = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/themes/light.css";
            }
            if (window.lucide) lucide.createIcons();
        });
    }

    initDatePickers() {
        if (window.flatpickr) {
            flatpickr('input[type="date"]', {
                dateFormat: "Y-m-d",
                allowInput: true
            });
        }
    }

    async fetchUniqueFilters() {
        try {
            const { data, error } = await supabase.from('item_mappings').select('mapping, item_name');
            if (!error && data) {
                this.uniqueLists.mapping = [...new Set(data.map(d => d.mapping).filter(Boolean))].sort();
                this.uniqueLists.item_name = [...new Set(data.map(d => d.item_name).filter(Boolean))].sort();
            }
        } catch (err) {
            console.error('Error fetching distinct mappings:', err);
        }
    }

    initNavigation() {
        const btnMobileMenu = document.getElementById('btn-mobile-menu');
        const btnCloseSidebar = document.getElementById('btn-close-sidebar');
        const sidebar = document.querySelector('.sidebar');
        const sidebarBackdrop = document.getElementById('sidebar-backdrop');

        const openSidebar = () => {
            sidebar?.classList.add('open');
            sidebarBackdrop?.classList.add('active');
        };

        const closeSidebar = () => {
            sidebar?.classList.remove('open');
            sidebarBackdrop?.classList.remove('active');
        };

        if (btnMobileMenu) {
            btnMobileMenu.addEventListener('click', openSidebar);
        }
        
        if (btnCloseSidebar) {
            btnCloseSidebar.addEventListener('click', closeSidebar);
        }

        if (sidebarBackdrop) {
            sidebarBackdrop.addEventListener('click', closeSidebar);
        }

        const btnShowImport = document.getElementById('btn-show-import');
        if (btnShowImport) {
            btnShowImport.addEventListener('click', () => {
                document.getElementById('modal-import')?.classList.remove('hidden');
                document.getElementById('import-progress')?.classList.add('hidden');
                const actionBar = document.getElementById('import-action-bar');
                if (actionBar) actionBar.style.display = 'none';
                const s1 = document.getElementById('import-step-1');
                const s2 = document.getElementById('import-step-2');
                const s3 = document.getElementById('import-step-3');
                if (s1 && s2 && s3) {
                    [s1, s2, s3].forEach(s => s.classList.remove('active', 'done'));
                    s1.classList.add('active');
                }
            });
        }

        document.getElementById('btn-import-done')?.addEventListener('click', () => {
            document.getElementById('modal-import')?.classList.add('hidden');
            document.getElementById('import-progress')?.classList.add('hidden');
            document.querySelector('.nav-link[data-tab="transactions"]')?.click();
            this.loadTransactions();
            this.updateSidebarBadges();
        });
        
        const btnShowHistory = document.getElementById('btn-show-history');
        if (btnShowHistory) {
            btnShowHistory.addEventListener('click', () => {
                document.getElementById('modal-history').classList.remove('hidden');
                this.loadHistory();
            });
        }
        
        const links = document.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tabId = link.getAttribute('data-tab');
                
                // Update active state
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                
                // Close sidebar on mobile after clicking
                closeSidebar();
                
                // Show view
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById(`view-${tabId}`).classList.add('active');

                if (tabId === 'settlement' && !window.settlementApp) { window.settlementApp = new SettlementProcessor(supabase); }
                if (tabId === 'dashboard') this.loadDashboard();
                if (tabId === 'transactions') this.loadTransactions();
                if (tabId === 'mappings') this.loadMappings();
                if (tabId === 'fixes') this.loadFixes();
                if (tabId === 'history') this.loadHistory();
                if (tabId === 'payment-links') this.loadPaymentLinks();
                if (tabId === 'erp-export') this.loadErpExport();
                // Students Details does not require initial data load
            });
        });
    }

    initDashboard() {
        const now = new Date();
        const dateFrom = document.getElementById('dashboard-date-from');
        const dateTo = document.getElementById('dashboard-date-to');
        if (dateFrom && dateTo) {
            dateFrom.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            dateTo.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            
            dateFrom.addEventListener('change', () => this.loadDashboard());
            dateTo.addEventListener('change', () => this.loadDashboard());
        }

        document.getElementById('dashboard-group-by')?.addEventListener('change', () => this.loadDashboard());
        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.addEventListener('change', () => this.loadDashboard());
        });

        // Add event delegation for the expand/collapse month rows
        const pivotBody = document.getElementById('dashboard-pivot-body');
        if (pivotBody) {
            pivotBody.addEventListener('click', (e) => {
                const monthRow = e.target.closest('.month-row');
                if (monthRow) {
                    const monthKey = monthRow.getAttribute('data-month');
                    const toggleContainer = monthRow.querySelector('.month-toggle');
                    const dayRows = pivotBody.querySelectorAll(`.day-row.month-${monthKey}`);
                    
                    if (toggleContainer.classList.contains('expanded')) {
                        toggleContainer.classList.remove('expanded');
                        dayRows.forEach(r => r.style.display = 'none');
                    } else {
                        toggleContainer.classList.add('expanded');
                        dayRows.forEach(r => r.style.display = 'table-row');
                    }
                }
            });
        }

        // Copy Table
        const btnCopy = document.getElementById('btn-copy-pivot');
        if (btnCopy) {
            btnCopy.addEventListener('click', () => {
                const table = document.getElementById('dashboard-pivot-table');
                
                const clone = table.cloneNode(true);
                // Collapsed daily rows must not end up in the pasted email
                clone.querySelectorAll('tr').forEach(tr => {
                    if (tr.style.display === 'none') tr.remove();
                });
                const cells = clone.querySelectorAll('th, td');
                cells.forEach(c => {
                    c.style.border = '1px solid black';
                    c.style.padding = '5px 8px';
                    c.style.color = '#000';
                    if (c.classList.contains('pivot-title')) {
                        c.style.backgroundColor = '#b4c6e7';
                        c.style.borderBottom = '2px solid black';
                        c.style.textAlign = 'center';
                        c.style.fontWeight = 'bold';
                    }
                    if (c.classList.contains('pivot-header')) {
                        c.style.backgroundColor = '#4472c4';
                        c.style.color = '#ffffff';
                        c.style.textAlign = 'center';
                        c.style.fontWeight = 'bold';
                    }
                    if (c.classList.contains('pivot-row-label') || c.classList.contains('pivot-col-label')) {
                        c.style.backgroundColor = '#e9e9e9';
                        c.style.fontWeight = 'bold';
                        if (c.classList.contains('pivot-row-label')) c.style.textAlign = 'left';
                    }
                    if (c.classList.contains('highlight-col') || c.classList.contains('highlight-cell')) {
                        c.style.backgroundColor = '#ffff00';
                    }
                    if (c.parentNode.parentNode.tagName === 'TFOOT') {
                        c.style.fontWeight = 'bold';
                        c.style.borderTop = '2px solid black';
                    }
                    if (c.cellIndex === 0) {
                        c.style.textAlign = 'left';
                    } else {
                        c.style.textAlign = 'right';
                    }
                });

                const htmlStr = `<table style="border-collapse: collapse; font-family: Arial, sans-serif; font-size: 14px; width: 600px; border: 2px solid black;">${clone.innerHTML}</table>`;
                
                const blobHtml = new Blob([htmlStr], { type: "text/html" });
                const blobText = new Blob([clone.innerText], { type: "text/plain" });
                const data = [new ClipboardItem({
                    "text/plain": blobText,
                    "text/html": blobHtml,
                })];

                navigator.clipboard.write(data).then(() => {
                    const orig = btnCopy.innerHTML;
                    btnCopy.innerHTML = '<i data-lucide="check"></i> Copied!';
                    if (window.lucide) lucide.createIcons();
                    setTimeout(() => {
                        btnCopy.innerHTML = orig;
                        if (window.lucide) lucide.createIcons();
                    }, 2000);
                }).catch(err => {
                    Toast.show('Failed to copy: ' + err.message, 'error');
                });
            });
        }
    }

    async loadDashboard() {
        const dateFrom = document.getElementById('dashboard-date-from')?.value;
        const dateTo = document.getElementById('dashboard-date-to')?.value;
        const groupBy = document.getElementById('dashboard-group-by')?.value || 'date';
        
        if (!dateFrom || !dateTo) return;

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]:checked');
        const selectedBanks = Array.from(checkboxes).map(cb => cb.value);

        const tbody = document.getElementById('dashboard-pivot-body');
        const tfoot = document.getElementById('dashboard-pivot-foot');
        if (!tbody || !tfoot) return;

        const formatMoney = (num) => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        if (selectedBanks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2" style="text-align: center;">No bank selected</td></tr>';
            tfoot.innerHTML = '<tr><td>Grand Total</td><td>0.00</td></tr>';
            document.getElementById('stat-total-collections').textContent = 'EGP 0.00';
            document.getElementById('stat-total-transactions').textContent = '0';
            document.getElementById('stat-valid-pct').textContent = '0%';
            document.getElementById('stat-errors').textContent = '0';
            return;
        }

        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading...</td></tr>';
        tfoot.innerHTML = '';

        try {
            let allData = [];
            let rpcSucceeded = false;
            
            // 1. Try fast server-side RPC supporting all Group By modes
            const { data: pivotByData, error: pivotByErr } = await supabase.rpc('get_dashboard_pivot_by', {
                start_date: dateFrom,
                end_date: dateTo,
                group_col: groupBy
            });
            if (!pivotByErr && Array.isArray(pivotByData)) {
                rpcSucceeded = true;
                allData = pivotByData.map(row => ({
                    payment_date: groupBy === 'date' ? row.group_key : null,
                    mapping: groupBy === 'mapping' ? row.group_key : null,
                    second_mapping: groupBy === 'second_mapping' ? row.group_key : null,
                    item_name: groupBy === 'item_name' ? row.group_key : null,
                    bank: row.bank,
                    item_price: row.total_amount
                }));
            } else if (groupBy === 'date') {
                // 2. Fallback to legacy date-only RPC
                const { data: rpcData, error: rpcError } = await supabase.rpc('get_dashboard_pivot', { start_date: dateFrom, end_date: dateTo });
                rpcSucceeded = !rpcError && Array.isArray(rpcData);
                if (rpcSucceeded) {
                    allData = rpcData.map(row => ({
                        payment_date: row.payment_date,
                        bank: row.bank,
                        item_price: row.daily_total
                    }));
                }
            }
            
            // Fallback (RPC missing / failed)
            if (!rpcSucceeded) {
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data, error } = await supabase.from('transactions')
                        .select('payment_date, bank, item_price, mapping, second_mapping, item_name, id_status')
                        .gte('payment_date', dateFrom)
                        .lte('payment_date', dateTo)
                        .in('bank', selectedBanks)
                        .order('id')
                        .range(from, from + 999);
                    
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }
            }

            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

            let bankTotals = { Total: 0 };
            selectedBanks.forEach(b => bankTotals[b] = 0);

            let htmlOutput = '';

            if (groupBy === 'date') {
                const monthlyPivot = {};
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    const pDate = toDateOnly(tx.payment_date);
                    if (!pDate) return;
                    const monthKey = pDate.substring(0, 7); // YYYY-MM
                    
                    if (!monthlyPivot[monthKey]) {
                        monthlyPivot[monthKey] = { Total: 0, days: {} };
                        selectedBanks.forEach(b => monthlyPivot[monthKey][b] = 0);
                    }
                    if (!monthlyPivot[monthKey].days[pDate]) {
                        monthlyPivot[monthKey].days[pDate] = { Total: 0 };
                        selectedBanks.forEach(b => monthlyPivot[monthKey].days[pDate][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    monthlyPivot[monthKey].days[pDate][tx.bank] += price;
                    monthlyPivot[monthKey].days[pDate].Total += price;
                    monthlyPivot[monthKey][tx.bank] += price;
                    monthlyPivot[monthKey].Total += price;
                    bankTotals[tx.bank] += price;
                    bankTotals.Total += price;
                });

                const months = Object.keys(monthlyPivot).sort();
                const multiMonth = months.length > 1;

                months.forEach(m => {
                    const monthData = monthlyPivot[m];
                    const days = Object.keys(monthData.days).sort();
                    
                    if (multiMonth) {
                        const parts = m.split('-');
                        const monthLabel = `${monthNames[parseInt(parts[1]) - 1]} ${parts[0]}`;
                        htmlOutput += `<tr class="month-row" data-month="${m}">
                            <td><div class="month-toggle"><i data-lucide="chevron-right"></i><span>${monthLabel}</span></div></td>`;
                        selectedBanks.forEach(b => {
                            htmlOutput += `<td class="${b === 'NUADIB64' ? 'highlight-cell' : ''}">${formatMoney(monthData[b])}</td>`;
                        });
                        htmlOutput += `<td>${formatMoney(monthData.Total)}</td></tr>`;
                    }

                    days.forEach(d => {
                        const row = monthData.days[d];
                        const dateParts = d.split('-');
                        const dateLabel = `${parseInt(dateParts[2])}-${monthNames[parseInt(dateParts[1]) - 1]}-${dateParts[0]}`;
                        htmlOutput += `<tr class="day-row month-${m}" style="${multiMonth ? 'display: none;' : ''}">
                            <td>${dateLabel}</td>`;
                        selectedBanks.forEach(b => {
                            htmlOutput += `<td class="${b === 'NUADIB64' ? 'highlight-cell' : ''}">${formatMoney(row[b])}</td>`;
                        });
                        htmlOutput += `<td>${formatMoney(row.Total)}</td></tr>`;
                    });
                });

                if (months.length === 0) {
                    htmlOutput = `<tr><td colspan="${selectedBanks.length + 2}" style="text-align: center;">No data for selected period</td></tr>`;
                }

            } else {
                // Group by Mapping or Item Name
                const groupedData = {};
                
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    
                    let key = 'Unknown';
                    if (groupBy === 'mapping') {
                        key = tx.mapping || 'Unmapped';
                    } else if (groupBy === 'second_mapping') {
                        key = tx.second_mapping || 'Unmapped';
                    } else if (groupBy === 'item_name') {
                        key = tx.item_name || 'Unknown Item';
                    }
                    
                    if (!groupedData[key]) {
                        groupedData[key] = { Total: 0 };
                        selectedBanks.forEach(b => groupedData[key][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    groupedData[key][tx.bank] += price;
                    groupedData[key].Total += price;
                    bankTotals[tx.bank] += price;
                    bankTotals.Total += price;
                });

                const keys = Object.keys(groupedData).sort();
                
                keys.forEach(k => {
                    const row = groupedData[k];
                    htmlOutput += `<tr><td>${escapeHTML(k)}</td>`;
                    selectedBanks.forEach(b => {
                        htmlOutput += `<td class="${b === 'NUADIB64' ? 'highlight-cell' : ''}">${formatMoney(row[b])}</td>`;
                    });
                    htmlOutput += `<td>${formatMoney(row.Total)}</td></tr>`;
                });

                if (keys.length === 0) {
                    htmlOutput = `<tr><td colspan="${selectedBanks.length + 2}" style="text-align: center;">No data for selected period</td></tr>`;
                }
            }

            tbody.innerHTML = htmlOutput;

            let footHtml = `<tr><td>Grand Total</td>`;
            selectedBanks.forEach(b => {
                footHtml += `<td class="${b === 'NUADIB64' ? 'highlight-cell' : ''}">${formatMoney(bankTotals[b])}</td>`;
            });
            footHtml += `<td>${formatMoney(bankTotals.Total)}</td></tr>`;
            tfoot.innerHTML = footHtml;

            const thead = document.querySelector('#dashboard-pivot-table thead');
            if (thead) {
                const label = groupBy === 'date' ? 'Date' : (groupBy === 'mapping' ? 'Mapping' : (groupBy === 'second_mapping' ? '2nd Mapping' : 'Item Name'));
                thead.innerHTML = `
                    <tr><th colspan="${selectedBanks.length + 2}" class="pivot-title">Total Fawry Collection</th></tr>
                    <tr>
                        <th class="pivot-row-label">${label}</th>
                        ${selectedBanks.map(b => `<th class="pivot-col-label ${b === 'NUADIB64' ? 'highlight-col' : ''}">${b}</th>`).join('')}
                        <th class="pivot-col-label">Grand Total</th>
                    </tr>
                `;
            }

            // Update Stat Cards
            const totalCollections = bankTotals.Total || 0;
            
            document.getElementById('stat-total-collections').textContent = `EGP ${formatMoney(totalCollections)}`;
            
            let validCount = 0;
            let totalCountAll = 0;

            if (rpcSucceeded) {
                // RPC only returned daily aggregates, so fetch valid/error counts for the date range
                const validQuery = supabase.from('transactions').select('*', { count: 'exact', head: true })
                    .gte('payment_date', dateFrom).lte('payment_date', dateTo).eq('id_status', 'Valid').in('bank', selectedBanks);
                const totalQuery = supabase.from('transactions').select('*', { count: 'exact', head: true })
                    .gte('payment_date', dateFrom).lte('payment_date', dateTo).in('bank', selectedBanks);

                const [{ count: vCnt, error: vErr }, { count: tCnt, error: tErr }] = await Promise.all([validQuery, totalQuery]);
                if (vErr) throw vErr;
                if (tErr) throw tErr;
                validCount = vCnt || 0;
                totalCountAll = tCnt || 0;
            } else {
                // Full rows were already fetched and filtered by selectedBanks – count in memory
                totalCountAll = allData.length;
                validCount = allData.reduce((acc, tx) => acc + (tx.id_status === 'Valid' ? 1 : 0), 0);
            }
            
            document.getElementById('stat-total-transactions').textContent = (totalCountAll || 0).toLocaleString();
            
            const validPct = totalCountAll > 0 ? ((validCount / totalCountAll) * 100).toFixed(1) : 0;
            const errorCount = (totalCountAll || 0) - (validCount || 0);
            
            document.getElementById('stat-valid-pct').textContent = `${validPct}%`;
            document.getElementById('stat-errors').textContent = errorCount.toLocaleString();
            this.updateSidebarBadges();
            
            if (window.lucide) lucide.createIcons();

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="${selectedBanks.length + 2}" style="color: var(--danger);">Error: ${escapeHTML(err.message)}</td></tr>`;
        }
    }

    initImport() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');

        dropZone.addEventListener('click', (e) => {
            if (!e.target.closest('button')) {
                fileInput.click();
            }
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                await this.handleFiles(e.dataTransfer.files);
            }
        });

        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length) {
                await this.handleFiles(e.target.files);
                e.target.value = ''; // Reset file input so same file can be imported again
            }
        });
    }

    async handleFiles(files) {
        if (this.isImporting) {
            Toast.show('An import is already in progress. Please wait.', 'warning');
            return;
        }
        this.isImporting = true;
        
        try {
            document.getElementById('import-progress').classList.remove('hidden');
            document.getElementById('import-log').innerHTML = '';
            
            const processor = new FawryProcessor(this.currentUser?.email || 'System');
            const success = await processor.processFiles(files);
            
            if (processor.skippedTransactions && processor.skippedTransactions.length > 0) {
                const summary = {};
                processor.skippedTransactions.forEach(t => {
                    const statusName = t.status ? String(t.status).trim() : 'Unknown';
                    summary[statusName] = (summary[statusName] || 0) + 1;
                });
                
                let skippedHtml = `
                    <div class="alert alert-warning" style="margin-top: 1rem; border-radius: 8px; padding: 1rem; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #f59e0b;">
                        <strong>⚠️ Notice: Skipped ${processor.skippedTransactions.length} transaction(s) with non-payable status:</strong>
                        <ul style="margin: 0.5rem 0 0 1.25rem; font-size: 0.85rem;">
                `;
                for (const [status, count] of Object.entries(summary)) {
                    skippedHtml += `<li><strong>${escapeHTML(status)}:</strong> ${count} transaction(s)</li>`;
                }
                skippedHtml += `
                        </ul>
                        <div style="font-size: 0.8rem; margin-top: 0.5rem; opacity: 0.9;">These transactions were not imported because only paid transactions are recorded.</div>
                    </div>
                `;
                
                const logEl = document.getElementById('import-log');
                if (logEl) {
                    logEl.innerHTML += skippedHtml;
                    logEl.scrollTop = logEl.scrollHeight;
                }
            }

            this.invalidateDistinctCache();
            this.updateSidebarBadges();

            const actionBar = document.getElementById('import-action-bar');
            if (actionBar) {
                actionBar.style.display = 'flex';
                if (window.lucide) lucide.createIcons({ root: actionBar });
            }

            if (success) {
                Toast.show("Import completed successfully!", "success");
            } else {
                Toast.show("Import finished with errors. Please review the log.", "error");
            }
        } catch (err) {
            console.error(err);
            Toast.show('Import failed: ' + err.message, 'error');
        } finally {
            this.isImporting = false;
        }
    }

    invalidateDistinctCache() {
        this.distinctCache = {};
    }

    // Returns the adjusted names currently stored for these mapping rules (call BEFORE changing the rules,
    // so transactions already renamed by the old rule can still be found).
    async getCurrentAdjustedNames(names) {
        const rows = await fetchByIn('item_mappings', 'item_name, adjusted_item_name', 'item_name', names, 'item_name', 100);
        return rows.map(r => r.adjusted_item_name).filter(Boolean);
    }

    // Fetches every transaction affected by a change to the mapping rules for `names`:
    // rows still carrying the original name, rows renamed earlier via `renamedTo`, or rows whose check_column ends with `-${name}`.
    async fetchTransactionsForItemNames(names, renamedTo = []) {
        const wantedNorm = new Set(names.map(n => normalizeItemName(n).toLowerCase()).filter(Boolean));
        if (wantedNorm.size === 0) return [];
        const rawTargets = [...new Set([...names, ...renamedTo].map(n => String(n || '').trim()).filter(Boolean))];
        const normTargets = [...new Set(rawTargets.map(n => normalizeItemName(n)).filter(Boolean))];
        const searchNames = [...new Set([...rawTargets, ...normTargets])];

        const byItemName = await fetchByIn('transactions', '*', 'item_name', searchNames, 'id', 50);

        // Also fetch by check_column suffix for single/small batches so previously renamed items are never missed
        let byCheckCol = [];
        if (normTargets.length <= 15) {
            const checkTasks = normTargets.map(name => async () => {
                const safe = name.replace(/[%_]/g, '\\$&');
                return await fetchAll('transactions', '*', q => q.ilike('check_column', `%-${safe}`), 'id');
            });
            byCheckCol = (await runConcurrent(checkTasks, 4)).flat();
        }

        const dedup = new Map();
        for (const r of [...byItemName, ...byCheckCol]) {
            if (r && r.id != null) dedup.set(r.id, r);
        }

        const allNormWanted = new Set([...wantedNorm, ...renamedTo.map(n => normalizeItemName(n).toLowerCase()).filter(Boolean)]);
        return Array.from(dedup.values()).filter(t =>
            allNormWanted.has(normalizeItemName(originalItemName(t)).toLowerCase()) ||
            allNormWanted.has(normalizeItemName(t.item_name).toLowerCase())
        );
    }

    // Re-applies all rules to the given rows and saves the ones that changed (rule columns only).
    // Settled / ERP-recorded rows are never changed here; they are counted in lockedSkipped and
    // can be reviewed with "Re-apply Rules".
    async reapplyRulesTo(rows) {
        const all = await recomputeTransactions(rows, { includeLocked: true });
        const open = all.filter(c => !c.diff.locked);
        const updated = open.length > 0 ? await updateRuleFields(open) : 0;
        if (updated > 0) this.invalidateDistinctCache();
        return { updated, lockedSkipped: all.length - open.length };
    }

    // Toast text for a reapplyRulesTo result
    reapplySummary({ updated, lockedSkipped }) {
        let msg = `${updated} transaction(s) updated.`;
        if (lockedSkipped > 0) msg += ` ${lockedSkipped} settled/ERP-recorded transaction(s) left unchanged – review them with "Re-apply Rules".`;
        return msg;
    }

    async recordBatch(fileName, type, processed, inserted, errorMessage) {
        const { error } = await supabase.from('import_batches').insert({
            user_email: this.currentUser ? this.currentUser.email : 'System',
            file_name: fileName,
            status: errorMessage ? (inserted > 0 ? 'partial' : 'failed') : (inserted === processed ? 'success' : (inserted > 0 ? 'partial' : 'failed')),
            records_processed: processed,
            records_inserted: inserted,
            details: { type, error_message: errorMessage }
        });
        if (error) console.warn('Could not record import history:', error.message);
    }

    async logAudit(action, affected, details) {
        if (!this.currentUser) return;
        const { error } = await supabase.from('audit_logs').insert({
            user_email: this.currentUser.email,
            action,
            affected_references: affected,
            details
        });
        if (error) console.warn('Audit log failed:', error.message);
    }

    resetMappingModal(title = 'Add Mapping') {
        this.editingMappingOriginalName = null;
        ['map-original', 'map-adjusted', 'map-category', 'map-second-category'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const suggest = document.getElementById('mapping-suggestion');
        if (suggest) suggest.style.display = 'none';
        const dupWarn = document.getElementById('mapping-duplicate-warning');
        if (dupWarn) dupWarn.style.display = 'none';
        document.getElementById('modal-mapping-title').innerText = title;
    }

    openMappingModalForEdit(mapping, carryOver = null) {
        if (!mapping) return;
        this.resetMappingModal('Edit Mapping');
        this.editingMappingOriginalName = mapping.item_name;
        document.getElementById('map-original').value = mapping.item_name || '';
        document.getElementById('map-adjusted').value = (carryOver && carryOver.adjusted_item_name != null) ? carryOver.adjusted_item_name : (mapping.adjusted_item_name || '');
        document.getElementById('map-category').value = (carryOver && carryOver.mapping) ? carryOver.mapping : (mapping.mapping || '');
        document.getElementById('map-second-category').value = (carryOver && carryOver.second_mapping) ? carryOver.second_mapping : (mapping.second_mapping || '');
        document.getElementById('modal-mapping').classList.remove('hidden');
    }

    /**
     * Checks if `inputName` conflicts with an existing mapping's item_name or adjusted_item_name.
     * @returns {{ type: 'direct' | 'adjusted', rule: object } | null}
     */
    findConflictingMapping(inputName, excludeOriginalName = null) {
        const normInput = normalizeItemName(inputName).toLowerCase();
        if (!normInput) return null;
        const normExclude = excludeOriginalName ? normalizeItemName(excludeOriginalName).toLowerCase() : null;
        const list = this.allMappingsData || this.mappingSuggestCache || [];

        for (const m of list) {
            if (!m || !m.item_name) continue;
            const normKey = normalizeItemName(m.item_name).toLowerCase();
            if (normExclude && normKey === normExclude) continue;
            if (normKey === normInput) {
                return { type: 'direct', rule: m };
            }
        }
        for (const m of list) {
            if (!m || !m.adjusted_item_name) continue;
            const normKey = normalizeItemName(m.item_name).toLowerCase();
            if (normExclude && normKey === normExclude) continue;
            const normAdj = normalizeItemName(m.adjusted_item_name).toLowerCase();
            if (normAdj === normInput) {
                return { type: 'adjusted', rule: m };
            }
        }
        return null;
    }

    resetFixModal(title = 'Add Fix') {
        this.editingFixOriginalRef = null;
        ['fix-ref', 'fix-id', 'fix-name', 'fix-mapping', 'fix-second-mapping'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['fix-duplicate-warning', 'fix-tx-preview', 'fix-id-feedback', 'fix-item-suggestion'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = 'none';
                el.innerHTML = '';
            }
        });
        document.getElementById('modal-fix-title').innerText = title;
        this.populateFixModalDatalists();
    }

    async populateFixModalDatalists() {
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
            const allData = this.allMappingsData || [];
            const itemNames = [...new Set(
                allData.flatMap(m => [m.adjusted_item_name, m.item_name]).map(v => normalizeItemName(v)).filter(Boolean)
            )].sort();
            const categories = [...new Set(allData.map(m => m.mapping).filter(Boolean))].sort();
            const secondCategories = [...new Set(allData.map(m => m.second_mapping).filter(Boolean))].sort();

            const dlItems = document.getElementById('datalist-fix-item-names');
            if (dlItems) {
                dlItems.innerHTML = itemNames.map(n => `<option value="${escapeHTML(n)}"></option>`).join('');
            }
            const dl1 = document.getElementById('datalist-mapping-categories');
            if (dl1 && !dl1.innerHTML) {
                dl1.innerHTML = categories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
            }
            const dl2 = document.getElementById('datalist-second-mapping-categories');
            if (dl2 && !dl2.innerHTML) {
                dl2.innerHTML = secondCategories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
            }
        } catch (err) {
            // Non-blocking autocomplete population
        }
    }

    findConflictingFix(refInput, excludeRef = null) {
        const normRef = String(refInput || '').trim().toLowerCase();
        if (!normRef) return null;
        const normExclude = excludeRef ? String(excludeRef).trim().toLowerCase() : null;
        const list = this.allFixesData || [];
        for (const f of list) {
            if (!f || !f.reference_number) continue;
            const key = String(f.reference_number).trim().toLowerCase();
            if (normExclude && key === normExclude) continue;
            if (key === normRef) return f;
        }
        return null;
    }

    openFixModalForEdit(fix, carryOver = null) {
        if (!fix) return;
        this.resetFixModal('Edit Fix');
        this.editingFixOriginalRef = fix.reference_number;
        document.getElementById('fix-ref').value = fix.reference_number || '';
        document.getElementById('fix-id').value = (carryOver && carryOver.correct_id) ? carryOver.correct_id : (fix.correct_id || '');
        document.getElementById('fix-name').value = (carryOver && carryOver.item_name) ? carryOver.item_name : (fix.item_name || '');
        document.getElementById('fix-mapping').value = (carryOver && carryOver.mapping) ? carryOver.mapping : (fix.mapping || '');
        document.getElementById('fix-second-mapping').value = (carryOver && carryOver.second_mapping) ? carryOver.second_mapping : (fix.second_mapping || '');
        document.getElementById('modal-fix').classList.remove('hidden');
        this.updateFixRefPreview(fix.reference_number);
        if (document.getElementById('fix-id').value) {
            this.updateFixIdFeedback(document.getElementById('fix-id').value);
        }
    }

    async openQuickFixForRef(refNumber) {
        const cleanRef = String(refNumber || '').trim();
        if (!cleanRef) return;
        try {
            if (!this.allFixesData) {
                this.allFixesData = await fetchAll('manual_fixes', '*', null, 'reference_number');
            }
        } catch (e) {
            // ignore
        }
        const existing = this.findConflictingFix(cleanRef, null);
        if (existing) {
            this.openFixModalForEdit(existing);
            Toast.show(`Loaded existing manual fix for Reference "${existing.reference_number}"`, 'info');
        } else {
            this.resetFixModal('Add Fix');
            document.getElementById('fix-ref').value = cleanRef;
            document.getElementById('modal-fix').classList.remove('hidden');
            this.updateFixRefPreview(cleanRef);
            setTimeout(() => document.getElementById('fix-id')?.focus(), 50);
        }
    }

    async updateFixRefPreview(rawRef) {
        const ref = String(rawRef || '').trim();
        const dupWarn = document.getElementById('fix-duplicate-warning');
        const previewEl = document.getElementById('fix-tx-preview');
        const reqId = (this.fixPreviewReqId = (this.fixPreviewReqId || 0) + 1);

        if (!ref) {
            if (dupWarn) dupWarn.style.display = 'none';
            if (previewEl) previewEl.style.display = 'none';
            return;
        }

        try {
            if (!this.allFixesData) {
                this.allFixesData = await fetchAll('manual_fixes', '*', null, 'reference_number');
            }
        } catch (e) {
            // ignore
        }
        if (reqId !== this.fixPreviewReqId) return;

        // 1. Check duplicate fix in manual_fixes
        if (dupWarn) {
            const conflict = this.findConflictingFix(ref, this.editingFixOriginalRef);
            if (conflict) {
                dupWarn.innerText = `⚠️ A manual fix for Reference "${conflict.reference_number}" already exists. Click here to edit the existing fix instead.`;
                dupWarn.style.display = 'block';
                dupWarn.onclick = () => {
                    this.openFixModalForEdit(conflict, {
                        correct_id: document.getElementById('fix-id')?.value.trim() || '',
                        item_name: normalizeItemName(document.getElementById('fix-name')?.value) || '',
                        mapping: normalizeItemName(document.getElementById('fix-mapping')?.value) || '',
                        second_mapping: normalizeItemName(document.getElementById('fix-second-mapping')?.value) || ''
                    });
                    Toast.show(`Switched to editing existing fix for "${conflict.reference_number}"`, 'info');
                };
            } else {
                dupWarn.style.display = 'none';
            }
        }

        // 2. Live Transaction Lookup in `transactions`
        if (!previewEl) return;
        previewEl.style.display = 'block';
        previewEl.innerHTML = `<span style="color: var(--text-muted);">Looking up transaction "${escapeHTML(ref)}"...</span>`;

        try {
            const { data: txRows, error } = await supabase
                .from('transactions')
                .select('reference_number, payment_date, student_id, id_status, item_name, check_column, item_price, mapping, second_mapping, is_settled')
                .eq('reference_number', ref)
                .limit(5);
            if (reqId !== this.fixPreviewReqId) return;
            if (error) throw error;

            if (!txRows || txRows.length === 0) {
                previewEl.innerHTML = `
                    <div style="color: #f59e0b; display: flex; align-items: center; gap: 0.4rem;">
                        <span>⚠️ No transaction found in database with Reference Number <strong>${escapeHTML(ref)}</strong>. Verify there are no typos.</span>
                    </div>
                `;
                return;
            }

            const t = txRows[0];
            let statusClass = 'valid';
            if (t.id_status && t.id_status.includes('Missing')) statusClass = 'missing';
            if (t.id_status && t.id_status.includes('Error')) statusClass = 'error';
            const extraCount = txRows.length > 1 ? ` <span class="text-muted">(+${txRows.length - 1} more row)</span>` : '';

            previewEl.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.35rem;">
                    <span><strong>Transaction Found</strong>${extraCount} • ${escapeHTML(toDateOnly(t.payment_date) || 'N/A')}</span>
                    <span class="badge ${statusClass}" style="font-size: 0.72rem;">${escapeHTML(t.id_status || 'Unknown')}</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem 0.75rem; color: var(--text-muted); font-size: 0.8rem;">
                    <div>Current ID: <strong style="color: var(--text-main);">${escapeHTML(t.student_id || 'Empty')}</strong></div>
                    <div>Amount: <strong style="color: var(--text-main);">EGP ${formatMoney(t.item_price)}</strong></div>
                    <div style="grid-column: 1 / -1;">Item: <strong style="color: var(--text-main);">${escapeHTML(t.item_name || '-')}</strong></div>
                    <div>Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.mapping || '-')}</strong></div>
                    <div>2nd Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.second_mapping || '-')}</strong></div>
                </div>
            `;
        } catch (err) {
            if (reqId !== this.fixPreviewReqId) return;
            previewEl.style.display = 'none';
        }
    }

    async updateFixIdFeedback(rawId) {
        const val = String(rawId || '').trim();
        const fbEl = document.getElementById('fix-id-feedback');
        const reqId = (this.fixIdReqId = (this.fixIdReqId || 0) + 1);
        if (!fbEl) return;

        if (!val) {
            fbEl.style.display = 'none';
            fbEl.innerHTML = '';
            return;
        }

        const status = validateID(val);
        fbEl.style.display = 'block';

        if (status !== 'Valid') {
            fbEl.style.background = 'rgba(239, 68, 68, 0.12)';
            fbEl.style.border = '1px solid rgba(239, 68, 68, 0.35)';
            fbEl.style.color = '#ef4444';
            fbEl.innerHTML = `⚠️ <strong>${escapeHTML(status)}</strong> — Saving this ID will mark the transaction as an Error.`;
            return;
        }

        fbEl.style.background = 'rgba(16, 185, 129, 0.12)';
        fbEl.style.border = '1px solid rgba(16, 185, 129, 0.35)';
        fbEl.style.color = '#10b981';
        fbEl.innerHTML = `✅ Valid 9-digit Student ID format. Checking Student Master...`;

        try {
            const { data: student, error } = await supabase
                .from('student_master')
                .select('student_id, full_name, faculty, status')
                .eq('student_id', val)
                .maybeSingle();
            if (reqId !== this.fixIdReqId) return;
            if (!error && student) {
                const fac = student.faculty ? ` • ${escapeHTML(student.faculty)}` : '';
                fbEl.innerHTML = `✅ <strong>Valid ID</strong> — ${escapeHTML(student.full_name || 'Student')}${fac}`;
            } else {
                fbEl.innerHTML = `✅ <strong>Valid 9-digit ID format</strong> <span style="opacity: 0.85;">(Not found in Student Master list)</span>`;
            }
        } catch (err) {
            if (reqId !== this.fixIdReqId) return;
            fbEl.innerHTML = `✅ <strong>Valid 9-digit ID format</strong>`;
        }
    }

    async updateFixItemSuggestion(rawName) {
        const query = normalizeItemName(rawName);
        const suggestEl = document.getElementById('fix-item-suggestion');
        if (!suggestEl) return;
        if (!query) {
            suggestEl.style.display = 'none';
            return;
        }
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
        } catch (e) {
            suggestEl.style.display = 'none';
            return;
        }
        const normQuery = query.toLowerCase();
        const match = (this.allMappingsData || []).find(m =>
            (m.item_name && normalizeItemName(m.item_name).toLowerCase() === normQuery) ||
            (m.adjusted_item_name && normalizeItemName(m.adjusted_item_name).toLowerCase() === normQuery)
        );
        if (match && (match.mapping || match.second_mapping)) {
            const mapInput = document.getElementById('fix-mapping');
            const secInput = document.getElementById('fix-second-mapping');
            // Auto-fill if both mapping inputs are currently empty
            if (mapInput && !mapInput.value.trim() && !secInput?.value.trim()) {
                mapInput.value = match.mapping || '';
                if (secInput && match.second_mapping) secInput.value = match.second_mapping;
                suggestEl.style.display = 'none';
                Toast.show(`Auto-filled Mapping "${match.mapping}" from Item Mappings`, 'info');
                return;
            }
            const curMap = mapInput?.value.trim() || '';
            const curSec = secInput?.value.trim() || '';
            if (curMap !== (match.mapping || '') || curSec !== (match.second_mapping || '')) {
                const secLabel = match.second_mapping ? ` / "${match.second_mapping}"` : '';
                suggestEl.innerText = `💡 Click to fill Mapping "${match.mapping || '-'}"${secLabel} from Item Mappings`;
                suggestEl.style.display = 'block';
                suggestEl.onclick = () => {
                    if (mapInput) mapInput.value = match.mapping || '';
                    if (secInput) secInput.value = match.second_mapping || '';
                    suggestEl.style.display = 'none';
                    Toast.show('Applied Mapping from Item Mappings!', 'success');
                };
            } else {
                suggestEl.style.display = 'none';
            }
        } else {
            suggestEl.style.display = 'none';
        }
    }

    initModals() {
        // Close modals on backdrop click or Escape key
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target !== modal) return;
                if (modal.id === 'modal-custom-confirm') {
                    document.getElementById('btn-custom-confirm-cancel')?.click();
                } else if (modal.id !== 'modal-import' || !this.isImporting) {
                    modal.classList.add('hidden');
                }
            });
        });

        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const confirmModal = document.getElementById('modal-custom-confirm');
            if (confirmModal && !confirmModal.classList.contains('hidden')) return; // handled by customConfirm
            const openModals = Array.from(document.querySelectorAll('.modal:not(.hidden)'));
            if (openModals.length === 0) return;
            // Close only the topmost open modal (highest z-index, or last in DOM on tie)
            openModals.sort((a, b) => {
                const zA = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
                const zB = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
                return zA - zB;
            });
            const topModal = openModals[openModals.length - 1];
            if (topModal.id === 'modal-import' && this.isImporting) return;
            topModal.classList.add('hidden');
        });

        // Open Mapping Modal
        document.getElementById('btn-add-mapping').addEventListener('click', () => {
            this.resetMappingModal('Add Mapping');
            document.getElementById('modal-mapping').classList.remove('hidden');
        });

        // Smart Mapping Auto-Suggest & Live Duplicate Detection
        let suggestTimeout;
        document.getElementById('map-original').addEventListener('input', (e) => {
            clearTimeout(suggestTimeout);
            suggestTimeout = setTimeout(async () => {
                const query = normalizeItemName(e.target.value);
                const suggestDiv = document.getElementById('mapping-suggestion');
                const dupWarn = document.getElementById('mapping-duplicate-warning');

                try {
                    if (!this.allMappingsData) {
                        this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
                    }
                    if (!this.mappingSuggestCache) {
                        this.mappingSuggestCache = this.allMappingsData.filter(m => m.mapping);
                    }
                } catch (err) {
                    if (suggestDiv) suggestDiv.style.display = 'none';
                    if (dupWarn) dupWarn.style.display = 'none';
                    return;
                }

                // 1. Live duplicate / adjusted-item check
                if (dupWarn) {
                    const conflict = this.findConflictingMapping(query, this.editingMappingOriginalName);
                    if (conflict) {
                        const r = conflict.rule;
                        if (conflict.type === 'direct') {
                            dupWarn.innerText = `⚠️ "${r.item_name}" already exists in Item Mappings. Click here to edit the original mapping instead.`;
                        } else {
                            dupWarn.innerText = `⚠️ "${query}" is already the Adjusted Item Name for original item "${r.item_name}". Click here to edit "${r.item_name}" instead.`;
                        }
                        dupWarn.style.display = 'block';
                        dupWarn.onclick = () => {
                            const curAdj = normalizeItemName(document.getElementById('map-adjusted').value);
                            const curCat = normalizeItemName(document.getElementById('map-category').value);
                            const curSec = normalizeItemName(document.getElementById('map-second-category').value);
                            this.openMappingModalForEdit(r, {
                                adjusted_item_name: curAdj || r.adjusted_item_name || '',
                                mapping: curCat || r.mapping || '',
                                second_mapping: curSec || r.second_mapping || ''
                            });
                            Toast.show(`Switched to editing original mapping "${r.item_name}"`, 'info');
                        };
                    } else {
                        dupWarn.style.display = 'none';
                    }
                }

                // 2. Smart Fuzzy Suggestion
                if (!suggestDiv) return;
                if (query.length < 3 || typeof Fuse === 'undefined') {
                    suggestDiv.style.display = 'none';
                    return;
                }
                const fuse = new Fuse(this.mappingSuggestCache || [], { keys: ['item_name'], threshold: 0.3 });
                const results = fuse.search(query).filter(r => normalizeItemName(r.item.item_name).toLowerCase() !== query.toLowerCase());
                if (results.length > 0) {
                    const topMatch = results[0].item;
                    const secLabel = topMatch.second_mapping ? ` / "${topMatch.second_mapping}"` : '';
                    suggestDiv.innerText = `💡 Smart Suggestion: Click to map to "${topMatch.mapping}"${secLabel} (similar to ${topMatch.item_name})`;
                    suggestDiv.style.display = 'block';
                    suggestDiv.onclick = () => {
                        document.getElementById('map-category').value = topMatch.mapping || '';
                        if (topMatch.second_mapping && !document.getElementById('map-second-category').value.trim()) {
                            document.getElementById('map-second-category').value = topMatch.second_mapping;
                        }
                        suggestDiv.style.display = 'none';
                        Toast.show('Applied Smart Suggestion!', 'success');
                    };
                } else {
                    suggestDiv.style.display = 'none';
                }
            }, 250);
        });

        // Open Fix Modal
        document.getElementById('btn-add-fix').addEventListener('click', () => {
            this.resetFixModal('Add Fix');
            document.getElementById('modal-fix').classList.remove('hidden');
        });

        // Live Transaction Preview & Duplicate Fix Detection on #fix-ref
        let fixRefTimeout;
        document.getElementById('fix-ref')?.addEventListener('input', (e) => {
            clearTimeout(fixRefTimeout);
            fixRefTimeout = setTimeout(() => {
                this.updateFixRefPreview(e.target.value);
            }, 250);
        });

        // Live Student ID Validation & Student Master Lookup on #fix-id
        let fixIdTimeout;
        document.getElementById('fix-id')?.addEventListener('input', (e) => {
            clearTimeout(fixIdTimeout);
            fixIdTimeout = setTimeout(() => {
                this.updateFixIdFeedback(e.target.value);
            }, 250);
        });

        // Smart Item Mapping Auto-Fill on #fix-name
        let fixNameTimeout;
        document.getElementById('fix-name')?.addEventListener('input', (e) => {
            clearTimeout(fixNameTimeout);
            fixNameTimeout = setTimeout(() => {
                this.updateFixItemSuggestion(e.target.value);
            }, 200);
        });

        // Save Mapping (with duplicate & chained-name prevention)
        const btnSaveMapping = document.getElementById('btn-save-mapping');
        btnSaveMapping.addEventListener('click', async () => {
            const original = normalizeItemName(document.getElementById('map-original').value);
            let adjusted = normalizeItemName(document.getElementById('map-adjusted').value);
            const category = normalizeItemName(document.getElementById('map-category').value);
            const secondCategory = normalizeItemName(document.getElementById('map-second-category').value);

            if (!original) return Toast.show('Original Item Name is required', 'warning');

            // Prevent redundant self-rename
            if (adjusted && adjusted.toLowerCase() === original.toLowerCase()) {
                adjusted = '';
            }

            btnSaveMapping.disabled = true;
            try {
                if (!this.allMappingsData) {
                    this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
                }

                // Check if original item name conflicts with an existing item_name or adjusted_item_name
                const conflict = this.findConflictingMapping(original, this.editingMappingOriginalName);
                if (conflict) {
                    const r = conflict.rule;
                    const msg = conflict.type === 'direct'
                        ? `A mapping for "${r.item_name}" already exists. Duplicate item names are not allowed.\n\nWould you like to edit the original mapping "${r.item_name}" instead?`
                        : `"${original}" is already the Adjusted Item Name for original item "${r.item_name}".\n\nTo prevent duplicate rules, would you like to edit the original mapping "${r.item_name}" instead?`;

                    const switchToOriginal = await window.customConfirm(msg, 'Edit Original Mapping', 'Cancel');
                    if (switchToOriginal) {
                        this.openMappingModalForEdit(r, {
                            adjusted_item_name: adjusted || r.adjusted_item_name || '',
                            mapping: category || r.mapping || '',
                            second_mapping: secondCategory || r.second_mapping || ''
                        });
                        Toast.show(`Loaded original mapping "${r.item_name}". Click Save Mapping to confirm your changes.`, 'info');
                    }
                    return;
                }

                // Also check if the user entered an Adjusted Item Name that is itself another rule's Original Item Name
                if (adjusted) {
                    const adjConflict = (this.allMappingsData || []).find(m =>
                        m.item_name !== (this.editingMappingOriginalName || original) &&
                        normalizeItemName(m.item_name).toLowerCase() === adjusted.toLowerCase()
                    );
                    if (adjConflict && (adjConflict.mapping !== (category || null) || adjConflict.second_mapping !== (secondCategory || null))) {
                        const ok = await window.customConfirm(
                            `Note: Adjusted Item Name "${adjusted}" also exists as an Original Item Name with category "${adjConflict.mapping || 'None'}". Continue saving?`,
                            'Save Anyway', 'Cancel'
                        );
                        if (!ok) return;
                    }
                }

                const oldEditingKey = this.editingMappingOriginalName;
                const isRenamingKey = oldEditingKey && oldEditingKey !== original;
                const lookupKeys = isRenamingKey ? [oldEditingKey, original] : [original];
                const previouslyRenamedTo = await this.getCurrentAdjustedNames(lookupKeys);

                if (isRenamingKey) {
                    const { error: delErr } = await supabase.from('item_mappings').delete().eq('item_name', oldEditingKey);
                    if (delErr) throw delErr;
                }

                const { error } = await supabase.from('item_mappings').upsert([{
                    item_name: original,
                    adjusted_item_name: adjusted || null,
                    mapping: category || null,
                    second_mapping: secondCategory || null
                }], { onConflict: 'item_name', ignoreDuplicates: false });
                if (error) throw error;

                await this.logAudit(
                    oldEditingKey ? 'Mapping Updated' : 'Single Mapping Added',
                    original,
                    { previous_item_name: oldEditingKey || undefined, original, adjusted, category, secondCategory }
                );

                // Re-apply rules to every affected transaction (fetch everything first, then update)
                const rows = await this.fetchTransactionsForItemNames(lookupKeys, [...previouslyRenamedTo, adjusted]);
                const result = await this.reapplyRulesTo(rows);

                this.mappingSuggestCache = null; // rules changed – reload suggestions next time
                Toast.show(`Mapping saved. ${this.reapplySummary(result)}`, 'success');
                document.getElementById('modal-mapping').classList.add('hidden');
                this.resetMappingModal();
                this.loadMappings();
            } catch (err) {
                Toast.show('Error saving mapping: ' + err.message, 'error');
            } finally {
                btnSaveMapping.disabled = false;
            }
        });

        // Save Fix (with live ID validation, duplicate protection, and reference rename cleanup)
        const btnSaveFix = document.getElementById('btn-save-fix');
        btnSaveFix.addEventListener('click', async () => {
            const ref = document.getElementById('fix-ref').value.trim();
            const correctId = document.getElementById('fix-id').value.trim();
            const correctName = normalizeItemName(document.getElementById('fix-name').value);
            const correctMapping = normalizeItemName(document.getElementById('fix-mapping').value);
            const correctSecondMapping = normalizeItemName(document.getElementById('fix-second-mapping').value);

            if (!ref) return Toast.show('Reference Number is required', 'warning');
            if (!correctId && !correctName && !correctMapping && !correctSecondMapping) {
                return Toast.show('Enter at least one value to correct', 'warning');
            }

            if (correctId) {
                const idStatus = validateID(correctId);
                if (idStatus !== 'Valid') {
                    const proceedInvalid = await window.customConfirm(
                        `The Student ID "${correctId}" is invalid (${idStatus}). Saving this ID will mark the transaction status as Error.\n\nDo you still want to save this ID?`,
                        'Save Anyway', 'Cancel'
                    );
                    if (!proceedInvalid) return;
                }
            }

            btnSaveFix.disabled = true;
            try {
                const isEditMode = document.getElementById('modal-fix-title').innerText === 'Edit Fix';
                const oldEditingRef = this.editingFixOriginalRef;
                const isRenamingRef = isEditMode && oldEditingRef && oldEditingRef !== ref;

                const { data: existing, error: existErr } = await supabase.from('manual_fixes').select('*').eq('reference_number', ref).maybeSingle();
                if (existErr) throw existErr;
                if (existing && (!isEditMode || isRenamingRef)) {
                    if (!await window.customConfirm(`A manual fix for reference "${ref}" already exists. Do you want to update the existing fix?`, 'Update Existing', 'Cancel')) {
                        return;
                    }
                }

                if (isRenamingRef) {
                    const { error: delErr } = await supabase.from('manual_fixes').delete().eq('reference_number', oldEditingRef);
                    if (delErr) throw delErr;
                }

                // When adding a partial fix to an existing reference (not full Edit Mode), preserve existing non-empty fields
                const mergedFix = (existing && !isEditMode) ? {
                    reference_number: ref,
                    correct_id: correctId || existing.correct_id || null,
                    item_name: correctName || existing.item_name || null,
                    mapping: correctMapping || existing.mapping || null,
                    second_mapping: correctSecondMapping || existing.second_mapping || null
                } : {
                    reference_number: ref,
                    correct_id: correctId || null,
                    item_name: correctName || null,
                    mapping: correctMapping || null,
                    second_mapping: correctSecondMapping || null
                };

                const { error } = await supabase.from('manual_fixes').upsert([mergedFix], { onConflict: 'reference_number', ignoreDuplicates: false });
                if (error) throw error;

                await this.logAudit(
                    isEditMode ? 'Manual Fix Updated' : 'Single Manual Fix Added',
                    ref,
                    isRenamingRef ? { ...mergedFix, previous_reference_number: oldEditingRef } : mergedFix
                );

                // Re-apply all rules to affected reference number(s)
                const affectedRefs = isRenamingRef ? [oldEditingRef, ref] : [ref];
                const rows = await fetchByIn('transactions', '*', 'reference_number', affectedRefs);
                const all = await recomputeTransactions(rows, { includeLocked: true });
                const lockedChanges = all.filter(c => c.diff.locked);
                let applyToLocked = false;

                if (lockedChanges.length > 0) {
                    applyToLocked = await window.customConfirm(
                        `Transaction "${ref}" is settled or already recorded in ERP. Changing it here will NOT change what was already posted to ERP. Do you want to apply this fix to the transaction anyway?`,
                        'Apply Anyway', 'Leave Unchanged'
                    );
                }

                const toApply = applyToLocked ? all : all.filter(c => !c.diff.locked);
                const updated = toApply.length > 0 ? await updateRuleFields(toApply) : 0;
                if (updated > 0) this.invalidateDistinctCache();

                const lockedSkipped = all.length - toApply.length;
                let summaryMsg = `${updated} transaction(s) updated.`;
                if (lockedSkipped > 0) summaryMsg += ` ${lockedSkipped} settled/ERP-recorded transaction(s) left unchanged.`;

                Toast.show(`Manual fix saved. ${summaryMsg}`, 'success');
                document.getElementById('modal-fix').classList.add('hidden');
                this.resetFixModal();
                this.loadFixes();
                if (document.getElementById('view-transactions')?.classList.contains('active')) {
                    this.loadTransactions();
                }
            } catch (err) {
                Toast.show('Error saving fix: ' + err.message, 'error');
            } finally {
                btnSaveFix.disabled = false;
            }
        });
    }

    initBulkUploads() {
        const handleUpload = async (e, type) => {
            const input = e.target;
            const file = input.files[0];
            if (!file) return;
            input.value = ''; // Reset so the same file can be selected again

            if (this.isBulkUploading) {
                Toast.show('An upload is already in progress. Please wait.', 'warning');
                return;
            }
            this.isBulkUploading = true;

            const getVal = (row, keyStr) => {
                const exact = row[keyStr];
                if (exact !== undefined && exact !== "") return exact;
                const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
                const foundKey = Object.keys(row).find(k => norm(k) === norm(keyStr));
                const v = foundKey ? row[foundKey] : null;
                return v === "" ? null : v;
            };
            const clean = v => (v === null || v === undefined) ? null : (String(v).trim() || null);

            const chunkSize = 500;
            let processed = 0;
            let inserted = 0;

            try {
                const buffer = await file.arrayBuffer();
                const workbook = XLSX.read(buffer, { type: 'array' });
                const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

                if (data.length === 0) {
                    Toast.show('File is empty!', 'warning');
                    return;
                }

                Toast.show('Uploading... please wait.', 'info');

                if (type === 'mappings') {
                    const existingAll = await fetchAll('item_mappings', '*', null, 'item_name');
                    const existingByNorm = new Map();
                    const existingByAdjNorm = new Map();
                    for (const ex of existingAll) {
                        const nk = normalizeItemName(ex.item_name).toLowerCase();
                        if (nk) existingByNorm.set(nk, ex);
                        if (ex.adjusted_item_name) {
                            const ak = normalizeItemName(ex.adjusted_item_name).toLowerCase();
                            if (ak) existingByAdjNorm.set(ak, ex);
                        }
                    }

                    const byNormKey = new Map();
                    let redirectedFromAdjusted = 0;
                    data.forEach(row => {
                        let item_name = normalizeItemName(getVal(row, 'Item Name'));
                        if (!item_name) return;
                        let adjusted_item_name = normalizeItemName(getVal(row, 'Adjusted Item Name')) || null;
                        const mapping = normalizeItemName(getVal(row, 'Mapping')) || null;
                        const second_mapping = normalizeItemName(getVal(row, '2nd Mapping')) || null;

                        let nk = item_name.toLowerCase();
                        // If the uploaded Item Name is actually an existing (or earlier uploaded) rule's Adjusted Item Name, target the original rule!
                        if (!existingByNorm.has(nk) && existingByAdjNorm.has(nk)) {
                            const origRule = existingByAdjNorm.get(nk);
                            adjusted_item_name = adjusted_item_name || item_name;
                            item_name = origRule.item_name;
                            nk = normalizeItemName(item_name).toLowerCase();
                            redirectedFromAdjusted++;
                        } else if (existingByNorm.has(nk)) {
                            item_name = existingByNorm.get(nk).item_name;
                        }

                        if (adjusted_item_name && adjusted_item_name.toLowerCase() === nk) {
                            adjusted_item_name = null;
                        }

                        const prev = byNormKey.get(nk);
                        const mergedEntry = {
                            item_name,
                            adjusted_item_name: adjusted_item_name || (prev ? prev.adjusted_item_name : null),
                            mapping: mapping || (prev ? prev.mapping : null),
                            second_mapping: second_mapping || (prev ? prev.second_mapping : null)
                        };
                        byNormKey.set(nk, mergedEntry);
                        if (mergedEntry.adjusted_item_name) {
                            existingByAdjNorm.set(mergedEntry.adjusted_item_name.toLowerCase(), mergedEntry);
                        }
                    });

                    const uploadedMappings = Array.from(byNormKey.values());
                    const matchingExistingCount = uploadedMappings.filter(m => existingByNorm.has(normalizeItemName(m.item_name).toLowerCase())).length;

                    let mappingsToProcess = uploadedMappings;
                    if (matchingExistingCount > 0) {
                        const extraNote = redirectedFromAdjusted > 0 ? ` (${redirectedFromAdjusted} row(s) matched an Adjusted Item Name and were linked to their Original Item Name)` : '';
                        const overwrite = await window.customConfirm(
                            `Found ${matchingExistingCount} item mapping(s) that already exist in the database${extraNote}. Do you want to update them with the new values?`,
                            'Update Existing', 'Skip Existing'
                        );
                        if (!overwrite) {
                            mappingsToProcess = uploadedMappings.filter(m => !existingByNorm.has(normalizeItemName(m.item_name).toLowerCase()));
                        } else {
                            // Merge blank cells with existing values so partial bulk uploads don't wipe existing fields
                            mappingsToProcess = uploadedMappings.map(m => {
                                const old = existingByNorm.get(normalizeItemName(m.item_name).toLowerCase());
                                if (!old) return m;
                                return {
                                    item_name: old.item_name,
                                    adjusted_item_name: m.adjusted_item_name || old.adjusted_item_name || null,
                                    mapping: m.mapping || old.mapping || null,
                                    second_mapping: m.second_mapping || old.second_mapping || null
                                };
                            });
                        }
                    }

                    if (mappingsToProcess.length === 0) {
                        Toast.show('No new item mappings to process.', 'info');
                        return;
                    }

                    processed = mappingsToProcess.length;
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames(mappingsToProcess.map(m => m.item_name));

                    for (let i = 0; i < mappingsToProcess.length; i += chunkSize) {
                        const chunk = mappingsToProcess.slice(i, i + chunkSize);
                        const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                        if (error) throw new Error(`Only ${inserted} of ${mappingsToProcess.length} mappings saved. ${error.message}`);
                        inserted += chunk.length;
                    }

                    // Fetch ALL affected transactions first, then update (no paging while modifying)
                    const rows = await this.fetchTransactionsForItemNames(mappingsToProcess.map(m => m.item_name), [...previouslyRenamedTo, ...mappingsToProcess.map(m => m.adjusted_item_name)]);
                    const result = await this.reapplyRulesTo(rows);

                    await this.logAudit('Bulk Mappings Uploaded', `Batch of ${inserted} items`, { count: inserted, redirected_from_adjusted: redirectedFromAdjusted, transactions_updated: result.updated, locked_skipped: result.lockedSkipped });
                    this.mappingSuggestCache = null;
                    Toast.show(`Uploaded ${inserted} item mappings. ${this.reapplySummary(result)}`, 'success');
                    this.loadMappings();

                } else if (type === 'fixes') {
                    const byRef = new Map();
                    data.forEach(row => {
                        const rawRef = clean(getVal(row, 'Reference Number'));
                        const reference_number = rawRef ? String(rawRef).trim() : null;
                        if (!reference_number || reference_number === 'null') return;
                        const key = reference_number.toLowerCase();
                        const prev = byRef.get(key);
                        const correct_id = clean(getVal(row, 'Correct ID'));
                        const item_name = clean(getVal(row, 'Item Name')) ? normalizeItemName(clean(getVal(row, 'Item Name'))) : null;
                        const mapping = clean(getVal(row, 'Mapping')) ? normalizeItemName(clean(getVal(row, 'Mapping'))) : null;
                        const second_mapping = clean(getVal(row, '2nd Mapping')) ? normalizeItemName(clean(getVal(row, '2nd Mapping'))) : null;

                        if (!correct_id && !item_name && !mapping && !second_mapping && !prev) return;

                        byRef.set(key, {
                            reference_number: prev ? prev.reference_number : reference_number,
                            correct_id: correct_id || (prev ? prev.correct_id : null) || null,
                            item_name: item_name || (prev ? prev.item_name : null) || null,
                            mapping: mapping || (prev ? prev.mapping : null) || null,
                            second_mapping: second_mapping || (prev ? prev.second_mapping : null) || null
                        });
                    });
                    const fixes = Array.from(byRef.values());

                    const invalidIdFixes = fixes.filter(f => f.correct_id && validateID(f.correct_id) !== 'Valid');
                    if (invalidIdFixes.length > 0) {
                        const sampleRefs = invalidIdFixes.slice(0, 3).map(f => `${f.reference_number} (${f.correct_id})`).join(', ');
                        const proceedInvalid = await window.customConfirm(
                            `${invalidIdFixes.length} row(s) in your upload have an invalid Student ID format (e.g., ${sampleRefs}). Saving invalid IDs will mark those transactions as Error.\n\nDo you want to continue uploading them anyway?`,
                            'Upload Anyway', 'Cancel Upload'
                        );
                        if (!proceedInvalid) return;
                    }

                    const existingRows = await fetchByIn('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', 'reference_number', fixes.map(f => f.reference_number), 'reference_number', 500);
                    const existingMap = new Map(existingRows.map(r => [String(r.reference_number).trim().toLowerCase(), r]));

                    let fixesToProcess = fixes;
                    if (existingMap.size > 0) {
                        const overwrite = await window.customConfirm(`Found ${existingMap.size} fixes that already exist in the database. Do you want to update them with the new values?`, 'Update Existing', 'Skip Existing');
                        if (!overwrite) {
                            fixesToProcess = fixes.filter(f => !existingMap.has(String(f.reference_number).trim().toLowerCase()));
                        } else {
                            // Merge blank cells with existing values so partial bulk uploads don't wipe existing fields
                            fixesToProcess = fixes.map(f => {
                                const old = existingMap.get(String(f.reference_number).trim().toLowerCase());
                                if (!old) return f;
                                return {
                                    reference_number: old.reference_number || f.reference_number,
                                    correct_id: f.correct_id || old.correct_id || null,
                                    item_name: f.item_name || old.item_name || null,
                                    mapping: f.mapping || old.mapping || null,
                                    second_mapping: f.second_mapping || old.second_mapping || null
                                };
                            });
                        }
                    }

                    if (fixesToProcess.length === 0) {
                        Toast.show('No new fixes to process.', 'info');
                        return;
                    }
                    processed = fixesToProcess.length;

                    for (let i = 0; i < fixesToProcess.length; i += chunkSize) {
                        const chunk = fixesToProcess.slice(i, i + chunkSize);
                        const { error } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                        if (error) throw new Error(`Only ${inserted} of ${fixesToProcess.length} fixes saved. ${error.message}`);
                        inserted += chunk.length;
                    }

                    // Re-apply all rules to affected transactions (blank cells no longer wipe mappings)
                    const rows = await fetchByIn('transactions', '*', 'reference_number', fixesToProcess.map(f => f.reference_number));
                    const result = await this.reapplyRulesTo(rows);

                    await this.logAudit('Bulk Fixes Uploaded', `Batch of ${inserted} items`, { count: inserted, transactions_updated: result.updated, locked_skipped: result.lockedSkipped });
                    Toast.show(`Uploaded ${inserted} manual fixes. ${this.reapplySummary(result)}`, 'success');
                    this.loadFixes();
                }

                await this.recordBatch(file.name, type, processed, inserted, null);
            } catch (err) {
                Toast.show('Upload error: ' + err.message, 'error');
                await this.recordBatch(file.name, type, processed, inserted, err.message);
            } finally {
                this.isBulkUploading = false;
            }
        };

        document.getElementById('file-upload-mappings').addEventListener('change', (e) => handleUpload(e, 'mappings'));
        document.getElementById('file-upload-fixes').addEventListener('change', (e) => handleUpload(e, 'fixes'));

        // Templates
        document.getElementById('btn-template-mappings').addEventListener('click', () => {
            const worksheet = XLSX.utils.json_to_sheet([{
                "Item Name": "",
                "Adjusted Item Name": "",
                "Mapping": "",
                "2nd Mapping": ""
            }]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
            XLSX.writeFile(workbook, "Item_Mappings_Template.xlsx");
        });

        document.getElementById('btn-template-fixes').addEventListener('click', () => {
            const worksheet = XLSX.utils.json_to_sheet([{
                "Reference Number": "",
                "Correct ID": "",
                "Item Name": "",
                "Mapping": "",
                "2nd Mapping": ""
            }]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
            XLSX.writeFile(workbook, "Manual_Fixes_Template.xlsx");
        });

        // Manual Fixes Search, Filters, Deduplicate & Unresolved Transactions Panel
        const fixesSearch = document.getElementById('fixes-search');
        let fixesSearchTimeout;
        fixesSearch?.addEventListener('input', () => {
            clearTimeout(fixesSearchTimeout);
            fixesSearchTimeout = setTimeout(() => {
                this.fixesPage = 1;
                this.renderFixesPage();
            }, 250);
        });

        ['fixes-filter-type', 'fixes-filter-category'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.fixesPage = 1;
                this.renderFixesPage();
            });
        });

        document.getElementById('btn-clear-fixes-filters')?.addEventListener('click', () => {
            const s = document.getElementById('fixes-search');
            const t = document.getElementById('fixes-filter-type');
            const c = document.getElementById('fixes-filter-category');
            if (s) s.value = '';
            if (t) t.value = '';
            if (c) c.value = '';
            this.fixesPage = 1;
            this.renderFixesPage();
        });

        document.getElementById('btn-dedup-fixes')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dedup-fixes');
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Cleaning...';
            btn.disabled = true;
            if (window.lucide) lucide.createIcons({ root: btn });
            try {
                await this.deduplicateManualFixes({ silent: false });
            } finally {
                btn.innerHTML = origHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons({ root: btn });
            }
        });

        document.getElementById('btn-toggle-unresolved-tx-panel')?.addEventListener('click', () => {
            const panel = document.getElementById('unresolved-tx-panel');
            if (!panel) return;
            const willOpen = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            if (willOpen) this.loadUnresolvedTransactionsSummary();
        });

        document.getElementById('btn-close-unresolved-tx-panel')?.addEventListener('click', () => {
            document.getElementById('unresolved-tx-panel')?.classList.add('hidden');
        });

        // Item Mappings Search, Filters, Deduplicate & Unmapped Panel
        let mappingsSearchTimeout;
        document.getElementById('mappings-search')?.addEventListener('input', () => {
            clearTimeout(mappingsSearchTimeout);
            mappingsSearchTimeout = setTimeout(() => {
                this.mappingsPage = 1;
                this.renderMappingsPage();
            }, 250);
        });

        ['mappings-filter-category', 'mappings-filter-second-category', 'mappings-filter-type'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.mappingsPage = 1;
                this.renderMappingsPage();
            });
        });

        document.getElementById('btn-clear-mappings-filters')?.addEventListener('click', () => {
            const s = document.getElementById('mappings-search');
            const c1 = document.getElementById('mappings-filter-category');
            const c2 = document.getElementById('mappings-filter-second-category');
            const t = document.getElementById('mappings-filter-type');
            if (s) s.value = '';
            if (c1) c1.value = '';
            if (c2) c2.value = '';
            if (t) t.value = '';
            this.mappingsPage = 1;
            this.renderMappingsPage();
        });

        document.getElementById('btn-dedup-mappings')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dedup-mappings');
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Cleaning...';
            btn.disabled = true;
            if (window.lucide) lucide.createIcons({ root: btn });
            try {
                await this.deduplicateItemMappings({ silent: false });
            } finally {
                btn.innerHTML = origHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons({ root: btn });
            }
        });

        document.getElementById('btn-toggle-unmapped-panel')?.addEventListener('click', () => {
            const panel = document.getElementById('unmapped-items-panel');
            if (!panel) return;
            const willOpen = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            if (willOpen) this.loadUnmappedItemsSummary();
        });

        document.getElementById('btn-close-unmapped-panel')?.addEventListener('click', () => {
            document.getElementById('unmapped-items-panel')?.classList.add('hidden');
        });
    }

    initReapply() {
        const modal = document.getElementById('modal-reapply-preview');
        const tbody = document.getElementById('reapply-preview-table-body');
        const selectAll = document.getElementById('reapply-select-all');
        const summaryEl = document.getElementById('reapply-summary');
        const fmt = v => (v === null || v === undefined || v === '') ? 'Empty' : String(v);

        // Main "Re-apply Rules" button: compute a preview of every change
        document.getElementById('btn-reapply-rules').addEventListener('click', async () => {
            const btn = document.getElementById('btn-reapply-rules');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader"></i> Computing...';
            btn.disabled = true;

            try {
                await this.stripDatabaseTransactionTimes();
                await this.deduplicateItemMappings({ silent: true });
                const [mappings, fixes, links] = await Promise.all([
                    fetchAll('item_mappings', '*', null, 'item_name'),
                    fetchAll('manual_fixes', '*', null, 'reference_number'),
                    fetchAll('links', 'payment_reference_number, custom_input_value', null, 'payment_reference_number')
                ]);

                const fixesMap = new Map(fixes.map(f => [String(f.reference_number), f]));
                const linksMap = new Map(links.map(l => [String(l.payment_reference_number), l]));
                const lookupMapping = buildMappingLookup(mappings);

                // Fetch every transaction (sequential pages – a failed page stops the run instead of being skipped)
                const txs = await fetchAll('transactions', '*', null, 'id');

                // Same pure function as import / fix save / mapping save: starts from the ORIGINAL
                // imported ID and item name, so removed links, fixes and rules are undone too.
                const proposals = [];
                for (const tx of txs) {
                    const ref = String(tx.reference_number);
                    const diff = diffTransaction(tx, { link: linksMap.get(ref), fix: fixesMap.get(ref), lookupMapping });
                    if (diff.changed) proposals.push({ tx, diff });
                }
                window.reapplyProposals = proposals;

                if (proposals.length === 0) {
                    Toast.show('No rules need to be applied. Everything is up to date!', 'info');
                    return;
                }

                const lockedCount = proposals.filter(p => p.diff.locked).length;
                if (summaryEl) {
                    summaryEl.textContent = `${proposals.length} transaction(s) would change.` +
                        (lockedCount > 0 ? ` ${lockedCount} of them are settled or already recorded in ERP and are not selected by default – changing them does not change what was already posted to ERP.` : '');
                }

                tbody.innerHTML = proposals.map((p, idx) => {
                    const { tx, diff } = p;
                    const lockBadge = diff.locked
                        ? ` <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: var(--warning, #f59e0b);">${tx.erp_batch_number ? 'In ERP' : 'Settled'}</span>`
                        : '';
                    return `
                        <tr>
                            <td><input type="checkbox" class="reapply-checkbox" data-index="${idx}" ${diff.locked ? '' : 'checked'}></td>
                            <td>${escapeHTML(tx.reference_number || '')}${lockBadge}</td>
                            <td><span class="badge" style="background: rgba(0, 229, 255, 0.1); color: var(--primary-color);">${escapeHTML(diff.changes.map(c => c.label).join(', '))}</span></td>
                            <td style="color: var(--text-muted); text-decoration: line-through;">${escapeHTML(diff.changes.map(c => fmt(c.from)).join(', '))}</td>
                            <td style="color: var(--success-color); font-weight: 500;">${escapeHTML(diff.changes.map(c => fmt(c.to)).join(', '))}</td>
                            <td style="font-size: 0.85rem; color: var(--text-muted);">${escapeHTML(diff.reasons.join(' + '))}</td>
                        </tr>
                    `;
                }).join('');

                // "Select all" reflects the rows as rendered (locked rows start unticked)
                if (selectAll) {
                    selectAll.checked = lockedCount === 0;
                    selectAll.indeterminate = lockedCount > 0 && lockedCount < proposals.length;
                }

                modal.classList.remove('hidden');
                if (window.lucide) lucide.createIcons();

            } catch (err) {
                Toast.show('Error computing rules: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });

        // "Select All" checkbox
        selectAll?.addEventListener('change', (e) => {
            e.target.indeterminate = false;
            document.querySelectorAll('.reapply-checkbox').forEach(cb => cb.checked = e.target.checked);
        });

        // "Apply Selected" button: writes only the rule columns of the selected rows
        document.getElementById('btn-apply-reapply-fixes')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-apply-reapply-fixes');
            const originalText = btn.innerHTML;

            const selected = Array.from(document.querySelectorAll('.reapply-checkbox:checked'))
                .map(cb => (window.reapplyProposals || [])[parseInt(cb.getAttribute('data-index'), 10)])
                .filter(Boolean);

            if (selected.length === 0) {
                Toast.show('No transactions selected.', 'info');
                modal.classList.add('hidden');
                return;
            }

            const lockedSelected = selected.filter(p => p.diff.locked).length;
            if (lockedSelected > 0) {
                const ok = await window.customConfirm(
                    `${lockedSelected} of the selected transactions are settled or already recorded in ERP. Changing them here will NOT change what was already posted to ERP. Continue?`,
                    'Apply Anyway', 'Cancel');
                if (!ok) return;
            }

            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Applying...';
            btn.disabled = true;
            try {
                const updatedCount = await updateRuleFields(selected.map(p => ({ id: p.tx.id, fields: p.diff.fields })));
                this.invalidateDistinctCache();

                await this.logAudit('Rules Re-applied', `Batch of ${updatedCount} transactions`, {
                    count: updatedCount,
                    locked_included: lockedSelected
                });

                Toast.show(`Successfully updated ${updatedCount} transactions!`, 'success');
                modal.classList.add('hidden');
                window.reapplyProposals = [];
                this.loadTransactions();

            } catch (err) {
                Toast.show('Error applying rules: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });
    }


    initFilters() {
        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            this.currentPage = 1;
            this.renderFilterChips('transactions');
            this.loadTransactions();
        });
        document.getElementById('btn-clear-filters').addEventListener('click', () => {
            document.getElementById('filter-date-from').value = '';
            document.getElementById('filter-date-to').value = '';
            document.getElementById('search-input').value = '';
            this.headerFilters.transactions = {};
            document.querySelectorAll('[data-table="transactions"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.currentPage = 1;
            this.renderFilterChips('transactions');
            this.loadTransactions();
        });

        document.getElementById('btn-clear-automatcher')?.addEventListener('click', () => {
            document.getElementById('automatcher-date-from').value = '';
            document.getElementById('automatcher-date-to').value = '';
            document.getElementById('automatcher-search').value = '';
            const toggle = document.getElementById('automatch-toggle-unmatched');
            if (toggle) toggle.checked = false;
            this.headerFilters.automatch = {};
            document.querySelectorAll('[data-table="automatch"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.renderFilterChips('automatch');
            this.runAutoMatcher();
        });

        let automatchSearchTimeout;
        document.getElementById('automatcher-search')?.addEventListener('input', () => {
            clearTimeout(automatchSearchTimeout);
            automatchSearchTimeout = setTimeout(() => {
                this.runAutoMatcher();
            }, 300);
        });

        document.getElementById('automatcher-date-from')?.addEventListener('change', () => this.runAutoMatcher());
        document.getElementById('automatcher-date-to')?.addEventListener('change', () => this.runAutoMatcher());

        const searchInput = document.getElementById('search-input');
        let searchTimeout;
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.currentPage = 1;
                this.loadTransactions();
            }, 500);
        });

        // Make date filters auto-update on change like the search input
        document.getElementById('filter-date-from')?.addEventListener('change', () => {
            this.currentPage = 1;
            this.loadTransactions();
        });
        document.getElementById('filter-date-to')?.addEventListener('change', () => {
            this.currentPage = 1;
            this.loadTransactions();
        });

        this.setupHeaderFilters();
    }

    setupHeaderFilters() {
        let popover = document.getElementById('global-header-filter-popover');
        if (!popover) {
            popover = document.createElement('div');
            popover.id = 'global-header-filter-popover';
            popover.className = 'header-filter-popover';
            popover.innerHTML = `
                <input type="text" class="header-filter-search" placeholder="Search...">
                <div class="header-filter-list"></div>
                <div class="header-filter-actions">
                    <button class="btn btn-outline" id="hfp-clear">Clear</button>
                    <button class="btn btn-primary" id="hfp-apply">Apply</button>
                </div>
            `;
            document.body.appendChild(popover);
        }

        const searchInput = popover.querySelector('.header-filter-search');
        const listContainer = popover.querySelector('.header-filter-list');
        const btnClear = document.getElementById('hfp-clear');
        const btnApply = document.getElementById('hfp-apply');

        let currentWrapper = null;
        let currentTable = null;
        let currentColumn = null;

        const renderList = async (searchTerm = '') => {
            let options = [];
            
            if (currentColumn === 'id_status') {
                options = ['Valid', 'Missing ID', 'Error'];
                if (searchTerm) options = options.filter(opt => opt.toLowerCase().includes(searchTerm.toLowerCase()));
            }
            else if (currentColumn === 'proposed_fix') {
                options = ['Has Proposed Match', 'No Match Found'];
                if (searchTerm) options = options.filter(opt => opt.toLowerCase().includes(searchTerm.toLowerCase()));
            }
            else if (currentColumn === 'bank') {
                options = ['NUADIB64', 'NUADCB136'];
                if (searchTerm) options = options.filter(opt => opt.toLowerCase().includes(searchTerm.toLowerCase()));
            }
            else if (currentColumn === 'is_settled') {
                options = ['Yes', 'No'];
                if (searchTerm) options = options.filter(opt => opt.toLowerCase().includes(searchTerm.toLowerCase()));
            }
            else if (currentTable === 'transactions' && ['mapping', 'item_name', 'second_mapping'].includes(currentColumn)) {
                // Prefer fast server-side DISTINCT via RPC, with fallback to paginated scan + 5-min cache
                listContainer.innerHTML = '<div style="padding: 1rem; text-align: center;"><i data-lucide="loader" class="spin"></i> Loading...</div>';
                if (window.lucide) lucide.createIcons();
                try {
                    this.distinctCache = this.distinctCache || {};
                    const cached = this.distinctCache[currentColumn];
                    if (!cached || Date.now() - cached.at > 5 * 60 * 1000) {
                        let values = null;
                        if (typeof supabase.rpc === 'function') {
                            const { data: rpcVals, error: rpcErr } = await supabase.rpc('get_distinct_transaction_values', { col_name: currentColumn });
                            if (!rpcErr && Array.isArray(rpcVals)) {
                                values = rpcVals.map(r => r.val ?? r[currentColumn] ?? r).filter(v => v !== null && v !== undefined && v !== '').sort();
                            }
                        }
                        if (!values) {
                            const rows = await fetchAll('transactions', currentColumn, null, 'id');
                            values = [...new Set(rows.map(r => r[currentColumn]).filter(v => v !== null && v !== undefined && v !== ''))].sort();
                        }
                        this.distinctCache[currentColumn] = {
                            at: Date.now(),
                            values
                        };
                    }
                    options = [...this.distinctCache[currentColumn].values];
                } catch (e) {
                    console.error('Error fetching distinct filter values', e);
                }
                if (searchTerm) options = options.filter(opt => String(opt).toLowerCase().includes(searchTerm.toLowerCase()));
            }
            else {
                listContainer.innerHTML = '<div style="padding: 1rem; text-align: center;"><i data-lucide="loader" class="spin"></i> Loading...</div>';
                if (window.lucide) lucide.createIcons();
                
                try {
                    if (currentTable === 'automatch' && this.invalidTx) {
                        options = [...new Set(this.invalidTx.map(t => t[currentColumn]).filter(v => v !== null && v !== undefined))].sort();
                        if (searchTerm) {
                            options = options.filter(opt => String(opt).toLowerCase().includes(searchTerm.toLowerCase()));
                        }
                    } else {
                        let query = supabase.from('transactions').select(currentColumn);
                        if (searchTerm) {
                            if (currentColumn === 'item_price') {
                                if (!isNaN(searchTerm)) query = query.eq(currentColumn, Number(searchTerm));
                            } else if (currentColumn === 'payment_date') {
                                query = query.eq(currentColumn, searchTerm);
                            } else {
                                query = query.ilike(currentColumn, `%${searchTerm}%`);
                            }
                        }
                        const { data, error } = await query.limit(100);
                        if (!error && data) {
                            options = [...new Set(data.map(d => d[currentColumn]).filter(v => v !== null && v !== undefined))].sort();
                        }
                    }
                } catch (e) {
                    console.error('Error fetching dynamic filter values', e);
                }
            }

            const selectedSet = new Set(this.headerFilters[currentTable][currentColumn] || []);

            if (options.length === 0) {
                listContainer.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">No options found</div>';
                return;
            }

            listContainer.innerHTML = options.map(opt => `
                <label>
                    <input type="checkbox" value="${escapeHTML(String(opt))}" ${selectedSet.has(String(opt)) ? 'checked' : ''}>
                    ${escapeHTML(String(opt))}
                </label>
            `).join('');
        };

        const closePopover = () => {
            popover.classList.remove('open');
            currentWrapper = null;
        };

        document.querySelectorAll('.th-filter-wrapper').forEach(wrapper => {
            wrapper.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentWrapper === wrapper) {
                    closePopover();
                    return;
                }
                
                currentWrapper = wrapper;
                currentTable = wrapper.dataset.table;
                currentColumn = wrapper.dataset.column;

                const rect = wrapper.getBoundingClientRect();
                const popoverWidth = 240; // width from css
                
                popover.style.top = `${rect.bottom + 5}px`;
                
                if (rect.left + popoverWidth > window.innerWidth) {
                    // Prevent overflow on the right side by aligning to the wrapper's right edge
                    popover.style.left = `${rect.right - popoverWidth}px`;
                } else {
                    popover.style.left = `${rect.left}px`;
                }
                
                searchInput.value = '';
                renderList();
                
                popover.classList.add('open');
                searchInput.focus();
            });
        });

        searchInput.addEventListener('input', (e) => renderList(e.target.value));
        popover.addEventListener('click', e => e.stopPropagation());
        
        document.addEventListener('click', () => {
            if (popover.classList.contains('open')) closePopover();
        });

        btnClear.addEventListener('click', () => {
            if (!currentWrapper) return;
            delete this.headerFilters[currentTable][currentColumn];
            currentWrapper.querySelector('.header-filter-icon').classList.remove('active');
            closePopover();
            this.renderFilterChips(currentTable);
            if (currentTable === 'transactions') { this.currentPage = 1; this.loadTransactions(); }
            else { this.runAutoMatcher(); }
        });

        btnApply.addEventListener('click', () => {
            if (!currentWrapper) return;
            const checked = Array.from(listContainer.querySelectorAll('input:checked')).map(cb => cb.value);
            if (checked.length > 0) {
                this.headerFilters[currentTable][currentColumn] = checked;
                currentWrapper.querySelector('.header-filter-icon').classList.add('active');
            } else {
                delete this.headerFilters[currentTable][currentColumn];
                currentWrapper.querySelector('.header-filter-icon').classList.remove('active');
            }
            
            closePopover();
            this.renderFilterChips(currentTable);
            if (currentTable === 'transactions') { this.currentPage = 1; this.loadTransactions(); }
            else { this.runAutoMatcher(); }
        });
    }

    initPagination() {
        document.getElementById('btn-prev').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadTransactions();
            }
        });

        document.getElementById('btn-next').addEventListener('click', () => {
            this.currentPage++;
            this.loadTransactions();
        });

        const pageSizeSelect = document.getElementById('page-size');
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', (e) => {
                this.pageSize = parseInt(e.target.value);
                this.currentPage = 1;
                this.loadTransactions();
            });
        }
    }

    initExport() {
        document.getElementById('btn-export').addEventListener('click', async () => {
            const btn = document.getElementById('btn-export');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader"></i> Exporting...';
            btn.disabled = true;

            try {
                let allData = [];
                let from = 0;
                const pageSize = 1000;
                let fetchMore = true;

                const dateFrom = document.getElementById('filter-date-from').value;
                const dateTo = document.getElementById('filter-date-to').value;
                const search = document.getElementById('search-input').value;

                // Fetch all data in pages
                while (fetchMore) {
                    let query = supabase.from('transactions').select('*');
                    
                    if (dateFrom) query = query.gte('payment_date', dateFrom);
                    if (dateTo) query = query.lte('payment_date', dateTo);
                    
                    for (const [col, values] of Object.entries(this.headerFilters.transactions)) {
                        if (values && values.length > 0) {
                            if (col === 'id_status') {
                                const filters = [];
                                if (values.includes('Valid')) filters.push('id_status.eq.Valid');
                                if (values.includes('Missing ID')) filters.push('id_status.ilike.%Missing ID%');
                                if (values.includes('Error')) filters.push('id_status.ilike.%Error%');
                                if (filters.length > 0) query = query.or(filters.join(','));
                            } else if (col === 'is_settled') {
                                const filters = [];
                                if (values.includes('Yes')) filters.push('is_settled.eq.true');
                                if (values.includes('No')) filters.push('is_settled.is.null', 'is_settled.eq.false');
                                if (filters.length > 0) query = query.or(filters.join(','));
                            } else {
                                query = query.in(col, values);
                            }
                        }
                    }
                    if (search) {
                        const safeSearch = sanitizeForFilter(search);
                        if (/^\d+$/.test(safeSearch)) {
                            query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
                        } else {
                            query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.ilike.%${safeSearch}%,item_name.ilike.%${safeSearch}%`);
                        }
                    }

                    const { data, error } = await query
                        .order('payment_date', { ascending: true })
                        .order('id', { ascending: true })
                        .range(from, from + pageSize - 1);

                    if (error) throw error;
                    
                    allData = allData.concat(data);
                    
                    if (data.length < pageSize) {
                        fetchMore = false;
                    } else {
                        from += pageSize;
                    }
                }

                if (allData.length === 0) {
                    Toast.show('No data to export.', 'warning');
                    return;
                }

                // Format exactly like the original Power Query Excel (strictly date-only, no time component)
                const formattedData = allData.map(t => {
                    const pDateStr = toDateOnly(t.payment_date);

                    return {
                        "Reference Number": t.reference_number,
                        "Payment Date": pDateStr,
                        "Student ID": t.student_id,
                        "Customer Mobile Number": t.customer_mobile,
                        "Total Amount Plus Fees": t.total_amount,
                        "Net Amount": t.net_amount,
                        "Fawry Fees": t.fawry_fees,
                        "Payment Status": t.payment_status,
                        "Item Name": t.item_name,
                        "Item Price": t.item_price,
                        "Mapping": t.mapping,
                        "2nd Mapping": t.second_mapping,
                        "Is Settled": t.is_settled ? 'Yes' : 'No',
                        "Settlement Batch": t.settlement_batch || '',
                        "Merchant Name": t.merchant_name,
                        "Bank": t.bank,
                        "Check Column": t.check_column,
                        "ID Status": t.id_status
                    };
                });

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                // Write integer Excel date serials (z: 'm/d/yyyy') so Excel shows a true Date with zero time component
                allData.forEach((t, idx) => {
                    const serial = dateToExcelSerial(t.payment_date);
                    if (serial !== null) {
                        const cellRef = XLSX.utils.encode_cell({ r: idx + 1, c: 1 });
                        worksheet[cellRef] = { t: 'n', v: serial, z: 'm/d/yyyy' };
                    }
                });
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Fawry Query");
                
                // Trigger download
                XLSX.writeFile(workbook, `Fawry_Query_Export_${new Date().toISOString().split('T')[0]}.xlsx`);

            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });

        document.getElementById('btn-export-mappings').addEventListener('click', async () => {
            try {
                let allData = [];
                let from = 0;
                let fetchMore = true;
                while (fetchMore) {
                    const { data, error } = await supabase.from('item_mappings').select('*').order('item_name').range(from, from + 999);
                    if (error) throw error;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                if (allData.length === 0) return Toast.show('No mappings to export.', 'warning');

                const formattedData = allData.map(m => ({
                    "Item Name": m.item_name,
                    "Adjusted Item Name": m.adjusted_item_name || "",
                    "Mapping": m.mapping || "",
                    "2nd Mapping": m.second_mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Item Mappings");
                XLSX.writeFile(workbook, `Item_Mappings_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            }
        });

        document.getElementById('btn-export-fixes').addEventListener('click', async () => {
            try {
                let allData = [];
                let from = 0;
                let fetchMore = true;
                while (fetchMore) {
                    const { data, error } = await supabase.from('manual_fixes').select('*').order('reference_number').range(from, from + 999);
                    if (error) throw error;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                if (allData.length === 0) return Toast.show('No fixes to export.', 'warning');

                const formattedData = allData.map(f => ({
                    "Reference Number": f.reference_number,
                    "Correct ID": f.correct_id || "",
                    "Item Name": f.item_name || "",
                    "Mapping": f.mapping || "",
                    "2nd Mapping": f.second_mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Manual Fixes");
                XLSX.writeFile(workbook, `Manual_Fixes_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            }
        });
    }

    async loadTransactions() {
        this.renderFilterChips('transactions');
        const requestId = (this.txRequestId = (this.txRequestId || 0) + 1);
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = Array(5).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(10) + '</tr>').join('');

        const dateFrom = document.getElementById('filter-date-from')?.value;
        const dateTo = document.getElementById('filter-date-to')?.value;
        const search = document.getElementById('search-input')?.value;

        let query = supabase.from('transactions').select('*', { count: 'exact' });

        if (dateFrom) query = query.gte('payment_date', dateFrom);
        if (dateTo) query = query.lte('payment_date', dateTo);
        for (const [col, values] of Object.entries(this.headerFilters.transactions)) {
            if (values && values.length > 0) {
                if (col === 'id_status') {
                    const filters = [];
                    if (values.includes('Valid')) filters.push('id_status.eq.Valid');
                    if (values.includes('Missing ID')) filters.push('id_status.ilike.%Missing ID%');
                    if (values.includes('Error')) filters.push('id_status.ilike.%Error%');
                    if (filters.length > 0) query = query.or(filters.join(','));
                } else if (col === 'is_settled') {
                    const filters = [];
                    if (values.includes('Yes')) filters.push('is_settled.eq.true');
                    if (values.includes('No')) filters.push('is_settled.is.null', 'is_settled.eq.false');
                    if (filters.length > 0) query = query.or(filters.join(','));
                } else {
                    query = query.in(col, values);
                }
            }
        }
        if (search) {
            const safeSearch = sanitizeForFilter(search);
            if (/^\d+$/.test(safeSearch)) {
                query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
            } else {
                query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.ilike.%${safeSearch}%,item_name.ilike.%${safeSearch}%`);
            }
        }

        const fromRange = (this.currentPage - 1) * this.pageSize;
        const toRange = fromRange + this.pageSize - 1;

        const { data, count: totalCount, error } = await query
            .order('payment_date', { ascending: false })
            .order('id', { ascending: false })
            .range(fromRange, toRange);

        // A newer request was started while this one was running – ignore this (stale) result
        if (requestId !== this.txRequestId) return;

        const totalPages = totalCount ? Math.ceil(totalCount / this.pageSize) : 1;

        // Update pagination UI
        document.getElementById('page-info').innerText = totalCount 
            ? `Page ${this.currentPage} of ${totalPages} (${totalCount.toLocaleString()} records)` 
            : `Page ${this.currentPage}`;
        document.getElementById('btn-prev').disabled = this.currentPage === 1;
        document.getElementById('btn-next').disabled = this.currentPage >= totalPages;

        if (error) {
            tbody.innerHTML = `<tr><td colspan="10" style="color: var(--danger);">${escapeHTML(error.message)}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><i data-lucide="inbox" style="width:48px;height:48px;opacity:0.5;"></i><h3>No transactions found</h3><p>Try adjusting your filters or go to Import CSV to add data.</p></div></td></tr>';
            if (window.lucide) lucide.createIcons();
            return;
        }

        tbody.innerHTML = data.map(t => {
            let statusClass = 'valid';
            if (t.id_status && t.id_status.includes('Missing')) statusClass = 'missing';
            if (t.id_status && t.id_status.includes('Error')) statusClass = 'error';

            const statusText = escapeHTML(t.id_status || '');
            const statusTitle = statusClass === 'error' ? ` title="${statusText}"` : '';
            const shortStatus = statusClass === 'error' ? 'Error' : statusText;

            return `
                <tr>
                    <td style="white-space: nowrap;">${escapeHTML(t.reference_number)}</td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.payment_date))}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 150px; font-size: 0.85rem; line-height: 1.3;"><strong>${escapeHTML(t.student_id)}</strong></td>
                    <td style="white-space: nowrap;">EGP ${formatMoney(t.item_price)}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 200px; font-size: 0.8rem; line-height: 1.3;">${escapeHTML(t.item_name)}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.mapping) || '-'}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.second_mapping) || '-'}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.bank)}</td>
                    <td>
                        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                            <span class="badge ${statusClass}"${statusTitle}>${shortStatus}</span>
                            <button type="button" class="btn btn-icon" data-quick-fix-ref="${escapeHTML(t.reference_number)}" title="Add / Edit Manual Fix for ${escapeHTML(t.reference_number)}" style="padding: 0.15rem 0.3rem; opacity: ${statusClass === 'valid' ? '0.55' : '1'};">
                                <i data-lucide="wrench" style="width: 13px; height: 13px;"></i>
                            </button>
                        </div>
                    </td>
                    <td>${t.is_settled ? '<span class="badge" style="background:#3b82f6;color:white;padding:0.2rem 0.4rem;font-size:0.7rem;">Yes</span>' : '<span style="color:var(--text-muted);font-size:0.8rem;">No</span>'}</td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-quick-fix-ref]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ref = btn.getAttribute('data-quick-fix-ref');
                this.openQuickFixForRef(ref);
            });
        });
        if (window.lucide) lucide.createIcons({ root: tbody });
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        if (tbody) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(5) + '</tr>').join('');
        }
        try {
            await this.deduplicateItemMappings({ silent: true });
            const allData = await fetchAll('item_mappings', '*', null, 'item_name');
            this.allMappingsData = allData;
            this.mappingsPage = 1;
            this.updateMappingsStatsAndDropdowns(allData);
            this.renderMappingsPage();
            this.loadUnmappedItemsSummary();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    updateMappingsStatsAndDropdowns(allData = this.allMappingsData || []) {
        const categories = [...new Set(allData.map(m => m.mapping).filter(Boolean))].sort();
        const secondCategories = [...new Set(allData.map(m => m.second_mapping).filter(Boolean))].sort();
        const renamedCount = allData.filter(m => m.adjusted_item_name && normalizeItemName(m.adjusted_item_name).toLowerCase() !== normalizeItemName(m.item_name).toLowerCase()).length;

        const elTotal = document.getElementById('mappings-stat-total');
        const elRenamed = document.getElementById('mappings-stat-renamed');
        const elCats = document.getElementById('mappings-stat-categories');
        const elSecCats = document.getElementById('mappings-stat-second-categories');
        if (elTotal) elTotal.textContent = allData.length.toLocaleString();
        if (elRenamed) elRenamed.textContent = renamedCount.toLocaleString();
        if (elCats) elCats.textContent = categories.length.toLocaleString();
        if (elSecCats) elSecCats.textContent = secondCategories.length.toLocaleString();

        const catSelect = document.getElementById('mappings-filter-category');
        if (catSelect) {
            const cur = catSelect.value;
            catSelect.innerHTML = '<option value="">All Categories</option>' +
                categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (categories.includes(cur)) catSelect.value = cur;
        }

        const secSelect = document.getElementById('mappings-filter-second-category');
        if (secSelect) {
            const cur = secSelect.value;
            secSelect.innerHTML = '<option value="">All 2nd Categories</option>' +
                secondCategories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (secondCategories.includes(cur)) secSelect.value = cur;
        }

        const dl1 = document.getElementById('datalist-mapping-categories');
        if (dl1) {
            dl1.innerHTML = categories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
        const dl2 = document.getElementById('datalist-second-mapping-categories');
        if (dl2) {
            dl2.innerHTML = secondCategories.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
    }

    async loadUnmappedItemsSummary() {
        const statEl = document.getElementById('mappings-stat-unmapped');
        const tbody = document.getElementById('unmapped-items-body');
        try {
            const unmappedRows = await fetchAll(
                'transactions',
                'reference_number, item_name, check_column, item_price, mapping',
                q => q.or('mapping.is.null,mapping.eq.'),
                'id'
            );

            const byOrigName = new Map();
            for (const tx of unmappedRows) {
                if (tx.mapping && String(tx.mapping).trim() !== '') continue;
                const orig = normalizeItemName(originalItemName(tx)) || normalizeItemName(tx.item_name);
                if (!orig) continue;
                const key = orig.toLowerCase();
                const prev = byOrigName.get(key) || {
                    originalName: orig,
                    displayName: normalizeItemName(tx.item_name) || orig,
                    count: 0,
                    totalAmount: 0
                };
                prev.count += 1;
                prev.totalAmount += parseFloat(tx.item_price || 0) || 0;
                byOrigName.set(key, prev);
            }

            const items = Array.from(byOrigName.values()).sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount);
            if (statEl) statEl.textContent = items.length.toLocaleString();

            if (!tbody) return;
            if (items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 1.5rem; color: var(--success);">All transaction items in the database have a Mapping Category!</td></tr>';
                return;
            }

            tbody.innerHTML = items.map(item => `
                <tr>
                    <td><strong>${escapeHTML(item.originalName)}</strong></td>
                    <td>${escapeHTML(item.displayName)}</td>
                    <td>${item.count.toLocaleString()}</td>
                    <td>EGP ${formatMoney(item.totalAmount)}</td>
                    <td>
                        <button type="button" class="btn btn-primary btn-sm" data-quick-map="${escapeHTML(item.originalName)}">
                            <i data-lucide="plus" style="width: 12px; height: 12px;"></i> Map Item
                        </button>
                    </td>
                </tr>
            `).join('');

            tbody.querySelectorAll('[data-quick-map]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetName = btn.getAttribute('data-quick-map');
                    const conflict = this.findConflictingMapping(targetName);
                    if (conflict) {
                        this.openMappingModalForEdit(conflict.rule);
                    } else {
                        this.resetMappingModal('Add Mapping');
                        document.getElementById('map-original').value = targetName;
                        document.getElementById('modal-mapping').classList.remove('hidden');
                        document.getElementById('map-original').dispatchEvent(new Event('input'));
                        setTimeout(() => document.getElementById('map-category')?.focus(), 50);
                    }
                });
            });
            if (window.lucide) lucide.createIcons({ root: tbody });
        } catch (err) {
            console.warn('Could not load unmapped items summary:', err.message);
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
        }
    }

    renderMappingsPage() {
        const tbody = document.getElementById('mappings-body');
        if (!tbody) return;
        const allData = this.allMappingsData || [];
        const pageSize = 100;

        if (allData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i data-lucide="git-merge" style="width:48px;height:48px;opacity:0.5;"></i><h3>No mappings yet</h3><p>Click "Add Mapping" to create your first item mapping.</p></div></td></tr>';
            document.getElementById('mappings-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const searchQ = (document.getElementById('mappings-search')?.value || '').trim().toLowerCase();
        const filterCat = document.getElementById('mappings-filter-category')?.value || '';
        const filterSec = document.getElementById('mappings-filter-second-category')?.value || '';
        const filterType = document.getElementById('mappings-filter-type')?.value || '';

        const filteredData = allData.filter(m => {
            if (filterCat && (m.mapping || '') !== filterCat) return false;
            if (filterSec && (m.second_mapping || '') !== filterSec) return false;
            if (filterType === 'renamed' && (!m.adjusted_item_name || normalizeItemName(m.adjusted_item_name).toLowerCase() === normalizeItemName(m.item_name).toLowerCase())) return false;
            if (filterType === 'incomplete' && m.mapping && String(m.mapping).trim() !== '') return false;
            if (searchQ) {
                const hay = `${m.item_name || ''} ${m.adjusted_item_name || ''} ${m.mapping || ''} ${m.second_mapping || ''}`.toLowerCase();
                if (!hay.includes(searchQ)) return false;
            }
            return true;
        });

        if (filteredData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i data-lucide="search" style="width:40px;height:40px;opacity:0.5;"></i><h3>No matching rules</h3><p>Try adjusting your search or category filters.</p></div></td></tr>';
            document.getElementById('mappings-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
        if (!this.mappingsPage || this.mappingsPage > totalPages) this.mappingsPage = 1;
        const startIdx = (this.mappingsPage - 1) * pageSize;
        const pageData = filteredData.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageData.map(m => `
            <tr>
                <td><strong>${escapeHTML(m.item_name)}</strong></td>
                <td>${m.adjusted_item_name ? `<span style="color: var(--primary);">${escapeHTML(m.adjusted_item_name)}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                <td>${m.mapping ? `<span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); border: 1px solid rgba(56, 189, 248, 0.25);">${escapeHTML(m.mapping)}</span>` : '<span style="color: var(--warning); font-size: 0.8rem;">Unmapped</span>'}</td>
                <td>${escapeHTML(m.second_mapping) || '-'}</td>
                <td style="white-space: nowrap;">
                    <button class="btn btn-outline btn-sm" data-edit-mapping="${escapeHTML(m.item_name)}">Edit</button>
                    <button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-mapping="${escapeHTML(m.item_name)}">Delete</button>
                </td>
            </tr>
        `).join('');

        // Wire up Edit buttons
        tbody.querySelectorAll('[data-edit-mapping]').forEach(btn => {
            btn.addEventListener('click', () => {
                const itemName = btn.getAttribute('data-edit-mapping');
                const mapping = allData.find(m => m.item_name === itemName);
                if (mapping) {
                    this.openMappingModalForEdit(mapping);
                }
            });
        });

        // Wire up Delete buttons
        tbody.querySelectorAll('[data-delete-mapping]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemName = btn.getAttribute('data-delete-mapping');
                if (!await window.customConfirm(`Delete mapping for "${itemName}"?`, 'Delete', 'Cancel')) return;
                btn.disabled = true;
                try {
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames([itemName]);
                    const { error } = await supabase.from('item_mappings').delete().eq('item_name', itemName);
                    if (error) throw error;

                    await this.logAudit('Mapping Deleted', itemName, { item_name: itemName });

                    const rows = await this.fetchTransactionsForItemNames([itemName], previouslyRenamedTo);
                    const result = await this.reapplyRulesTo(rows);

                    this.mappingSuggestCache = null;
                    Toast.show(`Mapping deleted. ${this.reapplySummary(result)}`, 'success');
                    this.loadMappings();
                } catch (err) {
                    Toast.show('Error deleting mapping: ' + err.message, 'error');
                    btn.disabled = false;
                }
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('mappings-pagination');
            if (filteredData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'mappings-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredData.length)} of ${filteredData.length} mappings</span>
                    <div class="pagination-controls">
                        <button class="btn btn-icon" id="btn-mappings-prev" ${this.mappingsPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.mappingsPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-mappings-next" ${this.mappingsPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                    </div>
                `;
                pager.querySelector('#btn-mappings-prev')?.addEventListener('click', () => {
                    if (this.mappingsPage > 1) {
                        this.mappingsPage--;
                        this.renderMappingsPage();
                    }
                });
                pager.querySelector('#btn-mappings-next')?.addEventListener('click', () => {
                    if (this.mappingsPage < totalPages) {
                        this.mappingsPage++;
                        this.renderMappingsPage();
                    }
                });
            }
        }
        if (window.lucide) lucide.createIcons();
    }

    async deduplicateManualFixes({ silent = true } = {}) {
        try {
            const allRows = await fetchAll('manual_fixes', '*', null, 'reference_number');
            if (!allRows || allRows.length === 0) {
                if (!silent) Toast.show('No manual fixes found to check.', 'info');
                return { mergedCount: 0, deletedCount: 0 };
            }

            const byNormRef = new Map();
            const keysToDelete = [];
            const rowsToUpsert = [];

            for (const row of allRows) {
                const rawRef = String(row.reference_number || '');
                const cleanRef = rawRef.trim();
                if (!cleanRef) continue;
                const normKey = cleanRef.toLowerCase();

                const normalizedRow = {
                    reference_number: cleanRef,
                    correct_id: row.correct_id ? String(row.correct_id).trim() : null,
                    item_name: row.item_name ? normalizeItemName(row.item_name) : null,
                    mapping: row.mapping ? normalizeItemName(row.mapping) : null,
                    second_mapping: row.second_mapping ? normalizeItemName(row.second_mapping) : null
                };

                if (!byNormRef.has(normKey)) {
                    byNormRef.set(normKey, {
                        canonical: normalizedRow,
                        rawKeys: [rawRef],
                        needsSave: rawRef !== cleanRef
                    });
                } else {
                    const group = byNormRef.get(normKey);
                    group.rawKeys.push(rawRef);
                    group.canonical = {
                        reference_number: group.canonical.reference_number,
                        correct_id: group.canonical.correct_id || normalizedRow.correct_id || null,
                        item_name: group.canonical.item_name || normalizedRow.item_name || null,
                        mapping: group.canonical.mapping || normalizedRow.mapping || null,
                        second_mapping: group.canonical.second_mapping || normalizedRow.second_mapping || null
                    };
                    group.needsSave = true;
                }
            }

            for (const group of byNormRef.values()) {
                if (group.rawKeys.length > 1 || group.needsSave) {
                    rowsToUpsert.push(group.canonical);
                    for (const k of group.rawKeys) {
                        if (k !== group.canonical.reference_number) {
                            keysToDelete.push(k);
                        }
                    }
                }
            }

            if (keysToDelete.length === 0 && rowsToUpsert.length === 0) {
                if (!silent) Toast.show('All manual fixes are clean — no duplicate Reference Numbers found!', 'success');
                return { mergedCount: 0, deletedCount: 0 };
            }

            if (keysToDelete.length > 0) {
                for (let i = 0; i < keysToDelete.length; i += 200) {
                    const chunk = keysToDelete.slice(i, i + 200);
                    const { error: delErr } = await supabase.from('manual_fixes').delete().in('reference_number', chunk);
                    if (delErr) throw delErr;
                }
            }

            if (rowsToUpsert.length > 0) {
                for (let i = 0; i < rowsToUpsert.length; i += 200) {
                    const chunk = rowsToUpsert.slice(i, i + 200);
                    const { error: upErr } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                    if (upErr) throw upErr;
                }
            }

            await this.logAudit('Manual Fixes Deduplicated', `${rowsToUpsert.length} merged, ${keysToDelete.length} removed`, {
                merged: rowsToUpsert.length,
                deleted_keys: keysToDelete
            });

            if (!silent) {
                Toast.show(`Cleaned ${keysToDelete.length} duplicate/whitespace fix row(s)!`, 'success');
                await this.loadFixes();
            }

            return { mergedCount: rowsToUpsert.length, deletedCount: keysToDelete.length };
        } catch (err) {
            if (!silent) Toast.show('Error deduplicating fixes: ' + err.message, 'error');
            return { mergedCount: 0, deletedCount: 0 };
        }
    }

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        if (tbody) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(6) + '</tr>').join('');
        }
        try {
            await this.deduplicateManualFixes({ silent: true });
            const allData = await fetchAll('manual_fixes', '*', null, 'reference_number');
            this.allFixesData = allData;
            this.fixesPage = 1;
            this.updateFixesStatsAndDropdowns(allData);
            this.renderFixesPage();
            this.loadUnresolvedTransactionsSummary();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    updateFixesStatsAndDropdowns(allData = this.allFixesData || []) {
        const idFixesCount = allData.filter(f => f.correct_id && String(f.correct_id).trim() !== '').length;
        const itemFixesCount = allData.filter(f =>
            (f.item_name && String(f.item_name).trim() !== '') ||
            (f.mapping && String(f.mapping).trim() !== '') ||
            (f.second_mapping && String(f.second_mapping).trim() !== '')
        ).length;
        const invalidIdCount = allData.filter(f => f.correct_id && validateID(String(f.correct_id).trim()) !== 'Valid').length;
        const categories = [...new Set(allData.map(f => f.mapping).filter(Boolean))].sort();

        const elTotal = document.getElementById('fixes-stat-total');
        const elId = document.getElementById('fixes-stat-id');
        const elItem = document.getElementById('fixes-stat-item');
        const elInvalid = document.getElementById('fixes-stat-invalid-id');
        if (elTotal) elTotal.textContent = allData.length.toLocaleString();
        if (elId) elId.textContent = idFixesCount.toLocaleString();
        if (elItem) elItem.textContent = itemFixesCount.toLocaleString();
        if (elInvalid) elInvalid.textContent = invalidIdCount.toLocaleString();

        const catSelect = document.getElementById('fixes-filter-category');
        if (catSelect) {
            const cur = catSelect.value;
            catSelect.innerHTML = '<option value="">All Mapping Categories</option>' +
                categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            if (categories.includes(cur)) catSelect.value = cur;
        }
    }

    async loadUnresolvedTransactionsSummary() {
        const statEl = document.getElementById('fixes-stat-unresolved');
        const tbody = document.getElementById('unresolved-tx-body');
        try {
            const badRows = await fetchAll(
                'transactions',
                'reference_number, payment_date, student_id, id_status, item_name, item_price',
                q => q.neq('id_status', 'Valid'),
                'id'
            );

            // Group by reference_number so each reference appears once
            const byRef = new Map();
            for (const tx of badRows) {
                if (!tx.reference_number) continue;
                const key = String(tx.reference_number).trim();
                if (!byRef.has(key)) {
                    byRef.set(key, tx);
                }
            }

            const items = Array.from(byRef.values());
            if (statEl) statEl.textContent = items.length.toLocaleString();

            if (!tbody) return;
            if (items.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 1.5rem; color: var(--success);">All transactions in the database currently have a Valid Student ID!</td></tr>';
                return;
            }

            const displayItems = items.slice(0, 150);
            tbody.innerHTML = displayItems.map(t => {
                const isMissing = t.id_status && t.id_status.includes('Missing');
                const statusClass = isMissing ? 'missing' : 'error';
                return `
                    <tr>
                        <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong></td>
                        <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.payment_date) || '-')}</td>
                        <td>${escapeHTML(t.student_id || '-')}</td>
                        <td><span class="badge ${statusClass}">${escapeHTML(t.id_status || 'Error')}</span></td>
                        <td style="max-width: 240px; white-space: normal; font-size: 0.82rem;">${escapeHTML(t.item_name || '-')}</td>
                        <td style="white-space: nowrap;">EGP ${formatMoney(t.item_price)}</td>
                        <td>
                            <button class="btn btn-primary btn-sm" data-fix-unresolved="${escapeHTML(t.reference_number)}">
                                <i data-lucide="wrench" style="width: 13px; height: 13px;"></i> Fix
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');

            tbody.querySelectorAll('[data-fix-unresolved]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const ref = btn.getAttribute('data-fix-unresolved');
                    this.openQuickFixForRef(ref);
                });
            });
            if (window.lucide) lucide.createIcons({ root: tbody });
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
            }
        }
    }

    renderFixesPage() {
        const tbody = document.getElementById('fixes-body');
        if (!tbody) return;
        const allData = this.allFixesData || [];
        const pageSize = 100;

        const searchVal = (document.getElementById('fixes-search')?.value || '').trim().toLowerCase();
        const typeFilter = document.getElementById('fixes-filter-type')?.value || '';
        const catFilter = document.getElementById('fixes-filter-category')?.value || '';

        const filteredData = allData.filter(f => {
            if (searchVal) {
                const haystack = [
                    f.reference_number,
                    f.correct_id,
                    f.item_name,
                    f.mapping,
                    f.second_mapping
                ].filter(Boolean).join(' ').toLowerCase();
                if (!haystack.includes(searchVal)) return false;
            }
            if (catFilter && (f.mapping || '') !== catFilter) return false;

            const hasId = Boolean(f.correct_id && String(f.correct_id).trim() !== '');
            const hasItem = Boolean(
                (f.item_name && String(f.item_name).trim() !== '') ||
                (f.mapping && String(f.mapping).trim() !== '') ||
                (f.second_mapping && String(f.second_mapping).trim() !== '')
            );
            if (typeFilter === 'id_only' && (!hasId || hasItem)) return false;
            if (typeFilter === 'item_only' && (!hasItem || hasId)) return false;
            if (typeFilter === 'both' && (!hasId || !hasItem)) return false;
            if (typeFilter === 'invalid_id') {
                if (!hasId || validateID(String(f.correct_id).trim()) === 'Valid') return false;
            }
            return true;
        });

        if (filteredData.length === 0) {
            const hasActiveFilters = Boolean(searchVal || typeFilter || catFilter);
            tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i data-lucide="wrench" style="width:48px;height:48px;opacity:0.5;"></i><h3>${hasActiveFilters ? 'No matching manual fixes' : 'No manual fixes'}</h3><p>${hasActiveFilters ? 'Try clearing or adjusting your search filters.' : 'Click "Add Fix" to create a manual correction.'}</p></div></td></tr>`;
            document.getElementById('fixes-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
        if (!this.fixesPage || this.fixesPage > totalPages) this.fixesPage = 1;
        const startIdx = (this.fixesPage - 1) * pageSize;
        const pageData = filteredData.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageData.map(f => {
            const cid = f.correct_id ? String(f.correct_id).trim() : '';
            const idStatus = cid ? validateID(cid) : null;
            const idBadge = cid
                ? (idStatus === 'Valid'
                    ? `<strong>${escapeHTML(cid)}</strong>`
                    : `<span style="display: inline-flex; align-items: center; gap: 0.35rem;"><strong style="color: var(--danger);">${escapeHTML(cid)}</strong> <span class="badge error" title="${escapeHTML(idStatus)}" style="font-size: 0.68rem;">Invalid</span></span>`)
                : '-';

            return `
                <tr>
                    <td><strong>${escapeHTML(f.reference_number)}</strong></td>
                    <td>${idBadge}</td>
                    <td>${escapeHTML(f.item_name) || '-'}</td>
                    <td>${ f.mapping ? `<span class="badge valid" style="background: rgba(16, 185, 129, 0.12); color: #10b981;">${escapeHTML(f.mapping)}</span>` : '-' }</td>
                    <td>${escapeHTML(f.second_mapping) || '-'}</td>
                    <td>
                        <button class="btn btn-outline btn-sm" data-edit-fix="${escapeHTML(f.reference_number)}">Edit</button>
                        <button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-fix="${escapeHTML(f.reference_number)}">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        // Wire up Edit buttons
        tbody.querySelectorAll('[data-edit-fix]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ref = btn.getAttribute('data-edit-fix');
                const fix = allData.find(f => f.reference_number === ref);
                if (fix) {
                    this.openFixModalForEdit(fix);
                }
            });
        });

        // Wire up Delete buttons
        tbody.querySelectorAll('[data-delete-fix]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ref = btn.getAttribute('data-delete-fix');
                if (!await window.customConfirm(`Delete fix for reference "${ref}"?`, 'Delete', 'Cancel')) return;
                btn.disabled = true;
                try {
                    const { error } = await supabase.from('manual_fixes').delete().eq('reference_number', ref);
                    if (error) throw error;

                    await this.logAudit('Manual Fix Deleted', ref, { reference_number: ref });

                    const rows = await fetchAll('transactions', '*', q => q.eq('reference_number', ref), 'id');
                    const result = await this.reapplyRulesTo(rows);

                    Toast.show(`Fix deleted. ${this.reapplySummary(result)}`, 'success');
                    this.loadFixes();
                } catch (err) {
                    Toast.show('Error deleting fix: ' + err.message, 'error');
                    btn.disabled = false;
                }
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('fixes-pagination');
            if (filteredData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'fixes-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredData.length)} of ${filteredData.length} fixes</span>
                    <div class="pagination-controls">
                        <button class="btn btn-icon" id="btn-fixes-prev" ${this.fixesPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.fixesPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-fixes-next" ${this.fixesPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                    </div>
                `;
                pager.querySelector('#btn-fixes-prev')?.addEventListener('click', () => {
                    if (this.fixesPage > 1) {
                        this.fixesPage--;
                        this.renderFixesPage();
                    }
                });
                pager.querySelector('#btn-fixes-next')?.addEventListener('click', () => {
                    if (this.fixesPage < totalPages) {
                        this.fixesPage++;
                        this.renderFixesPage();
                    }
                });
            }
        }
        if (window.lucide) lucide.createIcons();
    }

    initStudentMaster() {
        const tabBtns = document.querySelectorAll('.student-tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.student-tab-content').forEach(c => c.style.display = 'none');
                btn.classList.add('active');
                document.getElementById(btn.dataset.target).style.display = 'block';
                document.getElementById(btn.dataset.target).classList.add('active');
            });
        });

        document.getElementById('btn-export-students')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                const btn = document.getElementById('btn-export-students');
                const oldHtml = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Exporting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();

                let allData = [];
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data, error } = await supabase.from('student_master').select('*').order('student_id').range(from, from + 999);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }
                
                const ws = XLSX.utils.json_to_sheet(allData);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Students");
                XLSX.writeFile(wb, "Student_Master_Export.xlsx");
                Toast.show("Export complete", "success");
                
                btn.innerHTML = oldHtml;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
                const btn = document.getElementById('btn-export-students');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i data-lucide="download"></i> Export Master List';
                    if (window.lucide) lucide.createIcons();
                }
            }
        });

        const tbodyGlobal = document.getElementById('students-table-body');
        if (tbodyGlobal) {
            tbodyGlobal.addEventListener('click', async (e) => {
                const target = e.target.closest('.copyable-email');
                if (target) {
                    const email = target.getAttribute('data-email');
                    if (email) {
                        try {
                            await navigator.clipboard.writeText(email);
                            Toast.show('Email copied to clipboard!', 'success');
                        } catch (err) {
                            Toast.show('Failed to copy email.', 'error');
                        }
                    }
                }
            });
        }

        const btnSearch = document.getElementById('btn-search-students');
        const searchInput = document.getElementById('student-search-input');
        if (searchInput && btnSearch) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    btnSearch.click();
                }
            });
        }
        if (btnSearch) {
            btnSearch.addEventListener('click', async () => {
                const term = document.getElementById('student-search-input').value.trim();
                if (!term) return;
                
                try {
                    const { data, error } = await supabase
                        .from('student_master')
                        .select('*')
                        .or(`student_id.ilike.%${sanitizeForFilter(term)}%,full_name.ilike.%${sanitizeForFilter(term)}%,mobile.ilike.%${sanitizeForFilter(term)}%,email.ilike.%${sanitizeForFilter(term)}%`)
                        .limit(50);
                        
                    if (error) throw error;
                    
                    const profileEl = document.getElementById('inline-student-profile');
                    if (profileEl) profileEl.classList.add('hidden');

                    const tbody = document.getElementById('students-table-body');
                    if (!data || data.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i data-lucide="users" style="width:48px;height:48px;opacity:0.5;"></i><h3>No students found</h3><p>Try a different search term.</p></div></td></tr>';
                        if (window.lucide) lucide.createIcons();
                        return;
                    }
                    tbody.innerHTML = data.map(s => `
                        <tr class="student-row" style="cursor: pointer;" data-sid="${escapeHTML(s.student_id)}">
                            <td><strong>${escapeHTML(s.student_id)}</strong></td>
                            <td>${escapeHTML(s.full_name)}</td>
                            <td><span class="copyable-email" style="color: var(--primary); font-weight: 500;" data-email="${escapeHTML(s.email || '')}" title="Click to copy">${escapeHTML(s.email)}</span></td>
                            <td>${escapeHTML(s.mobile)}</td>
                            <td>${escapeHTML(s.college)}</td>
                            <td>${escapeHTML(s.program)}</td>
                        </tr>
                    `).join('');
                    
                    tbody.querySelectorAll('.student-row').forEach(row => {
                        row.addEventListener('click', (e) => {
                            if (e.target.classList.contains('copyable-email')) return; // don't open profile if clicking email to copy
                            this.loadStudentProfile(e.currentTarget.getAttribute('data-sid'));
                        });
                    });
                    
                    if (data.length === 1) {
                        this.loadStudentProfile(data[0].student_id);
                    }
                } catch(err) {
                    Toast.show('Search error: ' + err.message, 'error');
                }
            });
        }

        const dropzone = document.getElementById('student-upload-zone');
        const fileInput = document.getElementById('student-file-input');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', () => fileInput.click());
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--primary-color)';
            });
            dropzone.addEventListener('dragleave', () => dropzone.style.borderColor = 'var(--border-color)');
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = 'var(--border-color)';
                if (e.dataTransfer.files.length) {
                    this.handleStudentImport(e.dataTransfer.files[0]);
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const f = e.target.files[0];
                    e.target.value = ''; // allow re-selecting the same file
                    this.handleStudentImport(f);
                }
            });
        }
        
        // Auto-Matcher Targeted Import Setup
        const amDropzone = document.getElementById('automatcher-import-zone');
        const amFileInput = document.getElementById('automatcher-file-input');
        if (amDropzone && amFileInput) {
            amDropzone.addEventListener('click', () => amFileInput.click());
            amDropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                amDropzone.style.borderColor = 'var(--primary-color)';
            });
            amDropzone.addEventListener('dragleave', () => amDropzone.style.borderColor = 'var(--border-color)');
            amDropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                amDropzone.style.borderColor = 'var(--border-color)';
                if (e.dataTransfer.files.length) {
                    this.handleTargetedMatcherImport(e.dataTransfer.files[0]);
                }
            });
            amFileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const f = e.target.files[0];
                    e.target.value = '';
                    this.handleTargetedMatcherImport(f);
                }
            });
        }
        
        // Auto-Matcher Export Button
        const btnExportAm = document.getElementById('btn-export-automatch');
        if (btnExportAm) {
            btnExportAm.addEventListener('click', () => {
                if (!this.automatchProposals || this.automatchProposals.length === 0) {
                    Toast.show('No results to export. Run Auto-Match first to generate matches.', 'warning');
                    return;
                }
                const csvData = this.automatchProposals.map(tx => ({
                    "Reference Number": tx.original_ref,
                    "Payment Date": tx.original_date,
                    "Bank": tx.original_bank,
                    "Item Name": tx.original_item,
                    "Amount": tx.original_amount,
                    "Current Status": tx.original_status,
                    "Mapping": tx.original_mapping,
                    "2nd Mapping": tx.original_second_mapping,
                    "Proposed Fix (Student ID)": tx.proposedStudent ? tx.proposedStudent.student_id : 'No Match Found',
                    "Proposed Fix (Student Name)": tx.proposedStudent ? tx.proposedStudent.full_name : '',
                    "Match Reason": tx.matchReason
                }));
                const csv = Papa.unparse(csvData);
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement('a');
                const url = URL.createObjectURL(blob);
                link.href = url;
                link.download = `Auto_Matcher_Results.csv`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 100);
            });
        }

        const btnRunMatcher = document.getElementById('btn-run-automatcher');
        if (btnRunMatcher) {
            btnRunMatcher.addEventListener('click', () => this.runAutoMatcher());
        }
        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if(selectAllMatcher) {
            selectAllMatcher.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const showUnmatched = document.getElementById('automatch-toggle-unmatched')?.checked || false;
                const pfFilter = (this.headerFilters?.automatch || {})['proposed_fix'];
                if (Array.isArray(this.automatchProposals)) {
                    for (const p of this.automatchProposals) {
                        if (!showUnmatched && !p.proposedStudent) continue;
                        const pfStatus = p.proposedStudent ? 'Has Proposed Match' : 'No Match Found';
                        const visible = !pfFilter || pfFilter.length === 0 || pfFilter.includes(pfStatus);
                        if (visible && p.proposedStudent) {
                            p.selected = checked;
                        }
                    }
                }
                document.querySelectorAll('.automatch-checkbox').forEach(cb => cb.checked = checked);
            });
        }
        const toggleUnmatched = document.getElementById('automatch-toggle-unmatched');
        if (toggleUnmatched) {
            toggleUnmatched.addEventListener('change', () => {
                this.automatchPage = 1;
                this.renderAutoMatcherPage();
            });
        }
        const btnApplyMatch = document.getElementById('btn-apply-automatch-fixes');
        if(btnApplyMatch) {
            btnApplyMatch.addEventListener('click', () => {
                const checkedDomValues = new Set(Array.from(document.querySelectorAll('.automatch-checkbox:checked')).map(cb => cb.value));
                const selected = (this.automatchProposals || []).filter(p =>
                    p.proposedStudent && (p.selected || checkedDomValues.has(String(p.tx_id)))
                );
                if (selected.length === 0) {
                    Toast.show('Please select at least one proposed match to apply.', 'warning');
                    return;
                }
                const lockedCount = selected.filter(p => p.locked).length;
                const msgEl = document.getElementById('automatch-confirm-msg');
                if (msgEl) {
                    if (lockedCount > 0) {
                        msgEl.innerHTML = `<span style="color: var(--warning, #f59e0b); font-weight: 600; display: block; margin-bottom: 0.5rem;"><i data-lucide="alert-triangle" style="width: 16px; height: 16px; display: inline-block; vertical-align: text-bottom;"></i> Warning: ${lockedCount} of the ${selected.length} selected transaction(s) are settled or already recorded in ERP.</span>Changing them will update their student ID, but will <strong>NOT</strong> change what was already posted to ERP.<br><br>Do you want to proceed and apply fixes to all ${selected.length} transaction(s)?`;
                    } else {
                        msgEl.innerText = `Are you sure you want to apply fixes to ${selected.length} transaction(s)?`;
                    }
                }
                document.getElementById('modal-automatch-confirm')?.classList.remove('hidden');
                if (window.lucide) lucide.createIcons();
            });
        }
        
        const btnConfirmMatch = document.getElementById('btn-confirm-automatch');
        if(btnConfirmMatch) {
            btnConfirmMatch.addEventListener('click', () => this.applyAutoMatches());
        }

        const nameMatchCb = document.getElementById('automatch-enable-name');
        if (nameMatchCb) {
            nameMatchCb.addEventListener('click', (e) => {
                if (nameMatchCb.checked) {
                    e.preventDefault(); // Stop it from actually checking yet
                    document.getElementById('modal-name-match-warn')?.classList.remove('hidden');
                }
            });
        }
        
        const btnConfirmName = document.getElementById('btn-confirm-name-match');
        if (btnConfirmName) {
            btnConfirmName.addEventListener('click', () => {
                const cb = document.getElementById('automatch-enable-name');
                if (cb) cb.checked = true;
                document.getElementById('modal-name-match-warn')?.classList.add('hidden');
            });
        }
    }
    
    initHistory() {
        const btnRefresh = document.getElementById('btn-refresh-history');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', () => this.loadHistory());
        }
        
        const btnDetect = document.getElementById('btn-detect-duplicates');
        if (btnDetect) {
            btnDetect.addEventListener('click', () => this.detectDuplicates());
        }

        const btnCleanup = document.getElementById('btn-cleanup-duplicates');
        if (btnCleanup) {
            btnCleanup.addEventListener('click', async () => {
                const ids = window.duplicateIdsToDelete || [];
                if (ids.length === 0) return;
                
                const btn = document.getElementById('btn-cleanup-duplicates');
                const originalText = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Deleting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();
                
                try {
                    let deleted = 0;
                    for (let i = 0; i < ids.length; i += 200) {
                        const chunk = ids.slice(i, i + 200);
                        const { error } = await supabase.from('transactions').delete().in('id', chunk);
                        if (error) throw error;
                        deleted += chunk.length;
                    }
                    this.invalidateDistinctCache();
                    Toast.show(`Successfully deleted ${deleted} duplicate transactions.`, 'success');
                    document.getElementById('modal-detect-duplicates').classList.add('hidden');
                    window.duplicateIdsToDelete = [];
                    if (this.loadTransactions) this.loadTransactions();
                } catch(err) {
                    Toast.show('Error deleting: ' + err.message, 'error');
                } finally {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                    if (window.lucide) lucide.createIcons();
                }
            });
        }

        // Setup revert buttons delegation
        const historyBody = document.getElementById('history-body');
        if (historyBody) {
            historyBody.addEventListener('click', async (e) => {
                const btn = e.target.closest('.btn-revert-batch');
                if (!btn) return;
                
                const batchId = btn.getAttribute('data-batch-id');
                const fileName = btn.getAttribute('data-file-name');
                const type = btn.getAttribute('data-type');
                
                if (type !== 'transactions') {
                    Toast.show('Only transaction batches can be reverted currently.', 'warning');
                    return;
                }

                if (!await window.customConfirm(`Are you sure you want to revert the import for "${fileName}"? This will delete the transactions first created by this import. Transactions already settled or recorded in ERP are kept.`, 'Revert', 'Cancel')) return;
                
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Reverting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();

                try {
                    // Delete only rows first created by this batch that are NOT settled and NOT recorded in ERP
                    const { data: deletedRows, error: txError } = await supabase.from('transactions')
                        .delete()
                        .eq('batch_id', batchId)
                        .or('is_settled.is.null,is_settled.eq.false')
                        .is('erp_batch_number', null)
                        .select('id');
                    if (txError) throw txError;

                    const { count: keptCount, error: keptErr } = await supabase.from('transactions')
                        .select('id', { count: 'exact', head: true })
                        .eq('batch_id', batchId);
                    if (keptErr) throw keptErr;

                    // Update batch status
                    const { error: batchError } = await supabase.from('import_batches')
                        .update({ status: keptCount > 0 ? 'partially reverted' : 'reverted' })
                        .eq('id', batchId);
                    if (batchError) throw batchError;

                    this.invalidateDistinctCache();
                    const deletedCount = deletedRows ? deletedRows.length : 0;
                    Toast.show(keptCount > 0
                        ? `Reverted ${fileName}: deleted ${deletedCount}, kept ${keptCount} settled/ERP-recorded transaction(s).`
                        : `Successfully reverted ${fileName} (${deletedCount} transactions deleted)`, keptCount > 0 ? 'warning' : 'success');
                    this.loadHistory();
                    this.loadDashboard();
                    this.loadTransactions();
                } catch (err) {
                    Toast.show('Error reverting batch: ' + err.message, 'error');
                    btn.innerHTML = '<i data-lucide="rotate-ccw"></i> Revert';
                    btn.disabled = false;
                    if (window.lucide) lucide.createIcons();
                }
            });
        }
    }

    async loadHistory() {
        const tbody = document.getElementById('history-body');
        if (!tbody) return;
        
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;"><i data-lucide="loader" class="spin"></i> Loading...</td></tr>';
        if (window.lucide) lucide.createIcons();
        
        try {
            const { data, error } = await supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(50);
            if (error) throw error;
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No import history found.</td></tr>';
                return;
            }
            
            tbody.innerHTML = data.map(b => {
                const date = new Date(b.created_at).toLocaleString();
                const type = b.details && b.details.type ? b.details.type : 'transactions';
                const canRevert = type === 'transactions' && b.status !== 'reverted' && b.status !== 'failed' && b.status !== 'processing';
                
                let statusColor = 'var(--text-muted)';
                if (b.status === 'success') statusColor = 'var(--success)';
                else if (b.status === 'failed') statusColor = 'var(--danger)';
                else if (b.status === 'reverted' || b.status === 'partially reverted') statusColor = 'var(--warning)';
                else if (b.status === 'partial') statusColor = '#eab308'; // yellow-500
                
                return `
                    <tr>
                        <td>${escapeHTML(b.file_name)} <span style="font-size: 0.75rem; color: var(--text-muted);">(${escapeHTML(type)})</span></td>
                        <td>${escapeHTML(date)}</td>
                        <td>${escapeHTML(b.user_email || 'System')}</td>
                        <td>${Number(b.records_processed) || 0}</td>
                        <td style="color: ${statusColor};">
                            <div style="text-transform: capitalize; font-weight: 500;">${escapeHTML(b.status)}</div>
                            ${b.status === 'failed' && b.details && b.details.error_message ? `<div style="font-size: 0.75rem; margin-top: 0.25rem; word-break: break-word; max-width: 250px;">${escapeHTML(b.details.error_message)}</div>` : ''}
                        </td>
                        <td>
                            ${canRevert ? `<button class="btn btn-outline btn-revert-batch" data-batch-id="${escapeHTML(b.id)}" data-file-name="${escapeHTML(b.file_name)}" data-type="${escapeHTML(type)}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;"><i data-lucide="rotate-ccw" style="width: 14px; height: 14px;"></i> Revert</button>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');
            
            if (window.lucide) lucide.createIcons();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger); text-align: center;">Error loading history: ${escapeHTML(err.message)}</td></tr>`;
        }
    }
    
    async detectDuplicates() {
        const btn = document.getElementById('btn-detect-duplicates');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Detecting...';
        btn.disabled = true;
        if (window.lucide) lucide.createIcons();
        
        try {
            let allData = [];
            let from = 0;
            let fetchMore = true;
            while(fetchMore) {
                const { data, error } = await supabase.from('transactions').select('id, reference_number, item_price, item_name, check_column, erp_batch_number, is_settled').order('id').range(from, from + 999);
                if (error) throw error;
                if (!data || data.length === 0) break;
                allData = allData.concat(data);
                if (data.length < 1000) fetchMore = false;
                else from += 1000;
            }
            
            const grouped = {};
            for (const tx of allData) {
                if (!tx.reference_number) continue;
                // Same reference + price + ORIGINAL item (check_column), ignoring stray spaces.
                // (item_name is not used: two different items can share an adjusted name legitimately.)
                const check = tx.check_column != null ? String(tx.check_column).replace(/\s+/g, ' ').trim() : `${tx.reference_number}-${String(tx.item_name || '').trim()}`;
                const key = `${tx.reference_number}|${Number(tx.item_price || 0).toFixed(2)}|${check}`;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(tx);
            }
            
            const duplicates = [];
            const toDeleteIds = [];
            
            for (const [key, txs] of Object.entries(grouped)) {
                if (txs.length > 1) {
                    // Score rows: prefer settled and erp exported
                    txs.sort((a, b) => {
                        const aScore = (a.is_settled ? 100 : 0) + (a.erp_batch_number ? 50 : 0);
                        const bScore = (b.is_settled ? 100 : 0) + (b.erp_batch_number ? 50 : 0);
                        return (bScore - aScore) || (a.id < b.id ? -1 : 1); // tie → keep the oldest row
                    });
                    
                    for (let i = 1; i < txs.length; i++) {
                        // Never delete a copy that is settled or recorded in ERP
                        if (!txs[i].is_settled && !txs[i].erp_batch_number) toDeleteIds.push(txs[i].id);
                    }
                    duplicates.push({
                        ref: txs[0].reference_number,
                        name: txs[0].item_name,
                        price: txs[0].item_price,
                        trimmedCheck: txs[0].check_column,
                        untrimmedCheck: txs[1].check_column
                    });
                }
            }
            
            window.duplicateIdsToDelete = toDeleteIds;
            
            document.getElementById('duplicates-summary').innerText = `Found ${duplicates.length} duplicated transaction(s) (${toDeleteIds.length} extra row(s) will be removed). Settled / ERP-recorded copies are always kept.`;
            const tbody = document.getElementById('duplicates-body');
            tbody.innerHTML = duplicates.map(d => `
                <tr>
                    <td>${escapeHTML(d.ref)}</td>
                    <td>${escapeHTML(d.name)}</td>
                    <td>${escapeHTML(d.price)}</td>
                    <td><pre style="margin:0; font-size:0.8rem;">'${escapeHTML(d.trimmedCheck)}'</pre></td>
                    <td><pre style="margin:0; font-size:0.8rem;">'${escapeHTML(d.untrimmedCheck)}'</pre></td>
                </tr>
            `).join('');
            
            document.getElementById('btn-cleanup-duplicates').style.display = toDeleteIds.length > 0 ? 'inline-flex' : 'none';
            document.getElementById('modal-detect-duplicates').classList.remove('hidden');
            
        } catch(err) {
            Toast.show('Error: ' + err.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    }
    
    normalizeStudentId(val) {
        if (val === null || val === undefined) return '';
        const s = String(val).trim();
        if (/^0+\d{4,}$/.test(s)) {
            return s.replace(/^0+/, '');
        }
        return s;
    }

    mergeStudentRecord(existing, incoming) {
        if (!existing) return { ...incoming };
        const pickLongerName = (a, b) => {
            if (!a) return b || null;
            if (!b) return a || null;
            const aWords = String(a).trim().split(/\s+/).length;
            const bWords = String(b).trim().split(/\s+/).length;
            if (bWords > aWords) return b;
            if (aWords > bWords) return a;
            return String(b).length >= String(a).length ? b : a;
        };
        const isFromStudentDetails = incoming.source === 'StudentDetails';
        return {
            student_id: incoming.student_id || existing.student_id,
            full_name: pickLongerName(existing.full_name, incoming.full_name),
            arabic_name: incoming.arabic_name || existing.arabic_name || null,
            national_id: incoming.national_id || existing.national_id || null,
            email: (isFromStudentDetails ? (incoming.email || existing.email) : (existing.email || incoming.email)) || null,
            mobile: incoming.mobile || existing.mobile || null,
            guardian_name: incoming.guardian_name || existing.guardian_name || null,
            guardian_mobile: incoming.guardian_mobile || existing.guardian_mobile || null,
            college: (isFromStudentDetails ? (incoming.college || existing.college) : (existing.college || incoming.college)) || null,
            program: (isFromStudentDetails ? (incoming.program || existing.program) : (existing.program || incoming.program)) || null,
            source: existing.source && existing.source !== incoming.source ? 'Merged' : (incoming.source || existing.source || null)
        };
    }

    async handleStudentImport(file) {
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing Excel file...`;
        if (window.lucide) lucide.createIcons();

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: null });
            
            if (!rows || rows.length === 0) throw new Error("File is empty.");

            // Scan the first 10 rows to find the header row containing 'Student ID' or 'PEOPLE_ID1'
            let headerRowIdx = -1;
            for (let i = 0; i < Math.min(10, rows.length); i++) {
                const rowCells = (rows[i] || []).map(c => c != null ? String(c).trim() : '');
                if (rowCells.includes('Student ID') || rowCells.includes('PEOPLE_ID1')) {
                    headerRowIdx = i;
                    break;
                }
            }
            if (headerRowIdx === -1) {
                throw new Error("Unrecognized Excel format. Expected 'Student ID' or 'PEOPLE_ID1' column.");
            }

            const headers = rows[headerRowIdx];
            const dataRows = rows.slice(headerRowIdx + 1);

            const headerMap = {};
            headers.forEach((h, i) => { if (h != null && String(h).trim() !== '') headerMap[String(h).trim()] = i; });

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Preparing and normalizing student records...`;

            const cleanText = (val) => {
                if (val === null || val === undefined) return null;
                const s = String(val).replace(/\*+$/g, '').replace(/\s+/g, ' ').trim();
                if (!s || ['N/A', 'NA', 'NONE', 'NULL', '-'].includes(s.toUpperCase())) return null;
                return s;
            };

            const cleanPhone = (val) => {
                const txt = cleanText(val);
                if (!txt) return null;
                let digits = txt.replace(/[^0-9+]/g, '');
                if (!digits || digits.replace(/\D/g, '').length < 7) return null;
                // Restore leading 0 dropped by Excel numeric formatting on 10-digit Egyptian mobile numbers (10, 11, 12, 15)
                if (/^1[0125]\d{8}$/.test(digits)) {
                    digits = '0' + digits;
                }
                return digits;
            };

            const cleanNationalId = (val, rawSid, normSid) => {
                const txt = cleanText(val);
                if (!txt) return null;
                // Ignore dummy National ID values in StudentDetails that just repeat the 6-digit Student ID
                if (txt === rawSid || txt === normSid || txt.length < 7) return null;
                return txt;
            };

            const recordsMap = new Map();
            const paddedLegacyIds = new Set();

            for (const row of dataRows) {
                if (!row || row.length === 0) continue;

                let rawSid, student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source;

                if ('PEOPLE_ID1' in headerMap) {
                    rawSid = String(row[headerMap['PEOPLE_ID1']] || '').trim();
                    student_id = this.normalizeStudentId(rawSid);
                    if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                    const first = cleanText(row[headerMap['FIRST_NAME1']]);
                    const middle = cleanText(row[headerMap['MIDDLE_NAME1']]);
                    const last = cleanText(row[headerMap['LAST_NAME1']]);
                    const rawFull = cleanText(row[headerMap['Full name']]);
                    const combinedParts = [first, middle, last].filter(Boolean).join(' ');
                    if (rawFull && last && !rawFull.toLowerCase().includes(last.toLowerCase())) {
                        full_name = `${rawFull} ${last}`.replace(/\s+/g, ' ').trim();
                    } else {
                        full_name = combinedParts || rawFull || first || null;
                    }

                    arabic_name = cleanText(row[headerMap['ARABICNAME']]);
                    national_id = cleanNationalId(row[headerMap['GOVERNMENT_ID1']], rawSid, student_id) || cleanText(row[headerMap['PASSPORT_NUMBER1']]);
                    email = cleanText(row[headerMap['Email1']]) || cleanText(row[headerMap['personalEmail']]);
                    mobile = cleanPhone(row[headerMap['PhoneNumber1']]);
                    guardian_name = cleanText(row[headerMap['Guardian_NAME']]);
                    guardian_mobile = cleanPhone(row[headerMap['Guardian_Mobile']]);
                    college = cleanText(row[headerMap['University1']]) || cleanText(row[headerMap['CURRICULUM1']]);
                    const progParts = [cleanText(row[headerMap['PROGRAM1']]), cleanText(row[headerMap['DEGREE1']]), cleanText(row[headerMap['CURRICULUM1']])].filter(Boolean);
                    program = [...new Set(progParts)].join(' / ') || null;
                    source = 'ApplicantReport';
                } else if ('Student ID' in headerMap) {
                    rawSid = String(row[headerMap['Student ID']] || '').trim();
                    student_id = this.normalizeStudentId(rawSid);
                    if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                    full_name = cleanText(row[headerMap['Student Name']]);
                    arabic_name = null;
                    national_id = cleanNationalId(row[headerMap['National ID']], rawSid, student_id);
                    email = cleanText(row[headerMap['Email']]);
                    mobile = cleanPhone(row[headerMap['Mobile Phone Number']]) || cleanPhone(row[headerMap['Home Phone Number']]);
                    guardian_name = null;
                    guardian_mobile = null;
                    college = cleanText(row[headerMap['College']]);
                    program = cleanText(row[headerMap['Program']]);
                    source = 'StudentDetails';
                }

                if (student_id) {
                    const incoming = {
                        student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source
                    };
                    recordsMap.set(student_id, this.mergeStudentRecord(recordsMap.get(student_id), incoming));
                }
            }

            const records = Array.from(recordsMap.values());

            // Fetch existing student_master rows (both normalized IDs and any 0-padded legacy IDs) so we merge instead of wiping fields
            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Merging with existing database records...`;
            const lookupIds = [...new Set([...records.map(r => r.student_id), ...paddedLegacyIds])];
            const existingMap = new Map();
            const legacyIdsToDelete = [];

            const lookupChunks = [];
            for (let i = 0; i < lookupIds.length; i += 500) {
                lookupChunks.push(lookupIds.slice(i, i + 500));
            }
            const existingChunkResults = await runConcurrent(lookupChunks.map(chunk => async () => {
                const { data: existingRows, error: exErr } = await supabase.from('student_master').select('*').in('student_id', chunk);
                if (exErr) throw exErr;
                return existingRows || [];
            }), 4);
            for (const existingRows of existingChunkResults) {
                for (const ex of existingRows) {
                    const normId = this.normalizeStudentId(ex.student_id);
                    if (ex.student_id !== normId) {
                        legacyIdsToDelete.push(ex.student_id);
                    }
                    existingMap.set(normId, this.mergeStudentRecord(existingMap.get(normId), { ...ex, student_id: normId }));
                }
            }

            const mergedRecords = records.map(r => this.mergeStudentRecord(existingMap.get(r.student_id), r));

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${mergedRecords.length} records to database...`;
            
            let insertedCount = 0;
            for (let i = 0; i < mergedRecords.length; i += 1000) {
                const batch = mergedRecords.slice(i, i + 1000);
                const { error } = await supabase.from('student_master').upsert(batch);
                if (error) throw error;
                insertedCount += batch.length;
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.round((i / mergedRecords.length) * 100)}%`;
            }

            // Clean up any old 0-padded duplicate rows in student_master that have now been merged into their normalized IDs
            if (legacyIdsToDelete.length > 0) {
                for (let i = 0; i < legacyIdsToDelete.length; i += 500) {
                    await supabase.from('student_master').delete().in('student_id', legacyIdsToDelete.slice(i, i + 500));
                }
            }

            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: file.name,
                    status: 'success',
                    records_processed: mergedRecords.length,
                    records_inserted: insertedCount,
                    details: { type: 'student_master', legacy_ids_cleaned: legacyIdsToDelete.length }
                });
            }

            status.className = 'alert alert-success';
            status.innerHTML = `<i data-lucide="check-circle"></i> Successfully imported & merged ${mergedRecords.length} students!`;
            if (window.lucide) lucide.createIcons();

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${escapeHTML(err.message)}`;
            if (window.lucide) lucide.createIcons();
            console.error(err);
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: file.name,
                    status: 'failed',
                    records_processed: 0,
                    records_inserted: 0,
                    details: { type: 'student_master', error: err.message }
                });
            }
        }
    }
    
    async handleTargetedMatcherImport(file) {
        const status = document.getElementById('automatcher-import-status');
        status.innerText = 'Parsing file...';
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet);
            
            const refs = [];
            for (const r of rows) {
                const ref = r['Ref Number'] || r['Reference Number'] || r['REF NUMBER'] || r['Reference_Number'];
                if (ref) refs.push(String(ref).trim());
            }
            if (refs.length === 0) throw new Error("No 'Reference Number' or 'Ref Number' column found in file.");
            
            this.targetedMatchRefs = refs;
            status.innerText = `Targeted ${refs.length} transactions! Filter applied. Click Run Auto-Match.`;
        } catch(err) {
            status.innerText = 'Error: ' + err.message;
        }
    }

    async runAutoMatcher() {
        const btn = document.getElementById('btn-run-automatcher');
        const tbody = document.getElementById('automatcher-table-body');
        const btnApply = document.getElementById('btn-apply-automatch-fixes');
        
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching...`;
        btn.disabled = true;
        if (window.lucide) lucide.createIcons();

        try {
            const dateFrom = document.getElementById('automatcher-date-from')?.value;
            const dateTo = document.getElementById('automatcher-date-to')?.value;
            const search = document.getElementById('automatcher-search')?.value;

            // First fetch the base invalidTx (with or without targeted filter)
            let queryFn = (q) => {
                q = q.neq('id_status', 'Valid');
                if (dateFrom) q = q.gte('payment_date', dateFrom);
                if (dateTo) q = q.lte('payment_date', dateTo);
                if (search) {
                    const safeSearch = sanitizeForFilter(search);
                    if (/^\d+$/.test(safeSearch)) {
                        q = q.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
                    } else {
                        q = q.ilike('student_id', `%${safeSearch}%`);
                    }
                }
                if (this.targetedMatchRefs && this.targetedMatchRefs.length > 0 && this.targetedMatchRefs.length <= 500) {
                    q = q.in('reference_number', this.targetedMatchRefs);
                }
                return q;
            };

            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                console.warn("Large targeted filter, fetching all and filtering locally.");
            }

            let invalidTx = await fetchAll('transactions', '*', queryFn);
            this.invalidTx = invalidTx; // Store for header filter dropdowns
            
            // If the targeted match list was very large and bypassed the .in(), filter locally
            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                const targetSet = new Set(this.targetedMatchRefs);
                invalidTx = invalidTx.filter(t => targetSet.has(t.reference_number));
            }

            if (invalidTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="text-center">No invalid IDs found matching criteria.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }
            
            // Generate distinct mappings and item names for the filters
            const distinctMappings = [...new Set(invalidTx.map(t => t.mapping).filter(Boolean))].sort();
            const distinctItems = [...new Set(invalidTx.map(t => t.item_name).filter(Boolean))].sort();
            
            // Store for header filters
            this.automatchDistinctMappings = distinctMappings;
            this.automatchDistinctItems = distinctItems;

            // Apply dynamic header filters for Auto-Matcher
            const activeFilters = this.headerFilters.automatch || {};
            for (const [col, values] of Object.entries(activeFilters)) {
                if (values && values.length > 0 && col !== 'proposed_fix') {
                    if (col === 'id_status') {
                        // Statuses are stored as e.g. "Error: ID Too Short (3 digits)" – match by category
                        invalidTx = invalidTx.filter(t => {
                            const st = String(t.id_status || '');
                            return (values.includes('Valid') && st === 'Valid') ||
                                (values.includes('Missing ID') && st.includes('Missing ID')) ||
                                (values.includes('Error') && st.includes('Error'));
                        });
                    } else {
                        invalidTx = invalidTx.filter(t => values.includes(String(t[col])));
                    }
                }
            }
            
            let filteredTx = invalidTx;
            
            if (filteredTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="text-center">No transactions match selected filters.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }

                        // Fetch Master List safely without bulk PII download
            const requiredMobiles = new Set();
            const requiredIds = new Set();
            const requiredEmails = new Set();

            for (const tx of filteredTx) {
                if (tx.customer_mobile) requiredMobiles.add(String(tx.customer_mobile).replace(/[^0-9]/g, '').slice(-10));
                if (tx.student_id) {
                    const tId = String(tx.student_id).trim();
                    requiredIds.add(tId);
                    if (tId.includes('@')) requiredEmails.add(tId.toLowerCase());
                    else if (tId.replace(/[^0-9]/g, '').length >= 10) {
                        requiredMobiles.add(tId.replace(/[^0-9]/g, '').slice(-10));
                        requiredIds.add(tId.replace(/[^0-9]/g, ''));
                    }
                }
            }
            
            // Get links first to extract their PII (parallelized chunks)
            const invalidRefs = filteredTx.map(t => String(t.reference_number));
            const refChunks = [];
            for (let i = 0; i < invalidRefs.length; i += 500) {
                refChunks.push(invalidRefs.slice(i, i + 500));
            }
            const linkChunkResults = await runConcurrent(refChunks.map(refChunk => async () => {
                const { data, error } = await supabase.from('links').select('*').in('payment_reference_number', refChunk);
                if (error) throw error;
                return data || [];
            }), 4);
            let links = linkChunkResults.flat();
            
            for (const l of links) {
                if (l.customer_national_id) requiredIds.add(String(l.customer_national_id).trim());
                if (l.custom_input_value) {
                    const rawVal = String(l.custom_input_value).trim();
                    requiredIds.add(rawVal);
                    const normVal = this.normalizeStudentId(rawVal);
                    if (normVal) requiredIds.add(normVal);
                }
                if (l.customer_mobile) requiredMobiles.add(String(l.customer_mobile).replace(/[^0-9]/g, '').slice(-10));
                if (l.customer_email) requiredEmails.add(String(l.customer_email).toLowerCase().trim());
            }

            const enableNameMatch = document.getElementById('automatch-enable-name')?.checked;
            let nameStudents = [];
            let fetchMoreStudents = enableNameMatch;
            let sFrom = 0;
            while(fetchMoreStudents) {
                const { data, error } = await supabase.from('student_master').select('student_id, full_name').order('student_id').range(sFrom, sFrom + 999);
                if (error) throw error;
                nameStudents = nameStudents.concat(data || []);
                if (!data || data.length < 1000) fetchMoreStudents = false;
                else sFrom += 1000;
            }

            const studentTasks = [];
            const idArr = Array.from(requiredIds);
            for (let i = 0; i < idArr.length; i += 200) {
                const chunk = idArr.slice(i, i + 200);
                studentTasks.push(async () => {
                    const { data: d1, error: e1 } = await supabase.from('student_master').select('*').in('student_id', chunk);
                    if (e1) throw e1;
                    return d1 || [];
                });
                studentTasks.push(async () => {
                    const { data: d2, error: e2 } = await supabase.from('student_master').select('*').in('national_id', chunk);
                    if (e2) throw e2;
                    return d2 || [];
                });
            }
            
            const emailArr = Array.from(requiredEmails);
            for (let i = 0; i < emailArr.length; i += 200) {
                const chunk = emailArr.slice(i, i + 200);
                studentTasks.push(async () => {
                    const { data, error } = await supabase.from('student_master').select('*').in('email', chunk);
                    if (error) throw error;
                    return data || [];
                });
            }

            const mobileArr = Array.from(requiredMobiles);
            for (let i = 0; i < mobileArr.length; i += 20) {
                const chunk = mobileArr.slice(i, i + 20);
                const orFilters = chunk.filter(m => m.length >= 7).map(m => `mobile.ilike.%${m}%,guardian_mobile.ilike.%${m}%`).join(',');
                if (orFilters) {
                    studentTasks.push(async () => {
                        const { data, error } = await supabase.from('student_master').select('*').or(orFilters);
                        if (error) throw error;
                        return data || [];
                    });
                }
            }

            let students = (await runConcurrent(studentTasks, 4)).flat();

            // Deduplicate students
            const uniqueStudents = new Map();
            for (const s of nameStudents) uniqueStudents.set(s.student_id, s);
            for (const s of students) uniqueStudents.set(s.student_id, s);
            students = Array.from(uniqueStudents.values());

            // Build lookups
            const linksMap = {};
            links.forEach(l => {
                linksMap[l.payment_reference_number] = l;
            });
            
            const studentMobileMap = new Map();
            const studentIdMap = new Map();
            const studentEmailMap = new Map();
            const studentNameMap = new Map();
            const studentNationalIdMap = new Map();
            students.forEach(s => {
                if (s.student_id) {
                    const rawSid = String(s.student_id).trim();
                    studentIdMap.set(rawSid, s);
                    const normSid = this.normalizeStudentId(rawSid);
                    if (normSid) studentIdMap.set(normSid, s);
                }
                if (s.email) studentEmailMap.set(String(s.email).toLowerCase().trim(), s);
                if (s.full_name) studentNameMap.set(String(s.full_name).toLowerCase().trim(), s);
                if (s.national_id) studentNationalIdMap.set(String(s.national_id).trim(), s);

                if (s.mobile) {
                    const clean = String(s.mobile).replace(/[^0-9]/g, '');
                    if (clean.length >= 10) studentMobileMap.set(clean.slice(-10), s);
                }
                if (s.guardian_mobile) {
                    const clean = String(s.guardian_mobile).replace(/[^0-9]/g, '');
                    if (clean.length >= 10 && !studentMobileMap.has(clean.slice(-10))) {
                        studentMobileMap.set(clean.slice(-10), s);
                    }
                }
            });

            // Initialize AI Fuzzy Matcher for Names
            let nameFuse;
            if (typeof Fuse !== 'undefined') {
                nameFuse = new Fuse(students, {
                    keys: ['full_name'],
                    includeScore: true,
                    threshold: 0.20 // Allows for typos, missing middle names, etc.
                });
            }

            this.automatchProposals = [];
            let html = '';
            
            const formatMoney = (num) => parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            let loopCount = 0;
            for (const tx of filteredTx) {
                loopCount++;
                if (loopCount % 25 === 0) {
                    btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching... ${loopCount}/${filteredTx.length}`;
                    await new Promise(r => setTimeout(r, 0)); // Yield to browser to prevent freezing
                }

                const link = linksMap[tx.reference_number];
                let proposedStudent = null;
                let matchReason = '';

                // Try 1: ID
                if (link && link.custom_input_value) {
                    const rawInput = String(link.custom_input_value).trim();
                    proposedStudent = studentIdMap.get(rawInput) || studentIdMap.get(this.normalizeStudentId(rawInput));
                    if (proposedStudent) matchReason = 'Found exact ID in Link Info';
                }

                // Try 2: Mail
                if (!proposedStudent && link && link.customer_email) {
                    proposedStudent = studentEmailMap.get(String(link.customer_email).toLowerCase().trim());
                    if (proposedStudent) matchReason = 'Email matched via Link Info';
                }

                // Try 3: National ID
                if (!proposedStudent && link && link.customer_national_id) {
                    proposedStudent = studentNationalIdMap.get(String(link.customer_national_id).trim());
                    if (proposedStudent) matchReason = 'National ID matched via Link Info';
                }

                // Try 4: Phone (Link & Transaction)
                if (!proposedStudent && link && link.customer_mobile) {
                    const cleanMobile = String(link.customer_mobile).replace(/[^0-9]/g, '');
                    if (cleanMobile.length >= 10) proposedStudent = studentMobileMap.get(cleanMobile.slice(-10));
                    if (proposedStudent) matchReason = 'Phone number matched via Link Info';
                }
                if (!proposedStudent && tx.customer_mobile) {
                    const cleanMobile = String(tx.customer_mobile).replace(/[^0-9]/g, '');
                    if (cleanMobile.length >= 10) proposedStudent = studentMobileMap.get(cleanMobile.slice(-10));
                    if (proposedStudent) matchReason = 'Phone number matched via Transaction data';
                }

                // Try 5: Name (Link & Transaction)
                if (enableNameMatch) {
                    let searchStr = '';
                    if (!proposedStudent && link && link.customer_name) {
                        searchStr = String(link.customer_name).trim();
                        proposedStudent = studentNameMap.get(searchStr.toLowerCase());
                        if (proposedStudent) matchReason = 'Exact Name matched via Link Info';
                    }
                    if (!proposedStudent && !searchStr && tx.student_id) {
                        const tempStr = String(tx.student_id).trim();
                        if (/[a-zA-Z]/.test(tempStr) && tempStr.length > 3) {
                            searchStr = tempStr;
                            proposedStudent = studentNameMap.get(searchStr.toLowerCase());
                            if (proposedStudent) matchReason = 'Exact Name matched via Transaction data';
                        }
                    }

                    // --- NEW FUZZY MATCH LOGIC ---
                    if (!proposedStudent && searchStr && nameFuse) {
                        const results = nameFuse.search(searchStr);
                        if (results.length > 0) {
                            const bestMatch = results[0];
                            // 0.0 is a perfect match; anything scoring below 0.20 is accepted
                            if (bestMatch.score < 0.20) {
                                proposedStudent = bestMatch.item;
                                const confidence = Math.round((1 - bestMatch.score) * 100);
                                matchReason = `Fuzzy Name Match (Confidence: ${confidence}%): "${proposedStudent.full_name}"`;
                            }
                        }
                    }
                }
                
                // Track for export
                const proposalTx = {
                    tx_id: tx.id,
                    proposedStudent: proposedStudent,
                    matchReason: matchReason,
                    original_ref: tx.reference_number,
                    original_date: toDateOnly(tx.payment_date),
                    original_bank: tx.bank,
                    original_mapping: tx.mapping,
                    original_second_mapping: tx.second_mapping,
                    original_item: tx.item_name,
                    original_amount: tx.item_price,
                    original_status: tx.id_status,
                    locked: isLockedTransaction(tx),
                    selected: false
                };

                this.automatchProposals.push(proposalTx);
            }

            // Sort matched proposals on top
            this.automatchProposals.sort((a, b) => {
                if (a.proposedStudent && !b.proposedStudent) return -1;
                if (!a.proposedStudent && b.proposedStudent) return 1;
                return 0;
            });

            this.automatchPage = 1;
            this.renderAutoMatcherPage();
            btnApply.style.display = this.automatchProposals.filter(p => p.proposedStudent).length > 0 ? 'inline-block' : 'none';
            
            const selectAllMatcher = document.getElementById('automatcher-select-all');
            if (selectAllMatcher) selectAllMatcher.checked = false;

        } catch (err) {
            Toast.show('Matcher Error: ' + err.message, 'error');
        } finally {
            btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    }

    renderAutoMatcherPage() {
        this.renderFilterChips('automatch');
        const tbody = document.getElementById('automatcher-table-body');
        if (!tbody) return;
        const formatMoney = (num) => parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        
        // Update summary card stats
        const totalCount = (this.automatchProposals || []).length;
        const matchedCount = (this.automatchProposals || []).filter(p => p.proposedStudent).length;
        const unmatchedCount = totalCount - matchedCount;

        const summaryCard = document.getElementById('automatch-summary-card');
        if (summaryCard) {
            if (totalCount > 0) {
                summaryCard.style.display = 'block';
                const totalEl = document.getElementById('automatch-stat-total');
                const matchedEl = document.getElementById('automatch-stat-matched');
                const unmatchedEl = document.getElementById('automatch-stat-unmatched');
                if (totalEl) totalEl.innerText = totalCount.toLocaleString();
                if (matchedEl) matchedEl.innerText = matchedCount.toLocaleString();
                if (unmatchedEl) unmatchedEl.innerText = unmatchedCount.toLocaleString();
            } else {
                summaryCard.style.display = 'none';
            }
        }

        const showUnmatched = document.getElementById('automatch-toggle-unmatched')?.checked || false;
        const activeFilters = this.headerFilters?.automatch || {};
        const pfFilter = activeFilters['proposed_fix'];

        const filteredProposals = (this.automatchProposals || []).filter(proposal => {
            if (!showUnmatched && !proposal.proposedStudent) return false;
            const pfStatus = proposal.proposedStudent ? 'Has Proposed Match' : 'No Match Found';
            return !pfFilter || pfFilter.length === 0 || pfFilter.includes(pfStatus);
        });

        if (filteredProposals.length === 0) {
            if (totalCount > 0 && !showUnmatched) {
                tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding: 2.5rem 1rem;">
                    <div style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 0.75rem;">
                        No proposed matches were found among the ${totalCount.toLocaleString()} scanned transactions.
                    </div>
                    <button class="btn btn-outline btn-sm" id="btn-show-unmatched-empty">
                        <i data-lucide="eye" style="width: 14px; height: 14px; margin-right: 4px;"></i> Show all ${totalCount.toLocaleString()} unmatched transactions
                    </button>
                </td></tr>`;
                document.getElementById('btn-show-unmatched-empty')?.addEventListener('click', () => {
                    const toggle = document.getElementById('automatch-toggle-unmatched');
                    if (toggle) toggle.checked = true;
                    this.automatchPage = 1;
                    this.renderAutoMatcherPage();
                });
            } else {
                tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="padding: 2rem;">No fixable transactions found.</td></tr>';
            }
            const pager = document.getElementById('automatcher-pagination');
            if (pager) pager.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const pageSize = 100;
        const totalPages = Math.max(1, Math.ceil(filteredProposals.length / pageSize));
        if (!this.automatchPage || this.automatchPage > totalPages) this.automatchPage = 1;
        const startIdx = (this.automatchPage - 1) * pageSize;
        const pageProposals = filteredProposals.slice(startIdx, startIdx + pageSize);

        let html = '';
        for (const proposal of pageProposals) {
            if (proposal.proposedStudent) {
                const isNameMatch = proposal.matchReason.includes('Name');
                html += `
                    <tr>
                        <td><input type="checkbox" class="automatch-checkbox" value="${escapeHTML(proposal.tx_id)}" ${proposal.selected ? 'checked' : ''}></td>
                        <td>${escapeHTML(proposal.original_ref)}</td>
                        <td>${escapeHTML(proposal.original_date)}</td>
                        <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_second_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_item)}</td>
                        <td>${formatMoney(proposal.original_amount)}</td>
                        <td>
                            <span class="status-badge ${isNameMatch ? 'invalid-id' : 'valid-id'}" title="${escapeHTML(proposal.matchReason)}" ${isNameMatch ? 'style="background: rgba(234, 179, 8, 0.15); color: #eab308; border-color: rgba(234, 179, 8, 0.3);"' : ''}>
                                Matched: ${escapeHTML(proposal.proposedStudent.student_id)} ${isNameMatch ? ' (By Name)' : ''}
                            </span>
                            <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(proposal.proposedStudent.full_name)}</div>
                        </td>
                        <td style="white-space: normal; word-wrap: break-word; max-width: 200px;"><span style="font-size:0.85rem; color:var(--text-muted)">${escapeHTML(proposal.matchReason)}</span>${proposal.locked ? '<div style="font-size:0.8rem; color: var(--warning); margin-top: 2px;"><i data-lucide="lock" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:2px;"></i>Locked: settled / in ERP</div>' : ''}</td>
                    </tr>
                `;
            } else {
                html += `
                    <tr>
                        <td></td>
                        <td>${escapeHTML(proposal.original_ref)}</td>
                        <td>${escapeHTML(proposal.original_date)}</td>
                        <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_second_mapping || '-')}</td>
                        <td>${escapeHTML(proposal.original_item)}</td>
                        <td>${formatMoney(proposal.original_amount)}</td>
                        <td><span class="status-badge invalid-id">No Match Found</span></td>
                        <td><span style="color:var(--text-muted)">-</span></td>
                    </tr>
                `;
            }
        }

        tbody.innerHTML = html || '<tr><td colspan="9" class="text-center">No fixable transactions found.</td></tr>';

        tbody.querySelectorAll('.automatch-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const p = (this.automatchProposals || []).find(item => String(item.tx_id) === cb.value);
                if (p) p.selected = e.target.checked;
            });
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('automatcher-pagination');
            if (filteredProposals.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'automatcher-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, filteredProposals.length)} of ${filteredProposals.length} rows</span>
                    <div class="pagination-controls">
                        <button class="btn btn-icon" id="btn-automatch-prev" ${this.automatchPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.automatchPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-automatch-next" ${this.automatchPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                    </div>
                `;
                pager.querySelector('#btn-automatch-prev')?.addEventListener('click', () => {
                    if (this.automatchPage > 1) {
                        this.automatchPage--;
                        this.renderAutoMatcherPage();
                    }
                });
                pager.querySelector('#btn-automatch-next')?.addEventListener('click', () => {
                    if (this.automatchPage < totalPages) {
                        this.automatchPage++;
                        this.renderAutoMatcherPage();
                    }
                });
            }
        }
        if (window.lucide) lucide.createIcons();
    }

    async applyAutoMatches() {
        const checkedDomValues = new Set(Array.from(document.querySelectorAll('.automatch-checkbox:checked')).map(cb => cb.value));
        const selectedProposals = (this.automatchProposals || []).filter(p =>
            p.proposedStudent && (p.selected || checkedDomValues.has(String(p.tx_id)))
        );

        if (selectedProposals.length === 0) {
            Toast.show('Please select at least one proposed match to apply.', 'warning');
            return;
        }

        const btn = document.getElementById('btn-confirm-automatch');
        if (btn) {
            btn.innerText = 'Applying...';
            btn.disabled = true;
        }
        const originalBtn = document.getElementById('btn-apply-automatch-fixes');
        if (originalBtn) {
            originalBtn.disabled = true;
        }

        try {
            const appliedRefs = [];
            const manualFixesToInsert = [];

            const updateGroups = {};

            for (const proposal of selectedProposals) {
                const tx_id = proposal.tx_id;
                const sid = proposal.proposedStudent.student_id;
                if (!updateGroups[sid]) updateGroups[sid] = [];
                updateGroups[sid].push(tx_id);
                
                manualFixesToInsert.push({
                    reference_number: proposal.original_ref,
                    correct_id: sid
                });

                appliedRefs.push(proposal.original_ref);
            }

            // Execute batched updates
            for (const [sid, txIds] of Object.entries(updateGroups)) {
                // Batch up to 500 ids per request to avoid huge URLs
                for (let i = 0; i < txIds.length; i += 500) {
                    const chunk = txIds.slice(i, i + 500);
                    const { error } = await supabase
                        .from('transactions')
                        .update({ 
                            student_id: sid,
                            id_status: validateID(sid)
                        })
                        .in('id', chunk);
                    if (error) throw error;
                }
            }

            // Insert into manual_fixes (preserve existing item_name, mapping, second_mapping if any)
            if (manualFixesToInsert.length > 0) {
                // De-duplicate by reference (a reference can have several items) – an upsert cannot touch the same row twice
                const uniqueFixesMap = new Map(manualFixesToInsert.map(f => [String(f.reference_number), f]));
                const existingFixes = await fetchByIn('manual_fixes', 'reference_number', Array.from(uniqueFixesMap.keys()));
                const existingFixMap = new Map((existingFixes || []).map(ef => [String(ef.reference_number), ef]));

                const uniqueFixes = Array.from(uniqueFixesMap.values()).map(f => {
                    const ex = existingFixMap.get(String(f.reference_number));
                    return ex ? {
                        reference_number: f.reference_number,
                        correct_id: f.correct_id,
                        item_name: ex.item_name ?? null,
                        mapping: ex.mapping ?? null,
                        second_mapping: ex.second_mapping ?? null
                    } : f;
                });

                for (let i = 0; i < uniqueFixes.length; i += 500) {
                    const { error } = await supabase.from('manual_fixes').upsert(uniqueFixes.slice(i, i + 500), { onConflict: 'reference_number', ignoreDuplicates: false });
                    if (error) throw new Error('IDs were updated, but saving them as manual fixes failed: ' + error.message);
                }
            }

            // Audit Log
            const lockedCount = selectedProposals.filter(p => p.locked).length;
            if (appliedRefs.length > 0) {
                await this.logAudit('Applied Auto-Matches', appliedRefs.join(', '), {
                    count: appliedRefs.length,
                    locked_included: lockedCount
                });
            }

            this.invalidateDistinctCache();
            Toast.show(`Successfully applied ${appliedRefs.length} fixes!`, 'success');
            
            // Clear targeted state
            this.targetedMatchRefs = [];
            if (document.getElementById('automatcher-import-status')) {
                document.getElementById('automatcher-import-status').innerText = '';
            }

            this.runAutoMatcher();
            this.loadDashboard();
            this.loadTransactions();
            this.updateSidebarBadges();
        } catch (err) {
            Toast.show('Error applying fixes: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.innerText = 'Yes, Apply';
                btn.disabled = false;
            }
            if (originalBtn) {
                originalBtn.disabled = false;
            }
            document.getElementById('modal-automatch-confirm')?.classList.add('hidden');
        }
    }


    // ==========================================
    // Payment Links Catalog
    // ==========================================
    initPaymentLinks() {
        this.paymentLinksPage = 1;
        this.paymentLinksSearch = '';
        
        document.querySelectorAll('.nav-item').forEach(item => {
            if (item.getAttribute('data-target') === 'payment-links') {
                item.addEventListener('click', () => {
                    this.loadPaymentLinks();
                });
            }
        });
        
        let linksSearchTimeout;
        document.getElementById('links-search')?.addEventListener('input', (e) => {
            clearTimeout(linksSearchTimeout);
            linksSearchTimeout = setTimeout(() => {
                this.paymentLinksSearch = e.target.value.toLowerCase();
                this.paymentLinksPage = 1;
                this.loadPaymentLinks();
            }, 300);
        });

        document.getElementById('btn-add-link')?.addEventListener('click', () => {
            document.getElementById('modal-link-title').textContent = 'Add Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = '';
            document.getElementById('link-amount').value = '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = '';
            document.getElementById('link-expiry').value = '';
            document.getElementById('link-url').value = '';
            document.getElementById('modal-link').classList.remove('hidden');
        });

        document.getElementById('btn-save-link')?.addEventListener('click', async () => {
            const id = document.getElementById('link-id').value;
            const linkData = {
                name: document.getElementById('link-name').value,
                amount: parseFloat(document.getElementById('link-amount').value) || null,
                invoice_number: document.getElementById('link-invoice').value || null,
                creation_date: document.getElementById('link-created').value || null,
                expiry_date: document.getElementById('link-expiry').value ? new Date(document.getElementById('link-expiry').value).toISOString() : null,
                invoice_link: document.getElementById('link-url').value
            };
            
            if (!linkData.name || !linkData.invoice_link) {
                Toast.show("Name and Link URL are required", "error");
                return;
            }

            try {
                if (id) {
                    const { error } = await supabase.from('payment_links').update(linkData).eq('id', id);
                    if (error) throw error;
                    Toast.show("Link updated", "success");
                } else {
                    const { error } = await supabase.from('payment_links').insert(linkData);
                    if (error) throw error;
                    Toast.show("Link added", "success");
                }
                document.getElementById('modal-link').classList.add('hidden');
                this.loadPaymentLinks();
            } catch (err) {
                Toast.show("Error: " + err.message, "error");
            }
        });

        // Download Template
        document.getElementById('btn-template-links')?.addEventListener('click', () => {
            const templateData = [
                {
                    'Name': 'Example - Tuition Fees Fall 2025',
                    'Invoice Link': 'https://www.atfawry.com/invoice/pay/XXXXX',
                    'Creation Date': '2025-01-15',
                    'Expiry Date': '2025-12-31 23:59:59',
                    'Amount': 12000,
                    'Invoice Number': 'XXXXX'
                },
                {
                    'Name': '',
                    'Invoice Link': '',
                    'Creation Date': '',
                    'Expiry Date': '',
                    'Amount': '',
                    'Invoice Number': ''
                }
            ];
            const ws = XLSX.utils.json_to_sheet(templateData);
            // Set column widths for readability
            ws['!cols'] = [
                { wch: 45 }, // Name
                { wch: 55 }, // Invoice Link
                { wch: 15 }, // Creation Date
                { wch: 22 }, // Expiry Date
                { wch: 12 }, // Amount
                { wch: 18 }  // Invoice Number
            ];
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Payment Links");
            XLSX.writeFile(wb, "Payment_Links_Import_Template.xlsx");
            Toast.show("Template downloaded!", "success");
        });

        // Import Links
        document.getElementById('btn-import-links')?.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.xlsx, .csv';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                try {
                    Toast.show("Importing... Please wait.", "info");

                    const buffer = await file.arrayBuffer();
                    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
                    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                    const json = XLSX.utils.sheet_to_json(worksheet);

                    // Helper: convert Excel date (serial number, Date object or string) to YYYY-MM-DD
                    const parseDate = (val) => {
                        if (!val) return null;
                        if (val instanceof Date) { const d = new Date(val.getTime() - val.getTimezoneOffset() * 60000); return d.toISOString().split('T')[0]; }
                        if (typeof val === 'number') {
                            // Excel serial date: days since 1899-12-30
                            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                            const d = new Date(excelEpoch.getTime() + val * 86400000);
                            return d.toISOString().split('T')[0];
                        }
                        return String(val).trim() || null;
                    };
                    const parseDateTime = (val) => {
                        if (!val) return null;
                        if (val instanceof Date) return val.toISOString();
                        if (typeof val === 'number') {
                            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                            const d = new Date(excelEpoch.getTime() + val * 86400000);
                            return d.toISOString();
                        }
                        const d = new Date(val);
                        if (isNaN(d.getTime())) throw new Error(`Invalid Expiry Date: "${val}"`);
                        return d.toISOString();
                    };
                    const clean = v => (v === null || v === undefined) ? null : (String(v).trim() || null);

                    const rows = json.map(row => ({
                        name: clean(row['Name'] || row['Item Name'] || row['name']) || 'Unknown',
                        amount: parseFloat(String(row['Amount'] ?? row['amount'] ?? '').replace(/[^\d.-]/g, '')) || null,
                        invoice_number: clean(row['Invoice Number'] ?? row['invoice_number']),
                        creation_date: parseDate(row['Creation Date'] || row['creation_date']),
                        expiry_date: parseDateTime(row['Expiry Date'] || row['expiry_date']),
                        invoice_link: clean(row['Invoice Link'] || row['Payment Link'] || row['invoice_link'] || row['PAYMENT LINK'])
                    })).filter(r => r.invoice_link);

                    if (rows.length === 0) {
                        Toast.show("No valid links found in file.", "error");
                        return;
                    }

                    // Rows with an invoice number are upserted (de-duplicated, last one wins);
                    // rows without one are inserted as new links.
                    const withInvoice = Array.from(new Map(rows.filter(r => r.invoice_number).map(r => [r.invoice_number, r])).values());
                    const withoutInvoice = rows.filter(r => !r.invoice_number);

                    let imported = 0;
                    for (let i = 0; i < withInvoice.length; i += 1000) {
                        const chunk = withInvoice.slice(i, i + 1000);
                        const { error } = await supabase.from('payment_links').upsert(chunk, { onConflict: 'invoice_number' });
                        if (error) {
                            // Fallback when invoice_number has no unique constraint:
                            // update links that already exist, insert only the new ones (no duplicates).
                            const existing = await fetchByIn('payment_links', 'id, invoice_number', 'invoice_number', chunk.map(r => r.invoice_number), 'id');
                            const existingByInvoice = new Map(existing.map(r => [String(r.invoice_number), r.id]));
                            const toInsert = chunk.filter(r => !existingByInvoice.has(String(r.invoice_number)));
                            for (const r of chunk.filter(r => existingByInvoice.has(String(r.invoice_number)))) {
                                const { error: upErr } = await supabase.from('payment_links').update(r).eq('invoice_number', r.invoice_number);
                                if (upErr) throw new Error(`Saved ${imported} links, then failed: ${upErr.message}`);
                                imported++;
                            }
                            if (toInsert.length > 0) {
                                const { error: insErr } = await supabase.from('payment_links').insert(toInsert);
                                if (insErr) throw new Error(`Saved ${imported} links, then failed: ${insErr.message}`);
                                imported += toInsert.length;
                            }
                        } else {
                            imported += chunk.length;
                        }
                    }
                    for (let i = 0; i < withoutInvoice.length; i += 1000) {
                        const chunk = withoutInvoice.slice(i, i + 1000);
                        const { error } = await supabase.from('payment_links').insert(chunk);
                        if (error) throw new Error(`Saved ${imported} links, then failed: ${error.message}`);
                        imported += chunk.length;
                    }

                    await this.recordBatch(file.name, 'payment_links', withInvoice.length + withoutInvoice.length, imported, null);

                    Toast.show(`Imported ${imported} links successfully`, "success");
                    this.loadPaymentLinks();
                } catch (err) {
                    Toast.show("Error importing: " + err.message, "error");
                    await this.recordBatch(file.name, 'payment_links', 0, 0, err.message);
                }
            };
            input.click();
        });

        // Export Links
        document.getElementById('btn-export-links')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                let allData = [];
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data, error } = await supabase.from('payment_links').select('*').order('invoice_number').range(from, from + 999);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }
                
                const ws = XLSX.utils.json_to_sheet(allData);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Payment Links");
                XLSX.writeFile(wb, "Payment_Links_Export.xlsx");
                Toast.show("Export complete", "success");
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
            }
        });
        
        // Setup pagination
        document.getElementById('btn-links-prev')?.addEventListener('click', () => {
            if (this.paymentLinksPage > 1) {
                this.paymentLinksPage--;
                this.loadPaymentLinks();
            }
        });
        document.getElementById('btn-links-next')?.addEventListener('click', () => {
            this.paymentLinksPage++;
            this.loadPaymentLinks();
        });
    }

    async loadPaymentLinks() {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;
        
        const btnPrev = document.getElementById('btn-links-prev');
        const btnNext = document.getElementById('btn-links-next');
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;

        tbody.innerHTML = '<tr><td colspan="6" class="loading-state"><i data-lucide="loader" class="spin"></i> Loading links...</td></tr>';
        if (window.lucide) lucide.createIcons();

        try {
            let query = supabase.from('payment_links').select('*', { count: 'exact' });
            
            if (this.paymentLinksSearch) {
                const safe = sanitizeForFilter(this.paymentLinksSearch);
                let orFilters = `name.ilike.%${safe}%,invoice_number.ilike.%${safe}%`;
                const num = parseFloat(this.paymentLinksSearch.replace(/,/g, ''));
                if (!isNaN(num) && isFinite(num)) {
                    orFilters += `,amount.eq.${num}`;
                }
                query = query.or(orFilters);
            }
            
            const from = (this.paymentLinksPage - 1) * this.pageSize;
            const to = from + this.pageSize - 1;
            
            // Order by the actual creation date from the link, not the database insert time
            const { data, count, error } = await query.order('creation_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).range(from, to);
            
            if (error) throw error;
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No payment links found</td></tr>';
                if (btnPrev) btnPrev.disabled = true;
                if (btnNext) btnNext.disabled = true;
                document.getElementById('links-page-info').textContent = 'Page 1 of 1';
                return;
            }
            
            const now = new Date();

            tbody.innerHTML = data.map(link => {
                const isExpired = link.expiry_date && new Date(link.expiry_date) < now;
                const dateBadge = isExpired ? `<span class="badge error">${new Date(link.expiry_date).toLocaleDateString()}</span>` 
                                          : (link.expiry_date ? new Date(link.expiry_date).toLocaleDateString() : '-');
                                          
                return `
                    <tr>
                        <td><div class="truncate-text" title="${escapeHTML(link.name || '')}">${escapeHTML(link.name) || '-'}</div></td>
                        <td><span class="amount">${link.amount ? escapeHTML(formatMoney(link.amount)) + ' EGP' : '-'}</span></td>
                        <td>
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <span class="badge badge-gray">${escapeHTML(link.invoice_number || '-')}</span>
                                ${link.invoice_number ? `<button class="btn-icon copy-invoice-btn" data-invoice="${escapeHTML(link.invoice_number)}" title="Copy Invoice Number" style="padding: 0; width: 24px; height: 24px;"><i data-lucide="copy" style="width: 14px; height: 14px;"></i></button>` : ''}
                            </div>
                        </td>
                        <td>${link.creation_date ? escapeHTML(toDateOnly(link.creation_date)) : '-'}</td>
                        <td>${dateBadge}</td>
                        <td>
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <button class="btn btn-outline copy-link-btn" data-url="${escapeHTML(link.invoice_link || '')}" ${isExpired ? 'disabled title="Link Expired"' : ''}>Copy Link</button>
                                <button class="btn btn-outline edit-link-btn" data-id="${escapeHTML(link.id)}">Edit</button>
                                <button class="btn btn-outline delete-link-btn" style="color: var(--danger);" data-id="${escapeHTML(link.id)}">Delete</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
            
            tbody.querySelectorAll('.copy-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const url = e.currentTarget.dataset.url;
                    navigator.clipboard.writeText(url).then(() => {
                        Toast.show("Link copied to clipboard!", "success");
                    });
                });
            });

            tbody.querySelectorAll('.copy-invoice-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const invoice = e.currentTarget.dataset.invoice;
                    navigator.clipboard.writeText(invoice).then(() => {
                        Toast.show("Invoice number copied!", "success");
                    });
                });
            });

            tbody.querySelectorAll('.edit-link-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const id = e.currentTarget.getAttribute('data-id');
                    const link = data.find(l => String(l.id) === id);
                    if (link) {
                        document.getElementById('modal-link-title').textContent = 'Edit Payment Link';
                        document.getElementById('link-id').value = link.id;
                        document.getElementById('link-name').value = link.name || '';
                        document.getElementById('link-amount').value = link.amount || '';
                        document.getElementById('link-invoice').value = link.invoice_number || '';
                        document.getElementById('link-created').value = link.creation_date ? link.creation_date.split('T')[0] : '';
                        
                        let expiryStr = '';
                        if (link.expiry_date) {
                            const d = new Date(link.expiry_date);
                            const tzoffset = (new Date()).getTimezoneOffset() * 60000;
                            const localISOTime = (new Date(d - tzoffset)).toISOString().slice(0, 16);
                            expiryStr = localISOTime;
                        }
                        document.getElementById('link-expiry').value = expiryStr;
                        document.getElementById('link-url').value = link.invoice_link || '';
                        document.getElementById('modal-link').classList.remove('hidden');
                    }
                });
            });
            
            tbody.querySelectorAll('.delete-link-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const id = e.currentTarget.getAttribute('data-id'); // read before await (currentTarget is cleared afterwards)
                    if (await window.customConfirm("Are you sure you want to delete this link?", 'Delete', 'Cancel')) {
                        const { error } = await supabase.from('payment_links').delete().eq('id', id);
                        if (error) {
                            Toast.show("Error deleting link: " + error.message, "error");
                        } else {
                            Toast.show("Link deleted", "success");
                            this.loadPaymentLinks();
                        }
                    }
                });
            });

            const totalPages = Math.ceil(count / this.pageSize) || 1;
            document.getElementById('links-page-info').textContent = `Page ${this.paymentLinksPage} of ${totalPages}`;
            document.getElementById('btn-links-prev').disabled = this.paymentLinksPage === 1;
            document.getElementById('btn-links-next').disabled = this.paymentLinksPage === totalPages;

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">Error: ${escapeHTML(err.message)}</td></tr>`;
        }
        
        if (window.lucide) lucide.createIcons();
    }


    initErpExport() {
        const dateFrom = document.getElementById('erp-filter-date-from');
        const dateTo = document.getElementById('erp-filter-date-to');
        const bankFilter = document.getElementById('erp-filter-bank');
        const itemNameFilter = document.getElementById('erp-filter-item-name');
        const mappingFilter = document.getElementById('erp-filter-mapping');
        const btnExport = document.getElementById('btn-export-erp-file');
        const btnRecord = document.getElementById('btn-record-erp');

        if (dateFrom && dateTo) {
            const now = new Date();
            dateFrom.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            dateTo.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

            dateFrom.addEventListener('change', () => this.loadErpExport());
            dateTo.addEventListener('change', () => this.loadErpExport());
        }

        if (bankFilter) {
            bankFilter.addEventListener('change', () => this.loadErpExport());
        }
        
        // Item / Mapping only narrow the already-loaded rows – no new request
        if (itemNameFilter && window.TomSelect) {
            this.erpItemNameSelect = new TomSelect(itemNameFilter, {
                plugins: ['remove_button'],
                placeholder: "All Items",
                onChange: () => this.loadErpExport({ refresh: false })
            });
        } else if (itemNameFilter) {
            itemNameFilter.addEventListener('change', () => this.loadErpExport({ refresh: false }));
        }

        if (mappingFilter && window.TomSelect) {
            this.erpMappingSelect = new TomSelect(mappingFilter, {
                plugins: ['remove_button'],
                placeholder: "All Mappings",
                onChange: () => this.loadErpExport({ refresh: false })
            });
        } else if (mappingFilter) {
            mappingFilter.addEventListener('change', () => this.loadErpExport({ refresh: false }));
        }

        if (btnExport) {
            btnExport.addEventListener('click', () => this.downloadErpExport());
        }

        if (btnRecord) {
            btnRecord.addEventListener('click', () => this.recordErpReferences());
        }
    }

    /**
     * Fills the Item Name / Mapping dropdowns from rows already loaded for the current
     * date range + bank (no extra request).
     */
    updateErpDropdowns(baseData = this.erpBaseData || []) {
        const items = [...new Set(baseData.map(d => d.item_name).filter(Boolean))].sort();
        const mappings = [...new Set(baseData.map(d => d.mapping).filter(Boolean))].sort();

        const itemSelect = document.getElementById('erp-filter-item-name');
        const mappingSelect = document.getElementById('erp-filter-mapping');

        if (this.erpItemNameSelect) {
            const currentItems = this.erpItemNameSelect.getValue();
            this.erpItemNameSelect.clearOptions();
            items.forEach(i => this.erpItemNameSelect.addOption({value: i, text: i}));
            this.erpItemNameSelect.setValue(currentItems, true); // silent – caller filters once
        } else if (itemSelect) {
            const currentItem = itemSelect.value;
            itemSelect.innerHTML = items.map(i => `<option value="${escapeHTML(i)}">${escapeHTML(i)}</option>`).join('');
            if (items.includes(currentItem)) itemSelect.value = currentItem;
        }
        
        if (this.erpMappingSelect) {
            const currentMappings = this.erpMappingSelect.getValue();
            this.erpMappingSelect.clearOptions();
            mappings.forEach(m => this.erpMappingSelect.addOption({value: m, text: m}));
            this.erpMappingSelect.setValue(currentMappings, true);
        } else if (mappingSelect) {
            const currentMapping = mappingSelect.value;
            mappingSelect.innerHTML = mappings.map(m => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');
            if (mappings.includes(currentMapping)) mappingSelect.value = currentMapping;
        }
    }

    /**
     * @param {{refresh?: boolean}} [opts]
     *   refresh – re-download the date/bank range from the database (default true).
     *             Item / Mapping filter changes pass false and just re-filter the loaded rows.
     */
    async loadErpExport({ refresh = true } = {}) {
        if (!this.currentUser) return;
        const requestId = (this.erpRequestId = (this.erpRequestId || 0) + 1);
        
        const dateFrom = document.getElementById('erp-filter-date-from').value;
        const dateTo = document.getElementById('erp-filter-date-to').value;
        const bank = document.getElementById('erp-filter-bank').value;
        const baseKey = `${dateFrom}|${dateTo}|${bank}`;

        if (refresh || !this.erpBaseData || this.erpBaseKey !== baseKey) {
            let baseData = [];
            try {
                baseData = await fetchAll('transactions', '*', q => {
                    if (dateFrom) q = q.gte('payment_date', dateFrom);
                    if (dateTo) q = q.lte('payment_date', dateTo);
                    if (bank) q = q.eq('bank', bank);
                    return q;
                }, 'id');
            } catch (err) {
                if (requestId !== this.erpRequestId) return;
                // Never keep partial data – exporting it would silently miss transactions
                this.erpBaseData = null;
                this.erpBaseKey = null;
                this.erpData = [];
                this.renderErpPreview();
                Toast.show('Error loading ERP data: ' + err.message, 'error');
                return;
            }
            if (requestId !== this.erpRequestId) return; // a newer filter change is loading
            this.erpBaseData = baseData;
            this.erpBaseKey = baseKey;
            this.updateErpDropdowns(baseData);
        }

        // Read the item / mapping selection AFTER the dropdowns were refreshed
        const itemNameSelect = document.getElementById('erp-filter-item-name');
        const mappingSelect = document.getElementById('erp-filter-mapping');
        
        let itemNames = [];
        if (this.erpItemNameSelect) itemNames = [].concat(this.erpItemNameSelect.getValue()).filter(Boolean);
        else if (itemNameSelect && itemNameSelect.selectedOptions) {
            itemNames = Array.from(itemNameSelect.selectedOptions).map(o => o.value).filter(Boolean);
        }

        let mappings = [];
        if (this.erpMappingSelect) mappings = [].concat(this.erpMappingSelect.getValue()).filter(Boolean);
        else if (mappingSelect && mappingSelect.selectedOptions) {
            mappings = Array.from(mappingSelect.selectedOptions).map(o => o.value).filter(Boolean);
        }

        const itemSet = new Set(itemNames);
        const mappingSet = new Set(mappings);
        this.erpData = this.erpBaseData.filter(t =>
            (itemSet.size === 0 || itemSet.has(t.item_name)) &&
            (mappingSet.size === 0 || mappingSet.has(t.mapping))
        );
        this.erpPage = 1;
        this.renderErpPreview();
    }

    renderErpPreview() {
        const tbody = document.getElementById('erp-preview-body');
        if (!tbody) return;

        const rows = this.erpData || [];
        const summaryCard = document.getElementById('erp-summary-card');
        if (summaryCard) {
            if (rows.length > 0) {
                summaryCard.style.display = 'flex';
                const totalAmt = rows.reduce((sum, r) => sum + this.erpAmount(r), 0);
                const validCnt = rows.filter(r => !r.id_status || r.id_status === 'Valid').length;
                const invalidCnt = rows.length - validCnt;
                const recordedCnt = rows.filter(r => r.erp_batch_number).length;

                const elTotal = document.getElementById('erp-stat-total');
                const elAmount = document.getElementById('erp-stat-amount');
                const elValid = document.getElementById('erp-stat-valid');
                const elInvalid = document.getElementById('erp-stat-invalid');
                const elRecorded = document.getElementById('erp-stat-recorded');

                if (elTotal) elTotal.textContent = rows.length.toLocaleString();
                if (elAmount) elAmount.textContent = `EGP ${formatMoney(totalAmt)}`;
                if (elValid) elValid.textContent = validCnt.toLocaleString();
                if (elInvalid) elInvalid.textContent = invalidCnt.toLocaleString();
                if (elRecorded) elRecorded.textContent = recordedCnt.toLocaleString();
            } else {
                summaryCard.style.display = 'none';
            }
        }

        tbody.innerHTML = '';
        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No transactions match the selected ERP filters.</td></tr>';
            document.getElementById('erp-pagination')?.remove();
            return;
        }

        const pageSize = 100;
        const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        if (!this.erpPage || this.erpPage > totalPages) this.erpPage = 1;
        const startIdx = (this.erpPage - 1) * pageSize;
        const previewData = rows.slice(startIdx, startIdx + pageSize);
        
        previewData.forEach((row, index) => {
            const paddedAccount = this.erpAccount(row);
            const description = `${row.reference_number || ''}/${row.item_name || ''}/${row.mapping || ''}/${row.second_mapping || ''}/${row.student_id || ''}`;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(toDateOnly(row.payment_date))}</td>
                <td>${escapeHTML(paddedAccount)}</td>
                <td>${escapeHTML(description)}</td>
                <td>${escapeHTML(formatMoney(this.erpAmount(row)))}</td>
                <td>${escapeHTML(row.bank || '')}</td>
                <td>${startIdx + index + 1}</td>
            `;
            tbody.appendChild(tr);
        });

        const container = tbody.closest('.table-container');
        if (container) {
            let pager = document.getElementById('erp-pagination');
            if (rows.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'erp-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, rows.length)} of ${rows.length.toLocaleString()} lines</span>
                    <div class="pagination-controls">
                        <button class="btn btn-icon" id="btn-erp-prev" ${this.erpPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.erpPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-erp-next" ${this.erpPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                    </div>
                `;
                pager.querySelector('#btn-erp-prev')?.addEventListener('click', () => {
                    if (this.erpPage > 1) {
                        this.erpPage--;
                        this.renderErpPreview();
                    }
                });
                pager.querySelector('#btn-erp-next')?.addEventListener('click', () => {
                    if (this.erpPage < totalPages) {
                        this.erpPage++;
                        this.renderErpPreview();
                    }
                });
                if (window.lucide) lucide.createIcons({ root: pager });
            }
        }
    }

    // Amount credited per ERP line. item_price is the per-line amount
    // (the importer already sets it to Net Amount for NUADCB136). net_amount is order-level
    // and would be repeated on every item of a multi-item NUADIB64 order.
    erpAmount(row) {
        const v = parseFloat(row.item_price);
        return isNaN(v) ? 0 : Math.round(v * 100) / 100;
    }

    erpAccount(row) {
        const id = String(row.student_id ?? '').trim();
        return /^\d+$/.test(id) ? id.padStart(9, '0') : id;
    }

    async downloadErpExport() {
        if (!this.erpData || this.erpData.length === 0) {
            Toast.show('No data to export', 'warning');
            return;
        }

        // Rows already recorded in ERP are excluded by default to avoid posting them twice
        let rows = this.erpData;
        const alreadyRecorded = rows.filter(r => r.erp_batch_number).length;
        if (alreadyRecorded > 0) {
            const include = await window.customConfirm(
                `${alreadyRecorded} of ${rows.length} transactions are already recorded in ERP (they have a Journal Batch Number). Exporting them again may post them twice.`,
                'Include them anyway', 'Exclude recorded rows');
            if (!include) rows = rows.filter(r => !r.erp_batch_number);
        }
        if (rows.length === 0) {
            Toast.show('Nothing left to export – all rows are already recorded in ERP.', 'info');
            return;
        }

        const invalidTransactions = rows.filter(row => row.id_status && row.id_status !== 'Valid');

        if (invalidTransactions.length > 0) {
            const tbody = document.getElementById('erp-warning-table-body');
            tbody.innerHTML = invalidTransactions.map(t => `
                <tr>
                    <td>${escapeHTML(t.reference_number || '')}</td>
                    <td style="color: var(--danger); font-weight: bold;">${escapeHTML(t.student_id || '')}</td>
                    <td>${escapeHTML(formatMoney(this.erpAmount(t)))}</td>
                    <td>${escapeHTML(t.id_status)}</td>
                </tr>
            `).join('');

            document.getElementById('modal-erp-warning').classList.remove('hidden');

            const btnContinue = document.getElementById('btn-erp-continue-export');
            btnContinue.onclick = () => {
                document.getElementById('modal-erp-warning').classList.add('hidden');
                this.generateErpExcel(rows);
            };
        } else {
            this.generateErpExcel(rows);
        }
    }

    generateErpExcel(rows = this.erpData) {
        const exportData = rows.map((row, index) => ({
            'Date': toDateOnly(row.payment_date),
            'Voucher': '',
            'Company': 'NU',
            'Account': this.erpAccount(row),
            'Name': '',
            'Description': `${row.reference_number || ''}/${row.item_name || ''}/${row.mapping || ''}/${row.second_mapping || ''}/${row.student_id || ''}`,
            'Debit': 0,
            'Credit': this.erpAmount(row),
            'Currency': 'EGP',
            'Offset account type': 'Bank',
            'Offset Non-ledger account': row.bank,
            'Offset main account': '',
            'Method of payment': '',
            'Payment reference': row.reference_number || '',
            'Line number': index + 1
        }));

        const ws = XLSX.utils.json_to_sheet(exportData);
        rows.forEach((row, idx) => {
            const serial = dateToExcelSerial(row.payment_date);
            if (serial !== null) {
                const cellRef = XLSX.utils.encode_cell({ r: idx + 1, c: 0 });
                ws[cellRef] = { t: 'n', v: serial, z: 'm/d/yyyy' };
            }
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "ERP_Export");

        const dateStr = new Date().toISOString().split('T')[0];
        XLSX.writeFile(wb, `Dynamics_365_Export_${dateStr}.xlsx`);
        const total = exportData.reduce((sum, r) => sum + r.Credit, 0);
        Toast.show(`ERP file exported: ${exportData.length} lines, total EGP ${formatMoney(total)}`, 'success');
    }

    async recordErpReferences() {
        if (!this.erpData || this.erpData.length === 0) {
            Toast.show('No data selected', 'warning');
            return;
        }

        const batchNum = document.getElementById('erp-batch-number').value.trim();
        const startVoucher = document.getElementById('erp-voucher').value.trim();

        if (!batchNum) {
            Toast.show('Please enter a Journal Batch Number', 'warning');
            return;
        }

        const btn = document.getElementById('btn-record-erp');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Saving...';
        btn.disabled = true;

        try {
            const unexportedRows = this.erpData.filter(r => !r.erp_batch_number);
            const alreadyExported = this.erpData.length - unexportedRows.length;
            
            if (unexportedRows.length === 0) {
                Toast.show('All selected rows already have ERP references saved.', 'warning');
                return;
            }
            if (alreadyExported > 0) {
                if (!await window.customConfirm(`Warning: ${alreadyExported} rows already have ERP references. Only ${unexportedRows.length} new rows will be updated. Continue?`, 'Continue', 'Cancel')) {
                    return;
                }
            }

            const transactionIds = unexportedRows.map(r => r.id);
            const batchSize = 500;
            const concurrency = 4;
            const chunks = [];
            for (let i = 0; i < transactionIds.length; i += batchSize) {
                chunks.push(transactionIds.slice(i, i + batchSize));
            }

            for (let i = 0; i < chunks.length; i += concurrency) {
                const batch = chunks.slice(i, i + concurrency);
                const results = await Promise.all(batch.map(chunk =>
                    supabase.from('transactions')
                        .update({
                            erp_batch_number: batchNum,
                            erp_voucher: startVoucher
                        })
                        .in('id', chunk)
                ));
                const failed = results.find(r => r.error);
                if (failed) throw failed.error;
            }

            await this.logAudit('ERP References Recorded', batchNum, {
                batch_number: batchNum,
                voucher: startVoucher,
                count: transactionIds.length
            });

            Toast.show('Successfully saved ERP references', 'success');
            document.getElementById('erp-batch-number').value = '';
            document.getElementById('erp-voucher').value = '';
            
            // Reload ERP data to reflect saved references
            await this.loadErpExport();

        } catch (err) {
            Toast.show('Error saving: ' + err.message, 'error');
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    }

    setupPrintButton() {
        const btnPrint = document.getElementById('btn-print-profile');
        if (btnPrint) {
            btnPrint.addEventListener('click', () => {
                if (!this.currentProfileSid) return;
                
                const profileContent = document.getElementById('inline-student-profile').cloneNode(true);
                // Remove the print button from the clone so it doesn't print
                const printBtnClone = profileContent.querySelector('#btn-print-profile');
                if (printBtnClone) printBtnClone.remove();

                const st = this.currentProfileStudent || {};
                let name = st.full_name || st.name || '-';
                let email = st.email || '-';
                let phone = st.mobile || st.phone || '-';
                let college = st.college || '-';
                let program = st.program || '-';

                // Fallback to DOM row if metadata wasn't loaded
                if (name === '-') {
                    const row = document.querySelector(`.student-row[data-sid="${CSS.escape(String(this.currentProfileSid))}"]`);
                    if (row && row.children.length >= 6) {
                        name = row.children[1].innerText || '-';
                        email = row.children[2].innerText || '-';
                        phone = row.children[3].innerText || '-';
                        college = row.children[4].innerText || '-';
                        program = row.children[5].innerText || '-';
                    }
                }
                const sid = escapeHTML(this.currentProfileSid);
                [name, email, phone, college, program] = [name, email, phone, college, program].map(v => escapeHTML(v));

                const printWindow = window.open('', '_blank');
                if (!printWindow) {
                    Toast.show('Pop-up blocked – allow pop-ups for this site to print.', 'warning');
                    return;
                }
                printWindow.document.write(`
                    <html>
                    <head>
                        <title>Student Statement of Payments - ${sid}</title>
                        <style>
                            @page { margin: 0; }
                            body { font-family: 'Inter', sans-serif; padding: 2rem; color: #111; max-width: 900px; margin: 0 auto; }
                            h1 { font-size: 1.5rem; text-align: center; margin-bottom: 0.2rem; }
                            h2 { font-size: 1.2rem; text-align: center; color: #555; margin-bottom: 2rem; font-weight: normal; }
                            .header-info { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #ddd; }
                            table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; font-size: 0.9rem; }
                            th, td { padding: 0.75rem; border: 1px solid #ddd; text-align: left; }
                            th { background-color: #f5f5f5; font-weight: 600; }
                            td { background-color: #fff; }
                            .text-right { text-align: right; }
                            h3 { font-size: 1.1rem; margin-top: 1.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; }
                            .custom-footer { margin-top: 4rem; text-align: center; color: #666; font-size: 0.9rem; border-top: 1px solid #ddd; padding-top: 1rem; }
                            @media print {
                                body { padding: 1.5cm; }
                            }
                        </style>
                    </head>
                    <body>
                        <h2>Statement of Payments</h2>
                        <div class="header-info">
                            <h3 style="margin:0 0 0.5rem 0;">${name} (${sid})</h3>
                            <p style="margin:0; font-size: 0.9rem; color: #444;">${email} | ${phone}</p>
                            <p style="margin:0.25rem 0 0 0; font-size: 0.9rem; color: #444;">${college} / ${program}</p>
                            <p style="margin-top:1rem; font-size:0.8rem; color:#888;">Generated on: ${new Date().toLocaleString()}</p>
                        </div>
                        ${profileContent.innerHTML}
                        <div class="custom-footer">
                            Finance Team | Abdelrahman Mohamed
                        </div>
                    </body>
                    </html>
                `);
                
                printWindow.document.close();
                printWindow.focus();
                
                // Slight delay to ensure CSS loads before printing
                setTimeout(() => {
                    printWindow.print();
                    // printWindow.close(); // Optional: close after print dialog
                }, 250);
            });
        }
    }

    async loadStudentProfile(sid) {
        this.currentProfileSid = sid;
        try {
            document.getElementById('inline-student-profile').classList.remove('hidden');
            document.getElementById('student-summary-body').innerHTML = '';
            document.getElementById('student-ledger-body').innerHTML = '';

            const normSid = this.normalizeStudentId(sid);
            const sidVariants = Array.from(new Set([
                String(sid).trim(),
                normSid,
                /^\d+$/.test(normSid) && normSid.length < 9 ? normSid.padStart(9, '0') : null
            ].filter(Boolean)));

            // Fetch student profile record from student_master
            const { data: students } = await supabase.from('student_master')
                .select('*')
                .in('student_id', sidVariants)
                .limit(1);
            this.currentProfileStudent = (students && students[0]) || null;

            // Fetch Transactions using fetchAll pagination
            const txs = await fetchAll('transactions', '*', q => q.in('student_id', sidVariants).order('payment_date', { ascending: false }), 'payment_date');

            if (!txs || txs.length === 0) {
                document.getElementById('student-ledger-body').innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">No payments found for this student.</td></tr>';
                document.getElementById('student-summary-body').innerHTML = '<tr><td colspan="2" style="text-align: center; padding: 1rem;">No data</td></tr>';
                return;
            }

            // Render Ledger using formatMoney()
            document.getElementById('student-ledger-body').innerHTML = txs.map(t => {
                return `
                <tr>
                    <td>${escapeHTML(toDateOnly(t.payment_date) || '-')}</td>
                    <td>${escapeHTML(t.reference_number)}</td>
                    <td>${escapeHTML(t.item_name)}</td>
                    <td>${escapeHTML(t.mapping || 'Unmapped')}</td>
                    <td style="text-align: right; font-weight: 500;">${formatMoney(t.item_price || 0)}</td>
                </tr>
            `}).join('');

            // Calculate Summary Grouped by Mapping
            const summary = {};
            let total = 0;
            txs.forEach(t => {
                const mapKey = t.mapping || 'Unmapped';
                const amt = parseFloat(t.item_price || 0) || 0;
                if (!summary[mapKey]) summary[mapKey] = 0;
                summary[mapKey] += amt;
                total += amt;
            });

            const summaryHtml = Object.keys(summary).sort().map(k => `
                <tr>
                    <td><strong>${escapeHTML(k)}</strong></td>
                    <td style="text-align: right;">${formatMoney(summary[k])}</td>
                </tr>
            `).join('');
            
            document.getElementById('student-summary-body').innerHTML = summaryHtml + `
                <tr style="background-color: var(--bg-secondary);">
                    <td><strong>Grand Total</strong></td>
                    <td style="text-align: right; font-size: 1.1rem; font-weight: 700;">${formatMoney(total)} EGP</td>
                </tr>
            `;

        } catch (err) {
            Toast.show('Error loading profile: ' + err.message, 'error');
            document.getElementById('inline-student-profile').classList.add('hidden');
        }
    }

    renderFilterChips(table) {
        const containerId = table === 'transactions' ? 'transactions-filter-chips' : 'automatch-filter-chips';
        const container = document.getElementById(containerId);
        if (!container) return;

        const filters = this.headerFilters[table] || {};
        const entries = Object.entries(filters).filter(([col, vals]) => Array.isArray(vals) && vals.length > 0);

        if (entries.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        const labelMap = {
            reference_number: 'Ref',
            payment_date: 'Date',
            student_id: 'Student ID',
            item_price: 'Price',
            item_name: 'Item',
            mapping: 'Mapping',
            second_mapping: '2nd Mapping',
            bank: 'Bank',
            id_status: 'ID Status',
            is_settled: 'Settled',
            proposed_fix: 'Match'
        };

        const chipsHtml = entries.map(([col, vals]) => {
            const label = labelMap[col] || col.replace(/_/g, ' ');
            const valStr = vals.length > 2 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ');
            return `
                <span class="filter-chip">
                    <span><strong>${escapeHTML(label)}:</strong> ${escapeHTML(valStr)}</span>
                    <button type="button" class="btn-remove-chip" data-table="${table}" data-column="${col}" title="Remove filter">&times;</button>
                </span>
            `;
        }).join('');

        const clearAllHtml = `
            <button type="button" class="btn btn-outline" id="btn-clear-all-${table}-chips" style="padding: 0.15rem 0.55rem; font-size: 0.75rem; border-radius: 9999px; height: auto;">
                Clear All
            </button>
        `;

        container.innerHTML = chipsHtml + clearAllHtml;

        container.querySelectorAll('.btn-remove-chip').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const col = btn.getAttribute('data-column');
                delete this.headerFilters[table][col];
                const icon = document.querySelector(`.th-filter-wrapper[data-table="${table}"][data-column="${col}"] .header-filter-icon`);
                if (icon) icon.classList.remove('active');
                this.renderFilterChips(table);
                if (table === 'transactions') {
                    this.currentPage = 1;
                    this.loadTransactions();
                } else {
                    this.runAutoMatcher();
                }
            });
        });

        container.querySelector(`#btn-clear-all-${table}-chips`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.headerFilters[table] = {};
            document.querySelectorAll(`[data-table="${table}"] .header-filter-icon`).forEach(icon => icon.classList.remove('active'));
            this.renderFilterChips(table);
            if (table === 'transactions') {
                this.currentPage = 1;
                this.loadTransactions();
            } else {
                this.runAutoMatcher();
            }
        });
    }

    updateSidebarBadges() {
        clearTimeout(this._badgeUpdateTimer);
        this._badgeUpdateTimer = setTimeout(async () => {
            const badge = document.getElementById('sidebar-automatch-badge');
            if (!badge) return;
            try {
                const { count, error } = await supabase
                    .from('transactions')
                    .select('*', { count: 'exact', head: true })
                    .neq('id_status', 'Valid');
                if (!error && count !== null) {
                    if (count > 0) {
                        badge.textContent = count > 999 ? '999+' : count;
                        badge.style.display = 'inline-flex';
                    } else {
                        badge.style.display = 'none';
                    }
                }
            } catch (err) {
                console.warn('Could not update sidebar badge:', err);
            }
        }, 250);
    }

    initGlobalSearch() {
        const overlay = document.getElementById('global-search-overlay');
        const input = document.getElementById('global-search-input');
        const resultsContainer = document.getElementById('global-search-results');
        if (!overlay || !input || !resultsContainer) return;

        const openSearch = () => {
            overlay.classList.add('active');
            input.value = '';
            resultsContainer.innerHTML = `
                <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                    Type at least 2 characters to search across transactions and students.
                </div>
            `;
            setTimeout(() => input.focus(), 50);
        };

        const closeSearch = () => {
            overlay.classList.remove('active');
        };

        document.getElementById('btn-open-global-search')?.addEventListener('click', openSearch);
        document.getElementById('btn-mobile-search')?.addEventListener('click', openSearch);

        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                if (overlay.classList.contains('active')) {
                    closeSearch();
                } else {
                    openSearch();
                }
            } else if (e.key === 'Escape') {
                if (overlay.classList.contains('active')) {
                    closeSearch();
                }
            }
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSearch();
        });

        let searchTimeout;
        input.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            if (query.length < 2) {
                resultsContainer.innerHTML = `
                    <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                        Type at least 2 characters to search across transactions and students.
                    </div>
                `;
                return;
            }

            resultsContainer.innerHTML = `
                <div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                    <i data-lucide="loader" class="spin" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle; margin-right: 6px;"></i> Searching...
                </div>
            `;
            if (window.lucide) lucide.createIcons({ root: resultsContainer });

            searchTimeout = setTimeout(async () => {
                try {
                    const cleanQ = sanitizeForFilter(query);
                    if (!cleanQ) return;

                    const [txRes, studentRes] = await Promise.all([
                        supabase.from('transactions')
                            .select('id, reference_number, student_id, item_name, item_price, payment_date')
                            .or(`reference_number.ilike.%${cleanQ}%,student_id.ilike.%${cleanQ}%,item_name.ilike.%${cleanQ}%`)
                            .order('payment_date', { ascending: false })
                            .limit(5),
                        supabase.from('student_master')
                            .select('student_id, full_name, college, program, email')
                            .or(`student_id.ilike.%${cleanQ}%,full_name.ilike.%${cleanQ}%`)
                            .limit(5)
                    ]);

                    const txs = txRes.data || [];
                    const students = studentRes.data || [];

                    if (txs.length === 0 && students.length === 0) {
                        resultsContainer.innerHTML = `
                            <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                                No transactions or students found matching "${escapeHTML(query)}".
                            </div>
                        `;
                        return;
                    }

                    let html = '';
                    if (txs.length > 0) {
                        html += txs.map(tx => `
                            <div class="search-result-item" data-type="tx" data-ref="${escapeHTML(tx.reference_number)}">
                                <span class="result-type">TX</span>
                                <div class="result-text">
                                    <strong>${escapeHTML(tx.reference_number)}</strong>
                                    <span style="color: var(--text-muted); font-size: 0.8rem; margin-left: 0.5rem;">
                                        ID: ${escapeHTML(tx.student_id || '-')} &bull; ${escapeHTML(tx.item_name || '-')} &bull; EGP ${formatMoney(tx.item_price)} &bull; ${escapeHTML(toDateOnly(tx.payment_date))}
                                    </span>
                                </div>
                            </div>
                        `).join('');
                    }

                    if (students.length > 0) {
                        html += students.map(st => `
                            <div class="search-result-item" data-type="student" data-sid="${escapeHTML(st.student_id)}">
                                <span class="result-type" style="color: var(--success, #10b981);">STUDENT</span>
                                <div class="result-text">
                                    <strong>${escapeHTML(st.student_id)}</strong>
                                    <span style="margin-left: 0.5rem;">${escapeHTML(st.full_name || 'N/A')}</span>
                                    ${st.college ? `<span style="color: var(--text-muted); font-size: 0.8rem; margin-left: 0.5rem;">(${escapeHTML(st.college)})</span>` : ''}
                                </div>
                            </div>
                        `).join('');
                    }

                    resultsContainer.innerHTML = html;

                    resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
                        item.addEventListener('click', () => {
                            const type = item.getAttribute('data-type');
                            closeSearch();
                            if (type === 'tx') {
                                const ref = item.getAttribute('data-ref');
                                const txNav = document.querySelector('.nav-link[data-tab="transactions"]') || document.querySelector('.nav-item[data-view="transactions"]');
                                if (txNav) txNav.click();
                                const searchInp = document.getElementById('search-input');
                                if (searchInp) searchInp.value = ref;
                                this.currentPage = 1;
                                this.loadTransactions();
                            } else if (type === 'student') {
                                const sid = item.getAttribute('data-sid');
                                const smNav = document.querySelector('.nav-link[data-tab="student-master"]') || document.querySelector('.nav-item[data-view="student-master"]');
                                if (smNav) smNav.click();
                                const lookupBtn = document.querySelector('.student-tab-btn[data-target="student-lookup"]');
                                if (lookupBtn) lookupBtn.click();
                                const searchInp = document.getElementById('student-search-input');
                                if (searchInp) searchInp.value = sid;
                                this.loadStudentProfile(sid);
                            }
                        });
                    });

                } catch (err) {
                    resultsContainer.innerHTML = `
                        <div style="padding: 1rem; text-align: center; color: var(--danger); font-size: 0.85rem;">
                            Error searching: ${escapeHTML(err.message)}
                        </div>
                    `;
                }
            }, 300);
        });
    }

}
// Start app
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});










