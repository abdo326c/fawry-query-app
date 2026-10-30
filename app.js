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
    // rows still carrying the original name, plus rows renamed earlier via `renamedTo`.
    async fetchTransactionsForItemNames(names, renamedTo = []) {
        const wanted = new Set(names.map(n => String(n).trim()).filter(Boolean));
        if (wanted.size === 0) return [];
        const searchNames = [...new Set([...wanted, ...renamedTo.map(n => String(n).trim()).filter(Boolean)])];
        const rows = await fetchByIn('transactions', '*', 'item_name', searchNames, 'id', 50);
        return rows.filter(t =>
            wanted.has(String(originalItemName(t) || '').trim()) || wanted.has(String(t.item_name || '').trim())
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
        ['map-original', 'map-adjusted', 'map-category', 'map-second-category'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const suggest = document.getElementById('mapping-suggestion');
        if (suggest) suggest.style.display = 'none';
        document.getElementById('modal-mapping-title').innerText = title;
    }

    resetFixModal(title = 'Add Fix') {
        ['fix-ref', 'fix-id', 'fix-name', 'fix-mapping', 'fix-second-mapping'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        document.getElementById('modal-fix-title').innerText = title;
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

        // Smart Mapping Auto-Suggest (mappings are loaded once per modal opening)
        let suggestTimeout;
        document.getElementById('map-original').addEventListener('input', (e) => {
            clearTimeout(suggestTimeout);
            suggestTimeout = setTimeout(async () => {
                const query = e.target.value.trim();
                const suggestDiv = document.getElementById('mapping-suggestion');
                if (!suggestDiv) return;
                if (query.length < 3 || typeof Fuse === 'undefined') {
                    suggestDiv.style.display = 'none';
                    return;
                }
                try {
                    if (!this.mappingSuggestCache) {
                        this.mappingSuggestCache = await fetchAll('item_mappings', 'item_name, mapping', q => q.not('mapping', 'is', null), 'item_name');
                    }
                } catch (err) {
                    suggestDiv.style.display = 'none';
                    return;
                }
                const fuse = new Fuse(this.mappingSuggestCache, { keys: ['item_name'], threshold: 0.3 });
                const results = fuse.search(query).filter(r => r.item.item_name !== query);
                if (results.length > 0) {
                    const topMatch = results[0].item;
                    suggestDiv.innerText = `💡 Smart Suggestion: Click to map to "${topMatch.mapping}" (similar to ${topMatch.item_name})`;
                    suggestDiv.style.display = 'block';
                    suggestDiv.onclick = () => {
                        document.getElementById('map-category').value = topMatch.mapping;
                        suggestDiv.style.display = 'none';
                        Toast.show('Applied Smart Suggestion!', 'success');
                    };
                } else {
                    suggestDiv.style.display = 'none';
                }
            }, 300);
        });

        // Open Fix Modal
        document.getElementById('btn-add-fix').addEventListener('click', () => {
            this.resetFixModal('Add Fix');
            document.getElementById('modal-fix').classList.remove('hidden');
        });

        // Save Mapping
        const btnSaveMapping = document.getElementById('btn-save-mapping');
        btnSaveMapping.addEventListener('click', async () => {
            const original = document.getElementById('map-original').value.trim();
            const adjusted = document.getElementById('map-adjusted').value.trim();
            const category = document.getElementById('map-category').value.trim();
            const secondCategory = document.getElementById('map-second-category').value.trim();

            if (!original) return Toast.show('Original Item Name is required', 'warning');

            btnSaveMapping.disabled = true;
            try {
                const previouslyRenamedTo = await this.getCurrentAdjustedNames([original]);
                const { error } = await supabase.from('item_mappings').upsert([{
                    item_name: original,
                    adjusted_item_name: adjusted || null,
                    mapping: category || null,
                    second_mapping: secondCategory || null
                }], { onConflict: 'item_name', ignoreDuplicates: false });
                if (error) throw error;

                await this.logAudit('Single Mapping Added', original, { original, adjusted, category, secondCategory });

                // Re-apply rules to every affected transaction (fetch everything first, then update)
                const rows = await this.fetchTransactionsForItemNames([original], [...previouslyRenamedTo, adjusted]);
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

        // Save Fix
        const btnSaveFix = document.getElementById('btn-save-fix');
        btnSaveFix.addEventListener('click', async () => {
            const ref = document.getElementById('fix-ref').value.trim();
            const correctId = document.getElementById('fix-id').value.trim();
            const correctName = document.getElementById('fix-name').value.trim();
            const correctMapping = document.getElementById('fix-mapping').value.trim();
            const correctSecondMapping = document.getElementById('fix-second-mapping').value.trim();

            if (!ref) return Toast.show('Reference Number is required', 'warning');
            if (!correctId && !correctName && !correctMapping && !correctSecondMapping) {
                return Toast.show('Enter at least one value to correct', 'warning');
            }

            btnSaveFix.disabled = true;
            try {
                const isEditMode = document.getElementById('modal-fix-title').innerText === 'Edit Fix';
                const { data: existing, error: existErr } = await supabase.from('manual_fixes').select('*').eq('reference_number', ref).maybeSingle();
                if (existErr) throw existErr;
                if (existing && !isEditMode) {
                    if (!await window.customConfirm(`A manual fix for reference "${ref}" already exists. Do you want to update the old fix?`, 'Update', 'Cancel')) {
                        return;
                    }
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

                await this.logAudit('Single Manual Fix Added', ref, mergedFix);

                // Re-apply all rules to this reference's transactions
                const rows = await fetchAll('transactions', '*', q => q.eq('reference_number', ref), 'id');
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
                    const byName = new Map();
                    data.forEach(row => {
                        const item_name = clean(getVal(row, 'Item Name'));
                        if (!item_name) return;
                        byName.set(item_name, {
                            item_name,
                            adjusted_item_name: clean(getVal(row, 'Adjusted Item Name')),
                            mapping: clean(getVal(row, 'Mapping')),
                            second_mapping: clean(getVal(row, '2nd Mapping'))
                        });
                    });
                    const mappings = Array.from(byName.values());
                    processed = mappings.length;
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames(mappings.map(m => m.item_name));

                    for (let i = 0; i < mappings.length; i += chunkSize) {
                        const chunk = mappings.slice(i, i + chunkSize);
                        const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                        if (error) throw new Error(`Only ${inserted} of ${mappings.length} mappings saved. ${error.message}`);
                        inserted += chunk.length;
                    }

                    // Fetch ALL affected transactions first, then update (no paging while modifying)
                    const rows = await this.fetchTransactionsForItemNames(mappings.map(m => m.item_name), [...previouslyRenamedTo, ...mappings.map(m => m.adjusted_item_name)]);
                    const result = await this.reapplyRulesTo(rows);

                    await this.logAudit('Bulk Mappings Uploaded', `Batch of ${inserted} items`, { count: inserted, transactions_updated: result.updated, locked_skipped: result.lockedSkipped });
                    this.mappingSuggestCache = null;
                    Toast.show(`Uploaded ${inserted} item mappings. ${this.reapplySummary(result)}`, 'success');
                    this.loadMappings();

                } else if (type === 'fixes') {
                    const byRef = new Map();
                    data.forEach(row => {
                        const reference_number = clean(getVal(row, 'Reference Number'));
                        if (!reference_number || reference_number === 'null') return;
                        byRef.set(reference_number, {
                            reference_number,
                            correct_id: clean(getVal(row, 'Correct ID')),
                            item_name: clean(getVal(row, 'Item Name')),
                            mapping: clean(getVal(row, 'Mapping')),
                            second_mapping: clean(getVal(row, '2nd Mapping'))
                        });
                    });
                    const fixes = Array.from(byRef.values());

                    const existingRows = await fetchByIn('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', 'reference_number', fixes.map(f => f.reference_number), 'reference_number', 500);
                    const existingMap = new Map(existingRows.map(r => [String(r.reference_number), r]));

                    let fixesToProcess = fixes;
                    if (existingMap.size > 0) {
                        const overwrite = await window.customConfirm(`Found ${existingMap.size} fixes that already exist in the database. Do you want to overwrite them with the new values?`, 'Overwrite Existing', 'Skip Existing');
                        if (!overwrite) {
                            fixesToProcess = fixes.filter(f => !existingMap.has(String(f.reference_number)));
                        } else {
                            // Merge blank cells with existing values so partial bulk uploads don't wipe existing fields
                            fixesToProcess = fixes.map(f => {
                                const old = existingMap.get(String(f.reference_number));
                                if (!old) return f;
                                return {
                                    reference_number: f.reference_number,
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

        const fixesSearch = document.getElementById('fixes-search');
        let fixesSearchTimeout;
        fixesSearch?.addEventListener('input', () => {
            clearTimeout(fixesSearchTimeout);
            fixesSearchTimeout = setTimeout(() => {
                this.loadFixes();
            }, 500);
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
                    <td><span class="badge ${statusClass}"${statusTitle}>${shortStatus}</span></td>
                    <td>${t.is_settled ? '<span class="badge" style="background:#3b82f6;color:white;padding:0.2rem 0.4rem;font-size:0.7rem;">Yes</span>' : '<span style="color:var(--text-muted);font-size:0.8rem;">No</span>'}</td>
                </tr>
            `;
        }).join('');
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(5) + '</tr>').join('');
        try {
            const allData = await fetchAll('item_mappings', '*', null, 'item_name');
            this.allMappingsData = allData;
            this.mappingsPage = 1;
            this.renderMappingsPage();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
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

        const totalPages = Math.max(1, Math.ceil(allData.length / pageSize));
        if (!this.mappingsPage || this.mappingsPage > totalPages) this.mappingsPage = 1;
        const startIdx = (this.mappingsPage - 1) * pageSize;
        const pageData = allData.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageData.map(m => `
            <tr>
                <td>${escapeHTML(m.item_name)}</td>
                <td>${escapeHTML(m.adjusted_item_name) || '-'}</td>
                <td>${escapeHTML(m.mapping) || '-'}</td>
                <td>${escapeHTML(m.second_mapping) || '-'}</td>
                <td>
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
                    document.getElementById('map-original').value = mapping.item_name || '';
                    document.getElementById('map-adjusted').value = mapping.adjusted_item_name || '';
                    document.getElementById('map-category').value = mapping.mapping || '';
                    document.getElementById('map-second-category').value = mapping.second_mapping || '';
                    document.getElementById('modal-mapping-title').innerText = 'Edit Mapping';
                    document.getElementById('modal-mapping').classList.remove('hidden');
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
            if (allData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'mappings-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, allData.length)} of ${allData.length} mappings</span>
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

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(6) + '</tr>').join('');
        try {
            const searchVal = document.getElementById('fixes-search')?.value.trim();
            const queryFn = searchVal ? (q) => q.ilike('reference_number', `%${searchVal}%`) : null;
            const allData = await fetchAll('manual_fixes', '*', queryFn, 'reference_number');
            this.allFixesData = allData;
            this.fixesPage = 1;
            this.renderFixesPage();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
        }
    }

    renderFixesPage() {
        const tbody = document.getElementById('fixes-body');
        if (!tbody) return;
        const allData = this.allFixesData || [];
        const pageSize = 100;

        if (allData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i data-lucide="wrench" style="width:48px;height:48px;opacity:0.5;"></i><h3>No manual fixes</h3><p>Click "Add Fix" to create a manual correction.</p></div></td></tr>';
            document.getElementById('fixes-pagination')?.remove();
            if (window.lucide) lucide.createIcons();
            return;
        }

        const totalPages = Math.max(1, Math.ceil(allData.length / pageSize));
        if (!this.fixesPage || this.fixesPage > totalPages) this.fixesPage = 1;
        const startIdx = (this.fixesPage - 1) * pageSize;
        const pageData = allData.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageData.map(f => `
            <tr>
                <td>${escapeHTML(f.reference_number)}</td>
                <td>${escapeHTML(f.correct_id) || '-'}</td>
                <td>${escapeHTML(f.item_name) || '-'}</td>
                <td>${escapeHTML(f.mapping) || '-'}</td>
                <td>${escapeHTML(f.second_mapping) || '-'}</td>
                <td>
                    <button class="btn btn-outline btn-sm" data-edit-fix="${escapeHTML(f.reference_number)}">Edit</button>
                    <button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-fix="${escapeHTML(f.reference_number)}">Delete</button>
                </td>
            </tr>
        `).join('');

        // Wire up Edit buttons
        tbody.querySelectorAll('[data-edit-fix]').forEach(btn => {
            btn.addEventListener('click', () => {
                const ref = btn.getAttribute('data-edit-fix');
                const fix = allData.find(f => f.reference_number === ref);
                if (fix) {
                    document.getElementById('fix-ref').value = fix.reference_number || '';
                    document.getElementById('fix-id').value = fix.correct_id || '';
                    document.getElementById('fix-name').value = fix.item_name || '';
                    document.getElementById('fix-mapping').value = fix.mapping || '';
                    document.getElementById('fix-second-mapping').value = fix.second_mapping || '';
                    document.getElementById('modal-fix-title').innerText = 'Edit Fix';
                    document.getElementById('modal-fix').classList.remove('hidden');
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
            if (allData.length <= pageSize) {
                if (pager) pager.remove();
            } else {
                if (!pager) {
                    pager = document.createElement('div');
                    pager.id = 'fixes-pagination';
                    pager.className = 'pagination';
                    container.appendChild(pager);
                }
                pager.innerHTML = `
                    <span class="text-muted">Showing ${startIdx + 1}-${Math.min(startIdx + pageSize, allData.length)} of ${allData.length} fixes</span>
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










