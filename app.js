import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';
import {
    validateID,
    getEffectiveIdStatus,
    isNonInvalidTransaction,
    isLockedTransaction,
    fetchAll,
    fetchByIn,
    recomputeTransactions,
    updateRuleFields,
    normalizeItemName,
    originalItemName,
    escapeHTML,
    sanitizeExcelValue,
    sanitizeExcelRows,
    toDateOnly,
    toPeriodMonth,
    isDateInClosedPeriods,
    dateToExcelSerial,
    isSameDaySettlementBank,
    getStudentProgramLevel,
    formatStudentLevelTag,
    buildImportIssuesCsv,
    writeCompressedExcel
} from './rules.js';

import {
    runConcurrent,
    loadScriptOnce,
    renderIcons,
    inlineIcon,
    SUPABASE_EXEMPT_OR_FILTER,
    formatIdStatusMeta,
    formatMoney,
    sanitizeForFilter,
    loadSavedFilterPresets,
    saveFilterPresetList,
    upsertFilterPreset,
    deleteFilterPreset,
    Toast
} from './app-utils.js';
import { applyDashboardMixin } from './dashboard.js';
import { applyAutoMatcherMixin } from './auto-matcher.js';
import { applyErpExportMixin } from './erp-export.js';
import { applyAdminAuditMixin } from './admin-audit.js';
import './settlement.js';
import { applyForeignUiMixin } from './foreign-ui.js';
import { applyPaymentLinksUiMixin } from './payment-links-ui.js';
import { applyStudentsUiMixin } from './students-ui.js';
import { applyMappingsFixesUiMixin } from './mappings-fixes-ui.js';

class App {
    constructor() {
        this.currentUser = null;
        this.userRole = 'viewer';
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
        this._tabLoadedAt = {};
        this._dirtyTabs = new Set();
        this._txCountCache = null;
        this._authUsersSynced = false;
        this.closedPeriods = [];
        this.closedPeriodSet = new Set();
        this.selectedTransactionsMap = new Map();
        this.lastImportIssues = [];
        
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
        this.initTransactionBulkAssign();
        this.initPageJumpHelpers();
        this.initPagination();
        this.initExport();
        this.initReapply();
        this.initPaymentLinks();
        this.initErpExport();
        this.initDashboard();
        this.initStudentMaster();
        this.initHistory();
        this.initDoublePaymentsDetector();
        this.initUsersAndRoles();
        this.initHygieneReportModal();
        this.initForeignTransactions();
        renderIcons();
        this.initAuth();
    }

    invalidateTabs(...tabIds) {
        if (!this._dirtyTabs) this._dirtyTabs = new Set();
        if (tabIds.length === 0) {
            this._tabLoadedAt = {};
            this._txCountCache = null;
            return;
        }
        for (const id of tabIds) {
            this._dirtyTabs.add(id);
            if (id === 'transactions') this._txCountCache = null;
            if (id === 'erp-export') {
                this.erpBaseData = null;
                this.erpBaseKey = null;
            }
        }
    }

    markTabLoaded(tabId) {
        if (!this._tabLoadedAt) this._tabLoadedAt = {};
        if (!this._dirtyTabs) this._dirtyTabs = new Set();
        this._tabLoadedAt[tabId] = Date.now();
        this._dirtyTabs.delete(tabId);
    }

    shouldReloadTab(tabId, maxAgeMs = 120000) {
        if (!this._tabLoadedAt || this._dirtyTabs?.has(tabId)) return true;
        const loadedAt = this._tabLoadedAt[tabId];
        if (!loadedAt) return true;
        return (Date.now() - loadedAt) > maxAgeMs;
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
                this._tabLoadedAt = {};
                this._dirtyTabs = new Set();
                this._txCountCache = null;
                this._authUsersSynced = false;
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
                renderIcons(btn);
            } else {
                Toast.show('Successfully signed in', 'success');
                btn.innerHTML = '<i data-lucide="log-in"></i> Sign In';
                btn.disabled = false;
            }
        });

        // Logout
        document.getElementById('btn-logout').addEventListener('click', async () => {
            document.getElementById('change-password-popover')?.classList.add('hidden');
            await supabase.auth.signOut();
            Toast.show('Signed out', 'info');
        });

        // Self-service Change Password popover
        const btnChangePw = document.getElementById('btn-change-password');
        const cpPopover = document.getElementById('change-password-popover');
        const cpForm = document.getElementById('change-password-form');
        const clearCpInputs = () => {
            ['cp-current-password', 'cp-new-password', 'cp-confirm-password'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        };
        if (btnChangePw && cpPopover) {
            btnChangePw.addEventListener('click', () => {
                const willShow = cpPopover.classList.contains('hidden');
                clearCpInputs();
                cpPopover.classList.toggle('hidden', !willShow);
                if (willShow) document.getElementById('cp-current-password')?.focus();
            });
        }
        document.getElementById('btn-cancel-change-password')?.addEventListener('click', () => {
            clearCpInputs();
            cpPopover?.classList.add('hidden');
        });
        if (cpForm) {
            cpForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const currentPassword = String(document.getElementById('cp-current-password')?.value || '');
                const newPassword = String(document.getElementById('cp-new-password')?.value || '');
                const confirmPassword = String(document.getElementById('cp-confirm-password')?.value || '');

                if (newPassword.length < 8) {
                    Toast.show('New password must be at least 8 characters.', 'warning');
                    return;
                }
                if (newPassword !== confirmPassword) {
                    Toast.show('New password and confirmation do not match.', 'warning');
                    return;
                }

                const submitBtn = document.getElementById('btn-submit-change-password');
                if (submitBtn) submitBtn.disabled = true;
                try {
                    const { error } = await supabase.auth.changePassword({ currentPassword, newPassword });
                    if (error) throw error;
                    clearCpInputs();
                    cpPopover?.classList.add('hidden');
                    Toast.show('Your password has been updated.', 'success');
                } catch (err) {
                    Toast.show('Password update failed: ' + err.message, 'error');
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
        }
    }

    getRoleLevel(role) {
        const levels = { viewer: 1, operator: 2, accountant: 3, admin: 4 };
        return levels[String(role || 'viewer').trim().toLowerCase()] || 0;
    }

    hasRole(minRole) {
        return this.getRoleLevel(this.userRole) >= this.getRoleLevel(minRole);
    }

    requireRole(minRole, actionDesc = 'perform this action') {
        if (this.hasRole(minRole)) return true;
        const roleLabel = String(minRole).charAt(0).toUpperCase() + String(minRole).slice(1);
        Toast.show(`Permission denied: ${roleLabel} role (or higher) is required to ${actionDesc}.`, 'warning');
        return false;
    }

    async fetchUserRole(user) {
        if (!user || !user.email) {
            this.userIsActive = false;
            this.userRole = 'viewer';
            return 'viewer';
        }
        const email = String(user.email).trim().toLowerCase();
        if (email === 'ammahmoud@nu.edu.eg') {
            this.userIsActive = true;
            this.userRole = 'admin';
            try {
                await supabase.from('user_roles').upsert({
                    email: 'ammahmoud@nu.edu.eg',
                    role: 'admin',
                    updated_by: user.email,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'email' });
            } catch (_e) {
                // ignore if table not migrated yet
            }
            return 'admin';
        }
        this.userIsActive = true;
        try {
            let { data, error } = await supabase
                .from('user_roles')
                .select('role, is_active')
                .ilike('email', email)
                .maybeSingle();

            // Backwards compatibility if migration 2.6.0 (is_active) has not been run yet
            if (error && /is_active/i.test(error.message || '')) {
                const fallback = await supabase
                    .from('user_roles')
                    .select('role')
                    .ilike('email', email)
                    .maybeSingle();
                data = fallback.data;
                error = fallback.error;
            }

            if (!error && data) {
                if (data.is_active === false) {
                    this.userIsActive = false;
                    this.userRole = 'deactivated';
                    return 'deactivated';
                }
                if (data.role) {
                    const r = String(data.role).trim().toLowerCase();
                    if (['viewer', 'operator', 'accountant', 'admin'].includes(r)) {
                        this.userRole = r;
                        return r;
                    }
                }
            } else if (!error && !data) {
                // User signed in but has no user_roles entry yet: add as viewer so Admin sees them
                try {
                    await supabase.from('user_roles').insert({
                        email,
                        role: 'viewer',
                        updated_by: 'User Sign-in',
                        updated_at: new Date().toISOString()
                    });
                } catch (_insErr) {
                    // ignore if concurrent or blocked
                }
            }
        } catch (err) {
            console.warn('Could not fetch user role, defaulting to viewer:', err.message);
        }
        this.userRole = 'viewer';
        return 'viewer';
    }

    applyRolePermissionsToUI() {
        const role = String(this.userRole || 'viewer').toLowerCase();
        const badgeEl = document.getElementById('user-role-badge');
        if (badgeEl) {
            const roleMeta = {
                admin: { label: 'Admin', bg: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', border: 'rgba(168, 85, 247, 0.35)' },
                accountant: { label: 'Accountant', bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: 'rgba(16, 185, 129, 0.35)' },
                operator: { label: 'Operator', bg: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: 'rgba(56, 189, 248, 0.35)' },
                viewer: { label: 'Viewer', bg: 'rgba(148, 163, 184, 0.15)', color: 'var(--text-muted)', border: 'rgba(148, 163, 184, 0.3)' }
            };
            const meta = roleMeta[role] || roleMeta.viewer;
            badgeEl.textContent = meta.label;
            badgeEl.style.background = meta.bg;
            badgeEl.style.color = meta.color;
            badgeEl.style.borderColor = meta.border;
        }

        const navUsers = document.getElementById('nav-link-users');
        if (navUsers) {
            navUsers.style.display = this.hasRole('admin') ? 'flex' : 'none';
        }

        const setElVisible = (id, visible) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.tagName === 'INPUT' && el.type === 'file') {
                el.style.display = 'none';
                const nextBtn = el.nextElementSibling;
                if (nextBtn && nextBtn.tagName === 'BUTTON') {
                    nextBtn.style.display = visible ? '' : 'none';
                }
            } else {
                el.style.display = visible ? '' : 'none';
            }
            const wrapper = el.closest('label.upload-btn-wrapper');
            if (wrapper) wrapper.style.display = visible ? '' : 'none';
        };

        const isOperator = this.hasRole('operator');
        const isAccountant = this.hasRole('accountant');
        const isAdmin = this.hasRole('admin');

        // Operator+ controls (Imports, Student Master Add/Edit/Upload, Payment Links Create/Edit/Import)
        [
            'btn-show-import',
            'btn-show-foreign-import',
            'btn-toggle-student-import',
            'btn-add-student',
            'btn-edit-profile-student',
            'btn-add-link',
            'btn-import-links',
            'btn-template-links'
        ].forEach(id => setElVisible(id, isOperator));

        // Accountant+ controls (Mappings, Manual Fixes, Auto-Matcher apply, Re-apply rules, Settlement mark, ERP record)
        [
            'btn-reapply-rules',
            'btn-apply-reapply-fixes',
            'btn-add-mapping',
            'btn-save-mapping',
            'file-upload-mappings',
            'btn-add-fix',
            'btn-save-fix',
            'file-upload-fixes',
            'btn-select-high-confidence',
            'btn-apply-automatch-fixes',
            'btn-confirm-automatch',
            'btn-mark-settled',
            'btn-save-settlement-run',
            'btn-record-erp',
            'btn-foreign-automatch'
        ].forEach(id => setElVisible(id, isAccountant));

        // Admin-only controls (Duplicate cleanup, Deduplication, User Role management)
        [
            'btn-detect-duplicates',
            'btn-cleanup-duplicates',
            'btn-dedup-mappings',
            'btn-dedup-fixes',
            'btn-save-user-role'
        ].forEach(id => setElVisible(id, isAdmin));

        this.updateTxBulkSelectionUI?.();
    }

    async setupUser(user) {
        const resolvedRole = await this.fetchUserRole(user);
        if (resolvedRole === 'deactivated' || this.userIsActive === false) {
            this.currentUser = null;
            const deactivatedMsg = 'Your account has been deactivated. Contact the Finance System Admin.';
            const authErr = document.getElementById('auth-error');
            if (authErr) {
                authErr.textContent = deactivatedMsg;
                authErr.style.display = 'block';
            }
            document.getElementById('auth-overlay')?.classList.remove('hidden');
            Toast.show(deactivatedMsg, 'error');
            try { await supabase.auth.signOut(); } catch (_e) { /* ignore */ }
            return;
        }

        this.currentUser = user;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('user-profile-section').style.display = 'flex';
        document.getElementById('user-email-display').innerText = user.email;
        this.applyRolePermissionsToUI();
        renderIcons();
        this.fetchUniqueFilters();
        this.loadClosedPeriods({ silent: true });
        if (!this.restoreActiveTabFromUrl()) {
            this.loadTransactions();
        }
        this.updateSidebarBadges();
        if (this.hasRole('admin')) {
            this.checkAndShowHygieneReportModal();
        }
        // ERP Export data is loaded when that tab is opened (see initNavigation)
        this.initRealtime();
    }

    /**
     * Checks if any database transactions have a time component in payment_date
     * and strips it in-place to pure YYYY-MM-DD without shifting the calendar date.
     * Since payment_date is a DATE column in PostgreSQL, this is a no-op unless force=true.
     */
    async stripDatabaseTransactionTimes({ force = false } = {}) {
        if (!force) return 0;
        try {
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

    markLocalTxMutation() {
        this._lastLocalTxMutationAt = Date.now();
    }

    refreshActiveViewFromRealtime() {
        const views = document.querySelectorAll('.view.active');
        if (views.length > 0) {
            const activeId = views[0].id;
            if (activeId === 'view-transactions') {
                Toast.show('New activity detected. Refreshing data...', 'info');
                this.loadTransactions();
            } else if (activeId === 'view-dashboard') {
                this.loadDashboard();
            } else if (activeId === 'view-erp-export') {
                this.loadErpExport({ refresh: true });
            }
        }
        this.updateSidebarBadges({ force: true });
    }

    initRealtime() {
        if (!this._visibilityListenerBound && typeof document !== 'undefined') {
            this._visibilityListenerBound = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this._pendingRealtimeRefresh) {
                    this._pendingRealtimeRefresh = false;
                    this.refreshActiveViewFromRealtime();
                }
            });
        }
        if (this.realtimeChannel) return;
        this.realtimeChannel = supabase.channel('table-db-changes')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'transactions' },
                () => {
                    this.invalidateTabs('dashboard', 'transactions', 'erp-export', 'history');
                    this._badgeCache = null;

                    // Skip self-echoes right after local imports or bulk edits
                    if (this.isImporting || (Date.now() - (this._lastLocalTxMutationAt || 0) < 4000)) {
                        return;
                    }

                    // Skip background refreshes when tab is hidden; refresh when user returns
                    if (typeof document !== 'undefined' && document.hidden) {
                        this._pendingRealtimeRefresh = true;
                        return;
                    }

                    // Stagger refreshes across concurrent users (3.0s - 5.5s jitter)
                    if (this.realtimeTimeout) clearTimeout(this.realtimeTimeout);
                    const jitterMs = 3000 + Math.floor(Math.random() * 2500);
                    this.realtimeTimeout = setTimeout(() => {
                        this.realtimeTimeout = null;
                        if (typeof document !== 'undefined' && document.hidden) {
                            this._pendingRealtimeRefresh = true;
                            return;
                        }
                        this.refreshActiveViewFromRealtime();
                    }, jitterMs);
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
        try { savedTheme = localStorage.getItem('fawry-theme'); } catch (_e) { /* storage unavailable */ }
        const saveTheme = (t) => { try { localStorage.setItem('fawry-theme', t); } catch (_e) { /* ignore */ } };
        const prefersLight = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: light)').matches
            : false;

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
        const applyNoAutocomplete = (el) => {
            if (!el || typeof el.setAttribute !== 'function') return;
            el.setAttribute('autocomplete', 'off');
            el.setAttribute('autocorrect', 'off');
            el.setAttribute('autocapitalize', 'off');
            el.setAttribute('spellcheck', 'false');
            el.setAttribute('data-lpignore', 'true');
            el.setAttribute('data-form-type', 'other');
            el.setAttribute('aria-autocomplete', 'none');
        };

        document.querySelectorAll('input[type="date"], input[type="month"], input[type="datetime-local"]').forEach(applyNoAutocomplete);

        if (window.flatpickr) {
            flatpickr('input[type="date"]', {
                dateFormat: "Y-m-d",
                allowInput: false,
                disableMobile: true,
                onReady: (_selectedDates, _dateStr, instance) => {
                    applyNoAutocomplete(instance?.input);
                    applyNoAutocomplete(instance?.altInput);
                }
            });
        }
    }

    async fetchUniqueFilters({ force = false } = {}) {
        const cacheKey = 'spdb-unique-filters-v1';
        if (!force) {
            try {
                const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(cacheKey) : null;
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && Array.isArray(parsed.mapping) && Array.isArray(parsed.item_name) && (Date.now() - (parsed.ts || 0)) < 300000) {
                        this.uniqueLists.mapping = parsed.mapping;
                        this.uniqueLists.item_name = parsed.item_name;
                        return this.uniqueLists;
                    }
                }
            } catch (_e) { /* ignore storage errors */ }
            if (this._uniqueFiltersPromise) return this._uniqueFiltersPromise;
        }

        this._uniqueFiltersPromise = (async () => {
            try {
                const { data, error } = await supabase.from('item_mappings').select('mapping, item_name');
                if (!error && data) {
                    this.uniqueLists.mapping = [...new Set(data.map(d => d.mapping).filter(Boolean))].sort();
                    this.uniqueLists.item_name = [...new Set(data.map(d => d.item_name).filter(Boolean))].sort();
                    try {
                        if (typeof sessionStorage !== 'undefined') {
                            sessionStorage.setItem(cacheKey, JSON.stringify({
                                ts: Date.now(),
                                mapping: this.uniqueLists.mapping,
                                item_name: this.uniqueLists.item_name
                            }));
                        }
                    } catch (_e) { /* ignore storage errors */ }
                }
            } catch (err) {
                console.error('Error fetching distinct mappings:', err);
            } finally {
                this._uniqueFiltersPromise = null;
            }
            return this.uniqueLists;
        })();
        return this._uniqueFiltersPromise;
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
            this.invalidateTabs('dashboard', 'transactions', 'history', 'erp-export');
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
            link.addEventListener('click', async (e) => {
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

                // Persist active tab in URL hash & sessionStorage so refresh restores exact page
                try {
                    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('spdb-active-tab', tabId);
                    if (typeof window !== 'undefined' && window.history?.replaceState && window.location.hash !== `#${tabId}`) {
                        window.history.replaceState(null, '', `#${tabId}`);
                    }
                } catch (_e) { /* ignore history restrictions */ }

                if (tabId === 'settlement') {
                    try {
                        if (typeof window.SettlementProcessor === 'undefined') {
                            await loadScriptOnce('./settlement.js?v=2.5.6');
                        }
                        if (!window.settlementApp && typeof window.SettlementProcessor !== 'undefined') {
                            window.settlementApp = new window.SettlementProcessor(supabase);
                        } else if (this.shouldReloadTab('settlement') && typeof window.settlementApp?.loadSettlementHistory === 'function') {
                            window.settlementApp.loadSettlementHistory();
                            this.markTabLoaded('settlement');
                        }
                    } catch (err) {
                        Toast.show('Could not load Settlement module: ' + err.message, 'error');
                    }
                }
                if (tabId === 'dashboard' && this.shouldReloadTab('dashboard')) this.loadDashboard();
                if (tabId === 'transactions' && this.shouldReloadTab('transactions')) this.loadTransactions();
                if (tabId === 'foreign-transactions' && this.shouldReloadTab('foreign-transactions')) this.loadForeignTransactions();
                if (tabId === 'mappings' && this.shouldReloadTab('mappings')) this.loadMappings();
                if (tabId === 'fixes' && this.shouldReloadTab('fixes')) this.loadFixes();
                if (tabId === 'history' && this.shouldReloadTab('history')) this.loadHistory();
                if (tabId === 'payment-links' && this.shouldReloadTab('payment-links')) this.loadPaymentLinks();
                if (tabId === 'erp-export' && this.shouldReloadTab('erp-export')) this.loadErpExport();
                if (tabId === 'student-master') {
                    document.getElementById('inline-student-profile')?.classList.add('hidden');
                    document.getElementById('student-directory-view')?.classList.remove('hidden');
                    if (this.shouldReloadTab('student-master', 300000)) {
                        this.loadStudents({ skipAutoProfile: true });
                    }
                }
                if (tabId === 'users' && this.shouldReloadTab('users')) {
                    this.loadUsersAndRoles();
                }
            });
        });

        window.addEventListener('hashchange', () => {
            const hashTab = (window.location.hash || '').replace(/^#/, '').trim();
            if (!hashTab) return;
            const targetLink = document.querySelector(`.nav-link[data-tab="${hashTab}"]`);
            if (targetLink && targetLink.style.display !== 'none' && !targetLink.classList.contains('active')) {
                targetLink.click();
            }
        });
    }

    restoreActiveTabFromUrl() {
        let desiredTab = '';
        try {
            desiredTab = (window.location.hash || '').replace(/^#/, '').trim();
            if (!desiredTab && typeof sessionStorage !== 'undefined') {
                desiredTab = (sessionStorage.getItem('spdb-active-tab') || '').trim();
            }
        } catch (_e) { /* ignore */ }
        if (!desiredTab || desiredTab === 'transactions') return false;
        const targetLink = document.querySelector(`.nav-link[data-tab="${desiredTab}"]`);
        if (targetLink && targetLink.style.display !== 'none') {
            targetLink.click();
            return true;
        }
        return false;
    }

    async copyTextWithToast(text, label = 'Value') {
        const val = String(text || '').trim();
        if (!val) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(val);
            } else {
                const ta = document.createElement('textarea');
                ta.value = val;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            Toast.show(`Copied ${label}: ${val}`, 'success');
        } catch (_e) {
            Toast.show('Could not copy to clipboard', 'warning');
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

        document.getElementById('btn-download-import-errors')?.addEventListener('click', () => {
            const issues = this.lastImportIssues || [];
            const csv = buildImportIssuesCsv(issues);
            if (!csv) {
                Toast.show('No import issues to export.', 'info');
                return;
            }
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `fawry_import_issues_${toDateOnly(new Date()) || 'report'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            Toast.show(`Downloaded CSV issue report (${issues.length} row(s)).`, 'success');
        });
    }

    async handleFiles(files) {
        if (this.isImporting) {
            Toast.show('An import is already in progress. Please wait.', 'warning');
            return;
        }
        this.isImporting = true;
        this.lastImportIssues = [];
        const btnErrDownload = document.getElementById('btn-download-import-errors');
        btnErrDownload?.classList.add('hidden');
        
        try {
            document.getElementById('import-progress').classList.remove('hidden');
            document.getElementById('import-log').innerHTML = '';
            
            const processor = new FawryProcessor(this.currentUser?.email || 'System');
            const success = await processor.processFiles(files);
            this.lastImportIssues = Array.isArray(processor.importIssues) ? processor.importIssues : [];
            
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

            this.markLocalTxMutation();
            this.invalidateDistinctCache();
            this.updateSidebarBadges({ force: true });

            const actionBar = document.getElementById('import-action-bar');
            if (actionBar) {
                actionBar.style.display = 'flex';
                if (btnErrDownload) {
                    if (this.lastImportIssues.length > 0) {
                        btnErrDownload.innerHTML = `<i data-lucide="file-warning" style="width: 16px; height: 16px; margin-right: 6px;"></i> Download Issue Report (${this.lastImportIssues.length})`;
                        btnErrDownload.classList.remove('hidden');
                    } else {
                        btnErrDownload.classList.add('hidden');
                    }
                }
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
        this._uniqueFiltersPromise = null;
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('spdb-unique-filters-v1');
            }
        } catch (_e) { /* ignore */ }
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

        const ruleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
        const byItemNamePromise = fetchByIn('transactions', ruleCols, 'item_name', searchNames, 'id', 100);

        // Also fetch by check_column suffix for single/small batches so previously renamed items are never missed
        // Exclude rows where item_name === name since byItemNamePromise already fetches them
        let byCheckColPromise = Promise.resolve([]);
        if (normTargets.length <= 15) {
            const checkTasks = normTargets.map(name => async () => {
                const safe = name.replace(/[%_]/g, '\\$&');
                return await fetchAll('transactions', ruleCols, q => q.ilike('check_column', `%-${safe}`).neq('item_name', name), 'id');
            });
            byCheckColPromise = runConcurrent(checkTasks, 4).then(res => res.flat());
        }

        const [byItemName, byCheckCol] = await Promise.all([byItemNamePromise, byCheckColPromise]);

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
    // Settled / ERP-recorded rows and closed accounting periods are never changed here; they are counted in lockedSkipped / periodLockedSkipped.
    async reapplyRulesTo(rows, opts = {}) {
        const all = await recomputeTransactions(rows, {
            includeLocked: true,
            mappings: opts.mappings ?? this.allMappingsData ?? undefined,
            fixes: opts.fixes ?? this.allFixesData ?? undefined,
            links: opts.links ?? undefined
        });
        const periodSet = this.closedPeriodSet;
        let periodLockedSkipped = 0;
        const open = all.filter(c => {
            if (isDateInClosedPeriods(c.tx?.payment_date, periodSet)) {
                periodLockedSkipped++;
                return false;
            }
            return !c.diff.locked;
        });
        const updated = open.length > 0 ? await updateRuleFields(open) : 0;
        if (updated > 0) {
            this.markLocalTxMutation();
            this.invalidateDistinctCache();
            this.invalidateTabs('dashboard', 'transactions', 'erp-export');
        }
        return {
            updated,
            lockedSkipped: all.length - open.length - periodLockedSkipped,
            periodLockedSkipped,
            appliedChanges: open,
            allChanges: all
        };
    }

    // Toast text for a reapplyRulesTo result
    reapplySummary({ updated, lockedSkipped, periodLockedSkipped = 0 }) {
        let msg = `${updated} transaction(s) updated.`;
        if (lockedSkipped > 0) msg += ` ${lockedSkipped} settled/ERP-recorded transaction(s) left unchanged – review them with "Re-apply Rules".`;
        if (periodLockedSkipped > 0) msg += ` ${periodLockedSkipped} transaction(s) skipped because their accounting month is closed.`;
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
        this.invalidateTabs('history');
        if (error) console.warn('Could not record import history:', error.message);
    }

    async logAudit(action, affected, details, oldData, newData) {
        if (!this.currentUser) return;
        let payloadDetails = details;
        let affectedRef = affected;
        if (oldData !== undefined || newData !== undefined) {
            affectedRef = `${affected}:${details || ''}`;
            payloadDetails = {
                table: affected,
                record_id: details,
                before: oldData,
                after: newData,
                user_role: this.userRole || 'viewer'
            };
        } else if (payloadDetails && typeof payloadDetails === 'object' && !Array.isArray(payloadDetails)) {
            payloadDetails = { ...payloadDetails, user_role: this.userRole || 'viewer' };
        } else {
            payloadDetails = { value: payloadDetails, user_role: this.userRole || 'viewer' };
        }
        const { error } = await supabase.from('audit_logs').insert({
            user_email: this.currentUser.email,
            action,
            affected_references: affectedRef,
            details: payloadDetails
        });
        if (error) console.warn('Audit log failed:', error.message);
    }

    initFilters() {
        this.txQuickFilter = 'all';
        this.txSortCol = 'payment_date';
        this.txSortAsc = false;

        const setDateInput = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = val;
            if (el._flatpickr) el._flatpickr.setDate(val || '', false);
        };

        const syncQuickFilterButtons = () => {
            document.querySelectorAll('[data-tx-quick-filter]').forEach(btn => {
                const isActive = btn.getAttribute('data-tx-quick-filter') === (this.txQuickFilter || 'all');
                btn.classList.toggle('btn-primary', isActive);
                btn.classList.toggle('btn-outline', !isActive);
            });
        };

        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            this.currentPage = 1;
            this.renderFilterChips('transactions');
            this.loadTransactions();
        });
        document.getElementById('btn-clear-filters').addEventListener('click', () => {
            setDateInput('filter-date-from', '');
            setDateInput('filter-date-to', '');
            document.getElementById('search-input').value = '';
            this.headerFilters.transactions = {};
            this.txQuickFilter = 'all';
            syncQuickFilterButtons();
            document.querySelectorAll('[data-table="transactions"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.currentPage = 1;
            this.renderFilterChips('transactions');
            this.loadTransactions();
        });

        // Date Range Presets
        document.querySelectorAll('[data-tx-date-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-tx-date-preset');
                const now = new Date();
                const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

                if (preset === 'today') {
                    const s = fmtDate(now);
                    setDateInput('filter-date-from', s);
                    setDateInput('filter-date-to', s);
                } else if (preset === '7d') {
                    const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
                    setDateInput('filter-date-from', fmtDate(past));
                    setDateInput('filter-date-to', fmtDate(now));
                } else if (preset === 'this_month') {
                    const first = new Date(now.getFullYear(), now.getMonth(), 1);
                    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                    setDateInput('filter-date-from', fmtDate(first));
                    setDateInput('filter-date-to', fmtDate(last));
                } else if (preset === 'last_month') {
                    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    const last = new Date(now.getFullYear(), now.getMonth(), 0);
                    setDateInput('filter-date-from', fmtDate(first));
                    setDateInput('filter-date-to', fmtDate(last));
                } else {
                    setDateInput('filter-date-from', '');
                    setDateInput('filter-date-to', '');
                }
                this.currentPage = 1;
                this.loadTransactions();
            });
        });

        // Quick Filter Pills
        document.querySelectorAll('[data-tx-quick-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-tx-quick-filter') || 'all';
                this.txQuickFilter = (this.txQuickFilter === target && target !== 'all') ? 'all' : target;
                syncQuickFilterButtons();
                this.currentPage = 1;
                this.loadTransactions();
            });
        });

        // Column Sorting Triggers
        document.querySelectorAll('.th-sort-trigger').forEach(trigger => {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const col = trigger.getAttribute('data-sort-col');
                if (!col) return;
                if (this.txSortCol === col) {
                    this.txSortAsc = !this.txSortAsc;
                } else {
                    this.txSortCol = col;
                    this.txSortAsc = (col === 'item_name' || col === 'student_id' || col === 'reference_number');
                }
                document.querySelectorAll('.th-sort-trigger').forEach(t => {
                    const ind = t.querySelector('.sort-indicator');
                    if (!ind) return;
                    if (t.getAttribute('data-sort-col') === this.txSortCol) {
                        ind.textContent = this.txSortAsc ? '▲' : '▼';
                    } else {
                        ind.textContent = '';
                    }
                });
                this.currentPage = 1;
                this.loadTransactions();
            });
        });

        document.getElementById('btn-clear-automatcher')?.addEventListener('click', () => {
            const hadDateOrTarget = Boolean(
                document.getElementById('automatcher-date-from')?.value ||
                document.getElementById('automatcher-date-to')?.value ||
                (this.targetedMatchRefs && this.targetedMatchRefs.length > 0)
            );
            document.getElementById('automatcher-date-from').value = '';
            document.getElementById('automatcher-date-to').value = '';
            document.getElementById('automatcher-search').value = '';
            const toggle = document.getElementById('automatch-toggle-unmatched');
            if (toggle) toggle.checked = false;
            this.automatchTierFilter = 'all';
            document.querySelectorAll('[data-automatch-tier]').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-automatch-tier') === 'all');
            });
            this.targetedMatchRefs = [];
            const importStatus = document.getElementById('automatcher-import-status');
            if (importStatus) importStatus.innerText = '';
            this.headerFilters.automatch = {};
            document.querySelectorAll('[data-table="automatch"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.renderFilterChips('automatch');
            this.automatchPage = 1;
            if (hadDateOrTarget || !this.automatchProposals || this.automatchProposals.length === 0) {
                this.runAutoMatcher();
            } else {
                this.renderAutoMatcherPage();
            }
        });

        let automatchSearchTimeout;
        document.getElementById('automatcher-search')?.addEventListener('input', () => {
            clearTimeout(automatchSearchTimeout);
            automatchSearchTimeout = setTimeout(() => {
                this.automatchPage = 1;
                if (this.automatchProposals && this.automatchProposals.length > 0) {
                    this.renderAutoMatcherPage();
                } else {
                    this.runAutoMatcher();
                }
            }, 250);
        });

        document.getElementById('automatcher-date-from')?.addEventListener('change', () => this.runAutoMatcher());
        document.getElementById('automatcher-date-to')?.addEventListener('change', () => this.runAutoMatcher());

        const searchInput = document.getElementById('search-input');
        let searchTimeout;
        searchInput?.addEventListener('paste', (e) => {
            const pasted = e.clipboardData?.getData('text');
            if (pasted && /[\r\n\t]/.test(pasted)) {
                e.preventDefault();
                const normalized = pasted
                    .split(/[\r\n\t,;]+/)
                    .map(s => s.trim())
                    .filter(Boolean)
                    .join(', ');
                searchInput.value = normalized;
                clearTimeout(searchTimeout);
                this.currentPage = 1;
                this.loadTransactions();
            }
        });
        searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.currentPage = 1;
                this.loadTransactions();
            }, 400);
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
        this.initTransactionFilterPresets();
    }

    initTransactionFilterPresets() {
        this._txPresetStorageKey = 'spdb-tx-filter-presets-v1';
        this.txFilterPresets = loadSavedFilterPresets(this._txPresetStorageKey);
        this.activeTxPresetId = '';

        const selectEl = document.getElementById('tx-saved-preset-select');
        const nameInput = document.getElementById('tx-preset-name-input');
        const btnSave = document.getElementById('btn-save-tx-preset');
        const btnDelete = document.getElementById('btn-delete-tx-preset');
        const pillsEl = document.getElementById('tx-saved-presets-pills');

        selectEl?.addEventListener('change', () => {
            const id = selectEl.value;
            this.activeTxPresetId = id;
            if (btnDelete) btnDelete.disabled = !id;
            const preset = this.txFilterPresets.find(p => p.id === id);
            if (preset) this.applyTransactionFilterPreset(preset);
        });

        btnSave?.addEventListener('click', () => {
            const rawName = String(nameInput?.value || '').trim();
            const fallbackName = `View ${new Date().toLocaleDateString()} ${(this.txFilterPresets?.length || 0) + 1}`;
            const name = rawName || fallbackName;
            const state = this.captureTransactionFilterState();
            this.txFilterPresets = upsertFilterPreset(this.txFilterPresets, { name, state });
            saveFilterPresetList(this._txPresetStorageKey, this.txFilterPresets);
            const saved = this.txFilterPresets[0];
            this.activeTxPresetId = saved ? saved.id : '';
            if (nameInput) nameInput.value = '';
            this.renderTransactionFilterPresets();
            Toast.show(`Saved Transactions view "${name}".`, 'success');
        });

        btnDelete?.addEventListener('click', () => {
            const id = this.activeTxPresetId || selectEl?.value;
            if (!id) return;
            const target = this.txFilterPresets.find(p => p.id === id);
            this.txFilterPresets = deleteFilterPreset(this.txFilterPresets, id);
            saveFilterPresetList(this._txPresetStorageKey, this.txFilterPresets);
            this.activeTxPresetId = '';
            this.renderTransactionFilterPresets();
            Toast.show(`Deleted saved view${target ? ` "${target.name}"` : ''}.`, 'info');
        });

        pillsEl?.addEventListener('click', (e) => {
            const pill = e.target.closest('[data-tx-preset-id]');
            if (!pill) return;
            const id = pill.getAttribute('data-tx-preset-id');
            const preset = this.txFilterPresets.find(p => p.id === id);
            if (!preset) return;
            this.activeTxPresetId = preset.id;
            this.applyTransactionFilterPreset(preset);
        });

        this.renderTransactionFilterPresets();
    }

    captureTransactionFilterState() {
        return {
            dateFrom: document.getElementById('filter-date-from')?.value || '',
            dateTo: document.getElementById('filter-date-to')?.value || '',
            search: document.getElementById('search-input')?.value || '',
            quickFilter: this.txQuickFilter || 'all',
            sortCol: this.txSortCol || 'payment_date',
            sortAsc: Boolean(this.txSortAsc),
            headerFilters: JSON.parse(JSON.stringify(this.headerFilters?.transactions || {}))
        };
    }

    renderTransactionFilterPresets() {
        const selectEl = document.getElementById('tx-saved-preset-select');
        const pillsEl = document.getElementById('tx-saved-presets-pills');
        const btnDelete = document.getElementById('btn-delete-tx-preset');
        const presets = Array.isArray(this.txFilterPresets) ? this.txFilterPresets : [];

        if (selectEl) {
            selectEl.innerHTML = '<option value="">Load saved view...</option>' +
                presets.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`).join('');
            selectEl.value = presets.some(p => p.id === this.activeTxPresetId) ? this.activeTxPresetId : '';
        }
        if (btnDelete) {
            btnDelete.disabled = !(this.activeTxPresetId && presets.some(p => p.id === this.activeTxPresetId));
        }
        if (pillsEl) {
            pillsEl.innerHTML = presets.slice(0, 4).map(p => {
                const isActive = p.id === this.activeTxPresetId;
                return `<button type="button" class="btn ${isActive ? 'btn-primary' : 'btn-outline'} btn-sm" data-tx-preset-id="${escapeHTML(p.id)}" style="padding: 0.14rem 0.5rem; font-size: 0.72rem;">${escapeHTML(p.name)}</button>`;
            }).join('');
        }
    }

    applyTransactionFilterPreset(preset) {
        if (!preset || !preset.state) return;
        const st = preset.state;
        const setDate = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = val || '';
            if (el._flatpickr) el._flatpickr.setDate(val || '', false);
        };
        setDate('filter-date-from', st.dateFrom || '');
        setDate('filter-date-to', st.dateTo || '');
        const searchEl = document.getElementById('search-input');
        if (searchEl) searchEl.value = st.search || '';

        this.txQuickFilter = st.quickFilter || 'all';
        document.querySelectorAll('[data-tx-quick-filter]').forEach(btn => {
            const isActive = btn.getAttribute('data-tx-quick-filter') === this.txQuickFilter;
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-outline', !isActive);
        });

        this.txSortCol = st.sortCol || 'payment_date';
        this.txSortAsc = Boolean(st.sortAsc);
        document.querySelectorAll('.th-sort-trigger').forEach(t => {
            const ind = t.querySelector('.sort-indicator');
            if (!ind) return;
            if (t.getAttribute('data-sort-col') === this.txSortCol) {
                ind.textContent = this.txSortAsc ? '▲' : '▼';
            } else {
                ind.textContent = '';
            }
        });

        this.headerFilters.transactions = st.headerFilters && typeof st.headerFilters === 'object'
            ? JSON.parse(JSON.stringify(st.headerFilters))
            : {};
        document.querySelectorAll('[data-table="transactions"][data-column]').forEach(wrapper => {
            const col = wrapper.getAttribute('data-column');
            const icon = wrapper.querySelector('.header-filter-icon');
            if (!icon) return;
            const vals = this.headerFilters.transactions[col];
            icon.classList.toggle('active', Array.isArray(vals) && vals.length > 0);
        });

        this.renderTransactionFilterPresets();
        this.currentPage = 1;
        this.renderFilterChips('transactions');
        this.loadTransactions();
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
                options = ['Valid', 'Exempt', 'Missing ID', 'Error'];
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
                            const rows = await fetchAll('transactions', `id, ${currentColumn}`, null, 'id');
                            values = [...new Set(rows.map(r => r[currentColumn]).filter(v => v !== null && v !== undefined && v !== ''))].sort();
                        }
                        this.distinctCache[currentColumn] = {
                            at: Date.now(),
                            values
                        };
                    }
                    options = [...this.distinctCache[currentColumn].values];
                    if (currentColumn === 'mapping' || currentColumn === 'second_mapping') {
                        options.unshift('(Empty / Unmapped)');
                    }
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
                        const orderCol = currentColumn === 'payment_date' ? 'payment_date' : 'id';
                        const { data, error } = await query.order(orderCol, { ascending: false }).limit(500);
                        if (!error && data) {
                            const distinct = [...new Set(data.map(d => d[currentColumn]).filter(v => v !== null && v !== undefined))];
                            options = currentColumn === 'payment_date'
                                ? distinct.map(v => toDateOnly(v) || v).sort((a, b) => String(b).localeCompare(String(a)))
                                : distinct.sort();
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
            else if (this.automatchProposals && this.automatchProposals.length > 0) { this.automatchPage = 1; this.renderAutoMatcherPage(); }
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
            else if (this.automatchProposals && this.automatchProposals.length > 0) { this.automatchPage = 1; this.renderAutoMatcherPage(); }
            else { this.runAutoMatcher(); }
        });
    }

    initPageJumpHelpers() {
        const helper = {
            renderHtml: (prefix, totalPages = 1) => `
                <div style="display: inline-flex; align-items: center; gap: 0.35rem; margin-left: 0.35rem;">
                    <input type="number" id="${prefix}-jump-page" class="input-text page-jump-input" min="1" max="${Math.max(1, totalPages)}" placeholder="Page #" aria-label="Go to page" style="width: 74px; padding: 0.28rem 0.45rem; font-size: 0.82rem;">
                    <button type="button" id="btn-${prefix}-jump-page" class="btn btn-outline btn-sm" style="padding: 0.3rem 0.55rem;">Go</button>
                </div>
            `,
            bind: (prefix, getMaxPage, onJump, root = document) => {
                const input = root.querySelector(`#${prefix}-jump-page`);
                const btn = root.querySelector(`#btn-${prefix}-jump-page`);
                if (!input || !btn) return;
                const execute = () => {
                    const maxPage = Math.max(1, Number(typeof getMaxPage === 'function' ? getMaxPage() : getMaxPage) || 1);
                    const target = parseInt(input.value, 10);
                    if (!target || target < 1 || target > maxPage) {
                        Toast.show(`Enter a page number between 1 and ${maxPage}`, 'warning');
                        return;
                    }
                    input.value = '';
                    onJump(target);
                };
                btn.addEventListener('click', execute);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        execute();
                    }
                });
            }
        };
        this.pageJump = helper;
        window.fawryPageJump = helper;
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

        this.pageJump.bind('tx', () => this.txTotalPages || 1, (target) => {
            this.currentPage = target;
            this.loadTransactions();
        });
    }

    applyTransactionFiltersToQuery(query) {
        const dateFrom = document.getElementById('filter-date-from')?.value;
        const dateTo = document.getElementById('filter-date-to')?.value;
        const search = document.getElementById('search-input')?.value?.trim();

        if (dateFrom) query = query.gte('payment_date', dateFrom);
        if (dateTo) query = query.lte('payment_date', dateTo);

        // Quick Filter Pill
        const qf = this.txQuickFilter || 'all';
        if (qf === 'missing_id') {
            query = query.ilike('id_status', '%Missing ID%')
                .or('mapping.is.null,and(mapping.not.ilike.Dip,mapping.not.ilike.Dip *,mapping.not.ilike.Diploma*,mapping.not.ilike.*Workshop*)')
                .or('second_mapping.is.null,and(second_mapping.not.ilike.Dip,second_mapping.not.ilike.Dip *,second_mapping.not.ilike.Diploma*,second_mapping.not.ilike.*Workshop*)');
        } else if (qf === 'error_id') {
            query = query.ilike('id_status', '%Error%')
                .or('mapping.is.null,and(mapping.not.ilike.Dip,mapping.not.ilike.Dip *,mapping.not.ilike.Diploma*,mapping.not.ilike.*Workshop*)')
                .or('second_mapping.is.null,and(second_mapping.not.ilike.Dip,second_mapping.not.ilike.Dip *,second_mapping.not.ilike.Diploma*,second_mapping.not.ilike.*Workshop*)');
        } else if (qf === 'unmapped') {
            query = query.or('mapping.is.null,mapping.eq.');
        } else if (qf === 'unsettled') {
            query = query.or('is_settled.is.null,is_settled.eq.false');
        }

        // Column Header Popover Filters
        for (const [col, values] of Object.entries(this.headerFilters.transactions || {})) {
            if (values && values.length > 0) {
                if (col === 'id_status') {
                    const filters = [];
                    if (values.includes('Valid')) filters.push('id_status.eq.Valid');
                    if (values.includes('Exempt')) filters.push(SUPABASE_EXEMPT_OR_FILTER);
                    if (values.includes('Missing ID')) filters.push('id_status.ilike.%Missing ID%');
                    if (values.includes('Error')) filters.push('id_status.ilike.%Error%');
                    if (filters.length > 0) query = query.or(filters.join(','));
                } else if (col === 'is_settled') {
                    const filters = [];
                    if (values.includes('Yes')) filters.push('is_settled.eq.true');
                    if (values.includes('No')) filters.push('is_settled.is.null', 'is_settled.eq.false');
                    if (filters.length > 0) query = query.or(filters.join(','));
                } else if ((col === 'mapping' || col === 'second_mapping') && values.includes('(Empty / Unmapped)')) {
                    const nonEmpty = values.filter(v => v !== '(Empty / Unmapped)');
                    const clauses = [`${col}.is.null`, `${col}.eq.`];
                    nonEmpty.forEach(v => {
                        const safeVal = sanitizeForFilter(v);
                        if (safeVal) clauses.push(`${col}.eq.${safeVal}`);
                    });
                    query = query.or(clauses.join(','));
                } else {
                    query = query.in(col, values);
                }
            }
        }

        // Unified Search (supports multi-value Excel paste of Ref Numbers / Student IDs, or single partial search)
        if (search) {
            const rawTokens = search.split(/[\r\n\t,;]+/).map(t => sanitizeForFilter(t)).filter(Boolean);
            const isMultiIdList = rawTokens.length >= 2 && rawTokens.every(t => /^[A-Za-z0-9_-]{3,40}$/.test(t));
            if (isMultiIdList) {
                const uniqueTokens = [...new Set(rawTokens)].slice(0, 150);
                const inList = uniqueTokens.join(',');
                query = query.or(`reference_number.in.(${inList}),student_id.in.(${inList})`);
            } else {
                const safeSearch = sanitizeForFilter(search);
                if (safeSearch) {
                    query = query.or(
                        `student_id.ilike.%${safeSearch}%,reference_number.ilike.%${safeSearch}%,customer_mobile.ilike.%${safeSearch}%,item_name.ilike.%${safeSearch}%,mapping.ilike.%${safeSearch}%,second_mapping.ilike.%${safeSearch}%`
                    );
                }
            }
        }
        return query;
    }

    initExport() {
        document.getElementById('btn-export').addEventListener('click', async () => {
            const btn = document.getElementById('btn-export');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Exporting...';
            btn.disabled = true;

            try {
                const exportCols = 'id, reference_number, payment_date, student_id, student_level, customer_mobile, total_amount, net_amount, fawry_fees, payment_status, item_name, item_price, mapping, second_mapping, is_settled, settlement_batch, merchant_name, bank, check_column, id_status';
                const allData = await fetchAll(
                    'transactions',
                    exportCols,
                    q => this.applyTransactionFiltersToQuery(q),
                    'id',
                    {
                        onProgress: (loaded) => {
                            btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Exporting (${loaded.toLocaleString()})...`;
                        }
                    }
                );

                if (allData.length === 0) {
                    Toast.show('No data to export.', 'warning');
                    return;
                }

                // Preserve chronological export ordering after O(N) id-keyset fetch
                allData.sort((a, b) => {
                    const da = String(a.payment_date || '');
                    const db = String(b.payment_date || '');
                    if (da !== db) return da < db ? -1 : 1;
                    return (Number(a.id) || 0) - (Number(b.id) || 0);
                });

                // student_level is persisted directly on transactions via DB triggers;
                // only resolve legacy/unpersisted rows lacking the column.
                this.syncStudentMasterMapFromCache();
                const legacyRows = [];
                for (let i = 0; i < allData.length; i++) {
                    const t = allData[i];
                    if (t && Object.prototype.hasOwnProperty.call(t, 'student_level')) continue;
                    const raw = t?.student_id ? String(t.student_id).trim() : '';
                    if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID' || /^dip\d+/i.test(raw)) continue;
                    if (!this.lookupStudentBySid(raw)) legacyRows.push(t);
                }
                if (legacyRows.length > 0) {
                    btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Resolving student levels...`;
                    await this.ensureStudentLevelsForRows(legacyRows);
                }

                btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Building Excel (${allData.length.toLocaleString()})...`;
                await new Promise(r => setTimeout(r, 0));

                // Format and sanitize in a single pass to avoid duplicating 20k+ row objects
                const len = allData.length;
                const formattedData = new Array(len);
                for (let i = 0; i < len; i++) {
                    const t = allData[i];
                    const pDateStr = toDateOnly(t.payment_date);
                    const levelTag = formatStudentLevelTag(this.getTransactionStudentLevel(t));

                    formattedData[i] = {
                        "Reference Number": sanitizeExcelValue(t.reference_number),
                        "Payment Date": pDateStr,
                        "Student ID": sanitizeExcelValue(t.student_id),
                        "Level": levelTag,
                        "Customer Mobile Number": sanitizeExcelValue(t.customer_mobile),
                        "Total Amount Plus Fees": t.total_amount,
                        "Net Amount": t.net_amount,
                        "Fawry Fees": t.fawry_fees,
                        "Payment Status": sanitizeExcelValue(t.payment_status),
                        "Item Name": sanitizeExcelValue(t.item_name),
                        "Item Price": t.item_price,
                        "Mapping": sanitizeExcelValue(t.mapping),
                        "2nd Mapping": sanitizeExcelValue(t.second_mapping),
                        "Is Settled": t.is_settled ? 'Yes' : 'No',
                        "Settlement Batch": sanitizeExcelValue(t.settlement_batch || ''),
                        "Merchant Name": sanitizeExcelValue(t.merchant_name),
                        "Bank": sanitizeExcelValue(t.bank),
                        "Check Column": sanitizeExcelValue(t.check_column),
                        "ID Status": sanitizeExcelValue(t.id_status)
                    };
                }

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                // Write integer Excel date serials (z: 'yyyy-mm-dd') so Excel shows a true Date with zero time component
                for (let idx = 0; idx < len; idx++) {
                    const serial = dateToExcelSerial(allData[idx].payment_date);
                    if (serial !== null) {
                        worksheet[`B${idx + 2}`] = { t: 'n', v: serial, z: 'yyyy-mm-dd' };
                    }
                }
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Fawry Query");
                
                // Trigger download
                await writeCompressedExcel(workbook, `Fawry_Query_Export_${toDateOnly(new Date())}.xlsx`);

            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons({ root: btn });
            }
        });

        document.getElementById('btn-export-mappings').addEventListener('click', async () => {
            try {
                const allData = (this.allMappingsData && this.allMappingsData.length > 0)
                    ? this.allMappingsData
                    : await fetchAll('item_mappings', '*', null, 'item_name');

                if (allData.length === 0) return Toast.show('No mappings to export.', 'warning');

                const formattedData = allData.map(m => ({
                    "Item Name": m.item_name,
                    "Adjusted Item Name": m.adjusted_item_name || "",
                    "Mapping": m.mapping || "",
                    "2nd Mapping": m.second_mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(sanitizeExcelRows(formattedData));
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Item Mappings");
                writeCompressedExcel(workbook, `Item_Mappings_Export_${toDateOnly(new Date())}.xlsx`);
            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            }
        });

        document.getElementById('btn-export-fixes').addEventListener('click', async () => {
            try {
                const allData = (this.allFixesData && this.allFixesData.length > 0)
                    ? this.allFixesData
                    : await fetchAll('manual_fixes', '*', null, 'reference_number');

                if (allData.length === 0) return Toast.show('No fixes to export.', 'warning');

                const formattedData = allData.map(f => ({
                    "Reference Number": f.reference_number,
                    "Correct ID": f.correct_id || "",
                    "Item Name": f.item_name || "",
                    "Mapping": f.mapping || "",
                    "2nd Mapping": f.second_mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(sanitizeExcelRows(formattedData));
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Manual Fixes");
                writeCompressedExcel(workbook, `Manual_Fixes_Export_${toDateOnly(new Date())}.xlsx`);
            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
            }
        });
    }

    getTransactionsFilterKey() {
        const dateFrom = document.getElementById('filter-date-from')?.value || '';
        const dateTo = document.getElementById('filter-date-to')?.value || '';
        const search = document.getElementById('search-input')?.value?.trim() || '';
        return JSON.stringify([dateFrom, dateTo, search, this.txQuickFilter || 'all', this.headerFilters?.transactions || {}]);
    }

    async loadTransactions() {
        this.renderFilterChips('transactions');
        const requestId = (this.txRequestId = (this.txRequestId || 0) + 1);
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = Array(5).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(11) + '</tr>').join('');

        const filterKey = this.getTransactionsFilterKey();
        const reuseCount = this.currentPage > 1 && this._txCountCache?.key === filterKey && typeof this._txCountCache.count === 'number';
        const txCols = 'id, reference_number, payment_date, student_id, original_student_id, student_level, customer_mobile, total_amount, net_amount, fawry_fees, payment_status, item_name, item_price, mapping, second_mapping, merchant_name, bank, check_column, file_name, id_status, is_settled, settlement_batch, erp_batch_number, erp_voucher';

        let query = this.applyTransactionFiltersToQuery(
            supabase.from('transactions').select(txCols, reuseCount ? {} : { count: 'exact' })
        );

        const fromRange = (this.currentPage - 1) * this.pageSize;
        const toRange = fromRange + this.pageSize - 1;
        const sortCol = this.txSortCol || 'payment_date';
        const sortAsc = Boolean(this.txSortAsc);

        const { data, count: fetchedCount, error } = await query
            .order(sortCol, { ascending: sortAsc })
            .order('id', { ascending: sortAsc })
            .range(fromRange, toRange);

        if (!error && Array.isArray(data) && data.length > 0) {
            const legacyRows = data.filter(r => r && !Object.prototype.hasOwnProperty.call(r, 'student_level'));
            if (legacyRows.length > 0) {
                await this.ensureStudentLevelsForRows(legacyRows);
            }
        }

        // A newer request was started while this one was running – ignore this (stale) result
        if (requestId !== this.txRequestId) return;

        const totalCount = reuseCount ? this._txCountCache.count : fetchedCount;
        if (!error && typeof totalCount === 'number') {
            this._txCountCache = { key: filterKey, count: totalCount };
        }
        if (!error) this.markTabLoaded('transactions');

        const totalPages = totalCount ? Math.ceil(totalCount / this.pageSize) : 1;
        this.txTotalPages = totalPages;

        // Update pagination UI
        document.getElementById('page-info').innerText = totalCount 
            ? `Page ${this.currentPage} of ${totalPages} (${totalCount.toLocaleString()} records)` 
            : `Page ${this.currentPage}`;
        document.getElementById('btn-prev').disabled = this.currentPage === 1;
        document.getElementById('btn-next').disabled = this.currentPage >= totalPages;
        const jumpInput = document.getElementById('tx-jump-page');
        if (jumpInput) jumpInput.max = String(totalPages);

        // Update Live Summary Bar
        const elCount = document.getElementById('tx-stat-count');
        const elPageAmt = document.getElementById('tx-stat-page-amount');
        const elHealth = document.getElementById('tx-stat-page-health');
        if (elCount) elCount.textContent = (totalCount || 0).toLocaleString();

        if (error) {
            tbody.innerHTML = `<tr><td colspan="11" style="color: var(--danger);">${escapeHTML(error.message)}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            if (elPageAmt) elPageAmt.textContent = 'EGP 0.00';
            if (elHealth) elHealth.textContent = '0 Valid';
            this.currentPageTransactions = [];
            tbody.innerHTML = '<tr><td colspan="11"><div class="empty-state"><i data-lucide="inbox" style="width:48px;height:48px;opacity:0.5;"></i><h3>No transactions found</h3><p>Try adjusting your filters or go to Import CSV to add data.</p></div></td></tr>';
            this.updateTxBulkSelectionUI();
            renderIcons(tbody);
            return;
        }

        const pageAmount = data.reduce((sum, r) => sum + (parseFloat(r.item_price || 0) || 0), 0);
        const pageValidCount = data.filter(r => getEffectiveIdStatus(r) === 'Valid').length;
        const pageExemptCount = data.filter(r => getEffectiveIdStatus(r) === 'Exempt').length;
        const pageIssueCount = data.filter(r => !isNonInvalidTransaction(r)).length;
        if (elPageAmt) elPageAmt.textContent = `EGP ${formatMoney(pageAmount)}`;
        if (elHealth) {
            const parts = [`<span style="color: var(--success);">${pageValidCount} Valid</span>`];
            if (pageExemptCount > 0) {
                parts.push(`<span style="color: var(--text-muted);">${pageExemptCount} Exempt</span>`);
            }
            if (pageIssueCount > 0) {
                parts.push(`<span style="color: var(--danger);">${pageIssueCount} Issue${pageIssueCount === 1 ? '' : 's'}</span>`);
            }
            elHealth.innerHTML = parts.join(' &bull; ');
        }

        this.currentPageTransactions = data;

        tbody.innerHTML = data.map((t, idx) => {
            const { statusClass, statusText, shortStatus } = formatIdStatusMeta(t, { defaultStatus: '' });
            const statusTooltip = statusClass === 'exempt'
                ? 'Exempt from standard tuition Student ID rules (Dip & Workshop)'
                : statusText;

            const origItem = normalizeItemName(originalItemName(t)) || normalizeItemName(t.item_name) || '';
            const canEditRules = this.hasRole('accountant');
            const mappingCell = t.mapping
                ? escapeHTML(t.mapping)
                : (origItem && canEditRules
                    ? `<button type="button" class="btn btn-outline btn-sm" data-quick-map-item="${escapeHTML(origItem)}" title="Map '${escapeHTML(origItem)}'" style="padding: 0.12rem 0.45rem; font-size: 0.72rem; color: var(--warning); border-color: rgba(245, 158, 11, 0.4);">+ Map</button>`
                    : '-');

            const stuLevelBadge = this.renderStudentLevelBadge(this.getTransactionStudentLevel(t));

            const refVal = String(t.reference_number || '').trim();
            const sidVal = String(t.student_id || '').trim();
            const rowSelected = this.selectedTransactionsMap?.has(String(t.id));
            return `
                <tr data-tx-row-idx="${idx}" style="cursor: pointer;" title="Click to inspect transaction details">
                    <td style="text-align: center;">
                        <input type="checkbox" class="tx-row-checkbox" data-tx-id="${escapeHTML(t.id)}" data-tx-row-idx="${idx}" ${rowSelected ? 'checked' : ''} aria-label="Select transaction ${escapeHTML(t.reference_number)}">
                    </td>
                    <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong>${refVal ? `<button type="button" class="inline-copy-btn" data-copy-text="${escapeHTML(refVal)}" data-copy-label="Reference" title="Copy Reference Number">${inlineIcon('copy', 12)}</button>` : ''}</td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.payment_date))}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 165px; font-size: 0.85rem; line-height: 1.3;"><strong>${escapeHTML(t.student_id)}</strong>${sidVal ? `<button type="button" class="inline-copy-btn" data-copy-text="${escapeHTML(sidVal)}" data-copy-label="Student ID" title="Copy Student ID">${inlineIcon('copy', 12)}</button>` : ''}${stuLevelBadge}</td>
                    <td style="white-space: nowrap;">EGP ${formatMoney(t.item_price)}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 200px; font-size: 0.8rem; line-height: 1.3;">${escapeHTML(t.item_name)}</td>
                    <td style="white-space: nowrap;">${mappingCell}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.second_mapping) || '-'}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.bank)}</td>
                    <td>
                        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                            <span class="badge ${statusClass}" title="${escapeHTML(statusTooltip)}">${escapeHTML(shortStatus)}</span>
                            ${canEditRules ? `<button type="button" class="tx-quick-fix-btn ${statusClass}" data-quick-fix-ref="${escapeHTML(t.reference_number)}" title="Add / Edit Manual Fix for ${escapeHTML(t.reference_number)}">
                                ${inlineIcon('wrench', 13)}
                            </button>` : ''}
                        </div>
                    </td>
                    <td>${t.is_settled ? '<span class="badge" style="background:#3b82f6;color:white;padding:0.2rem 0.4rem;font-size:0.7rem;">Yes</span>' : '<span style="color:var(--text-muted);font-size:0.8rem;">No</span>'}</td>
                </tr>
            `;
        }).join('');

        if (!tbody.dataset.delegatedBound) {
            tbody.dataset.delegatedBound = '1';
            tbody.addEventListener('click', (e) => {
                const copyBtn = e.target.closest('[data-copy-text]');
                if (copyBtn) {
                    e.stopPropagation();
                    this.copyTextWithToast(copyBtn.getAttribute('data-copy-text'), copyBtn.getAttribute('data-copy-label') || 'Value');
                    return;
                }
                const fixBtn = e.target.closest('[data-quick-fix-ref]');
                if (fixBtn) {
                    e.stopPropagation();
                    this.openQuickFixForRef(fixBtn.getAttribute('data-quick-fix-ref'));
                    return;
                }
                const mapBtn = e.target.closest('[data-quick-map-item]');
                if (mapBtn) {
                    e.stopPropagation();
                    this.openQuickMapForItem(mapBtn.getAttribute('data-quick-map-item'));
                    return;
                }
                if (e.target.closest('button, a, input')) return;
                const row = e.target.closest('tr[data-tx-row-idx]');
                if (row) {
                    const idx = parseInt(row.getAttribute('data-tx-row-idx'), 10);
                    const tx = (this.currentPageTransactions || [])[idx];
                    if (tx) this.openTransactionDetailsModal(tx);
                }
            });
            tbody.addEventListener('change', (e) => {
                const cb = e.target.closest('.tx-row-checkbox');
                if (!cb) return;
                const idx = parseInt(cb.getAttribute('data-tx-row-idx'), 10);
                const tx = (this.currentPageTransactions || [])[idx];
                if (!tx || tx.id == null) return;
                const key = String(tx.id);
                if (cb.checked) this.selectedTransactionsMap.set(key, tx);
                else this.selectedTransactionsMap.delete(key);
                this.updateTxBulkSelectionUI();
            });
        }

        this.updateTxBulkSelectionUI();
        renderIcons(tbody);
    }

    initTransactionBulkAssign() {
        const selectAllEl = document.getElementById('tx-select-all');
        const btnClear = document.getElementById('btn-tx-clear-selection');
        const btnSameMobile = document.getElementById('btn-tx-select-same-mobile');
        const idInput = document.getElementById('tx-bulk-student-id');
        const idStatusEl = document.getElementById('tx-bulk-id-status');
        const btnApply = document.getElementById('btn-tx-bulk-assign-id');

        selectAllEl?.addEventListener('change', () => {
            const pageRows = this.currentPageTransactions || [];
            pageRows.forEach(tx => {
                if (!tx || tx.id == null) return;
                const key = String(tx.id);
                if (selectAllEl.checked) this.selectedTransactionsMap.set(key, tx);
                else this.selectedTransactionsMap.delete(key);
            });
            document.querySelectorAll('#transactions-body .tx-row-checkbox').forEach(cb => {
                cb.checked = selectAllEl.checked;
            });
            this.updateTxBulkSelectionUI();
        });

        btnClear?.addEventListener('click', () => {
            this.selectedTransactionsMap.clear();
            document.querySelectorAll('#transactions-body .tx-row-checkbox').forEach(cb => {
                cb.checked = false;
            });
            this.updateTxBulkSelectionUI();
        });

        btnSameMobile?.addEventListener('click', () => {
            const selectedMobiles = new Set(
                Array.from(this.selectedTransactionsMap.values())
                    .map(t => String(t?.customer_mobile || '').replace(/\D/g, '').slice(-10))
                    .filter(Boolean)
            );
            if (selectedMobiles.size === 0) {
                Toast.show('Selected row(s) do not have a customer mobile number.', 'info');
                return;
            }
            const pageRows = this.currentPageTransactions || [];
            let added = 0;
            pageRows.forEach(tx => {
                if (!tx || tx.id == null) return;
                const mob = String(tx.customer_mobile || '').replace(/\D/g, '').slice(-10);
                if (mob && selectedMobiles.has(mob)) {
                    const key = String(tx.id);
                    if (!this.selectedTransactionsMap.has(key)) {
                        this.selectedTransactionsMap.set(key, tx);
                        added++;
                    }
                }
            });
            document.querySelectorAll('#transactions-body .tx-row-checkbox').forEach(cb => {
                const txId = cb.getAttribute('data-tx-id');
                cb.checked = Boolean(txId && this.selectedTransactionsMap.has(txId));
            });
            this.updateTxBulkSelectionUI();
            Toast.show(
                added > 0
                    ? `Added ${added} matching row(s) sharing the same mobile number.`
                    : 'All visible rows sharing that mobile number are already selected.',
                'info'
            );
        });

        idInput?.addEventListener('input', () => {
            const val = String(idInput.value || '').trim();
            if (!idStatusEl) return;
            if (!val) {
                idStatusEl.textContent = '';
                idStatusEl.style.color = 'var(--text-muted)';
                return;
            }
            const status = validateID(val);
            const student = this.studentMasterByIdMap?.get(val.toLowerCase()) || null;
            idStatusEl.textContent = student?.full_name ? `${status} — ${student.full_name}` : status;
            idStatusEl.style.color = status === 'Valid' ? 'var(--success)' : 'var(--warning, #f59e0b)';
        });

        btnApply?.addEventListener('click', () => this.applyBulkStudentIdToSelected());
    }

    updateTxBulkSelectionUI() {
        const bar = document.getElementById('tx-bulk-assign-bar');
        const countEl = document.getElementById('tx-bulk-selected-count');
        const selectAllEl = document.getElementById('tx-select-all');
        const idInput = document.getElementById('tx-bulk-student-id');
        const btnApply = document.getElementById('btn-tx-bulk-assign-id');

        const selectedCount = this.selectedTransactionsMap?.size || 0;
        if (countEl) countEl.textContent = String(selectedCount);
        if (bar) bar.classList.toggle('hidden', selectedCount === 0);

        const canEdit = this.hasRole('accountant');
        if (idInput) idInput.style.display = canEdit ? '' : 'none';
        if (btnApply) btnApply.style.display = canEdit ? '' : 'none';

        if (selectAllEl) {
            const pageRows = (this.currentPageTransactions || []).filter(t => t && t.id != null);
            const checkedOnPage = pageRows.filter(t => this.selectedTransactionsMap?.has(String(t.id))).length;
            selectAllEl.checked = pageRows.length > 0 && checkedOnPage === pageRows.length;
            selectAllEl.indeterminate = checkedOnPage > 0 && checkedOnPage < pageRows.length;
        }
    }

    async applyBulkStudentIdToSelected() {
        if (!this.requireRole('accountant', 'bulk-assign Student IDs')) return;
        const idInput = document.getElementById('tx-bulk-student-id');
        const btnApply = document.getElementById('btn-tx-bulk-assign-id');
        const newId = String(idInput?.value || '').trim();
        if (!newId) {
            Toast.show('Enter a Student ID to assign.', 'warning');
            idInput?.focus();
            return;
        }

        const selectedRows = Array.from(this.selectedTransactionsMap?.values() || []);
        if (selectedRows.length === 0) {
            Toast.show('Select at least one transaction row first.', 'info');
            return;
        }

        const closedRows = [];
        const openRows = [];
        for (const tx of selectedRows) {
            if (isDateInClosedPeriods(tx?.payment_date, this.closedPeriodSet)) {
                closedRows.push(tx);
            } else {
                openRows.push(tx);
            }
        }
        if (openRows.length === 0) {
            const months = [...new Set(closedRows.map(r => toPeriodMonth(r.payment_date)).filter(Boolean))].sort();
            Toast.show(`Blocked: all selected row(s) belong to closed accounting period(s): ${months.join(', ')}.`, 'error');
            return;
        }

        const idStatus = validateID(newId);
        const uniqueRefs = [...new Set(openRows.map(t => String(t.reference_number || '').trim()).filter(Boolean))];
        const lockedCount = openRows.filter(t => isLockedTransaction(t)).length;

        let msg = `Assign Student ID "${newId}" (${idStatus}) to ${openRows.length} row(s) across ${uniqueRefs.length} reference number(s)?`;
        if (idStatus !== 'Valid') {
            msg += ` Warning: ID validation returned "${idStatus}".`;
        }
        if (closedRows.length > 0) {
            msg += ` ${closedRows.length} selected row(s) in closed accounting period(s) will be skipped.`;
        }
        if (lockedCount > 0) {
            msg += ` ${lockedCount} row(s) are settled or already posted to ERP (ERP batch will remain unchanged).`;
        }

        const ok = await window.customConfirm(msg, 'Apply Student ID', 'Cancel');
        if (!ok) return;

        const origHtml = btnApply ? btnApply.innerHTML : '';
        if (btnApply) {
            btnApply.disabled = true;
            btnApply.innerHTML = '<i data-lucide="loader" class="spin"></i> Applying...';
            renderIcons(btnApply);
        }

        try {
            const existingFixes = await fetchByIn('manual_fixes', '*', 'reference_number', uniqueRefs, 'reference_number');
            const prevMap = new Map(existingFixes.map(f => [String(f.reference_number || '').trim(), f]));

            const fixesToUpsert = uniqueRefs.map(ref => {
                const prev = prevMap.get(ref);
                return {
                    reference_number: ref,
                    correct_id: newId,
                    item_name: prev?.item_name || null,
                    mapping: prev?.mapping || null,
                    second_mapping: prev?.second_mapping || null
                };
            });

            for (let i = 0; i < fixesToUpsert.length; i += 500) {
                const chunk = fixesToUpsert.slice(i, i + 500);
                const { error } = await supabase.from('manual_fixes').upsert(chunk, {
                    onConflict: 'reference_number',
                    ignoreDuplicates: false
                });
                if (error) throw error;
            }

            if (Array.isArray(this.allFixesData)) {
                const updatedSet = new Set(uniqueRefs.map(r => r.toLowerCase()));
                this.allFixesData = this.allFixesData.filter(f => !updatedSet.has(String(f.reference_number || '').trim().toLowerCase()));
                this.allFixesData.push(...fixesToUpsert);
                this.allFixesData.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));
                this.updateFixesStatsAndDropdowns?.(this.allFixesData);
            }

            const fixesMap = new Map(fixesToUpsert.map(f => [f.reference_number, f]));
            const changes = await recomputeTransactions(openRows, {
                includeLocked: true,
                fixes: fixesMap,
                mappings: this.allMappingsData || undefined
            });
            const updatedCount = changes.length > 0 ? await updateRuleFields(changes) : 0;

            await this.logAudit(
                'Bulk Student ID Assigned',
                uniqueRefs.slice(0, 10).join(', ') + (uniqueRefs.length > 10 ? ` (+${uniqueRefs.length - 10} more)` : ''),
                {
                    assigned_student_id: newId,
                    id_status: idStatus,
                    reference_count: uniqueRefs.length,
                    rows_selected: openRows.length,
                    transactions_updated: updatedCount,
                    closed_period_skipped: closedRows.length,
                    revert_data: existingFixes.length > 0
                        ? { table_name: 'manual_fixes', operation: 'update', previous_rows: existingFixes }
                        : { table_name: 'manual_fixes', operation: 'insert', inserted_keys: uniqueRefs }
                }
            );

            this.selectedTransactionsMap.clear();
            if (idInput) idInput.value = '';
            const idStatusEl = document.getElementById('tx-bulk-id-status');
            if (idStatusEl) idStatusEl.textContent = '';

            this.markLocalTxMutation();
            this.updateTxBulkSelectionUI();
            this.invalidateDistinctCache();
            this.invalidateTabs('dashboard', 'transactions', 'fixes', 'erp-export');
            await this.loadTransactions();
            this.updateSidebarBadges({ force: true });

            Toast.show(`Assigned Student ID ${newId} to ${updatedCount || openRows.length} transaction(s).`, 'success');
        } catch (err) {
            Toast.show('Bulk assign failed: ' + err.message, 'error');
        } finally {
            if (btnApply) {
                btnApply.innerHTML = origHtml;
                btnApply.disabled = false;
                renderIcons(btnApply);
            }
        }
    }

    async openQuickMapForItem(rawItemName) {
        const cleanName = normalizeItemName(rawItemName);
        if (!cleanName) return;
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
            this.updateMappingsStatsAndDropdowns(this.allMappingsData);
        } catch (_e) {
            // ignore
        }
        const conflict = this.findConflictingMapping(cleanName, null);
        if (conflict) {
            this.openMappingModalForEdit(conflict.rule);
            Toast.show(`Loaded existing mapping for "${conflict.rule.item_name}"`, 'info');
        } else {
            this.resetMappingModal('Add Mapping');
            document.getElementById('map-original').value = cleanName;
            document.getElementById('modal-mapping').classList.remove('hidden');
            document.getElementById('map-original').dispatchEvent(new Event('input'));
            setTimeout(() => document.getElementById('map-category')?.focus(), 50);
        }
    }

    async openTransactionDetailsModal(txOrRef) {
        if (txOrRef && typeof txOrRef === 'object' && isSameDaySettlementBank(txOrRef)) {
            return this.openForeignTransactionDetailsModal(txOrRef);
        }
        const modal = document.getElementById('modal-tx-details');
        const body = document.getElementById('modal-tx-details-body');
        if (!modal || !body || !txOrRef) return;

        let tx = txOrRef;
        let siblingItems = [];
        if (typeof txOrRef === 'string' || typeof txOrRef === 'number') {
            const refStr = String(txOrRef).trim();
            body.innerHTML = `<div class="text-center" style="padding: 2rem; color: var(--text-muted);"><i data-lucide="loader" class="spin"></i> Loading transaction ${escapeHTML(refStr)}...</div>`;
            modal.classList.remove('hidden');
            if (window.lucide) lucide.createIcons({ root: body });
            try {
                const { data: rows, error } = await supabase
                    .from('transactions')
                    .select('*')
                    .eq('reference_number', refStr)
                    .order('id', { ascending: true });
                if (error) throw error;
                if (!rows || rows.length === 0) {
                    // Fallback to Foreign Transactions (NuMisrUsd5) when ref isn't in Fawry transactions
                    const localFx = (this.foreignTransactions || []).find(r => String(r.reference_number || '').trim() === refStr);
                    if (localFx) {
                        return this.openForeignTransactionDetailsModal(this.normalizeForeignTransactionRow(localFx));
                    }
                    try {
                        const { data: fxRows } = await supabase
                            .from('foreign_transactions')
                            .select('*')
                            .eq('reference_number', refStr)
                            .limit(1);
                        if (fxRows && fxRows.length > 0) {
                            return this.openForeignTransactionDetailsModal(this.normalizeForeignTransactionRow(fxRows[0]));
                        }
                    } catch (_e) {
                        // ignore if foreign_transactions table not created
                    }
                    body.innerHTML = `<div class="text-center" style="padding: 2rem; color: var(--danger);">No transaction found with reference number <strong>${escapeHTML(refStr)}</strong>.</div>`;
                    return;
                }
                tx = rows[0];
                if (rows.length > 1) siblingItems = rows;
            } catch (err) {
                body.innerHTML = `<div class="text-center" style="padding: 2rem; color: var(--danger);">Error loading transaction: ${escapeHTML(err.message)}</div>`;
                return;
            }
        }

        const origItem = normalizeItemName(originalItemName(tx)) || normalizeItemName(tx.item_name) || '-';
        const { statusClass, statusText } = formatIdStatusMeta(tx, { defaultStatus: 'Unknown' });
        const multiItemSummaryHtml = siblingItems.length > 1
            ? `<div style="grid-column: 1 / -1; margin-top: 0.35rem; padding: 0.45rem 0.65rem; border-radius: 6px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); font-size: 0.8rem;">
                <strong>Order Contains ${siblingItems.length} Items:</strong>
                ${siblingItems.map(r => `${escapeHTML(r.item_name || '-')} (EGP ${formatMoney(r.item_price)})`).join(' &bull; ')}
               </div>`
            : '';

        body.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.75rem 1rem; border-radius: 8px; background: var(--bg-subtle); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="color: var(--text-muted); font-size: 0.82rem;">Reference:</span>
                    <strong style="font-size: 1.05rem;">${escapeHTML(tx.reference_number || '-')}</strong>
                    <button type="button" class="btn btn-outline btn-sm" id="btn-tx-detail-copy-ref" style="padding: 0.12rem 0.45rem; font-size: 0.72rem;">Copy</button>
                </div>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span class="badge ${statusClass}">${escapeHTML(statusText)}</span>
                    ${tx.is_settled ? '<span class="badge" style="background:#3b82f6;color:white;">Settled</span>' : '<span class="badge" style="background:rgba(148,163,184,0.2);color:var(--text-muted);">Unsettled</span>'}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem;">
                <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Student &amp; Customer</h4>
                    <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.3rem;">
                        <div>Student ID: <strong>${escapeHTML(tx.student_id || 'Empty')}</strong>${this.renderStudentLevelBadge(this.getTransactionStudentLevel(tx))}</div>
                        <div id="tx-detail-student-lookup" style="color: var(--text-muted); font-size: 0.8rem;">Looking up Student Master...</div>
                        <div>Customer Mobile: <strong>${escapeHTML(tx.customer_mobile || '-')}</strong></div>
                        <div>Payment Date: <strong>${escapeHTML(toDateOnly(tx.payment_date) || '-')}</strong></div>
                    </div>
                </div>

                <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Financial Breakdown</h4>
                    <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.3rem;">
                        <div>Item Price: <strong style="color: var(--primary);">EGP ${formatMoney(tx.item_price)}</strong></div>
                        <div>Fawry Fees: <strong>EGP ${formatMoney(tx.fawry_fees)}</strong></div>
                        <div>Net Amount: <strong>EGP ${formatMoney(tx.net_amount)}</strong></div>
                        <div>Total Plus Fees: <strong>EGP ${formatMoney(tx.total_amount)}</strong></div>
                    </div>
                </div>
            </div>

            <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Item, Mapping &amp; Settlement</h4>
                <div style="font-size: 0.85rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 1rem;">
                    <div style="grid-column: 1 / -1;">Current Item Name: <strong>${escapeHTML(tx.item_name || '-')}</strong></div>
                    <div style="grid-column: 1 / -1; color: var(--text-muted); font-size: 0.8rem;">Original Fawry Item: <strong>${escapeHTML(origItem)}</strong></div>
                    <div>Mapping: <strong>${escapeHTML(tx.mapping || '-')}</strong></div>
                    <div>2nd Mapping: <strong>${escapeHTML(tx.second_mapping || '-')}</strong></div>
                    <div>Bank: <strong>${escapeHTML(tx.bank || '-')}</strong></div>
                    <div>Merchant: <strong>${escapeHTML(tx.merchant_name || '-')}</strong></div>
                    <div>Settlement Batch: <strong>${escapeHTML(tx.settlement_batch || '-')}</strong></div>
                    <div>ERP Batch: <strong>${escapeHTML(tx.erp_batch_number || '-')}</strong></div>
                    ${multiItemSummaryHtml}
                </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 0.65rem; flex-wrap: wrap;">
                ${this.hasRole('accountant') ? `
                <button type="button" class="btn btn-outline" id="btn-tx-detail-map">
                    <i data-lucide="layers" style="width: 14px; height: 14px;"></i> Map Item
                </button>
                <button type="button" class="btn btn-primary" id="btn-tx-detail-fix">
                    <i data-lucide="wrench" style="width: 14px; height: 14px;"></i> Manual Fix
                </button>` : ''}
                <button type="button" class="btn btn-outline" id="btn-tx-detail-close">Close</button>
            </div>
        `;

        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons({ root: body });

        document.getElementById('btn-tx-detail-close')?.addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        document.getElementById('btn-tx-detail-copy-ref')?.addEventListener('click', () => {
            if (navigator.clipboard && tx.reference_number) {
                navigator.clipboard.writeText(String(tx.reference_number));
                Toast.show(`Copied Reference "${tx.reference_number}"`, 'success');
            }
        });

        document.getElementById('btn-tx-detail-fix')?.addEventListener('click', () => {
            modal.classList.add('hidden');
            this.openQuickFixForRef(tx.reference_number);
        });

        document.getElementById('btn-tx-detail-map')?.addEventListener('click', () => {
            modal.classList.add('hidden');
            this.openQuickMapForItem(origItem);
        });

        // Live Student Master lookup
        const lookupEl = document.getElementById('tx-detail-student-lookup');
        if (lookupEl) {
            if (!tx.student_id || tx.student_id === 'Empty') {
                lookupEl.textContent = 'No Student ID on transaction';
            } else {
                const cachedSt = this.lookupStudentBySid(tx.student_id);
                if (cachedSt) {
                    const colProg = [cachedSt.college, cachedSt.program].filter(Boolean).join(' • ');
                    const lvlBadge = this.renderStudentLevelBadge(getStudentProgramLevel(cachedSt));
                    lookupEl.innerHTML = `<span style="color: var(--success);">Student: <strong>${escapeHTML(cachedSt.full_name || cachedSt.arabic_name || 'N/A')}</strong>${lvlBadge}${colProg ? ` (${escapeHTML(colProg)})` : ''}</span>`;
                } else {
                    try {
                        const { data: st } = await supabase
                            .from('student_master')
                            .select('full_name, college, program')
                            .eq('student_id', String(tx.student_id).trim())
                            .maybeSingle();
                        if (st) {
                            const colProg = [st.college, st.program].filter(Boolean).join(' • ');
                            const lvlBadge = this.renderStudentLevelBadge(getStudentProgramLevel(st));
                            lookupEl.innerHTML = `<span style="color: var(--success);">Student: <strong>${escapeHTML(st.full_name || 'N/A')}</strong>${lvlBadge}${colProg ? ` (${escapeHTML(colProg)})` : ''}</span>`;
                        } else {
                            lookupEl.textContent = 'Student ID not found in Student Master';
                        }
                    } catch (_e) {
                        lookupEl.textContent = '';
                    }
                }
            }
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
                if (window.duplicateCleanupMode === 'foreign') {
                    await this.cleanupForeignDuplicates();
                    return;
                }
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
                if (!this.requireRole('admin', 'revert import batches')) return;
                
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
        renderIcons(tbody);
        
        try {
            const { data, error } = await supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(50);
            if (error) throw error;
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No import history found.</td></tr>';
                this.markTabLoaded('history');
                return;
            }
            
            tbody.innerHTML = data.map(b => {
                const date = new Date(b.created_at).toLocaleString();
                const type = b.details && b.details.type ? b.details.type : 'transactions';
                const canRevert = this.hasRole('admin') && type === 'transactions' && b.status !== 'reverted' && b.status !== 'failed' && b.status !== 'processing';
                
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
            
            this.markTabLoaded('history');
            renderIcons(tbody);
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
            const allData = await fetchAll(
                'transactions',
                'id, reference_number, item_price, item_name, check_column, erp_batch_number, is_settled',
                null,
                'id'
            );
            
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
            
            for (const txs of Object.values(grouped)) {
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
            
            window.duplicateCleanupMode = 'fawry';
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

    renderFilterChips(table) {
        const containerId = table === 'transactions' ? 'transactions-filter-chips' : 'automatch-filter-chips';
        const container = document.getElementById(containerId);
        if (!container) return;

        const filters = this.headerFilters[table] || {};
        const entries = Object.entries(filters).filter(([_col, vals]) => Array.isArray(vals) && vals.length > 0);

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
                } else if (this.automatchProposals && this.automatchProposals.length > 0) {
                    this.automatchPage = 1;
                    this.renderAutoMatcherPage();
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
            } else if (this.automatchProposals && this.automatchProposals.length > 0) {
                this.automatchPage = 1;
                this.renderAutoMatcherPage();
            } else {
                this.runAutoMatcher();
            }
        });
    }

    updateSidebarBadges({ force = false } = {}) {
        clearTimeout(this._badgeUpdateTimer);
        if (typeof document !== 'undefined' && document.hidden && !force) {
            return;
        }
        const badge = document.getElementById('sidebar-automatch-badge');
        const applyBadgeCount = (count) => {
            if (!badge || typeof count !== 'number' || !Number.isFinite(count)) return;
            if (count > 0) {
                badge.textContent = count > 999 ? '999+' : count;
                badge.style.display = 'inline-flex';
            } else {
                badge.style.display = 'none';
            }
        };

        if (!force && this._badgeCache && (Date.now() - this._badgeCache.ts < 60000)) {
            applyBadgeCount(this._badgeCache.count);
            return;
        }

        const delayMs = force ? 0 : 250;
        this._badgeUpdateTimer = setTimeout(async () => {
            const targetBadge = document.getElementById('sidebar-automatch-badge');
            if (!targetBadge) return;
            try {
                let count = null;
                if (typeof supabase.rpc === 'function') {
                    const { data: rpcCount, error: rpcErr } = await supabase.rpc('get_unresolved_tx_count');
                    if (!rpcErr && typeof rpcCount === 'number' && Number.isFinite(rpcCount)) {
                        count = Math.max(0, rpcCount);
                    }
                }

                if (count === null) {
                    const [totalRes, exemptRes] = await Promise.all([
                        supabase
                            .from('transactions')
                            .select('*', { count: 'exact', head: true })
                            .neq('id_status', 'Valid'),
                        supabase
                            .from('transactions')
                            .select('*', { count: 'exact', head: true })
                            .neq('id_status', 'Valid')
                            .or(SUPABASE_EXEMPT_OR_FILTER)
                    ]);
                    if (!totalRes.error && totalRes.count !== null && totalRes.count !== undefined) {
                        const exemptCnt = (!exemptRes.error && exemptRes.count) ? exemptRes.count : 0;
                        count = Math.max(0, totalRes.count - exemptCnt);
                    }
                }

                if (count !== null) {
                    this._badgeCache = { count, ts: Date.now() };
                    applyBadgeCount(count);
                }
            } catch (err) {
                console.warn('Could not update sidebar badge:', err);
            }
        }, delayMs);
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
        document.getElementById('btn-close-global-search')?.addEventListener('click', closeSearch);

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

        let activeResultIdx = -1;
        const updateActiveResult = (nextIdx) => {
            const items = Array.from(resultsContainer.querySelectorAll('.search-result-item'));
            if (items.length === 0) {
                activeResultIdx = -1;
                return;
            }
            activeResultIdx = ((nextIdx % items.length) + items.length) % items.length;
            items.forEach((el, i) => {
                el.classList.toggle('kbd-active', i === activeResultIdx);
                if (i === activeResultIdx && typeof el.scrollIntoView === 'function') {
                    el.scrollIntoView({ block: 'nearest' });
                }
            });
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                updateActiveResult(activeResultIdx + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                updateActiveResult(activeResultIdx <= 0 ? resultsContainer.querySelectorAll('.search-result-item').length - 1 : activeResultIdx - 1);
            } else if (e.key === 'Enter') {
                const items = Array.from(resultsContainer.querySelectorAll('.search-result-item'));
                if (items.length > 0) {
                    e.preventDefault();
                    const target = items[activeResultIdx >= 0 ? activeResultIdx : 0];
                    if (target) target.click();
                }
            }
        });

        let searchTimeout;
        input.addEventListener('input', (e) => {
            activeResultIdx = -1;
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

                    const [txRes, foreignRes, studentRes] = await Promise.all([
                        supabase.from('transactions')
                            .select('id, reference_number, student_id, item_name, item_price, payment_date')
                            .or(`reference_number.ilike.%${cleanQ}%,student_id.ilike.%${cleanQ}%,item_name.ilike.%${cleanQ}%`)
                            .order('payment_date', { ascending: false })
                            .limit(5),
                        supabase.from('foreign_transactions')
                            .select('reference_number, student_id, description, amount, currency, value_date')
                            .or(`reference_number.ilike.%${cleanQ}%,student_id.ilike.%${cleanQ}%,description.ilike.%${cleanQ}%,matched_student_name.ilike.%${cleanQ}%`)
                            .order('value_date', { ascending: false })
                            .limit(5)
                            .then(res => res)
                            .catch(() => ({ data: [] })),
                        supabase.from('student_master')
                            .select('student_id, full_name, college, program, email, personal_email')
                            .or(`student_id.ilike.%${cleanQ}%,full_name.ilike.%${cleanQ}%`)
                            .limit(5)
                    ]);

                    const txs = txRes.data || [];
                    const cloudFx = Array.isArray(foreignRes?.data) ? foreignRes.data : [];
                    const localFxMatches = (this.foreignTransactions || []).filter(r => {
                        const ql = query.toLowerCase();
                        return String(r.reference_number || '').toLowerCase().includes(ql)
                            || String(r.student_id || '').toLowerCase().includes(ql)
                            || String(r.description || '').toLowerCase().includes(ql)
                            || String(r.matched_student_name || '').toLowerCase().includes(ql);
                    });
                    const fxMap = new Map();
                    localFxMatches.forEach(r => fxMap.set(r.reference_number, r));
                    cloudFx.forEach(r => fxMap.set(r.reference_number, r));
                    const foreignHits = [...fxMap.values()].slice(0, 5);
                    const students = studentRes.data || [];

                    if (txs.length === 0 && foreignHits.length === 0 && students.length === 0) {
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

                    if (foreignHits.length > 0) {
                        html += foreignHits.map(fx => `
                            <div class="search-result-item" data-type="foreign" data-ref="${escapeHTML(fx.reference_number)}">
                                <span class="result-type" style="color: #f59e0b;">FOREIGN</span>
                                <div class="result-text">
                                    <strong>${escapeHTML(fx.reference_number)}</strong>
                                    <span style="color: var(--text-muted); font-size: 0.8rem; margin-left: 0.5rem;">
                                        ID: ${escapeHTML(fx.student_id || '-')} &bull; ${escapeHTML(fx.description || '-')} &bull; ${escapeHTML(fx.currency || 'USD')} ${formatMoney(fx.amount)} &bull; ${escapeHTML(toDateOnly(fx.value_date))}
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
                            } else if (type === 'foreign') {
                                const ref = item.getAttribute('data-ref');
                                const fxNav = document.querySelector('.nav-link[data-tab="foreign-transactions"]');
                                if (fxNav) fxNav.click();
                                const searchInp = document.getElementById('foreign-search-input');
                                if (searchInp) searchInp.value = ref;
                                this.foreignPage = 1;
                                this.applyForeignFilters();
                            } else if (type === 'student') {
                                const sid = item.getAttribute('data-sid');
                                const searchInp = document.getElementById('student-search-input');
                                if (searchInp) searchInp.value = sid;
                                const smNav = document.querySelector('.nav-link[data-tab="student-master"]') || document.querySelector('.nav-item[data-view="student-master"]');
                                if (smNav) smNav.click();
                                this.loadStudents({ skipAutoProfile: true });
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

    // ==========================================

}

applyDashboardMixin(App);
applyAutoMatcherMixin(App);
applyErpExportMixin(App);
applyAdminAuditMixin(App);
applyForeignUiMixin(App);
applyPaymentLinksUiMixin(App);
applyStudentsUiMixin(App);
applyMappingsFixesUiMixin(App);

export { App };

// Start app when static shell is already in the document (and not yet initialized on this DOM)
document.addEventListener('DOMContentLoaded', () => {
    const layout = document.querySelector('.app-layout');
    if (layout && !layout.dataset.appInitialized) {
        layout.dataset.appInitialized = '1';
        window.app = new App();
    }
});
