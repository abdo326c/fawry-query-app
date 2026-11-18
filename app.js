import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';
import {
    validateID,
    isIdValidationExempt,
    getEffectiveIdStatus,
    isNonInvalidTransaction,
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
    sanitizeExcelValue,
    sanitizeExcelRows,
    toDateOnly,
    dateToExcelSerial,
    calculateSettlementDate,
    isSameDaySettlementBank,
    resolveErpJournalDate,
    normalizeStudentIdValue,
    getStudentProgramLevel,
    formatStudentLevelTag,
    ensureProgramHasLevelPrefix,
    normalizePhoneKey,
    buildStudentLookupIndex,
    matchTransactionToStudent,
    classifyStudentEmails,
    mergeStudentEmails,
    getStudentDisplayEmails,
    writeCompressedExcel
} from './rules.js';
import {
    parseBankStatementGrid,
    parseBanqueMisrPdfText,
    reconstructBanqueMisrPdfLinesFromPages,
    matchForeignDepositsToStudents,
    normalizePersonName,
    DEFAULT_FOREIGN_BANK,
    DEFAULT_FOREIGN_MAPPING
} from './foreign-transactions.js';
import {
    loadFxStore,
    saveFxStore,
    resolveUsdToEgpRate,
    convertUsdToEgp,
    syncMissingFxRates,
    setManualFxRate,
    getEgyptDateTimeParts,
    getMsUntilNextEgyptNoon,
    isRateStaleForEgyptNoon
} from './fx-rates.js';

import {
    runConcurrent,
    loadScriptOnce,
    renderIcons,
    inlineIcon,
    SUPABASE_EXEMPT_OR_FILTER,
    formatIdStatusMeta,
    formatMoney,
    sanitizeForFilter,
    Toast,
    withDropdownTaskProgress
} from './app-utils.js';
import { applyDashboardMixin } from './dashboard.js';
import { applyAutoMatcherMixin } from './auto-matcher.js';
import { applyErpExportMixin } from './erp-export.js';
import { applyAdminAuditMixin } from './admin-audit.js';

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
            await supabase.auth.signOut();
            Toast.show('Signed out', 'info');
        });
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
            } catch (e) {
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
                } catch (insErr) {
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
            try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
            return;
        }

        this.currentUser = user;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('user-profile-section').style.display = 'flex';
        document.getElementById('user-email-display').innerText = user.email;
        this.applyRolePermissionsToUI();
        this.fetchUniqueFilters();
        this.loadTransactions();
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
            this._mappingsDedupedOnce = true;
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
                        this.invalidateTabs('dashboard', 'transactions', 'erp-export', 'history');
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
                                this.loadErpExport({ refresh: true });
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
        if (window.flatpickr) {
            flatpickr('input[type="date"]', {
                dateFormat: "Y-m-d",
                allowInput: true
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

        const ruleCols = 'id, reference_number, student_id, original_student_id, item_name, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
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
    // Settled / ERP-recorded rows are never changed here; they are counted in lockedSkipped and
    // can be reviewed with "Re-apply Rules".
    async reapplyRulesTo(rows, opts = {}) {
        const all = await recomputeTransactions(rows, {
            includeLocked: true,
            mappings: opts.mappings ?? this.allMappingsData ?? undefined,
            fixes: opts.fixes ?? this.allFixesData ?? undefined,
            links: opts.links ?? undefined
        });
        const open = all.filter(c => !c.diff.locked);
        const updated = open.length > 0 ? await updateRuleFields(open) : 0;
        if (updated > 0) {
            this.invalidateDistinctCache();
            this.invalidateTabs('dashboard', 'transactions', 'erp-export');
        }
        return { updated, lockedSkipped: all.length - open.length, appliedChanges: open, allChanges: all };
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
            const { statusClass, statusText } = formatIdStatusMeta(t, { defaultStatus: 'Unknown' });
            const extraCount = txRows.length > 1 ? ` <span class="text-muted">(${txRows.length} items in order)</span>` : '';
            const multiItemItemsHtml = txRows.length > 1
                ? `<div style="grid-column: 1 / -1; margin-top: 0.25rem; padding: 0.4rem 0.55rem; border-radius: 6px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #f59e0b; font-size: 0.76rem;">
                    <strong>Multi-Item Order (${txRows.length} lines):</strong> ${txRows.map(r => `${escapeHTML(r.item_name || '-')} (EGP ${formatMoney(r.item_price)})`).join(' • ')}<br>
                    <span style="opacity: 0.9;">Tip: Leave Item Name &amp; Mapping blank to fix only the Student ID while preserving each item's own mapping rule.</span>
                   </div>`
                : '';

            previewEl.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.35rem;">
                    <span><strong>Transaction Found</strong>${extraCount} • ${escapeHTML(toDateOnly(t.payment_date) || 'N/A')}</span>
                    <span class="badge ${statusClass}" style="font-size: 0.72rem;">${escapeHTML(statusText)}</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem 0.75rem; color: var(--text-muted); font-size: 0.8rem;">
                    <div>Current ID: <strong style="color: var(--text-main);">${escapeHTML(t.student_id || 'Empty')}</strong></div>
                    <div>Amount: <strong style="color: var(--text-main);">EGP ${formatMoney(t.item_price)}</strong></div>
                    <div style="grid-column: 1 / -1;">Item: <strong style="color: var(--text-main);">${escapeHTML(t.item_name || '-')}</strong></div>
                    <div>Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.mapping || '-')}</strong></div>
                    <div>2nd Mapping: <strong style="color: var(--text-main);">${escapeHTML(t.second_mapping || '-')}</strong></div>
                    ${multiItemItemsHtml}
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
        // Fast path: check in-memory Student Master cache first (0ms network wait)
        const cachedStudent = this.studentMasterByIdMap?.get(val)
            || (this.allStudentsData ? this.allStudentsData.find(s => String(s.student_id).trim() === val) : null);
        if (cachedStudent) {
            const colLabel = cachedStudent.college || cachedStudent.program || '';
            const fac = colLabel ? ` • ${escapeHTML(colLabel)}` : '';
            fbEl.innerHTML = `✅ <strong>Valid ID</strong> — ${escapeHTML(cachedStudent.full_name || 'Student')}${fac}`;
            return;
        }

        fbEl.innerHTML = `✅ Valid 9-digit Student ID format. Checking Student Master...`;

        try {
            const { data: student, error } = await supabase
                .from('student_master')
                .select('student_id, full_name, college, program')
                .eq('student_id', val)
                .maybeSingle();
            if (reqId !== this.fixIdReqId) return;
            if (!error && student) {
                const colLabel = student.college || student.program || '';
                const fac = colLabel ? ` • ${escapeHTML(colLabel)}` : '';
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
                const prevRule = (this.allMappingsData || []).find(m => m.item_name === (oldEditingKey || original));

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
                    {
                        previous_item_name: oldEditingKey || undefined,
                        original,
                        adjusted,
                        category,
                        secondCategory,
                        revert_data: {
                            table_name: 'item_mappings',
                            operation: prevRule ? 'upsert' : 'delete',
                            previous_rows: prevRule ? [prevRule] : [{ item_name: original }]
                        }
                    }
                );

                // Re-apply rules to every affected transaction (fetch everything first, then update)
                const rows = await this.fetchTransactionsForItemNames(lookupKeys, [...previouslyRenamedTo, adjusted]);
                const result = await this.reapplyRulesTo(rows);

                this.mappingSuggestCache = null; // rules changed – reload suggestions next time
                Toast.show(`Mapping saved. ${this.reapplySummary(result)}`, 'success');
                document.getElementById('modal-mapping').classList.add('hidden');
                this.resetMappingModal();
                this.loadMappings();
                if (document.getElementById('view-transactions')?.classList.contains('active')) {
                    this.loadTransactions();
                }
                if (document.getElementById('view-erp-export')?.classList.contains('active')) {
                    this.loadErpExport({ refresh: true });
                }
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

                let existing = this.allFixesData ? this.findConflictingFix(ref, null) : null;
                if (!this.allFixesData) {
                    const { data: dbExisting, error: existErr } = await supabase.from('manual_fixes').select('*').eq('reference_number', ref).maybeSingle();
                    if (existErr) throw existErr;
                    existing = dbExisting;
                }
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

                const prevFix = isRenamingRef
                    ? ((this.allFixesData || []).find(f => f.reference_number === oldEditingRef) || existing)
                    : existing;

                // Update in-memory allFixesData immediately so recompute & table render need 0 extra table downloads
                if (Array.isArray(this.allFixesData)) {
                    const dropKeys = new Set([ref.toLowerCase()]);
                    if (isRenamingRef && oldEditingRef) dropKeys.add(String(oldEditingRef).trim().toLowerCase());
                    this.allFixesData = this.allFixesData.filter(f => !dropKeys.has(String(f.reference_number || '').trim().toLowerCase()));
                    this.allFixesData.push(mergedFix);
                    this.allFixesData.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));
                }

                const affectedRefs = isRenamingRef ? [oldEditingRef, ref] : [ref];
                const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';

                const [, rows] = await Promise.all([
                    this.logAudit(
                        isEditMode ? 'Manual Fix Updated' : 'Single Manual Fix Added',
                        ref,
                        {
                            ...(isRenamingRef ? { ...mergedFix, previous_reference_number: oldEditingRef } : mergedFix),
                            revert_data: {
                                table_name: 'manual_fixes',
                                operation: prevFix ? 'upsert' : 'delete',
                                previous_rows: prevFix ? [prevFix] : [{ reference_number: ref }]
                            }
                        }
                    ),
                    fetchByIn('transactions', fixRuleCols, 'reference_number', affectedRefs)
                ]);

                const all = await recomputeTransactions(rows, {
                    includeLocked: true,
                    mappings: this.allMappingsData || undefined,
                    fixes: this.allFixesData || [mergedFix]
                });
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
                const foreignUpdated = await this.applyManualFixesToForeignTransactions(this.allFixesData || [mergedFix]);
                if (updated > 0 || foreignUpdated > 0) this.invalidateDistinctCache();

                const lockedSkipped = all.length - toApply.length;
                let summaryMsg = `${updated + foreignUpdated} transaction(s) updated.`;
                if (lockedSkipped > 0) summaryMsg += ` ${lockedSkipped} settled/ERP-recorded transaction(s) left unchanged.`;

                Toast.show(`Manual fix saved. ${summaryMsg}`, 'success');
                document.getElementById('modal-fix').classList.add('hidden');
                this.resetFixModal();

                if (Array.isArray(this.allFixesData)) {
                    this.updateFixesStatsAndDropdowns(this.allFixesData);
                    this.renderFixesPage();
                    this.syncUnresolvedAfterFixChange(rows, toApply);
                } else {
                    this.loadFixes();
                }
                if (document.getElementById('view-transactions')?.classList.contains('active')) {
                    this.loadTransactions();
                }
                if (document.getElementById('view-erp-export')?.classList.contains('active')) {
                    this.loadErpExport({ refresh: true });
                }
                if (document.getElementById('view-automatcher')?.classList.contains('active')) {
                    this.runAutoMatcher();
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

                    const existingRows = Array.isArray(this.allFixesData)
                        ? this.allFixesData
                        : await fetchByIn('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', 'reference_number', fixes.map(f => f.reference_number), 'reference_number', 500);
                    const uploadedKeys = new Set(fixes.map(f => String(f.reference_number).trim().toLowerCase()));
                    const existingMap = new Map(
                        existingRows
                            .filter(r => uploadedKeys.has(String(r.reference_number || '').trim().toLowerCase()))
                            .map(r => [String(r.reference_number).trim().toLowerCase(), r])
                    );

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

                    // Upsert manual_fixes chunks in parallel (4x concurrency)
                    const upsertTasks = [];
                    for (let i = 0; i < fixesToProcess.length; i += chunkSize) {
                        const chunk = fixesToProcess.slice(i, i + chunkSize);
                        upsertTasks.push(async () => {
                            const { error } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                            if (error) throw new Error(`Only ${inserted} of ${fixesToProcess.length} fixes saved. ${error.message}`);
                            inserted += chunk.length;
                        });
                    }
                    await runConcurrent(upsertTasks, 4);

                    // Update in-memory allFixesData if cached
                    if (Array.isArray(this.allFixesData)) {
                        const byKey = new Map(this.allFixesData.map(f => [String(f.reference_number || '').trim().toLowerCase(), f]));
                        for (const f of fixesToProcess) {
                            byKey.set(String(f.reference_number || '').trim().toLowerCase(), f);
                        }
                        this.allFixesData = Array.from(byKey.values()).sort((a, b) =>
                            String(a.reference_number || '').localeCompare(String(b.reference_number || ''))
                        );
                    }

                    // Fetch only rule columns (not '*') and pass cached fixes/mappings into reapplyRulesTo
                    const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                    const rows = await fetchByIn('transactions', fixRuleCols, 'reference_number', fixesToProcess.map(f => f.reference_number));
                    const result = await this.reapplyRulesTo(rows, {
                        fixes: this.allFixesData || fixesToProcess,
                        mappings: this.allMappingsData || undefined
                    });
                    const foreignUpdated = await this.applyManualFixesToForeignTransactions(this.allFixesData || fixesToProcess);

                    await this.logAudit('Bulk Fixes Uploaded', `Batch of ${inserted} items`, { count: inserted, transactions_updated: result.updated + foreignUpdated, foreign_updated: foreignUpdated, locked_skipped: result.lockedSkipped });
                    const foreignMsg = foreignUpdated > 0 ? ` (${foreignUpdated} foreign deposit(s) updated)` : '';
                    Toast.show(`Uploaded ${inserted} manual fixes. ${this.reapplySummary(result)}${foreignMsg}`, 'success');
                    if (Array.isArray(this.allFixesData)) {
                        this.updateFixesStatsAndDropdowns(this.allFixesData);
                        this.renderFixesPage();
                        this.syncUnresolvedAfterFixChange(rows, result.appliedChanges || []);
                    } else {
                        this.loadFixes();
                    }
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
            writeCompressedExcel(workbook, "Item_Mappings_Template.xlsx");
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
            writeCompressedExcel(workbook, "Manual_Fixes_Template.xlsx");
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
        document.getElementById('btn-reapply-rules').addEventListener('click', () => {
            withDropdownTaskProgress(
                'btn-reapply-rules',
                'Computing...',
                'Computing rules & fetching transactions...',
                async (progressToast) => {
                    try {
                        if (this.hasRole('admin') && !this._mappingsDedupedOnce) {
                            await this.deduplicateItemMappings({ silent: true });
                        }
                        const ruleCols = 'id, reference_number, student_id, original_student_id, item_name, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                        const [mappings, fixes, links, txs] = await Promise.all([
                            fetchAll('item_mappings', '*', null, 'item_name'),
                            fetchAll('manual_fixes', '*', null, 'reference_number'),
                            fetchAll('links', 'payment_reference_number, custom_input_value', null, 'payment_reference_number'),
                            fetchAll('transactions', ruleCols, null, 'id')
                        ]);

                        progressToast.update(`Evaluating ${txs.length.toLocaleString()} transaction(s) against rules...`);
                        await new Promise(resolve => setTimeout(resolve, 0));

                        const fixesMap = new Map(fixes.map(f => [String(f.reference_number), f]));
                        const linksMap = new Map(links.map(l => [String(l.payment_reference_number), l]));
                        const lookupMapping = buildMappingLookup(mappings);

                        // Same pure function as import / fix save / mapping save: starts from the ORIGINAL
                        // imported ID and item name, so removed links, fixes and rules are undone too.
                        const proposals = [];
                        for (const tx of txs) {
                            const ref = String(tx.reference_number);
                            const diff = diffTransaction(tx, { link: linksMap.get(ref), fix: fixesMap.get(ref), lookupMapping });
                            if (diff.changed) proposals.push({ tx, diff });
                        }
                        window.reapplyProposals = proposals;

                        // Also apply manual fixes to Foreign Transactions when Re-apply Rules is clicked
                        this.allFixesData = fixes;
                        progressToast.update('Checking manual fixes for BM transactions...');
                        const foreignReapplied = await this.applyManualFixesToForeignTransactions(fixes);

                        if (proposals.length === 0) {
                            progressToast.dismiss();
                            Toast.show(
                                foreignReapplied > 0
                                    ? `Applied manual fixes to ${foreignReapplied} foreign transaction(s)!`
                                    : 'No rules need to be applied. Everything is up to date!',
                                foreignReapplied > 0 ? 'success' : 'info'
                            );
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

                        progressToast.dismiss();
                        modal.classList.remove('hidden');
                    } catch (err) {
                        progressToast.dismiss();
                        Toast.show('Error computing rules: ' + err.message, 'error');
                    }
                }
            );
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
                const updatedCount = await updateRuleFields(selected.map(p => ({ id: p.tx.id, fields: p.diff.fields, diff: p.diff })));
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

        // Unified Search (supports partial Reference Number, Student ID, Mobile, Item Name, Mapping, 2nd Mapping)
        if (search) {
            const safeSearch = sanitizeForFilter(search);
            if (safeSearch) {
                query = query.or(
                    `student_id.ilike.%${safeSearch}%,reference_number.ilike.%${safeSearch}%,customer_mobile.ilike.%${safeSearch}%,item_name.ilike.%${safeSearch}%,mapping.ilike.%${safeSearch}%,second_mapping.ilike.%${safeSearch}%`
                );
            }
        }
        return query;
    }

    rebuildStudentMasterMap(students = []) {
        const map = this.studentMasterByIdMap instanceof Map ? new Map() : new Map();
        for (const s of (students || [])) {
            if (!s || !s.student_id) continue;
            const rawSid = String(s.student_id).trim();
            if (!rawSid) continue;
            if (!s._level) s._level = getStudentProgramLevel(s);
            if (!s._levelTag) s._levelTag = formatStudentLevelTag(s._level);
            map.set(rawSid, s);
            map.set(rawSid.toUpperCase(), s);
            const normSid = s._normSid || (this.normalizeStudentId ? this.normalizeStudentId(rawSid) : normalizeStudentIdValue(rawSid));
            if (normSid) {
                const normStr = String(normSid);
                map.set(normStr, s);
                map.set(normStr.toUpperCase(), s);
                if (/^\d+$/.test(normStr) && normStr.length < 9) {
                    map.set(normStr.padStart(9, '0'), s);
                }
            }
        }
        this.studentMasterByIdMap = map;
        this._sidLevelCache = new Map();
        this._studentLookupIndexCache = null;
        this._lastMappedStudentsRef = students;
        this._lastMappedStudentsLen = Array.isArray(students) ? students.length : 0;
        return map;
    }

    syncStudentMasterMapFromCache() {
        const activeArr = (Array.isArray(this.allStudentsData) && this.allStudentsData.length > 0)
            ? this.allStudentsData
            : (Array.isArray(this.allStudents) && this.allStudents.length > 0 ? this.allStudents : null);
        if (activeArr && (this._lastMappedStudentsRef !== activeArr || this._lastMappedStudentsLen !== activeArr.length || !this.studentMasterByIdMap)) {
            this.rebuildStudentMasterMap(activeArr);
        }
        if (!this.studentMasterByIdMap) {
            this.studentMasterByIdMap = new Map();
        }
        return this.studentMasterByIdMap;
    }

    async ensureFullStudentMaster({ forceReload = false, onProgress = null } = {}) {
        if (!forceReload && Array.isArray(this.allStudentsData) && this.allStudentsData.length > 0) {
            this.syncStudentMasterMapFromCache();
            return this.allStudentsData;
        }
        if (typeof onProgress === 'function') {
            if (!this._studentMasterProgressListeners) this._studentMasterProgressListeners = new Set();
            this._studentMasterProgressListeners.add(onProgress);
            if (Array.isArray(this._partialStudentsPreview) && this._partialStudentsPreview.length > 0) {
                try { onProgress(this._partialStudentsLoadedCount || this._partialStudentsPreview.length, this._partialStudentsPreview); } catch (_e) {}
            }
        }
        if (!forceReload && this._fullStudentMasterPromise) {
            try {
                return await this._fullStudentMasterPromise;
            } finally {
                if (typeof onProgress === 'function') this._studentMasterProgressListeners?.delete(onProgress);
            }
        }
        this._fullStudentMasterPromise = (async () => {
            try {
                const data = await fetchAll(
                    'student_master',
                    'student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source',
                    null,
                    'student_id',
                    {
                        onProgress: (loaded, partialRows) => {
                            if (Array.isArray(partialRows) && partialRows.length > 0 && !this._partialStudentsPreview) {
                                this._partialStudentsPreview = partialRows.slice(0, 200).map(s => this.indexStudentRecord(s));
                            }
                            this._partialStudentsLoadedCount = loaded;
                            if (this._studentMasterProgressListeners) {
                                for (const fn of this._studentMasterProgressListeners) {
                                    try { fn(loaded, this._partialStudentsPreview || partialRows); } catch (_e) {}
                                }
                            }
                        }
                    }
                );
                if (Array.isArray(data) && data.length > 0) {
                    this.allStudentsData = data.map(s => this.indexStudentRecord(s));
                    this.allStudents = this.allStudentsData;
                    this.rebuildStudentMasterMap(this.allStudentsData);
                } else if (!this.allStudentsData) {
                    this.allStudentsData = [];
                }
                return this.allStudentsData || [];
            } finally {
                this._partialStudentsPreview = null;
                this._partialStudentsLoadedCount = 0;
                if (this._studentMasterProgressListeners) this._studentMasterProgressListeners.clear();
                this._fullStudentMasterPromise = null;
            }
        })();
        return this._fullStudentMasterPromise;
    }

    async ensureStudentLevelMap() {
        this.syncStudentMasterMapFromCache();
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && Array.isArray(this.allStudents) && this.allStudents.length > 0) {
            return this.studentMasterByIdMap;
        }
        if (this._fullStudentMasterPromise) {
            try { await this._fullStudentMasterPromise; } catch (_e) {}
            return this.studentMasterByIdMap;
        }
        if (this._studentLevelMapPromise) {
            return this._studentLevelMapPromise;
        }
        this._studentLevelMapPromise = (async () => {
            try {
                const rows = await fetchAll('student_master', 'student_id, full_name, arabic_name, guardian_name, college, program, mobile', null, 'student_id');
                if (Array.isArray(rows) && rows.length > 0) {
                    if (!this.allStudents || this.allStudents.length === 0) {
                        this.allStudents = rows;
                    }
                    this.rebuildStudentMasterMap(rows);
                }
            } catch (_e) {
                // Ignore when offline or unseeded
            } finally {
                this._studentLevelMapPromise = null;
            }
            return this.studentMasterByIdMap;
        })();
        return this._studentLevelMapPromise;
    }

    async ensureStudentLevelsForRows(rows = []) {
        this.syncStudentMasterMapFromCache();
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && Array.isArray(this.allStudents) && this.allStudents.length > 0) {
            return this.studentMasterByIdMap;
        }
        const candidates = new Set();
        for (const r of (rows || [])) {
            const stored = typeof r?.student_level === 'string' ? r.student_level.trim().toUpperCase() : '';
            if (stored === 'UG' || stored === 'PG') continue;
            const raw = r?.student_id ? String(r.student_id).trim() : '';
            if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID' || /^dip\d+/i.test(raw)) continue;
            if (this.studentMasterByIdMap?.has(raw)) continue;
            candidates.add(raw);
            const norm = this.normalizeStudentId ? this.normalizeStudentId(raw) : normalizeStudentIdValue(raw);
            if (norm) candidates.add(norm);
        }
        if (candidates.size > 0) {
            try {
                const candidateList = [...candidates];
                const data = candidateList.length <= 200
                    ? ((await supabase
                        .from('student_master')
                        .select('student_id, full_name, college, program')
                        .in('student_id', candidateList)).data || [])
                    : await fetchByIn('student_master', 'student_id, full_name, college, program', 'student_id', candidateList, 'student_id', 200, 4);
                if (Array.isArray(data) && data.length > 0) {
                    if (!this.studentMasterByIdMap) this.studentMasterByIdMap = new Map();
                    for (const s of data) {
                        if (!s || !s.student_id) continue;
                        s._level = getStudentProgramLevel(s);
                        s._levelTag = formatStudentLevelTag(s._level);
                        const rawSid = String(s.student_id).trim();
                        this.studentMasterByIdMap.set(rawSid, s);
                        this.studentMasterByIdMap.set(rawSid.toUpperCase(), s);
                        const normSid = this.normalizeStudentId ? this.normalizeStudentId(rawSid) : normalizeStudentIdValue(rawSid);
                        if (normSid) {
                            this.studentMasterByIdMap.set(normSid, s);
                            if (/^\d+$/.test(normSid) && normSid.length < 9) {
                                this.studentMasterByIdMap.set(normSid.padStart(9, '0'), s);
                            }
                        }
                    }
                    this._sidLevelCache = new Map();
                }
            } catch (_e) {
                // Ignore transient lookup failures; full directory loads lazily only when explicitly needed
            }
        }
        return this.studentMasterByIdMap;
    }

    lookupStudentBySid(sid) {
        if (sid === null || sid === undefined) return null;
        const raw = String(sid).trim();
        if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID') return null;
        const map = this.syncStudentMasterMapFromCache();
        if (map.size === 0) return null;
        const direct = map.get(raw) || map.get(raw.toUpperCase());
        if (direct) return direct;
        const norm = this.normalizeStudentId ? this.normalizeStudentId(raw) : normalizeStudentIdValue(raw);
        if (norm) {
            const byNorm = map.get(norm) || map.get(norm.toUpperCase());
            if (byNorm) return byNorm;
            if (/^\d+$/.test(norm) && norm.length < 9) {
                const byPad = map.get(norm.padStart(9, '0'));
                if (byPad) return byPad;
            }
        }
        return null;
    }

    getStudentLevelBySid(sid) {
        if (sid === null || sid === undefined) return '';
        const raw = String(sid).trim();
        if (!raw || raw === 'Empty' || raw === 'Missing' || raw === 'Missing ID') return '';
        if (!this._sidLevelCache) this._sidLevelCache = new Map();
        const cached = this._sidLevelCache.get(raw);
        if (cached !== undefined) return cached;
        const student = this.lookupStudentBySid(raw);
        const level = student
            ? (student._level || (student._level = getStudentProgramLevel(student)))
            : (/^dip\d+/i.test(raw) ? 'PG' : '');
        if (this.studentMasterByIdMap && this.studentMasterByIdMap.size > 0 && this._sidLevelCache.size < 30000) {
            this._sidLevelCache.set(raw, level);
        }
        return level;
    }

    getStudentLevelLabelBySid(sid) {
        return formatStudentLevelTag(this.getStudentLevelBySid(sid));
    }

    getTransactionStudentLevel(tx) {
        if (!tx) return '';
        const stored = typeof tx.student_level === 'string' ? tx.student_level.trim().toUpperCase() : '';
        if (stored === 'UG' || stored === 'PG') return stored;
        if (tx.student_id) {
            const bySid = this.getStudentLevelBySid(tx.student_id);
            if (bySid) return bySid;
        }
        if (tx.program) {
            return getStudentProgramLevel(tx.program);
        }
        return '';
    }

    renderStudentLevelBadge(levelOrStudent) {
        const level = (levelOrStudent === 'UG' || levelOrStudent === 'PG')
            ? levelOrStudent
            : getStudentProgramLevel(levelOrStudent);
        if (!level) return '';
        if (level === 'UG') {
            return `<span class="badge badge-level-ug" style="font-size: 0.68rem; padding: 0.08rem 0.38rem; border-radius: 4px; font-weight: 700; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); margin-left: 0.35rem; vertical-align: middle;" title="Undergraduate Program">(UG)</span>`;
        }
        return `<span class="badge badge-level-pg" style="font-size: 0.68rem; padding: 0.08rem 0.38rem; border-radius: 4px; font-weight: 700; background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); margin-left: 0.35rem; vertical-align: middle;" title="Postgraduate Program">(PG)</span>`;
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
        tbody.innerHTML = Array(5).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(10) + '</tr>').join('');

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
            tbody.innerHTML = `<tr><td colspan="10" style="color: var(--danger);">${escapeHTML(error.message)}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            if (elPageAmt) elPageAmt.textContent = 'EGP 0.00';
            if (elHealth) elHealth.textContent = '0 Valid';
            tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><i data-lucide="inbox" style="width:48px;height:48px;opacity:0.5;"></i><h3>No transactions found</h3><p>Try adjusting your filters or go to Import CSV to add data.</p></div></td></tr>';
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

            return `
                <tr data-tx-row-idx="${idx}" style="cursor: pointer;" title="Click to inspect transaction details">
                    <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong></td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.payment_date))}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 165px; font-size: 0.85rem; line-height: 1.3;"><strong>${escapeHTML(t.student_id)}</strong>${stuLevelBadge}</td>
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
        }

        renderIcons(tbody);
    }

    async openQuickMapForItem(rawItemName) {
        const cleanName = normalizeItemName(rawItemName);
        if (!cleanName) return;
        try {
            if (!this.allMappingsData) {
                this.allMappingsData = await fetchAll('item_mappings', '*', null, 'item_name');
            }
            this.updateMappingsStatsAndDropdowns(this.allMappingsData);
        } catch (e) {
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
                    } catch (e) {
                        lookupEl.textContent = '';
                    }
                }
            }
        }
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        if (tbody) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(5) + '</tr>').join('');
        }
        try {
            if (this.hasRole('admin') && !this._mappingsDedupedOnce) {
                await this.deduplicateItemMappings({ silent: true });
            }
            const allData = await fetchAll('item_mappings', 'item_name, adjusted_item_name, mapping, second_mapping', null, 'item_name');
            this.allMappingsData = allData;
            this.mappingsPage = 1;
            this.updateMappingsStatsAndDropdowns(allData);
            this.renderMappingsPage();
            this.loadUnmappedItemsSummary();
            this.markTabLoaded('mappings');
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
                'id, reference_number, item_name, check_column, item_price, mapping',
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

            const canEditMappings = this.hasRole('accountant');
            tbody.innerHTML = items.map(item => `
                <tr>
                    <td><strong>${escapeHTML(item.originalName)}</strong></td>
                    <td>${escapeHTML(item.displayName)}</td>
                    <td>${item.count.toLocaleString()}</td>
                    <td>EGP ${formatMoney(item.totalAmount)}</td>
                    <td>
                        ${canEditMappings ? `<button type="button" class="btn btn-primary btn-sm" data-quick-map="${escapeHTML(item.originalName)}">
                            <i data-lucide="plus" style="width: 12px; height: 12px;"></i> Map Item
                        </button>` : '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>'}
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

        const canEditMapping = this.hasRole('accountant');
        const canDeleteMapping = this.hasRole('admin');
        tbody.innerHTML = pageData.map(m => `
            <tr>
                <td><strong>${escapeHTML(m.item_name)}</strong></td>
                <td>${m.adjusted_item_name ? `<span style="color: var(--primary);">${escapeHTML(m.adjusted_item_name)}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                <td>${m.mapping ? `<span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); border: 1px solid rgba(56, 189, 248, 0.25);">${escapeHTML(m.mapping)}</span>` : '<span style="color: var(--warning); font-size: 0.8rem;">Unmapped</span>'}</td>
                <td>${escapeHTML(m.second_mapping) || '-'}</td>
                <td style="white-space: nowrap;">
                    ${canEditMapping ? `<button class="btn btn-outline btn-sm" data-edit-mapping="${escapeHTML(m.item_name)}">Edit</button>` : ''}
                    ${canDeleteMapping ? `<button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-mapping="${escapeHTML(m.item_name)}">Delete</button>` : ''}
                    ${(!canEditMapping && !canDeleteMapping) ? '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>' : ''}
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
                    const prevRule = allData.find(m => m.item_name === itemName);
                    const previouslyRenamedTo = await this.getCurrentAdjustedNames([itemName]);
                    const { error } = await supabase.from('item_mappings').delete().eq('item_name', itemName);
                    if (error) throw error;

                    await this.logAudit('Mapping Deleted', itemName, {
                        item_name: itemName,
                        revert_data: prevRule ? {
                            table_name: 'item_mappings',
                            operation: 'upsert',
                            previous_rows: [prevRule]
                        } : undefined
                    });

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
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-mappings-prev" ${this.mappingsPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.mappingsPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-mappings-next" ${this.mappingsPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('mappings', totalPages)}
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
                this.pageJump.bind('mappings', totalPages, (target) => {
                    this.mappingsPage = target;
                    this.renderMappingsPage();
                }, pager);
            }
        }
        renderIcons(document.getElementById('view-mappings'));
    }

    async deduplicateManualFixes({ silent = true, prefetchedRows = null } = {}) {
        try {
            this._fixesDedupedOnce = true;
            const allRows = Array.isArray(prefetchedRows)
                ? prefetchedRows
                : await fetchAll('manual_fixes', '*', null, 'reference_number');
            if (!allRows || allRows.length === 0) {
                if (!silent) Toast.show('No manual fixes found to check.', 'info');
                return { mergedCount: 0, deletedCount: 0, cleanRows: [] };
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

            const cleanRows = [];
            for (const group of byNormRef.values()) {
                cleanRows.push(group.canonical);
                if (group.rawKeys.length > 1 || group.needsSave) {
                    rowsToUpsert.push(group.canonical);
                    for (const k of group.rawKeys) {
                        if (k !== group.canonical.reference_number) {
                            keysToDelete.push(k);
                        }
                    }
                }
            }
            cleanRows.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));

            if (keysToDelete.length === 0 && rowsToUpsert.length === 0) {
                if (!silent) Toast.show('All manual fixes are clean — no duplicate Reference Numbers found!', 'success');
                return { mergedCount: 0, deletedCount: 0, cleanRows };
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
                this.allFixesData = cleanRows;
                this.updateFixesStatsAndDropdowns(cleanRows);
                this.renderFixesPage();
            }

            return { mergedCount: rowsToUpsert.length, deletedCount: keysToDelete.length, cleanRows };
        } catch (err) {
            if (!silent) Toast.show('Error deduplicating fixes: ' + err.message, 'error');
            return { mergedCount: 0, deletedCount: 0, cleanRows: Array.isArray(prefetchedRows) ? prefetchedRows : [] };
        }
    }

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        if (tbody && (!this.allFixesData || this.allFixesData.length === 0)) {
            tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(6) + '</tr>').join('');
        }
        try {
            let allData = await fetchAll('manual_fixes', 'reference_number, correct_id, item_name, mapping, second_mapping', null, 'reference_number');
            if (this.hasRole('admin') && !this._fixesDedupedOnce) {
                const dedupRes = await this.deduplicateManualFixes({ silent: true, prefetchedRows: allData });
                if (Array.isArray(dedupRes.cleanRows)) {
                    allData = dedupRes.cleanRows;
                }
            }
            this.allFixesData = allData;
            this.fixesPage = 1;
            this.updateFixesStatsAndDropdowns(allData);
            this.renderFixesPage();
            this.loadUnresolvedTransactionsSummary();
            this.markTabLoaded('fixes');
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

    renderUnresolvedTransactionsDom() {
        const statEl = document.getElementById('fixes-stat-unresolved');
        const tbody = document.getElementById('unresolved-tx-body');
        const byRef = this.unresolvedTxByRef || new Map();
        const items = Array.from(byRef.values());
        if (statEl) statEl.textContent = items.length.toLocaleString();

        if (!tbody) return;
        if (items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 1.5rem; color: var(--success);">All transactions in the database currently have a Valid Student ID!</td></tr>';
            return;
        }

        const canEditFixes = this.hasRole('accountant');
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
                        ${canEditFixes ? `<button class="btn btn-primary btn-sm" data-fix-unresolved="${escapeHTML(t.reference_number)}">
                            <i data-lucide="wrench" style="width: 13px; height: 13px;"></i> Fix
                        </button>` : '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>'}
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
    }

    syncUnresolvedAfterFixChange(txRows = [], appliedChanges = []) {
        if (!this.unresolvedTxByRef) return;
        const changeById = new Map((appliedChanges || []).map(c => [c.id, c.fields]));
        let mutated = false;

        for (const tx of txRows || []) {
            if (!tx || !tx.reference_number) continue;
            const refKey = String(tx.reference_number).trim();
            const updatedFields = changeById.get(tx.id);
            const newStatus = updatedFields ? updatedFields.id_status : tx.id_status;
            const newStudentId = updatedFields ? updatedFields.student_id : tx.student_id;
            const newItemName = updatedFields ? updatedFields.item_name : tx.item_name;

            if (newStatus === 'Valid') {
                if (this.unresolvedTxByRef.delete(refKey)) mutated = true;
            } else {
                this.unresolvedTxByRef.set(refKey, {
                    ...tx,
                    student_id: newStudentId,
                    item_name: newItemName,
                    id_status: newStatus
                });
                mutated = true;
            }
        }

        if (mutated) {
            this.renderUnresolvedTransactionsDom();
            this.updateSidebarBadges();
        }
    }

    async loadUnresolvedTransactionsSummary() {
        const tbody = document.getElementById('unresolved-tx-body');
        try {
            const badRows = await fetchAll(
                'transactions',
                'id, reference_number, payment_date, student_id, id_status, item_name, item_price, mapping, second_mapping',
                q => q.neq('id_status', 'Valid').neq('id_status', 'Exempt'),
                'id'
            );

            // Group by reference_number so each reference appears once (exclude exempt Dip & Workshop rows)
            const byRef = new Map();
            for (const tx of badRows) {
                if (!tx.reference_number || isNonInvalidTransaction(tx)) continue;
                const key = String(tx.reference_number).trim();
                if (!byRef.has(key)) {
                    byRef.set(key, tx);
                }
            }
            for (const ftx of (this.foreignTransactions || [])) {
                const norm = this.normalizeForeignTransactionRow(ftx);
                if (!norm.reference_number || isNonInvalidTransaction(norm)) continue;
                const key = String(norm.reference_number).trim();
                if (!byRef.has(key)) {
                    byRef.set(key, {
                        reference_number: norm.reference_number,
                        payment_date: norm.value_date || norm.payment_date,
                        student_id: norm.student_id || '',
                        id_status: norm.id_status || 'Missing ID',
                        item_name: norm.description || '',
                        item_price: norm.amount || 0
                    });
                }
            }

            this.unresolvedTxByRef = byRef;
            this.renderUnresolvedTransactionsDom();
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

        const canEditFix = this.hasRole('accountant');
        const canDeleteFix = this.hasRole('admin');
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
                        ${canEditFix ? `<button class="btn btn-outline btn-sm" data-edit-fix="${escapeHTML(f.reference_number)}">Edit</button>` : ''}
                        ${canDeleteFix ? `<button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-fix="${escapeHTML(f.reference_number)}">Delete</button>` : ''}
                        ${(!canEditFix && !canDeleteFix) ? '<span style="color: var(--text-muted); font-size: 0.78rem;">View Only</span>' : ''}
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
                    const prevFix = allData.find(f => f.reference_number === ref);
                    const { error } = await supabase.from('manual_fixes').delete().eq('reference_number', ref);
                    if (error) throw error;

                    if (Array.isArray(this.allFixesData)) {
                        const cleanKey = String(ref || '').trim().toLowerCase();
                        this.allFixesData = this.allFixesData.filter(f => String(f.reference_number || '').trim().toLowerCase() !== cleanKey);
                    }

                    const fixRuleCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, check_column, mapping, second_mapping, id_status, is_settled, erp_batch_number';
                    const [, rows] = await Promise.all([
                        this.logAudit('Manual Fix Deleted', ref, {
                            reference_number: ref,
                            revert_data: prevFix ? {
                                table_name: 'manual_fixes',
                                operation: 'upsert',
                                previous_rows: [prevFix]
                            } : undefined
                        }),
                        fetchAll('transactions', fixRuleCols, q => q.eq('reference_number', ref), 'id')
                    ]);

                    const result = await this.reapplyRulesTo(rows, {
                        fixes: this.allFixesData || [],
                        mappings: this.allMappingsData || undefined
                    });

                    Toast.show(`Fix deleted. ${this.reapplySummary(result)}`, 'success');
                    if (Array.isArray(this.allFixesData)) {
                        this.updateFixesStatsAndDropdowns(this.allFixesData);
                        this.renderFixesPage();
                        this.syncUnresolvedAfterFixChange(rows, result.appliedChanges || []);
                    } else {
                        this.loadFixes();
                    }
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
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-fixes-prev" ${this.fixesPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.fixesPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-fixes-next" ${this.fixesPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('fixes', totalPages)}
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
                this.pageJump.bind('fixes', totalPages, (target) => {
                    this.fixesPage = target;
                    this.renderFixesPage();
                }, pager);
            }
        }
        renderIcons(document.getElementById('view-fixes'));
    }

    initStudentMaster() {
        this.studentsCurrentPage = 1;
        this.studentsPageSize = 100;
        this.allStudentsData = null;
        this.filteredStudentsData = [];

        const btnToggleImport = document.getElementById('btn-toggle-student-import');
        const btnCloseImport = document.getElementById('btn-close-student-import');
        const importPanel = document.getElementById('student-import');
        if (btnToggleImport && importPanel) {
            btnToggleImport.addEventListener('click', () => {
                importPanel.classList.toggle('hidden');
            });
        }
        if (btnCloseImport && importPanel) {
            btnCloseImport.addEventListener('click', () => {
                importPanel.classList.add('hidden');
            });
        }

        const btnAddStudent = document.getElementById('btn-add-student');
        if (btnAddStudent) {
            btnAddStudent.addEventListener('click', () => this.openStudentModal());
        }

        const btnSaveStudent = document.getElementById('btn-save-student');
        if (btnSaveStudent) {
            btnSaveStudent.addEventListener('click', async () => {
                const rawSid = document.getElementById('stu-modal-id')?.value.trim();
                const fullName = document.getElementById('stu-modal-name')?.value.trim();
                if (!rawSid || !fullName) {
                    Toast.show('Student ID and Full Name are required.', 'warning');
                    return;
                }

                const normSid = this.normalizeStudentId(rawSid);
                const payload = {
                    student_id: normSid,
                    full_name: fullName,
                    arabic_name: document.getElementById('stu-modal-arabic-name')?.value.trim() || null,
                    national_id: document.getElementById('stu-modal-national-id')?.value.trim() || null,
                    email: document.getElementById('stu-modal-email')?.value.trim() || null,
                    personal_email: document.getElementById('stu-modal-personal-email')?.value.trim() || null,
                    mobile: document.getElementById('stu-modal-mobile')?.value.trim() || null,
                    guardian_name: document.getElementById('stu-modal-guardian-name')?.value.trim() || null,
                    guardian_mobile: document.getElementById('stu-modal-guardian-mobile')?.value.trim() || null,
                    college: document.getElementById('stu-modal-college')?.value.trim() || null,
                    program: ensureProgramHasLevelPrefix(document.getElementById('stu-modal-program')?.value.trim() || ''),
                    source: 'Manual'
                };

                try {
                    btnSaveStudent.disabled = true;
                    const existing = (this.allStudentsData || []).find(s => String(s.student_id) === String(normSid));
                    if (existing && existing.source && existing.source !== 'Manual' && !existing.source.includes('Manual')) {
                        payload.source = `${existing.source}, Manual`;
                    }

                    const { error } = await supabase.from('student_master').upsert([payload], { onConflict: 'student_id' });
                    if (error) throw error;

                    await this.logAudit(existing ? 'UPDATE' : 'CREATE', 'student_master', normSid, existing || null, payload);
                    Toast.show(existing ? `Updated student ${normSid}` : `Added student ${normSid}`, 'success');
                    document.getElementById('modal-student')?.classList.add('hidden');

                    await this.loadStudents({ forceReload: true, skipAutoProfile: true });
                    if (this.currentProfileSid && String(this.normalizeStudentId(this.currentProfileSid)) === String(normSid)) {
                        this.loadStudentProfile(normSid);
                    }
                } catch (err) {
                    Toast.show('Error saving student: ' + err.message, 'error');
                } finally {
                    btnSaveStudent.disabled = false;
                }
            });
        }

        document.getElementById('btn-export-students')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                const btn = document.getElementById('btn-export-students');
                const oldHtml = btn.innerHTML;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Exporting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();

                const exportSource = (this.filteredStudentsData && this.filteredStudentsData.length > 0)
                    ? this.filteredStudentsData
                    : await this.ensureFullStudentMaster();

                const rows = (exportSource || []).map(s => {
                    const { nuEmail, personalEmail } = getStudentDisplayEmails(s);
                    return {
                        'Student ID': s.student_id || '',
                        'Level': s._levelTag || formatStudentLevelTag(getStudentProgramLevel(s)),
                        'Full Name': s.full_name || '',
                        'Arabic Name': s.arabic_name || '',
                        'Email': nuEmail || '',
                        'Personal Email': personalEmail || '',
                        'Mobile': s.mobile || '',
                        'National ID': s.national_id || '',
                        'College': s.college || '',
                        'Program': s.program || '',
                        'Guardian Name': s.guardian_name || '',
                        'Guardian Mobile': s.guardian_mobile || '',
                        'Source': s.source || ''
                    };
                });

                const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(rows));
                ws['!cols'] = [
                    { wch: 14 }, { wch: 10 }, { wch: 28 }, { wch: 26 }, { wch: 28 }, { wch: 28 },
                    { wch: 16 }, { wch: 18 }, { wch: 22 }, { wch: 24 },
                    { wch: 24 }, { wch: 16 }, { wch: 16 }
                ];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Students");
                await writeCompressedExcel(wb, `Student_Master_Export_${toDateOnly(new Date())}.xlsx`);
                Toast.show(`Exported ${rows.length.toLocaleString()} students`, "success");

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
                const copySidBtn = e.target.closest('.copyable-student-id');
                if (copySidBtn) {
                    e.stopPropagation();
                    const sidVal = copySidBtn.getAttribute('data-copy-sid');
                    if (sidVal) {
                        try {
                            await navigator.clipboard.writeText(sidVal);
                            Toast.show(`Student ID "${sidVal}" copied!`, 'success');
                        } catch (err) {
                            Toast.show('Failed to copy Student ID.', 'error');
                        }
                    }
                    return;
                }

                const target = e.target.closest('.copyable-email');
                if (target) {
                    e.stopPropagation();
                    const email = target.getAttribute('data-email');
                    if (email) {
                        try {
                            await navigator.clipboard.writeText(email);
                            Toast.show('Email copied to clipboard!', 'success');
                        } catch (err) {
                            Toast.show('Failed to copy email.', 'error');
                        }
                    }
                    return;
                }

                const row = e.target.closest('.student-row');
                if (row) {
                    const sid = row.getAttribute('data-sid');
                    if (sid) this.loadStudentProfile(sid);
                }
            });
        }

        const btnSearch = document.getElementById('btn-search-students');
        const searchInput = document.getElementById('student-search-input');
        const collegeSelect = document.getElementById('student-filter-college');
        const sourceSelect = document.getElementById('student-filter-source');
        const btnClear = document.getElementById('btn-clear-student-filters');

        let searchDebounce = null;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    this.studentsCurrentPage = 1;
                    this.loadStudents();
                }, 220);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(searchDebounce);
                    this.studentsCurrentPage = 1;
                    this.loadStudents();
                }
            });
        }
        if (btnSearch) {
            btnSearch.addEventListener('click', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents();
            });
        }
        if (collegeSelect) {
            collegeSelect.addEventListener('change', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }
        if (sourceSelect) {
            sourceSelect.addEventListener('change', () => {
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }
        if (btnClear) {
            btnClear.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                if (collegeSelect) collegeSelect.value = '';
                if (sourceSelect) sourceSelect.value = '';
                document.getElementById('inline-student-profile')?.classList.add('hidden');
                document.getElementById('student-directory-view')?.classList.remove('hidden');
                this.currentProfileSid = null;
                this.studentsCurrentPage = 1;
                this.loadStudents({ skipAutoProfile: true });
            });
        }

        document.getElementById('btn-close-student-profile')?.addEventListener('click', () => {
            document.getElementById('inline-student-profile')?.classList.add('hidden');
            document.getElementById('student-directory-view')?.classList.remove('hidden');
            this.currentProfileSid = null;
        });

        document.getElementById('btn-edit-profile-student')?.addEventListener('click', () => {
            if (!this.currentProfileSid) return;
            const st = this.currentProfileStudent || (this.allStudentsData || []).find(s => String(s.student_id) === String(this.currentProfileSid));
            this.openStudentModal(st || { student_id: this.currentProfileSid });
        });

        document.getElementById('btn-export-student-statement')?.addEventListener('click', () => {
            this.exportStudentStatement();
        });

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
                    this.handleStudentImport(Array.from(e.dataTransfer.files));
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const files = Array.from(e.target.files);
                    e.target.value = ''; // allow re-selecting the same file(s)
                    this.handleStudentImport(files);
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
                const tierLabels = {
                    high: 'High (ID / Email / National ID)',
                    phone: 'Phone Match',
                    name: 'Name Match',
                    unmatched: 'Unmatched'
                };
                const exportRows = this.automatchProposals.map(tx => ({
                    "Reference Number": tx.original_ref,
                    "Payment Date": tx.original_date,
                    "Current Student ID": tx.original_student_id || '',
                    "Current Status": tx.original_status,
                    "Confidence Tier": tierLabels[tx.confidenceTier] || (tx.proposedStudent ? 'Matched' : 'Unmatched'),
                    "Proposed Fix (Student ID)": tx.proposedStudent ? tx.proposedStudent.student_id : 'No Match Found',
                    "Level": tx.proposedStudent ? (tx.proposedStudent._levelTag || formatStudentLevelTag(getStudentProgramLevel(tx.proposedStudent))) : '',
                    "Proposed Fix (Student Name)": tx.proposedStudent ? tx.proposedStudent.full_name : '',
                    "Match Reason": tx.matchReason || '',
                    "Item Name": tx.original_item,
                    "Mapping": tx.original_mapping || '',
                    "2nd Mapping": tx.original_second_mapping || '',
                    "Amount": Number(tx.original_amount || 0),
                    "Bank": tx.original_bank || ''
                }));
                const safeExportRows = sanitizeExcelRows(exportRows);
                if (typeof XLSX !== 'undefined' && XLSX.utils && typeof XLSX.writeFile === 'function') {
                    const ws = XLSX.utils.json_to_sheet(safeExportRows);
                    ws['!cols'] = [
                        { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 24 },
                        { wch: 26 }, { wch: 22 }, { wch: 10 }, { wch: 30 }, { wch: 36 },
                        { wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 14 }
                    ];
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, 'Auto-Matcher Results');
                    writeCompressedExcel(wb, `Auto_Matcher_Results_${toDateOnly(new Date())}.xlsx`);
                } else {
                    const csv = Papa.unparse(safeExportRows);
                    // Include UTF-8 BOM so Microsoft Excel renders Arabic text cleanly when opening CSV exports
                    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
                    const link = document.createElement('a');
                    const url = URL.createObjectURL(blob);
                    link.href = url;
                    link.download = `Auto_Matcher_Results.csv`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 100);
                }
            });
        }

        const btnRunMatcher = document.getElementById('btn-run-automatcher');
        if (btnRunMatcher) {
            btnRunMatcher.addEventListener('click', () => this.runAutoMatcher());
        }

        this.automatchTierFilter = 'all';
        document.querySelectorAll('[data-automatch-tier]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-automatch-tier]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tier = btn.getAttribute('data-automatch-tier') || 'all';
                this.automatchTierFilter = tier;
                const toggle = document.getElementById('automatch-toggle-unmatched');
                if (tier === 'unmatched' && toggle && !toggle.checked) {
                    toggle.checked = true;
                }
                this.automatchPage = 1;
                this.renderAutoMatcherPage();
            });
        });

        const btnSelectHighConfidence = document.getElementById('btn-select-high-confidence');
        if (btnSelectHighConfidence) {
            btnSelectHighConfidence.addEventListener('click', () => {
                let count = 0;
                for (const p of (this.automatchProposals || [])) {
                    if (p.proposedStudent && p.confidenceTier === 'high' && !p.locked) {
                        p.selected = true;
                        count++;
                    } else {
                        p.selected = false;
                    }
                }
                this.renderAutoMatcherPage();
                if (count > 0) {
                    Toast.show(`Selected ${count} high-confidence match(es) (ID / Email / National ID).`, 'success');
                } else {
                    Toast.show('No unlocked high-confidence matches available to select.', 'info');
                }
            });
        }

        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if (selectAllMatcher) {
            selectAllMatcher.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const visibleProposals = this.getFilteredAutoMatchProposals();
                for (const p of visibleProposals) {
                    if (p.proposedStudent && (!checked || !p.locked)) {
                        p.selected = checked;
                    }
                }
                document.querySelectorAll('.automatch-checkbox').forEach(cb => {
                    const p = (this.automatchProposals || []).find(item => String(item.tx_id) === cb.value);
                    if (p && (!checked || !p.locked)) {
                        cb.checked = checked;
                    }
                });
                this.updateAutoMatchSelectionUI();
            });
        }
        const toggleUnmatched = document.getElementById('automatch-toggle-unmatched');
        if (toggleUnmatched) {
            toggleUnmatched.addEventListener('change', () => {
                if (!toggleUnmatched.checked && this.automatchTierFilter === 'unmatched') {
                    this.automatchTierFilter = 'all';
                    document.querySelectorAll('[data-automatch-tier]').forEach(b => {
                        b.classList.toggle('active', b.getAttribute('data-automatch-tier') === 'all');
                    });
                }
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
    
    normalizeStudentId(val) {
        if (val === null || val === undefined) return '';
        const s = String(val).trim();
        if (/^0+\d{4,}$/.test(s)) {
            return s.replace(/^0+/, '');
        }
        return s;
    }

    async labelExistingStudentsInDatabase({ silent = false } = {}) {
        if (!this.hasRole('operator')) {
            if (!silent) this.requireRole('operator', 'label students in database');
            return { updated: 0, ugCount: 0, pgCount: 0 };
        }
        const btn = document.getElementById('btn-label-existing-students');
        const oldHtml = btn ? btn.innerHTML : '';
        let loadingToast = null;
        if (!silent) {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Labeling...';
                if (window.lucide) lucide.createIcons();
            }
            if (window.Toast?.showLoading) {
                loadingToast = window.Toast.showLoading('Scanning & labeling existing students with (UG) / (PG)...');
            }
        }
        try {
            const allRows = (this.allStudentsData && this.allStudentsData.length > 0)
                ? this.allStudentsData
                : await fetchAll('student_master', '*', null, 'student_id');

            let ugCount = 0;
            let pgCount = 0;
            const rowsToUpdate = [];

            for (const s of (allRows || [])) {
                const lvl = getStudentProgramLevel(s) || 'PG';
                if (lvl === 'UG') ugCount++;
                else pgCount++;

                const newProg = ensureProgramHasLevelPrefix(s.program);
                if (String(s.program || '').trim() !== newProg) {
                    s.program = newProg;
                    this.indexStudentRecord(s);
                    rowsToUpdate.push({
                        student_id: s.student_id,
                        full_name: s.full_name ?? null,
                        arabic_name: s.arabic_name ?? null,
                        national_id: s.national_id ?? null,
                        email: s.email ?? null,
                        personal_email: s.personal_email ?? null,
                        mobile: s.mobile ?? null,
                        guardian_name: s.guardian_name ?? null,
                        guardian_mobile: s.guardian_mobile ?? null,
                        college: s.college ?? null,
                        program: newProg,
                        source: s.source ?? null
                    });
                }
            }

            if (rowsToUpdate.length > 0) {
                await this.upsertStudentMasterBatches(rowsToUpdate);
            }

            this.rebuildStudentMasterMap(allRows || []);
            if (document.getElementById('view-student-master')?.classList.contains('active')) {
                this.renderStudentsPage();
            }

            if (loadingToast) loadingToast.dismiss();
            if (!silent) {
                Toast.show(
                    `Labeled ${(allRows || []).length.toLocaleString()} students (${ugCount.toLocaleString()} UG, ${pgCount.toLocaleString()} PG — ${rowsToUpdate.length.toLocaleString()} updated in DB).`,
                    'success'
                );
            }
            return { updated: rowsToUpdate.length, ugCount, pgCount, total: (allRows || []).length };
        } catch (err) {
            if (loadingToast) loadingToast.dismiss();
            if (!silent) Toast.show('Error labeling students: ' + err.message, 'error');
            throw err;
        } finally {
            if (!silent && btn) {
                btn.disabled = false;
                btn.innerHTML = oldHtml;
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    /**
     * Upsert student_master rows in conservative batches so GIN trigram index updates
     * stay well within Supabase's statement_timeout, automatically splitting timed-out chunks.
     */
    async upsertStudentMasterBatches(records, { batchSize = 150, concurrency = 2, minBatchSize = 25, onProgress = null } = {}) {
        if (!Array.isArray(records) || records.length === 0) return 0;

        const isTimeoutError = (err) => {
            const msg = String(err?.message || err?.details || err || '').toLowerCase();
            return err?.code === '57014' || msg.includes('statement timeout') || msg.includes('canceling statement');
        };

        let uploadedCount = 0;
        const upsertChunk = async (chunk, retried = false) => {
            const { error } = await supabase.from('student_master').upsert(chunk, { onConflict: 'student_id' });
            if (!error) {
                uploadedCount += chunk.length;
                if (typeof onProgress === 'function') {
                    onProgress(uploadedCount, records.length);
                }
                return chunk.length;
            }

            if (isTimeoutError(error)) {
                if (chunk.length > minBatchSize) {
                    const mid = Math.ceil(chunk.length / 2);
                    await upsertChunk(chunk.slice(0, mid), false);
                    await upsertChunk(chunk.slice(mid), false);
                    return chunk.length;
                }
                if (!retried) {
                    await new Promise(resolve => setTimeout(resolve, 350));
                    return upsertChunk(chunk, true);
                }
            }
            throw error;
        };

        const tasks = [];
        for (let i = 0; i < records.length; i += batchSize) {
            const chunk = records.slice(i, i + batchSize);
            tasks.push(() => upsertChunk(chunk));
        }
        await runConcurrent(tasks, concurrency);
        return uploadedCount;
    }

    mergeStudentRecord(existing, incoming) {
        if (!existing) {
            const { email, personal_email } = classifyStudentEmails(incoming?.email, incoming?.personal_email);
            return { ...incoming, email, personal_email };
        }
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
        const { email, personal_email } = mergeStudentEmails(existing, incoming, isFromStudentDetails);
        return {
            student_id: incoming.student_id || existing.student_id,
            full_name: pickLongerName(existing.full_name, incoming.full_name),
            arabic_name: incoming.arabic_name || existing.arabic_name || null,
            national_id: incoming.national_id || existing.national_id || null,
            email,
            personal_email,
            mobile: incoming.mobile || existing.mobile || null,
            guardian_name: incoming.guardian_name || existing.guardian_name || null,
            guardian_mobile: incoming.guardian_mobile || existing.guardian_mobile || null,
            college: (isFromStudentDetails ? (incoming.college || existing.college) : (existing.college || incoming.college)) || null,
            program: (isFromStudentDetails ? (incoming.program || existing.program) : (existing.program || incoming.program)) || null,
            source: existing.source && existing.source !== incoming.source ? 'Merged' : (incoming.source || existing.source || null)
        };
    }

    async handleStudentImport(fileOrFiles) {
        const files = Array.isArray(fileOrFiles)
            ? fileOrFiles
            : (fileOrFiles && typeof fileOrFiles.length === 'number' && !(fileOrFiles instanceof Blob))
                ? Array.from(fileOrFiles)
                : (fileOrFiles ? [fileOrFiles] : []);
        if (files.length === 0) return;

        const batchFileName = files.map(f => f.name).join(', ');
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing ${files.length > 1 ? `${files.length} Excel files` : 'Excel file'}...`;
        if (window.lucide) lucide.createIcons();

        try {
            const cleanText = (val) => {
                if (val === null || val === undefined) return null;
                const s = String(val).replace(/\*+$/g, '').replace(/\s+/g, ' ').trim();
                if (!s || ['N/A', 'NA', 'NONE', 'NULL', '-', '.', '0', 'NO', 'NO PASSPORT', 'لا يوجد'].includes(s.toUpperCase())) return null;
                if (s.startsWith('=')) return null; // Ignore un-evaluated formula strings like =D2&" "&E2
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
                // Ignore dummy National ID / Passport values that repeat the Student ID, are too short, or are Excel float-truncated (ending in 6+ zeros)
                if (txt === rawSid || txt === normSid || txt.length < 7) return null;
                if (/^\d{8}0{6,}$/.test(txt)) return null;
                if (new Set(txt.replace(/[\s\-]/g, '').split('')).size < 3) return null;
                return txt;
            };

            const recordsMap = new Map();
            const paddedLegacyIds = new Set();

            for (const file of files) {
                const data = await file.arrayBuffer();
                const workbook = XLSX.read(data, { type: 'array' });
                let parsedAnySheet = false;

                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
                    if (!rows || rows.length === 0) continue;

                    // Scan the first 10 rows to find the header row containing 'Student ID', 'PEOPLE_ID1', or 'People ID'
                    let headerRowIdx = -1;
                    for (let i = 0; i < Math.min(10, rows.length); i++) {
                        const rowCells = (rows[i] || []).map(c => c != null ? String(c).trim() : '');
                        if (rowCells.includes('Student ID') || rowCells.includes('PEOPLE_ID1') || rowCells.includes('People ID')) {
                            headerRowIdx = i;
                            break;
                        }
                    }
                    if (headerRowIdx === -1) continue;
                    parsedAnySheet = true;

                    const headers = rows[headerRowIdx];
                    const dataRows = rows.slice(headerRowIdx + 1);

                    const headerMap = {};
                    headers.forEach((h, i) => { if (h != null && String(h).trim() !== '') headerMap[String(h).trim()] = i; });

                    status.innerHTML = `<i data-lucide="loader" class="spin"></i> Preparing and normalizing student records (${escapeHTML(file.name)})...`;

                    let lastRawSid = '';
                    let lastStudentId = '';

                    for (const row of dataRows) {
                        if (!row || row.length === 0) continue;

                        let rawSid, student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source;

                        if ('PEOPLE_ID1' in headerMap || 'People ID' in headerMap) {
                            const pidCol = 'PEOPLE_ID1' in headerMap ? 'PEOPLE_ID1' : 'People ID';
                            const cellSid = row[headerMap[pidCol]] != null ? String(row[headerMap[pidCol]]).trim() : '';
                            if (cellSid) {
                                rawSid = cellSid;
                                student_id = this.normalizeStudentId(rawSid);
                                lastRawSid = rawSid;
                                lastStudentId = student_id;
                            } else {
                                // Continuation row (e.g. Father / Mother guardian entry for the preceding applicant)
                                rawSid = lastRawSid;
                                student_id = lastStudentId;
                            }
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            const first = cleanText(row[headerMap['FIRST_NAME1'] ?? headerMap['First Name']]);
                            const middle = cleanText(row[headerMap['MIDDLE_NAME1'] ?? headerMap['Middle Name']]);
                            const last = cleanText(row[headerMap['LAST_NAME1'] ?? headerMap['Last Name']]);
                            const rawFull = cleanText(row[headerMap['Full name']]);
                            const combinedParts = [first, middle, last].filter(Boolean).join(' ');
                            if (rawFull && last && !rawFull.toLowerCase().includes(last.toLowerCase())) {
                                full_name = `${rawFull} ${last}`.replace(/\s+/g, ' ').trim();
                            } else {
                                full_name = combinedParts || rawFull || first || null;
                            }

                            arabic_name = cleanText(row[headerMap['ARABICNAME'] ?? headerMap['Arabic Name']]);
                            national_id = cleanNationalId(row[headerMap['GOVERNMENT_ID1'] ?? headerMap['Government Id']], rawSid, student_id)
                                || cleanNationalId(row[headerMap['PASSPORT_NUMBER1'] ?? headerMap['Passport Number']], rawSid, student_id);
                            const rawUniEmail = cleanText(row[headerMap['Email1'] ?? headerMap['University Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['personalEmail'] ?? headerMap['Personal Email']]);
                            ({ email, personal_email } = classifyStudentEmails(rawUniEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['PhoneNumber1'] ?? headerMap['Phone Number']]);
                            const rel = cleanText(row[headerMap['Guardian_Relation'] ?? headerMap['Parent Relation']]);
                            const rawGName = cleanText(row[headerMap['Guardian_NAME'] ?? headerMap['Parent Name']]);
                            const rawGMob = cleanPhone(row[headerMap['Guardian_Mobile'] ?? headerMap['Parent Mobile']]);

                            // Prioritize Father / Mother guardian info over 'Other' (which often just repeats the student's own name with no mobile)
                            const existingRec = student_id ? recordsMap.get(student_id) : null;
                            const isPrimaryParent = rel && /^(father|mother)$/i.test(rel);
                            if (existingRec && existingRec.guardian_mobile && !rawGMob) {
                                guardian_name = existingRec.guardian_name;
                                guardian_mobile = existingRec.guardian_mobile;
                            } else if (existingRec && existingRec.guardian_name && !isPrimaryParent && existingRec._isPrimaryParent) {
                                guardian_name = existingRec.guardian_name;
                                guardian_mobile = existingRec.guardian_mobile || rawGMob;
                            } else {
                                guardian_name = rawGName;
                                guardian_mobile = rawGMob;
                            }

                            college = cleanText(row[headerMap['University1'] ?? headerMap['University']])
                                || cleanText(row[headerMap['CURRICULUM1'] ?? headerMap['Curriculum']]);
                            const progParts = [
                                cleanText(row[headerMap['PROGRAM1'] ?? headerMap['Program']]),
                                cleanText(row[headerMap['DEGREE1'] ?? headerMap['Degree']]),
                                cleanText(row[headerMap['CURRICULUM1'] ?? headerMap['Curriculum']])
                            ].filter(Boolean);
                            program = [...new Set(progParts)].join(' / ') || null;
                            source = 'ApplicantReport';

                            if (student_id) {
                                const incoming = {
                                    student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source
                                };
                                const merged = this.mergeStudentRecord(existingRec, incoming);
                                if (isPrimaryParent && (rawGName || rawGMob)) merged._isPrimaryParent = true;
                                else if (existingRec?._isPrimaryParent) merged._isPrimaryParent = true;
                                recordsMap.set(student_id, merged);
                            }
                            continue;
                        } else if ('Student ID' in headerMap && 'Full Name' in headerMap) {
                            // Exported / Master Combined format (has student_master columns)
                            rawSid = String(row[headerMap['Student ID']] || '').trim();
                            student_id = this.normalizeStudentId(rawSid);
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            full_name = cleanText(row[headerMap['Full Name']]);
                            arabic_name = cleanText(row[headerMap['Arabic Name']]);
                            national_id = cleanNationalId(row[headerMap['National ID']], rawSid, student_id);
                            const rawUniEmail = cleanText(row[headerMap['NU Email'] ?? headerMap['University Email'] ?? headerMap['Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['Personal Email'] ?? headerMap['Secondary Email'] ?? headerMap['personalEmail']]);
                            ({ email, personal_email } = classifyStudentEmails(rawUniEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['Mobile']]);
                            guardian_name = cleanText(row[headerMap['Guardian Name']]);
                            guardian_mobile = cleanPhone(row[headerMap['Guardian Mobile']]);
                            college = cleanText(row[headerMap['College']]);
                            program = cleanText(row[headerMap['Program']]);
                            source = cleanText(row[headerMap['Source']]) || 'Merged';
                        } else if ('Student ID' in headerMap) {
                            rawSid = String(row[headerMap['Student ID']] || '').trim();
                            student_id = this.normalizeStudentId(rawSid);
                            if (rawSid && rawSid !== student_id) paddedLegacyIds.add(rawSid);

                            full_name = cleanText(row[headerMap['Student Name']]);
                            arabic_name = null;
                            national_id = cleanNationalId(row[headerMap['National ID']], rawSid, student_id);
                            const rawEmail = cleanText(row[headerMap['Email'] ?? headerMap['University Email']]);
                            const rawPersonalEmail = cleanText(row[headerMap['Personal Email'] ?? headerMap['personalEmail']]);
                            ({ email, personal_email } = classifyStudentEmails(rawEmail, rawPersonalEmail));
                            mobile = cleanPhone(row[headerMap['Mobile Phone Number']]) || cleanPhone(row[headerMap['Home Phone Number']]);
                            guardian_name = null;
                            guardian_mobile = null;
                            college = cleanText(row[headerMap['College']]);
                            program = cleanText(row[headerMap['Program']]);
                            source = 'StudentDetails';
                        }

                        if (student_id) {
                            const incoming = {
                                student_id, full_name, arabic_name, national_id, email, personal_email, mobile, guardian_name, guardian_mobile, college, program, source
                            };
                            recordsMap.set(student_id, this.mergeStudentRecord(recordsMap.get(student_id), incoming));
                        }
                    }
                }

                if (!parsedAnySheet) {
                    throw new Error(`Unrecognized Excel format in "${file.name}". Expected 'Student ID', 'People ID', or 'PEOPLE_ID1' column.`);
                }
            }

            const records = Array.from(recordsMap.values()).map(r => {
                const copy = { ...r };
                delete copy._isPrimaryParent;
                return copy;
            });

            // Fetch existing student_master rows (both normalized IDs and any 0-padded legacy IDs) so we merge instead of wiping fields
            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Merging with existing database records...`;
            const lookupIds = [...new Set([...records.map(r => r.student_id), ...paddedLegacyIds])];
            const existingMap = new Map();
            const rawExistingByNormId = new Map();
            const legacyIdsToDelete = [];

            const lookupChunks = [];
            for (let i = 0; i < lookupIds.length; i += 250) {
                lookupChunks.push(lookupIds.slice(i, i + 250));
            }
            const existingChunkResults = await runConcurrent(lookupChunks.map(chunk => async () => {
                const { data: existingRows, error: exErr } = await supabase.from('student_master').select('*').in('student_id', chunk);
                if (exErr) throw exErr;
                return existingRows || [];
            }), 3);
            for (const existingRows of existingChunkResults) {
                for (const ex of existingRows) {
                    const normId = this.normalizeStudentId(ex.student_id);
                    if (ex.student_id !== normId) {
                        legacyIdsToDelete.push(ex.student_id);
                    } else if (!rawExistingByNormId.has(normId)) {
                        rawExistingByNormId.set(normId, ex);
                    }
                    existingMap.set(normId, this.mergeStudentRecord(existingMap.get(normId), { ...ex, student_id: normId }));
                }
            }

            const mergedRecords = records.map(r => {
                const merged = this.mergeStudentRecord(existingMap.get(r.student_id), r);
                merged.program = ensureProgramHasLevelPrefix(merged.program);
                return merged;
            });

            const syncFields = [
                'student_id', 'full_name', 'arabic_name', 'national_id',
                'email', 'personal_email', 'mobile', 'guardian_name',
                'guardian_mobile', 'college', 'program', 'source'
            ];
            const recordsToUpsert = mergedRecords.filter(merged => {
                const rawEx = rawExistingByNormId.get(merged.student_id);
                if (!rawEx) return true;
                return syncFields.some(field => (merged[field] ?? null) !== (rawEx[field] ?? null));
            });

            let insertedCount = 0;
            if (recordsToUpsert.length > 0) {
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${recordsToUpsert.length.toLocaleString()} new/updated records...`;
                insertedCount = await this.upsertStudentMasterBatches(recordsToUpsert, {
                    batchSize: 150,
                    concurrency: 2,
                    onProgress: (done, total) => {
                        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.min(100, Math.round((done / total) * 100))}%`;
                    }
                });
            }

            // Clean up any old 0-padded duplicate rows in student_master that have now been merged into their normalized IDs
            if (legacyIdsToDelete.length > 0) {
                for (let i = 0; i < legacyIdsToDelete.length; i += 200) {
                    const { error: delErr } = await supabase.from('student_master').delete().in('student_id', legacyIdsToDelete.slice(i, i + 200));
                    if (delErr) throw delErr;
                }
            }

            const unchangedCount = mergedRecords.length - recordsToUpsert.length;
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: batchFileName,
                    status: 'success',
                    records_processed: mergedRecords.length,
                    records_inserted: insertedCount,
                    details: {
                        type: 'student_master',
                        legacy_ids_cleaned: legacyIdsToDelete.length,
                        unchanged_skipped: unchangedCount
                    }
                });
            }

            status.className = 'alert alert-success';
            status.innerHTML = unchangedCount > 0
                ? `<i data-lucide="check-circle"></i> Successfully processed ${mergedRecords.length.toLocaleString()} students (${insertedCount.toLocaleString()} added/updated, ${unchangedCount.toLocaleString()} unchanged)!`
                : `<i data-lucide="check-circle"></i> Successfully imported & merged ${mergedRecords.length.toLocaleString()} students!`;
            if (window.lucide) lucide.createIcons();
            await this.loadStudents({ forceReload: true });

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${escapeHTML(err.message)}`;
            if (window.lucide) lucide.createIcons();
            console.error(err);
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: batchFileName,
                    status: 'failed',
                    records_processed: 0,
                    records_inserted: 0,
                    details: { type: 'student_master', error: err.message }
                });
            }
        }
    }
    


    // ==========================================
    // Payment Links Catalog
    // ==========================================
    initPaymentLinks() {
        this.paymentLinksPage = 1;
        this.paymentLinksSearch = '';
        this.paymentLinksStatusFilter = 'all';
        this.paymentLinksSort = 'created_desc';
        this.allPaymentLinks = null;
        this.filteredPaymentLinks = [];

        let linksSearchTimeout;
        const searchInput = document.getElementById('links-search');
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(linksSearchTimeout);
            linksSearchTimeout = setTimeout(() => {
                this.paymentLinksSearch = e.target.value.trim().toLowerCase();
                this.paymentLinksPage = 1;
                this.loadPaymentLinks();
            }, 220);
        });

        const sortSelect = document.getElementById('links-sort');
        sortSelect?.addEventListener('change', (e) => {
            this.paymentLinksSort = e.target.value || 'created_desc';
            this.paymentLinksPage = 1;
            this.loadPaymentLinks();
        });

        document.querySelectorAll('[data-link-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-link-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.paymentLinksStatusFilter = btn.getAttribute('data-link-filter') || 'all';
                this.paymentLinksPage = 1;
                this.loadPaymentLinks();
            });
        });

        document.getElementById('btn-clear-links-filters')?.addEventListener('click', () => {
            this.paymentLinksSearch = '';
            this.paymentLinksStatusFilter = 'all';
            this.paymentLinksSort = 'created_desc';
            this.paymentLinksPage = 1;
            if (searchInput) searchInput.value = '';
            if (sortSelect) sortSelect.value = 'created_desc';
            document.querySelectorAll('[data-link-filter]').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-link-filter') === 'all');
            });
            this.loadPaymentLinks();
        });

        document.getElementById('btn-add-link')?.addEventListener('click', () => {
            this.openPaymentLinkModal();
        });

        // Quick Expiry Date Presets (+7d, +14d, +30d)
        document.querySelectorAll('.link-expiry-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const days = parseInt(btn.getAttribute('data-days'), 10) || 7;
                const d = new Date();
                d.setDate(d.getDate() + days);
                d.setHours(23, 59, 0, 0);
                const tzoffset = d.getTimezoneOffset() * 60000;
                const localISOTime = new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
                const expInput = document.getElementById('link-expiry');
                if (expInput) expInput.value = localISOTime;
            });
        });

        // Auto-extract Invoice Number from URL when pasted & check duplicate invoice
        const urlInput = document.getElementById('link-url');
        const invInput = document.getElementById('link-invoice');
        const checkDuplicateInvoice = () => {
            const warnEl = document.getElementById('link-duplicate-warning');
            if (!warnEl || !invInput) return;
            const invVal = invInput.value.trim();
            const currentId = document.getElementById('link-id')?.value || '';
            if (!invVal) {
                warnEl.style.display = 'none';
                return;
            }
            const dup = (this.allPaymentLinks || []).find(l =>
                String(l.invoice_number || '').trim().toLowerCase() === invVal.toLowerCase() &&
                String(l.id) !== String(currentId)
            );
            if (dup) {
                warnEl.style.display = 'block';
                warnEl.innerHTML = `Invoice <strong>${escapeHTML(dup.invoice_number)}</strong> already exists (${escapeHTML(dup.name || 'Unnamed')}). <u>Click here to edit existing link instead</u>.`;
                warnEl.onclick = () => {
                    this.openPaymentLinkModal(dup, false);
                };
            } else {
                warnEl.style.display = 'none';
            }
        };

        invInput?.addEventListener('input', checkDuplicateInvoice);
        urlInput?.addEventListener('input', () => {
            const url = (urlInput.value || '').trim();
            if (url && invInput && !invInput.value.trim()) {
                const match = url.match(/\/(?:pay|invoice)\/([A-Za-z0-9_-]+)\/?$/i) || url.match(/\/([A-Za-z0-9_-]{4,24})\/?$/);
                if (match && match[1] && !['pay', 'invoice', 'atfawry'].includes(match[1].toLowerCase())) {
                    invInput.value = match[1];
                    checkDuplicateInvoice();
                }
            }
        });

        document.getElementById('btn-save-link')?.addEventListener('click', async () => {
            const id = document.getElementById('link-id').value;
            const linkData = {
                name: document.getElementById('link-name').value.trim(),
                amount: parseFloat(document.getElementById('link-amount').value) || null,
                invoice_number: document.getElementById('link-invoice').value.trim() || null,
                creation_date: document.getElementById('link-created').value || null,
                expiry_date: document.getElementById('link-expiry').value ? new Date(document.getElementById('link-expiry').value).toISOString() : null,
                invoice_link: document.getElementById('link-url').value.trim()
            };
            
            if (!linkData.name || !linkData.invoice_link) {
                Toast.show("Item Name and Payment Link URL are required", "error");
                return;
            }

            try {
                if (id) {
                    const existing = (this.allPaymentLinks || []).find(l => String(l.id) === String(id));
                    const { error } = await supabase.from('payment_links').update(linkData).eq('id', id);
                    if (error) throw error;
                    await this.logAudit('UPDATE', 'payment_links', linkData.invoice_number || id, existing || null, linkData);
                    Toast.show("Link updated", "success");
                } else {
                    const { error } = await supabase.from('payment_links').insert(linkData);
                    if (error) throw error;
                    await this.logAudit('CREATE', 'payment_links', linkData.invoice_number || linkData.name, null, linkData);
                    Toast.show("Link added", "success");
                }
                document.getElementById('modal-link').classList.add('hidden');
                this.loadPaymentLinks({ forceReload: true });
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
            writeCompressedExcel(wb, "Payment_Links_Import_Template.xlsx");
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

                    const parseDate = (val) => {
                        if (!val) return null;
                        if (val instanceof Date) { const d = new Date(val.getTime() - val.getTimezoneOffset() * 60000); return d.toISOString().split('T')[0]; }
                        if (typeof val === 'number') {
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

                    const withInvoice = Array.from(new Map(rows.filter(r => r.invoice_number).map(r => [r.invoice_number, r])).values());
                    const withoutInvoice = rows.filter(r => !r.invoice_number);

                    let imported = 0;
                    for (let i = 0; i < withInvoice.length; i += 1000) {
                        const chunk = withInvoice.slice(i, i + 1000);
                        const { error } = await supabase.from('payment_links').upsert(chunk, { onConflict: 'invoice_number' });
                        if (error) {
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
                    this.loadPaymentLinks({ forceReload: true });
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
                const source = (this.filteredPaymentLinks && this.filteredPaymentLinks.length > 0)
                    ? this.filteredPaymentLinks
                    : await fetchAll('payment_links', '*', null, 'id');

                const now = new Date();
                const exportRows = (source || []).map(l => {
                    const statusInfo = this.getPaymentLinkStatus(l, now);
                    return {
                        'Item Name': l.name || '',
                        'Amount (EGP)': l.amount ? Number(parseFloat(l.amount).toFixed(2)) : '',
                        'Invoice Number': l.invoice_number || '',
                        'Status': statusInfo.label,
                        'Creation Date': toDateOnly(l.creation_date) || '',
                        'Expiry Date': toDateOnly(l.expiry_date) || '',
                        'Payment Link': l.invoice_link || ''
                    };
                });

                const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(exportRows));
                ws['!cols'] = [
                    { wch: 42 }, { wch: 15 }, { wch: 18 },
                    { wch: 16 }, { wch: 15 }, { wch: 15 }, { wch: 55 }
                ];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Payment Links");
                writeCompressedExcel(wb, `Payment_Links_Export_${toDateOnly(new Date())}.xlsx`);
                Toast.show(`Exported ${exportRows.length.toLocaleString()} links`, "success");
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
            }
        });
        
        // Setup pagination
        document.getElementById('btn-links-prev')?.addEventListener('click', () => {
            if (this.paymentLinksPage > 1) {
                this.paymentLinksPage--;
                this.renderPaymentLinksPage();
            }
        });
        document.getElementById('btn-links-next')?.addEventListener('click', () => {
            this.paymentLinksPage++;
            this.renderPaymentLinksPage();
        });
        this.pageJump.bind('links', () => this.paymentLinksTotalPages || 1, (target) => {
            this.paymentLinksPage = target;
            this.renderPaymentLinksPage();
        });
    }

    openPaymentLinkModal(link = null, isDuplicate = false) {
        const modal = document.getElementById('modal-link');
        if (!modal) return;
        const warnEl = document.getElementById('link-duplicate-warning');
        if (warnEl) warnEl.style.display = 'none';

        const todayStr = new Date().toISOString().slice(0, 10);

        if (link && !isDuplicate) {
            document.getElementById('modal-link-title').textContent = 'Edit Payment Link';
            document.getElementById('link-id').value = link.id;
            document.getElementById('link-name').value = link.name || '';
            document.getElementById('link-amount').value = link.amount || '';
            document.getElementById('link-invoice').value = link.invoice_number || '';
            document.getElementById('link-created').value = toDateOnly(link.creation_date) || '';
            let expiryStr = '';
            if (link.expiry_date) {
                const d = new Date(link.expiry_date);
                if (!isNaN(d.getTime())) {
                    const tzoffset = (new Date()).getTimezoneOffset() * 60000;
                    expiryStr = (new Date(d - tzoffset)).toISOString().slice(0, 16);
                }
            }
            document.getElementById('link-expiry').value = expiryStr;
            document.getElementById('link-url').value = link.invoice_link || '';
        } else if (link && isDuplicate) {
            document.getElementById('modal-link-title').textContent = 'Renew / Duplicate Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = link.name || '';
            document.getElementById('link-amount').value = link.amount || '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = todayStr;
            const d = new Date();
            d.setDate(d.getDate() + 14);
            d.setHours(23, 59, 0, 0);
            const tzoffset = d.getTimezoneOffset() * 60000;
            document.getElementById('link-expiry').value = new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
            document.getElementById('link-url').value = '';
        } else {
            document.getElementById('modal-link-title').textContent = 'Add Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = '';
            document.getElementById('link-amount').value = '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = todayStr;
            document.getElementById('link-expiry').value = '';
            document.getElementById('link-url').value = '';
        }

        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    }

    getPaymentLinkStatus(link, now = new Date()) {
        if (!link.expiry_date) {
            return { key: 'active', label: 'Active (No Expiry)', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
        }
        const exp = new Date(link.expiry_date);
        if (isNaN(exp.getTime())) {
            return { key: 'active', label: 'Active', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
        }
        const diffMs = exp.getTime() - now.getTime();
        if (diffMs < 0) {
            return { key: 'expired', label: 'Expired', badgeClass: 'badge-danger', isExpired: true, isExpiringSoon: false };
        }
        const daysLeft = Math.ceil(diffMs / 86400000);
        if (daysLeft <= 7) {
            return { key: 'expiring', label: `Expiring (${daysLeft}d)`, badgeClass: 'badge-warning', isExpired: false, isExpiringSoon: true };
        }
        return { key: 'active', label: 'Active', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
    }

    updatePaymentLinksStats() {
        const list = this.allPaymentLinks || [];
        const now = new Date();
        let activeCount = 0;
        let expiringCount = 0;
        let expiredCount = 0;
        let activeValue = 0;

        list.forEach(l => {
            const st = this.getPaymentLinkStatus(l, now);
            const amt = parseFloat(l.amount || 0) || 0;
            if (st.isExpired) {
                expiredCount++;
            } else {
                activeCount++;
                activeValue += amt;
                if (st.isExpiringSoon) expiringCount++;
            }
        });

        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setEl('links-stat-total', list.length.toLocaleString());
        setEl('links-stat-active', activeCount.toLocaleString());
        setEl('links-stat-expiring', expiringCount.toLocaleString());
        setEl('links-stat-expired', expiredCount.toLocaleString());
        setEl('links-stat-value', `EGP ${formatMoney(activeValue)}`);
    }

    async loadPaymentLinks({ forceReload = false } = {}) {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;
        
        try {
            if (!this.allPaymentLinks || forceReload) {
                tbody.innerHTML = '<tr><td colspan="6" class="loading-state"><i data-lucide="loader" class="spin"></i> Loading links...</td></tr>';
                renderIcons(tbody);
                const all = await fetchAll('payment_links', '*', null, 'id');
                this.allPaymentLinks = all || [];
                this.updatePaymentLinksStats();
            }
            this.markTabLoaded('payment-links');

            const now = new Date();
            const search = (this.paymentLinksSearch || '').trim().toLowerCase();
            const searchNum = search.replace(/,/g, '');
            const statusFilter = this.paymentLinksStatusFilter || 'all';
            const sortMode = this.paymentLinksSort || 'created_desc';

            const clearBtn = document.getElementById('btn-clear-links-filters');
            if (clearBtn) {
                if (search || statusFilter !== 'all' || sortMode !== 'created_desc') {
                    clearBtn.classList.remove('hidden');
                } else {
                    clearBtn.classList.add('hidden');
                }
            }

            const filtered = (this.allPaymentLinks || []).filter(link => {
                const st = this.getPaymentLinkStatus(link, now);
                if (statusFilter === 'active' && st.isExpired) return false;
                if (statusFilter === 'expiring' && !st.isExpiringSoon) return false;
                if (statusFilter === 'expired' && !st.isExpired) return false;
                if (statusFilter === 'missing_invoice' && link.invoice_number && String(link.invoice_number).trim()) return false;

                if (search) {
                    const name = String(link.name || '').toLowerCase();
                    const inv = String(link.invoice_number || '').toLowerCase();
                    const url = String(link.invoice_link || '').toLowerCase();
                    const amtStr = link.amount != null ? String(link.amount) : '';
                    const match = name.includes(search) || inv.includes(search) || url.includes(search) || (searchNum && amtStr.includes(searchNum));
                    if (!match) return false;
                }
                return true;
            });

            filtered.sort((a, b) => {
                if (sortMode === 'created_desc' || sortMode === 'created_asc') {
                    const da = toDateOnly(a.creation_date) || '';
                    const db = toDateOnly(b.creation_date) || '';
                    if (da !== db) {
                        if (!da) return 1;
                        if (!db) return -1;
                        return sortMode === 'created_desc' ? db.localeCompare(da) : da.localeCompare(db);
                    }
                    return (b.id || 0) - (a.id || 0);
                }
                if (sortMode === 'expiry_asc' || sortMode === 'expiry_desc') {
                    const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
                    const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
                    return sortMode === 'expiry_asc' ? ea - eb : eb - ea;
                }
                if (sortMode === 'amount_desc' || sortMode === 'amount_asc') {
                    const aa = parseFloat(a.amount || 0) || 0;
                    const ab = parseFloat(b.amount || 0) || 0;
                    return sortMode === 'amount_desc' ? ab - aa : aa - ab;
                }
                if (sortMode === 'name_asc') {
                    return String(a.name || '').localeCompare(String(b.name || ''));
                }
                return 0;
            });

            this.filteredPaymentLinks = filtered;
            this.renderPaymentLinksPage();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">Error: ${escapeHTML(err.message)}</td></tr>`;
        }
    }

    renderPaymentLinksPage() {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;

        const btnPrev = document.getElementById('btn-links-prev');
        const btnNext = document.getElementById('btn-links-next');
        const pageInfo = document.getElementById('links-page-info');

        const total = (this.filteredPaymentLinks || []).length;
        const pageSize = this.pageSize || 50;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (this.paymentLinksPage > totalPages) this.paymentLinksPage = totalPages;
        if (this.paymentLinksPage < 1) this.paymentLinksPage = 1;

        if (total === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            <i data-lucide="link" style="width: 42px; height: 42px; opacity: 0.5;"></i>
                            <h3>No payment links found</h3>
                            <p>Try adjusting your search or status filter, or add a new payment link.</p>
                        </div>
                    </td>
                </tr>`;
            if (btnPrev) btnPrev.disabled = true;
            if (btnNext) btnNext.disabled = true;
            if (pageInfo) pageInfo.textContent = '0 links';
            if (window.lucide) lucide.createIcons();
            return;
        }

        const startIdx = (this.paymentLinksPage - 1) * pageSize;
        const data = this.filteredPaymentLinks.slice(startIdx, startIdx + pageSize);
        const now = new Date();

        tbody.innerHTML = data.map(link => {
            const st = this.getPaymentLinkStatus(link, now);
            const expDateStr = toDateOnly(link.expiry_date);
            let statusBadgeStyle = 'background: rgba(16, 185, 129, 0.14); color: #10b981;';
            if (st.isExpired) statusBadgeStyle = 'background: rgba(239, 68, 68, 0.15); color: var(--danger);';
            else if (st.isExpiringSoon) statusBadgeStyle = 'background: rgba(245, 158, 11, 0.16); color: #f59e0b;';

            return `
                <tr>
                    <td>
                        <div class="truncate-text" style="font-weight: 500;" title="${escapeHTML(link.name || '')}">${escapeHTML(link.name) || '-'}</div>
                    </td>
                    <td style="white-space: nowrap;">
                        <span class="amount" style="font-weight: 600;">${link.amount ? escapeHTML(formatMoney(link.amount)) + ' EGP' : '-'}</span>
                    </td>
                    <td style="white-space: nowrap;">
                        <div style="display: inline-flex; gap: 0.35rem; align-items: center;">
                            <span class="badge badge-gray" style="font-family: monospace;">${escapeHTML(link.invoice_number || '-')}</span>
                            ${link.invoice_number ? `<button type="button" class="action-icon-btn copy-invoice-btn" data-invoice="${escapeHTML(link.invoice_number)}" title="Copy Invoice Number" aria-label="Copy Invoice Number"><i data-lucide="copy"></i></button>` : ''}
                        </div>
                    </td>
                    <td style="white-space: nowrap;">${link.creation_date ? escapeHTML(toDateOnly(link.creation_date)) : '-'}</td>
                    <td style="white-space: nowrap;">
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <span>${expDateStr ? escapeHTML(expDateStr) : '-'}</span>
                            <span class="badge" style="font-size: 0.72rem; padding: 0.15rem 0.55rem; ${statusBadgeStyle}">${escapeHTML(st.label)}</span>
                        </div>
                    </td>
                    <td style="text-align: right; white-space: nowrap;">
                        <div style="display: inline-flex; gap: 0.35rem; align-items: center;">
                            <button type="button" class="btn btn-outline btn-sm copy-link-btn" data-url="${escapeHTML(link.invoice_link || '')}" ${st.isExpired ? 'disabled title="Link Expired"' : 'title="Copy Payment Link URL"'} style="padding: 0.25rem 0.6rem; font-size: 0.76rem;">
                                <i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy Link
                            </button>
                            ${link.invoice_link ? `<a href="${escapeHTML(link.invoice_link)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" title="Open Payment Link in New Tab" style="padding: 0.25rem 0.45rem; font-size: 0.76rem; text-decoration: none;"><i data-lucide="external-link" style="width: 13px; height: 13px;"></i></a>` : ''}
                            ${this.hasRole('operator') ? `
                            <button type="button" class="btn btn-outline btn-sm edit-link-btn" data-id="${escapeHTML(link.id)}" title="Edit Link" style="padding: 0.25rem 0.45rem; font-size: 0.76rem;">
                                <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
                            </button>` : ''}
                            ${this.hasRole('admin') ? `
                            <button type="button" class="btn btn-outline btn-sm delete-link-btn" style="color: var(--danger); padding: 0.25rem 0.45rem; font-size: 0.76rem;" data-id="${escapeHTML(link.id)}" title="Delete Link">
                                <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
                            </button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.copy-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const url = e.currentTarget.dataset.url;
                if (!url) return;
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
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const link = data.find(l => String(l.id) === String(id));
                if (link) this.openPaymentLinkModal(link, false);
            });
        });

        tbody.querySelectorAll('.delete-link-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const existing = (this.allPaymentLinks || []).find(l => String(l.id) === String(id));
                if (await window.customConfirm("Are you sure you want to delete this payment link?", 'Delete', 'Cancel')) {
                    const { error } = await supabase.from('payment_links').delete().eq('id', id);
                    if (error) {
                        Toast.show("Error deleting link: " + error.message, "error");
                    } else {
                        await this.logAudit('DELETE', 'payment_links', existing?.invoice_number || id, existing || { id }, null);
                        Toast.show("Link deleted", "success");
                        this.loadPaymentLinks({ forceReload: true });
                    }
                }
            });
        });

        this.paymentLinksTotalPages = totalPages;
        if (pageInfo) {
            pageInfo.innerHTML = `Showing <strong>${(startIdx + 1).toLocaleString()}</strong>–<strong>${Math.min(startIdx + pageSize, total).toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> links (Page ${this.paymentLinksPage} of ${totalPages})`;
        }
        if (btnPrev) btnPrev.disabled = this.paymentLinksPage <= 1;
        if (btnNext) btnNext.disabled = this.paymentLinksPage >= totalPages;
        const linksJumpInput = document.getElementById('links-jump-page');
        if (linksJumpInput) linksJumpInput.max = String(totalPages);

        renderIcons(document.getElementById('view-payment-links'));
    }



    openStudentModal(student = null) {
        const modal = document.getElementById('modal-student');
        if (!modal) return;
        const titleEl = document.getElementById('modal-student-title');
        const idInput = document.getElementById('stu-modal-id');

        if (student) {
            if (titleEl) titleEl.textContent = `Edit Student (${student.student_id})`;
            if (idInput) {
                idInput.value = student.student_id || '';
                idInput.readOnly = true;
                idInput.style.opacity = '0.75';
            }
            const setVal = (id, v) => {
                const el = document.getElementById(id);
                if (el) el.value = v || '';
            };
            const { nuEmail, personalEmail } = getStudentDisplayEmails(student);
            setVal('stu-modal-national-id', student.national_id);
            setVal('stu-modal-name', student.full_name);
            setVal('stu-modal-arabic-name', student.arabic_name);
            setVal('stu-modal-email', nuEmail);
            setVal('stu-modal-personal-email', personalEmail);
            setVal('stu-modal-mobile', student.mobile);
            setVal('stu-modal-guardian-name', student.guardian_name);
            setVal('stu-modal-guardian-mobile', student.guardian_mobile);
            setVal('stu-modal-college', student.college);
            setVal('stu-modal-program', student.program);
        } else {
            if (titleEl) titleEl.textContent = 'Add Student Record';
            if (idInput) {
                idInput.value = '';
                idInput.readOnly = false;
                idInput.style.opacity = '1';
            }
            [
                'stu-modal-national-id', 'stu-modal-name', 'stu-modal-arabic-name',
                'stu-modal-email', 'stu-modal-personal-email', 'stu-modal-mobile', 'stu-modal-guardian-name',
                'stu-modal-guardian-mobile', 'stu-modal-college', 'stu-modal-program'
            ].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        }
        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    }

    indexStudentRecord(s) {
        if (!s || typeof s !== 'object') return s;
        const sid = String(s.student_id || '').toLowerCase();
        s._normSid = this.normalizeStudentId(sid).toLowerCase();
        s._sourceLower = String(s.source || '').toLowerCase();
        s._level = getStudentProgramLevel(s);
        s._levelTag = formatStudentLevelTag(s._level);
        s._searchHaystack = `${sid}\n${s._normSid}\n${s._level}\n${s._levelTag}\n${s.full_name || ''}\n${s.arabic_name || ''}\n${s.email || ''}\n${s.personal_email || ''}\n${s.mobile || ''}\n${s.guardian_mobile || ''}\n${s.guardian_name || ''}\n${s.national_id || ''}\n${s.college || ''}\n${s.program || ''}`.toLowerCase();
        return s;
    }

    async loadStudents({ forceReload = false, skipAutoProfile = false } = {}) {
        const tbody = document.getElementById('students-table-body');
        try {
            if (!this.allStudentsData || forceReload) {
                const termRawInit = (document.getElementById('student-search-input')?.value || '').trim();
                const collegeInit = document.getElementById('student-filter-college')?.value || '';
                const sourceInit = document.getElementById('student-filter-source')?.value || '';
                const canRenderPreview = !termRawInit && !collegeInit && !sourceInit && (this.studentsCurrentPage || 1) === 1;
                let previewRendered = false;

                if (tbody) {
                    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i data-lucide="loader" class="spin" style="width:36px;height:36px;opacity:0.6;"></i><h3>Loading student directory...</h3></div></td></tr>';
                    renderIcons(tbody);
                }
                await this.ensureFullStudentMaster({
                    forceReload,
                    onProgress: (loaded, previewRows) => {
                        const totalEl = document.getElementById('students-stat-total');
                        if (totalEl && !this.allStudentsData) {
                            totalEl.textContent = `${loaded.toLocaleString()}...`;
                        }
                        if (canRenderPreview && !previewRendered && Array.isArray(previewRows) && previewRows.length > 0) {
                            previewRendered = true;
                            this.filteredStudentsData = previewRows;
                            this.renderStudentsPage();
                        }
                    }
                });
                this.updateStudentsStatsAndDropdowns();
            }
            this.markTabLoaded('student-master');

            const termRaw = (document.getElementById('student-search-input')?.value || '').trim();
            const term = termRaw.toLowerCase();
            const normTerm = termRaw ? this.normalizeStudentId(termRaw).toLowerCase() : '';
            const collegeFilter = document.getElementById('student-filter-college')?.value || '';
            const sourceFilter = document.getElementById('student-filter-source')?.value || '';
            const sourceFilterLower = sourceFilter.toLowerCase();

            const clearBtn = document.getElementById('btn-clear-student-filters');
            if (clearBtn) {
                if (termRaw || collegeFilter || sourceFilter) clearBtn.classList.remove('hidden');
                else clearBtn.classList.add('hidden');
            }

            this.filteredStudentsData = (this.allStudentsData || []).filter(s => {
                if (collegeFilter && (s.college || '') !== collegeFilter) return false;
                if (sourceFilterLower && !(s._sourceLower ?? String(s.source || '').toLowerCase()).includes(sourceFilterLower)) return false;
                if (term) {
                    if (!s._searchHaystack) this.indexStudentRecord(s);
                    const match = (normTerm && s._normSid === normTerm) || s._searchHaystack.includes(term);
                    if (!match) return false;
                }
                return true;
            });

            this.renderStudentsPage();

            if (!skipAutoProfile && term && this.filteredStudentsData.length === 1) {
                this.loadStudentProfile(this.filteredStudentsData[0].student_id);
            }
        } catch (err) {
            Toast.show('Error loading students: ' + err.message, 'error');
        }
    }

    updateStudentsStatsAndDropdowns() {
        const list = this.allStudentsData || [];
        const total = list.length;
        const collegesSet = new Set();
        let withMobile = 0;
        let withNatId = 0;
        let mergedCount = 0;

        list.forEach(s => {
            if (s.college && String(s.college).trim()) collegesSet.add(String(s.college).trim());
            if (s.mobile && String(s.mobile).trim()) withMobile++;
            if (s.national_id && String(s.national_id).trim()) withNatId++;
            if (s.source && String(s.source).includes(',')) mergedCount++;
        });

        const setStat = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setStat('students-stat-total', total.toLocaleString());
        setStat('students-stat-colleges', collegesSet.size.toLocaleString());
        setStat('students-stat-mobile', total > 0 ? `${withMobile.toLocaleString()} (${Math.round((withMobile / total) * 100)}%)` : '0');
        setStat('students-stat-nat-id', total > 0 ? `${withNatId.toLocaleString()} (${Math.round((withNatId / total) * 100)}%)` : '0');
        setStat('students-stat-merged', mergedCount.toLocaleString());

        const collegeSelect = document.getElementById('student-filter-college');
        const currentVal = collegeSelect ? collegeSelect.value : '';
        const sortedColleges = Array.from(collegesSet).sort((a, b) => a.localeCompare(b));
        if (collegeSelect) {
            collegeSelect.innerHTML = `<option value="">All Colleges (${sortedColleges.length})</option>` +
                sortedColleges.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
            collegeSelect.value = currentVal;
        }

        const datalist = document.getElementById('datalist-student-colleges');
        if (datalist) {
            datalist.innerHTML = sortedColleges.map(c => `<option value="${escapeHTML(c)}"></option>`).join('');
        }
    }

    renderStudentsPage() {
        const tbody = document.getElementById('students-table-body');
        const paginationEl = document.getElementById('students-pagination');
        if (!tbody) return;

        const data = this.filteredStudentsData || [];
        const total = data.length;
        const pageSize = this.studentsPageSize || 100;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (this.studentsCurrentPage > totalPages) this.studentsCurrentPage = totalPages;
        if (this.studentsCurrentPage < 1) this.studentsCurrentPage = 1;

        if (total === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            <i data-lucide="users" style="width:48px;height:48px;opacity:0.5;"></i>
                            <h3>No students found</h3>
                            <p>Try a different search term or filter.</p>
                        </div>
                    </td>
                </tr>`;
            if (paginationEl) paginationEl.innerHTML = '';
            renderIcons(tbody);
            return;
        }

        const startIdx = (this.studentsCurrentPage - 1) * pageSize;
        const pageItems = data.slice(startIdx, startIdx + pageSize);

        tbody.innerHTML = pageItems.map(s => {
            const levelBadge = this.renderStudentLevelBadge(getStudentProgramLevel(s));
            const { nuEmail, personalEmail } = getStudentDisplayEmails(s);
            const emailCellHtml = `
                <div class="student-emails-cell" style="display: flex; flex-direction: column; gap: 0.18rem;">
                    ${nuEmail
                        ? `<span class="copyable-email" style="color: var(--primary); font-weight: 500;" data-email="${escapeHTML(nuEmail)}" title="Click to copy NU email">${escapeHTML(nuEmail)}</span>`
                        : (personalEmail
                            ? `<span style="color: var(--text-muted); font-size: 0.78rem; font-style: italic;">No NU email</span>`
                            : `<span style="color: var(--text-muted);">—</span>`)
                    }
                    ${personalEmail
                        ? `<span class="copyable-email" style="color: var(--text-muted); font-size: 0.78rem;" data-email="${escapeHTML(personalEmail)}" title="Click to copy personal email"><span style="opacity: 0.7; margin-right: 0.25rem;">Personal:</span>${escapeHTML(personalEmail)}</span>`
                        : ''
                    }
                </div>
            `;
            return `
            <tr class="student-row" style="cursor: pointer;" data-sid="${escapeHTML(s.student_id)}">
                <td style="white-space: nowrap;">
                    <div style="display: inline-flex; align-items: center; gap: 0.45rem;">
                        <strong style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.92rem; color: var(--text-main);">${escapeHTML(s.student_id)}</strong>${levelBadge}
                        <button type="button" class="btn-icon copyable-student-id" data-copy-sid="${escapeHTML(s.student_id)}" title="Copy Student ID" style="padding: 2px; width: 22px; height: 22px; opacity: 0.7; border-radius: 4px;">
                            <i data-lucide="copy" style="width: 12px; height: 12px;"></i>
                        </button>
                    </div>
                </td>
                <td><strong>${escapeHTML(s.full_name)}</strong></td>
                <td>${emailCellHtml}</td>
                <td>${escapeHTML(s.mobile)}</td>
                <td>${escapeHTML(s.college)}</td>
                <td>${escapeHTML(s.program)}</td>
            </tr>
        `;
        }).join('');
        if (window.lucide) lucide.createIcons({ root: tbody });

        if (paginationEl) {
            paginationEl.innerHTML = `
                <div class="pagination-info" style="font-size: 0.85rem; color: var(--text-muted);">
                    Showing <strong>${(startIdx + 1).toLocaleString()}</strong>–<strong>${Math.min(startIdx + pageSize, total).toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> students
                </div>
                <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <button class="btn btn-secondary btn-sm" id="students-prev-page" ${this.studentsCurrentPage <= 1 ? 'disabled' : ''}>Previous</button>
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">Page <strong>${this.studentsCurrentPage}</strong> of <strong>${totalPages}</strong></span>
                    <button class="btn btn-secondary btn-sm" id="students-next-page" ${this.studentsCurrentPage >= totalPages ? 'disabled' : ''}>Next</button>
                    ${this.pageJump.renderHtml('students', totalPages)}
                </div>
            `;
            document.getElementById('students-prev-page')?.addEventListener('click', () => {
                if (this.studentsCurrentPage > 1) {
                    this.studentsCurrentPage--;
                    this.renderStudentsPage();
                }
            });
            document.getElementById('students-next-page')?.addEventListener('click', () => {
                if (this.studentsCurrentPage < totalPages) {
                    this.studentsCurrentPage++;
                    this.renderStudentsPage();
                }
            });
            this.pageJump.bind('students', totalPages, (target) => {
                this.studentsCurrentPage = target;
                this.renderStudentsPage();
            }, paginationEl);
        }
    }

    setupPrintButton() {
        const btnPrint = document.getElementById('btn-print-profile');
        if (btnPrint) {
            btnPrint.addEventListener('click', () => {
                if (!this.currentProfileSid) return;
                
                const profileContent = document.getElementById('inline-student-profile').cloneNode(true);
                ['.header', '#student-profile-header'].forEach(sel => {
                    const el = profileContent.querySelector(sel);
                    if (el) el.remove();
                });

                const st = this.currentProfileStudent || {};
                const { nuEmail, personalEmail } = getStudentDisplayEmails(st);
                let name = st.full_name || st.name || '-';
                let email = [nuEmail, personalEmail].filter(Boolean).join(' | ') || '-';
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
                            table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; font-size: 0.85rem; }
                            th, td { padding: 0.65rem; border: 1px solid #ddd; text-align: left; }
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
                }, 250);
            });
        }
    }

    async loadStudentProfile(sid) {
        this.currentProfileSid = sid;
        this.currentProfileTransactions = [];
        try {
            document.getElementById('student-directory-view')?.classList.add('hidden');
            const profileContainer = document.getElementById('inline-student-profile');
            if (profileContainer) {
                profileContainer.classList.remove('hidden');
            }
            if (window.lucide) lucide.createIcons();
            window.scrollTo({ top: 0, behavior: 'smooth' });

            document.getElementById('student-summary-body').innerHTML = '';
            document.getElementById('student-ledger-body').innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">Loading payment history...</td></tr>';

            const normSid = this.normalizeStudentId(sid);
            const paddedErpSid = /^\d+$/.test(normSid) && normSid.length < 9 ? normSid.padStart(9, '0') : null;
            const sidVariants = Array.from(new Set([
                String(sid).trim(),
                normSid,
                paddedErpSid
            ].filter(Boolean)));

            const profileTxCols = 'id, reference_number, payment_date, student_id, original_student_id, item_name, item_price, fawry_fees, net_amount, total_amount, check_column, mapping, second_mapping, bank, merchant_name, id_status, is_settled, settlement_batch, erp_batch_number';

            // Fetch student profile record (from cache or DB) + Fawry transactions + Foreign transactions in parallel
            const cachedSt = (this.allStudentsData || []).find(s => sidVariants.includes(String(s.student_id)));
            const foreignPromise = (async () => {
                try {
                    const fxClient = supabase.from('foreign_transactions');
                    if (fxClient && typeof fxClient.select === 'function') {
                        const res = await fxClient.select('*').in('student_id', sidVariants);
                        if (!res?.error && Array.isArray(res?.data)) return res.data;
                    }
                } catch (_e) { /* offline / unmigrated fallback */ }
                return [];
            })();
            const [st, fetchedTxs, fetchedForeign] = await Promise.all([
                cachedSt
                    ? Promise.resolve(cachedSt)
                    : supabase.from('student_master').select('*').in('student_id', sidVariants).limit(1).then(res => (res.data && res.data[0]) || null),
                fetchAll('transactions', profileTxCols, q => q.in('student_id', sidVariants), 'id'),
                foreignPromise
            ]);

            // Merge cloud & local Foreign Transactions matching this Student ID
            const fxByRef = new Map();
            (this.foreignTransactions || [])
                .map((r, i) => this.normalizeForeignTransactionRow(r, i))
                .filter(r => sidVariants.includes(String(r.student_id || '').trim()))
                .forEach(r => fxByRef.set(r.reference_number, r));
            (fetchedForeign || [])
                .map((r, i) => this.normalizeForeignTransactionRow(r, i))
                .filter(r => sidVariants.includes(String(r.student_id || '').trim()))
                .forEach(r => fxByRef.set(r.reference_number, r));
            const studentForeignTxs = [...fxByRef.values()].map(r => {
                const pDate = toDateOnly(r.value_date || r.payment_date || r.transaction_date);
                const usdAmt = Number(r.amount ?? r.item_price) || 0;
                const fx = convertUsdToEgp(usdAmt, pDate, this.fxStore);
                return {
                    ...r,
                    payment_date: pDate,
                    item_name: r.description || r.item_name || 'Cash Deposit',
                    item_price: fx.rate > 0 ? fx.egpAmount : usdAmt,
                    raw_usd: usdAmt,
                    currency: r.currency || 'USD',
                    is_settled: true
                };
            });

            this.currentProfileStudent = st;
            const txs = [...(fetchedTxs || []), ...studentForeignTxs].sort((a, b) => {
                const da = toDateOnly(a.payment_date) || '';
                const db = toDateOnly(b.payment_date) || '';
                if (da !== db) return db.localeCompare(da);
                return (b.id || 0) - (a.id || 0);
            });
            this.currentProfileTransactions = txs;

            let totalPaid = 0;
            let settledCount = 0;
            let erpPostedCount = 0;
            txs.forEach(t => {
                totalPaid += parseFloat(t.item_price || 0) || 0;
                if (t.is_settled) settledCount++;
                if (t.erp_batch_number && String(t.erp_batch_number).trim() !== '') erpPostedCount++;
            });
            const latestDate = txs.length > 0 ? (toDateOnly(txs[0].payment_date) || '-') : 'No payments';

            const headerEl = document.getElementById('student-profile-header');
            if (headerEl) {
                const name = st?.full_name || 'Student Record';
                const arabicName = st?.arabic_name || '';
                const college = st?.college || '';
                const program = st?.program || '';
                const { nuEmail: email, personalEmail } = getStudentDisplayEmails(st);
                const mobile = st?.mobile || '';
                const natId = st?.national_id || '';
                const guardianName = st?.guardian_name || '';
                const guardianMobile = st?.guardian_mobile || '';
                const src = st?.source || 'Master';

                const initials = name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map(w => w[0].toUpperCase())
                    .join('') || 'ST';

                const renderCopyableField = (val, label) => {
                    if (!val || val === '-') {
                        return `<span style="color: var(--text-muted); font-style: italic; font-size: 0.82rem;">Not provided</span>`;
                    }
                    return `
                        <button type="button" class="student-copy-chip" data-profile-copy="${escapeHTML(val)}" data-profile-copy-label="${escapeHTML(label)}" title="Click to copy ${escapeHTML(label)}">
                            <span style="font-weight: 600;">${escapeHTML(val)}</span>
                            <i data-lucide="copy" style="width: 12px; height: 12px; opacity: 0.75;"></i>
                        </button>
                    `;
                };

                headerEl.innerHTML = `
                    <div class="student-dossier-banner">
                        <div class="student-identity-main">
                            <div class="student-avatar-monogram">${escapeHTML(initials)}</div>
                            <div style="flex: 1; min-width: 220px;">
                                <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
                                    <h2 style="margin: 0; font-size: 1.4rem; font-weight: 700; color: var(--text-main); letter-spacing: -0.01em;">${escapeHTML(name)}</h2>
                                    ${this.renderStudentLevelBadge(st ? getStudentProgramLevel(st) : this.getStudentLevelBySid(sid))}
                                    <span class="badge" style="background: rgba(16,185,129,0.14); color: #10b981; font-size: 0.73rem; border: 1px solid rgba(16,185,129,0.28);">${escapeHTML(src)}</span>
                                </div>
                                ${arabicName ? `<div style="font-size: 0.96rem; color: var(--text-secondary); margin-top: 0.2rem; font-weight: 500;" dir="auto">${escapeHTML(arabicName)}</div>` : ''}

                                <!-- High-Visibility Copyable Student ID Bar -->
                                <div class="student-id-hero-bar">
                                    <button type="button" class="student-id-copy-pill" id="btn-copy-profile-sid" data-profile-copy="${escapeHTML(sid)}" data-profile-copy-label="Student ID" title="Click to copy Student ID (${escapeHTML(sid)})">
                                        <span class="sid-label">Student ID</span>
                                        <span class="sid-value">${escapeHTML(sid)}</span>
                                        <span class="sid-action" id="btn-copy-profile-sid-label">
                                            <i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy ID
                                        </span>
                                    </button>
                                    ${paddedErpSid && paddedErpSid !== String(sid).trim() ? `
                                        <button type="button" class="student-copy-chip" data-profile-copy="${escapeHTML(paddedErpSid)}" data-profile-copy-label="9-Digit ERP Account" title="Copy 9-digit zero-padded ERP Account number" style="padding: 0.35rem 0.65rem; font-family: monospace;">
                                            <span style="color: var(--text-muted); font-family: var(--font-family); font-size: 0.74rem;">ERP 9-Digit:</span>
                                            <strong>${escapeHTML(paddedErpSid)}</strong>
                                            <i data-lucide="copy" style="width: 12px; height: 12px; opacity: 0.75;"></i>
                                        </button>
                                    ` : ''}
                                    <button type="button" class="btn btn-outline btn-sm" id="btn-profile-view-in-tx" title="Filter Orders Transactions by this Student ID" style="padding: 0.35rem 0.65rem; font-size: 0.76rem; height: auto;">
                                        <i data-lucide="external-link" style="width: 12px; height: 12px;"></i> View in Transactions
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Right Financial KPI Strip -->
                        <div class="student-kpi-strip">
                            <div class="student-kpi-box" style="border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.06);">
                                <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Total Paid</div>
                                <div style="font-size: 1.4rem; font-weight: 800; color: #10b981; font-family: 'JetBrains Mono', ui-monospace, monospace; margin-top: 0.15rem;">${formatMoney(totalPaid)} <span style="font-size: 0.82rem; font-weight: 600;">EGP</span></div>
                                <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.15rem;">${txs.length} transaction(s)</div>
                            </div>
                            <div class="student-kpi-box">
                                <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Reconciliation</div>
                                <div style="font-size: 0.98rem; font-weight: 700; color: var(--text-main); margin-top: 0.22rem;">${settledCount} / ${txs.length} Settled</div>
                                <div style="font-size: 0.76rem; color: var(--primary); margin-top: 0.18rem;">${erpPostedCount} posted to ERP</div>
                            </div>
                            <div class="student-kpi-box">
                                <div style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Latest Payment</div>
                                <div style="font-size: 0.98rem; font-weight: 700; color: var(--text-main); margin-top: 0.22rem; font-family: monospace;">${escapeHTML(latestDate)}</div>
                                <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.18rem;">${txs.length > 0 ? `EGP ${formatMoney(txs[0].item_price || 0)}` : 'No activity'}</div>
                            </div>
                        </div>
                    </div>

                    <!-- 4-Tile Structured Dossier Metadata Grid -->
                    <div class="student-dossier-grid">
                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="graduation-cap" style="width: 14px; height: 14px; color: var(--primary);"></i> Academic Program
                            </div>
                            <div style="font-size: 0.85rem;">
                                <span style="color: var(--text-muted);">College:</span>
                                <strong style="color: var(--text-main); margin-left: 0.25rem;">${escapeHTML(college || '-')}</strong>
                            </div>
                            <div style="font-size: 0.83rem;">
                                <span style="color: var(--text-muted);">Program:</span>
                                <span style="color: var(--text-secondary); margin-left: 0.25rem;">${escapeHTML(program || '-')}</span>
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="phone" style="width: 14px; height: 14px; color: #10b981;"></i> Contact Details
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Mobile:</span>
                                ${renderCopyableField(mobile, 'Mobile Number')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">NU Email:</span>
                                ${renderCopyableField(email, 'NU Email')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Personal Email:</span>
                                ${renderCopyableField(personalEmail, 'Personal Email')}
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="id-card" style="width: 14px; height: 14px; color: #38bdf8;"></i> Identity &amp; National ID
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">National ID:</span>
                                ${renderCopyableField(natId, 'National ID')}
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.83rem;">
                                <span style="color: var(--text-muted);">ID Validation:</span>
                                <span class="badge ${validateID(paddedErpSid || sid) === 'Valid' ? 'valid' : 'error'}" style="font-size: 0.72rem;">${escapeHTML(validateID(paddedErpSid || sid))}</span>
                            </div>
                        </div>

                        <div class="student-dossier-tile">
                            <div class="student-dossier-tile-title">
                                <i data-lucide="users" style="width: 14px; height: 14px; color: #a855f7;"></i> Guardian Info
                            </div>
                            <div style="font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Name:</span>
                                <strong style="color: var(--text-main); margin-left: 0.25rem;">${escapeHTML(guardianName || '-')}</strong>
                            </div>
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.84rem;">
                                <span style="color: var(--text-muted);">Phone:</span>
                                ${renderCopyableField(guardianMobile, 'Guardian Mobile')}
                            </div>
                        </div>
                    </div>
                `;

                // Wire up all copyable chips & main Student ID pill inside the dossier header
                headerEl.querySelectorAll('[data-profile-copy]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const val = btn.getAttribute('data-profile-copy');
                        const label = btn.getAttribute('data-profile-copy-label') || 'Value';
                        if (!val) return;
                        try {
                            await navigator.clipboard.writeText(val);
                            Toast.show(`${label} "${val}" copied to clipboard!`, 'success');
                            if (btn.id === 'btn-copy-profile-sid') {
                                btn.classList.add('copied');
                                const actionEl = document.getElementById('btn-copy-profile-sid-label');
                                if (actionEl) actionEl.innerHTML = '✓ Copied!';
                                setTimeout(() => {
                                    btn.classList.remove('copied');
                                    if (actionEl) {
                                        actionEl.innerHTML = '<i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy ID';
                                        if (window.lucide) lucide.createIcons({ root: actionEl });
                                    }
                                }, 1600);
                            }
                        } catch (err) {
                            Toast.show(`Failed to copy ${label}`, 'error');
                        }
                    });
                });

                // Wire up "View in Transactions" shortcut
                document.getElementById('btn-profile-view-in-tx')?.addEventListener('click', () => {
                    const txNav = document.querySelector('.nav-link[data-tab="transactions"]');
                    const searchEl = document.getElementById('search-input');
                    if (searchEl) searchEl.value = String(sid).trim();
                    if (txNav) txNav.click();
                    this.currentPage = 1;
                    this.renderFilterChips('transactions');
                    this.loadTransactions();
                });

                if (window.lucide) lucide.createIcons({ root: headerEl });
            }

            if (!txs || txs.length === 0) {
                document.getElementById('student-ledger-body').innerHTML = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
                            <div style="display: flex; flex-direction: column; align-items: center; gap: 0.45rem;">
                                <i data-lucide="inbox" style="width: 32px; height: 32px; opacity: 0.45;"></i>
                                <div style="font-weight: 600; color: var(--text-secondary);">No payments recorded for Student ID ${escapeHTML(sid)}</div>
                                <div style="font-size: 0.8rem;">Payments matching ${escapeHTML(sidVariants.join(' or '))} will appear here automatically.</div>
                            </div>
                        </td>
                    </tr>`;
                document.getElementById('student-summary-body').innerHTML = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.85rem;">
                            No payment categories yet
                        </td>
                    </tr>`;
                if (window.lucide) lucide.createIcons({ root: document.getElementById('student-ledger-body') });
                return;
            }

            const ledgerBody = document.getElementById('student-ledger-body');
            ledgerBody.innerHTML = txs.map((t, idx) => {
                const bankName = t.bank || t.bank_Style || '-';
                const refNum = t.reference_number || '-';
                return `
                <tr>
                    <td style="white-space: nowrap; font-family: monospace; font-size: 0.83rem;">${escapeHTML(toDateOnly(t.payment_date) || '-')}</td>
                    <td style="white-space: nowrap;">
                        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                            <a href="#" class="student-ledger-ref-link" data-idx="${idx}" style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 700; color: var(--primary); text-decoration: none;" title="Click to inspect transaction details">
                                ${escapeHTML(refNum)}
                            </a>
                            ${t.reference_number ? `
                            <button type="button" class="btn-icon student-ledger-copy-ref" data-ref="${escapeHTML(t.reference_number)}" title="Copy Reference Number" style="padding: 2px; width: 20px; height: 20px; opacity: 0.65;">
                                <i data-lucide="copy" style="width: 11px; height: 11px;"></i>
                            </button>` : ''}
                        </div>
                    </td>
                    <td style="max-width: 240px; white-space: normal; font-size: 0.84rem;">${escapeHTML(t.item_name || '-')}</td>
                    <td><span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); font-size: 0.74rem;">${escapeHTML(t.mapping || 'Unmapped')}</span></td>
                    <td style="font-size: 0.82rem; color: var(--text-secondary);">${escapeHTML(t.second_mapping || '-')}</td>
                    <td style="font-size: 0.82rem;">${escapeHTML(bankName)}</td>
                    <td style="text-align: right; font-weight: 700; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">${isSameDaySettlementBank(t) ? `USD ${formatMoney(t.raw_usd ?? t.amount ?? 0)} <span style="font-size: 0.72rem; color: var(--text-muted);">(≈ EGP ${formatMoney(t.item_price || 0)})</span>` : formatMoney(t.item_price || 0)}</td>
                </tr>
            `;
            }).join('');

            ledgerBody.querySelectorAll('.student-ledger-ref-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const idx = parseInt(link.getAttribute('data-idx'), 10);
                    const tx = this.currentProfileTransactions[idx];
                    if (tx && typeof this.openTransactionDetailsModal === 'function') {
                        this.openTransactionDetailsModal(tx);
                    }
                });
            });

            ledgerBody.querySelectorAll('.student-ledger-copy-ref').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ref = btn.getAttribute('data-ref');
                    if (!ref) return;
                    try {
                        await navigator.clipboard.writeText(ref);
                        Toast.show(`Reference "${ref}" copied!`, 'success');
                    } catch (err) {
                        Toast.show('Failed to copy reference', 'error');
                    }
                });
            });
            if (window.lucide) lucide.createIcons({ root: ledgerBody });

            // Calculate Summary Grouped by Mapping (sorted highest amount first)
            const summary = {};
            let total = 0;
            txs.forEach(t => {
                const mapKey = t.mapping || 'Unmapped';
                const amt = parseFloat(t.item_price || 0) || 0;
                if (!summary[mapKey]) summary[mapKey] = { count: 0, amount: 0 };
                summary[mapKey].count += 1;
                summary[mapKey].amount += amt;
                total += amt;
            });

            const sortedCategories = Object.keys(summary).sort((a, b) => summary[b].amount - summary[a].amount);
            const summaryHtml = sortedCategories.map(k => {
                const pct = total > 0 ? Math.min(100, Math.round((summary[k].amount / total) * 100)) : 0;
                return `
                <tr>
                    <td>
                        <div style="font-weight: 600; color: var(--text-main);">${escapeHTML(k)}</div>
                        <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.06); border-radius: 999px; margin-top: 4px; overflow: hidden;">
                            <div style="width: ${pct}%; height: 100%; background: var(--primary); border-radius: 999px;"></div>
                        </div>
                    </td>
                    <td style="text-align: center; font-weight: 600;">${summary[k].count}</td>
                    <td style="text-align: right; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">
                        ${formatMoney(summary[k].amount)}
                        <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 400;">${pct}%</div>
                    </td>
                </tr>
            `;
            }).join('');
            
            document.getElementById('student-summary-body').innerHTML = summaryHtml + `
                <tr style="background-color: var(--bg-secondary);">
                    <td><strong>Grand Total</strong></td>
                    <td style="text-align: center;"><strong>${txs.length}</strong></td>
                    <td style="text-align: right; font-size: 1rem; font-weight: 800; color: #10b981; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;">${formatMoney(total)} EGP</td>
                </tr>
            `;

        } catch (err) {
            Toast.show('Error loading profile: ' + err.message, 'error');
            document.getElementById('inline-student-profile')?.classList.add('hidden');
            document.getElementById('student-directory-view')?.classList.remove('hidden');
        }
    }

    exportStudentStatement() {
        if (!this.currentProfileSid) {
            Toast.show('Select a student first to export their statement.', 'warning');
            return;
        }
        const st = this.currentProfileStudent || {};
        const txs = this.currentProfileTransactions || [];
        const sid = this.currentProfileSid;
        const studentLevelTag = formatStudentLevelTag(st.student_id || st.program !== undefined ? getStudentProgramLevel(st) : this.getStudentLevelBySid(sid));

        const ledgerRows = txs.map(t => ({
            'Payment Date': toDateOnly(t.payment_date) || '',
            'Reference Number': t.reference_number || '',
            'Student ID': t.student_id || sid,
            'Level': studentLevelTag || formatStudentLevelTag(this.getTransactionStudentLevel(t)),
            'Student Name': t.full_name || st.full_name || '',
            'Item Name': t.item_name || '',
            'Mapping': t.mapping || 'Unmapped',
            '2nd Mapping': t.second_mapping || '',
            'Bank': t.bank || t.bank_Style || '',
            'Amount (EGP)': Number(parseFloat(t.item_price || 0).toFixed(2))
        }));

        const summaryMap = {};
        let grandTotal = 0;
        txs.forEach(t => {
            const k = t.mapping || 'Unmapped';
            const amt = parseFloat(t.item_price || 0) || 0;
            if (!summaryMap[k]) summaryMap[k] = { count: 0, total: 0 };
            summaryMap[k].count++;
            summaryMap[k].total += amt;
            grandTotal += amt;
        });

        const summaryRows = Object.keys(summaryMap).sort().map(k => ({
            'Mapping Category': k,
            'Transactions': summaryMap[k].count,
            'Total Amount (EGP)': Number(summaryMap[k].total.toFixed(2))
        }));
        summaryRows.push({
            'Mapping Category': 'Grand Total',
            'Transactions': txs.length,
            'Total Amount (EGP)': Number(grandTotal.toFixed(2))
        });

        const { nuEmail, personalEmail } = getStudentDisplayEmails(st);
        const profileRows = [
            { 'Field': 'Student ID', 'Value': sid },
            { 'Field': 'Level', 'Value': studentLevelTag || '-' },
            { 'Field': 'Full Name', 'Value': st.full_name || '-' },
            { 'Field': 'Arabic Name', 'Value': st.arabic_name || '-' },
            { 'Field': 'College', 'Value': st.college || '-' },
            { 'Field': 'Program', 'Value': st.program || '-' },
            { 'Field': 'NU Email', 'Value': nuEmail || '-' },
            { 'Field': 'Personal Email', 'Value': personalEmail || '-' },
            { 'Field': 'Mobile', 'Value': st.mobile || '-' },
            { 'Field': 'National ID', 'Value': st.national_id || '-' },
            { 'Field': 'Total Transactions', 'Value': txs.length },
            { 'Field': 'Total Paid (EGP)', 'Value': Number(grandTotal.toFixed(2)) },
            { 'Field': 'Statement Generated On', 'Value': new Date().toLocaleString() }
        ];

        const wb = XLSX.utils.book_new();
        const safeLedger = sanitizeExcelRows(ledgerRows);
        const wsLedger = XLSX.utils.json_to_sheet(safeLedger.length ? safeLedger : [{ 'Note': 'No payments recorded for this student' }]);
        wsLedger['!cols'] = [
            { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 26 },
            { wch: 32 }, { wch: 22 }, { wch: 20 }, { wch: 16 },
            { wch: 16 }
        ];
        const wsSummary = XLSX.utils.json_to_sheet(sanitizeExcelRows(summaryRows));
        wsSummary['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 20 }];
        const wsProfile = XLSX.utils.json_to_sheet(sanitizeExcelRows(profileRows));
        wsProfile['!cols'] = [{ wch: 24 }, { wch: 36 }];

        XLSX.utils.book_append_sheet(wb, wsLedger, 'Statement of Payments');
        XLSX.utils.book_append_sheet(wb, wsSummary, 'Category Summary');
        XLSX.utils.book_append_sheet(wb, wsProfile, 'Student Profile');
        writeCompressedExcel(wb, `Student_Statement_${sid}_${toDateOnly(new Date())}.xlsx`);
        Toast.show(`Exported statement for ${sid}`, 'success');
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

    updateSidebarBadges() {
        clearTimeout(this._badgeUpdateTimer);
        this._badgeUpdateTimer = setTimeout(async () => {
            const badge = document.getElementById('sidebar-automatch-badge');
            if (!badge) return;
            try {
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
                    const count = Math.max(0, totalRes.count - exemptCnt);
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
    // Users, Roles & Audit Log (Admin Only)
    // ==========================================

    // =========================================================================
    // FOREIGN TRANSACTIONS (Smart Bank Statement Student Deposit Extractor)
    // =========================================================================

    getFixesByRefMap() {
        const fixes = this.allFixesData;
        if (!Array.isArray(fixes) || fixes.length === 0) return null;
        if (this._fixesByRefCache && this._fixesByRefCacheSource === fixes && this._fixesByRefCacheLen === fixes.length) {
            return this._fixesByRefCache;
        }
        const map = new Map();
        for (const f of fixes) {
            const k = String(f?.reference_number || '').trim().toLowerCase();
            if (k && !map.has(k)) map.set(k, f);
        }
        this._fixesByRefCache = map;
        this._fixesByRefCacheSource = fixes;
        this._fixesByRefCacheLen = fixes.length;
        return map;
    }

    normalizeForeignTransactionRow(r, idx = 0) {
        if (!r) return r;
        const amount = Number(r.amount ?? r.item_price) || 0;
        const effectiveDate = r.value_date || r.payment_date || r.transaction_date || '';
        const ref = r.reference_number || r.external_ref || r.transaction_ref || '';
        let desc = String(r.description ?? r.item_name ?? '');
        if (/[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(desc)) desc = desc.normalize('NFKC');
        let studentId = r.student_id || '';
        const origStudentId = String(studentId).trim();
        let matchedName = String(r.matched_student_name || '');
        if (/[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(matchedName)) matchedName = matchedName.normalize('NFKC');
        let matchSource = r.match_source || (studentId ? 'statement_id' : 'unmatched');
        let mapping = r.mapping || DEFAULT_FOREIGN_MAPPING;
        let secondMapping = r.second_mapping || '';
        let studentIdOverridden = false;

        // Check Manual Fixes table (this.allFixesData) in O(1) via cached Map
        const fixesMap = this.getFixesByRefMap();
        if (fixesMap) {
            const refLower = String(ref || '').trim().toLowerCase();
            const txRefLower = String(r.transaction_ref || '').trim().toLowerCase();
            const fix = (refLower ? fixesMap.get(refLower) : null) || (txRefLower ? fixesMap.get(txRefLower) : null);
            if (fix) {
                if (fix.correct_id && String(fix.correct_id).trim()) {
                    const nextId = String(fix.correct_id).trim();
                    if (nextId !== origStudentId) studentIdOverridden = true;
                    studentId = nextId;
                    matchSource = 'manual';
                }
                if (fix.item_name && String(fix.item_name).trim()) {
                    desc = String(fix.item_name).trim();
                }
                if (fix.mapping && String(fix.mapping).trim()) {
                    mapping = String(fix.mapping).trim();
                }
                if (fix.second_mapping && String(fix.second_mapping).trim()) {
                    secondMapping = String(fix.second_mapping).trim();
                }
            }
        }

        const storedLevel = typeof r.student_level === 'string' ? r.student_level.trim().toUpperCase() : '';
        const hasPersistedLevelProp = Object.prototype.hasOwnProperty.call(r, 'student_level');
        const resolvedLevel = studentIdOverridden
            ? (this.getStudentLevelBySid(studentId) || undefined)
            : ((storedLevel === 'UG' || storedLevel === 'PG')
                ? storedLevel
                : (this.getStudentLevelBySid(studentId) || (hasPersistedLevelProp ? null : undefined)));

        const idStatus = studentId ? validateID(studentId) : 'Missing ID';
        const out = {
            ...r,
            _uid: r._uid || `${ref}_${effectiveDate}_${amount}_${idx}`,
            reference_number: ref,
            value_date: effectiveDate,
            payment_date: effectiveDate,
            student_id: studentId,
            matched_student_name: matchedName,
            amount,
            item_price: amount,
            description: desc,
            item_name: desc,
            mapping,
            second_mapping: secondMapping,
            bank: DEFAULT_FOREIGN_BANK,
            id_status: idStatus,
            match_source: matchSource,
            check_column: r.check_column || `${ref}-${String(desc).trim()}`
        };
        if (resolvedLevel !== undefined) {
            out.student_level = resolvedLevel;
        } else if (studentIdOverridden) {
            delete out.student_level;
        }
        return out;
    }

    toForeignDbRow(r) {
        const norm = this.normalizeForeignTransactionRow(r);
        if (!norm || !norm.reference_number) return null;
        return {
            reference_number: String(norm.reference_number).trim(),
            transaction_ref: norm.transaction_ref ? String(norm.transaction_ref).trim() : null,
            transaction_code: norm.transaction_code ? String(norm.transaction_code).trim() : 'CHF',
            event: norm.event ? String(norm.event).trim() : 'INIT',
            value_date: toDateOnly(norm.value_date || norm.payment_date || norm.transaction_date) || null,
            transaction_date: toDateOnly(norm.transaction_date || norm.value_date || norm.payment_date) || null,
            transaction_datetime: norm.transaction_datetime ? String(norm.transaction_datetime).trim() : null,
            amount: Number(norm.amount ?? norm.item_price) || 0,
            currency: norm.currency ? String(norm.currency).trim() : 'USD',
            account_number: norm.account_number ? String(norm.account_number).trim() : null,
            student_id: norm.student_id ? String(norm.student_id).trim() : null,
            student_level: this.getTransactionStudentLevel(norm) || null,
            extracted_name: norm.extracted_name || null,
            matched_student_name: norm.matched_student_name || null,
            handler_name: norm.handler_name || null,
            deposit_method: norm.deposit_method || 'Cash Deposit',
            description: norm.description || null,
            id_status: norm.id_status || null,
            match_source: norm.match_source || 'unmatched'
            // erp_batch_number / erp_voucher are deliberately NOT synced from here: they are written
            // only by recordErpReferences and the ERP unlink action. Including them made every
            // re-import / re-sync upsert overwrite a posted batch with NULL (double-posting risk).
        };
    }

    async syncForeignTransactionsToSupabase({ silent = false, rows = null } = {}) {
        const sourceRows = Array.isArray(rows) ? rows : (this.foreignTransactions || []);
        if (sourceRows.length === 0) {
            if (!silent) Toast.show('No BM transactions available to sync.', 'warning');
            return { synced: 0, error: null };
        }

        const deduped = new Map();
        sourceRows.forEach(r => {
            const dbRow = this.toForeignDbRow(r);
            if (dbRow && dbRow.reference_number) {
                deduped.set(dbRow.reference_number, dbRow);
            }
        });
        const dbRows = [...deduped.values()];
        if (dbRows.length === 0) {
            if (!silent) Toast.show('No valid reference numbers found to sync.', 'warning');
            return { synced: 0, error: null };
        }

        try {
            const tableClient = supabase.from('foreign_transactions');
            if (!tableClient || typeof tableClient.upsert !== 'function') {
                return { synced: 0, error: null };
            }
            const chunkSize = 200;
            for (let i = 0; i < dbRows.length; i += chunkSize) {
                const batch = dbRows.slice(i, i + chunkSize);
                const { error } = await tableClient.upsert(batch, { onConflict: 'reference_number' });
                if (error) {
                    if (!silent) Toast.show(`Supabase sync failed: ${error.message}`, 'error');
                    return { synced: 0, error };
                }
            }
            if (!silent) {
                Toast.show(`Synced ${dbRows.length} foreign transaction(s) to Supabase`, 'success');
            }
            return { synced: dbRows.length, error: null };
        } catch (err) {
            if (!silent) Toast.show(`Supabase sync failed: ${err.message}`, 'error');
            return { synced: 0, error: err };
        }
    }

    async applyManualFixesToForeignTransactions(fixesList) {
        const fixes = Array.isArray(fixesList) ? fixesList : (this.allFixesData || []);
        if (!fixes.length || !Array.isArray(this.foreignTransactions) || this.foreignTransactions.length === 0) {
            return 0;
        }
        const fixByRef = new Map();
        for (const f of fixes) {
            const k = String(f.reference_number || '').trim().toLowerCase();
            if (k) fixByRef.set(k, f);
        }

        let updatedCount = 0;
        const updatedRowsForDb = [];
        this.foreignTransactions = this.foreignTransactions.map((row, idx) => {
            const refKey = String(row.reference_number || '').trim().toLowerCase();
            const txRefKey = String(row.transaction_ref || '').trim().toLowerCase();
            const fix = fixByRef.get(refKey) || (txRefKey ? fixByRef.get(txRefKey) : null);
            if (!fix) return row;

            const next = { ...row };
            let changed = false;
            if (fix.correct_id && String(fix.correct_id).trim() && String(fix.correct_id).trim() !== String(row.student_id || '').trim()) {
                next.student_id = String(fix.correct_id).trim();
                next.id_status = validateID(next.student_id);
                next.match_source = 'manual';
                changed = true;
            }
            if (fix.item_name && String(fix.item_name).trim() && String(fix.item_name).trim() !== String(row.description || '').trim()) {
                next.description = String(fix.item_name).trim();
                next.item_name = next.description;
                changed = true;
            }
            if (fix.mapping && String(fix.mapping).trim() && String(fix.mapping).trim() !== String(row.mapping || '').trim()) {
                next.mapping = String(fix.mapping).trim();
                changed = true;
            }
            if (fix.second_mapping && String(fix.second_mapping).trim() && String(fix.second_mapping).trim() !== String(row.second_mapping || '').trim()) {
                next.second_mapping = String(fix.second_mapping).trim();
                changed = true;
            }

            if (changed) {
                updatedCount++;
                updatedRowsForDb.push(next);
            }
            return this.normalizeForeignTransactionRow(next, idx);
        });

        if (updatedCount > 0) {
            this.persistForeignTransactionsLocal();
            this.applyForeignFilters();
            this.invalidateTabs('dashboard', 'erp-export');
            try {
                await runConcurrent(
                    updatedRowsForDb.map(r => () => supabase.from('foreign_transactions').update({
                        student_id: r.student_id,
                        description: r.description,
                        id_status: r.id_status,
                        match_source: r.match_source
                    }).eq('reference_number', r.reference_number)),
                    6
                );
            } catch (_e) {
                // ignore if table not migrated yet
            }
        }
        return updatedCount;
    }

    initForeignTransactions() {
        this.foreignTransactions = [];
        this.filteredForeignTransactions = [];
        this.foreignPage = 1;
        this.foreignPageSize = 50;
        this.foreignSortCol = 'value_date';
        this.foreignSortAsc = false;
        this.foreignQuickFilter = 'all';
        this.pendingForeignExtraction = null;
        this.foreignPreviewTab = 'deposits';
        this.foreignStorageKey = 'fawry_app_foreign_transactions_v1';

        try {
            const cached = localStorage.getItem(this.foreignStorageKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed)) {
                    this.foreignTransactions = parsed.map((r, i) => this.normalizeForeignTransactionRow(r, i));
                }
            }
        } catch (_e) {
            // ignore storage errors
        }

        // Open Statement Import Modal
        document.getElementById('btn-show-foreign-import')?.addEventListener('click', () => {
            if (!this.requireRole('operator', 'import bank statements')) return;
            document.getElementById('modal-foreign-import')?.classList.remove('hidden');
            if (window.lucide) lucide.createIcons({ root: document.getElementById('modal-foreign-import') });
        });

        // Drag & Drop + File Input for PDF / Excel / CSV Statements
        const dropZone = document.getElementById('foreign-drop-zone');
        const fileInput = document.getElementById('foreign-file-input');
        if (dropZone && fileInput) {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });
            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                if (e.dataTransfer?.files?.length) {
                    this.handleForeignStatementFiles(Array.from(e.dataTransfer.files));
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files?.length) {
                    this.handleForeignStatementFiles(Array.from(e.target.files));
                    e.target.value = '';
                }
            });
        }

        // Preview Tab Toggle inside Import Modal
        const btnTabDeposits = document.getElementById('btn-foreign-preview-tab-deposits');
        const btnTabExcluded = document.getElementById('btn-foreign-preview-tab-excluded');
        btnTabDeposits?.addEventListener('click', () => {
            this.foreignPreviewTab = 'deposits';
            btnTabDeposits.className = 'btn btn-primary btn-sm';
            if (btnTabExcluded) btnTabExcluded.className = 'btn btn-outline btn-sm';
            this.renderForeignImportPreview();
        });
        btnTabExcluded?.addEventListener('click', () => {
            this.foreignPreviewTab = 'excluded';
            btnTabExcluded.className = 'btn btn-primary btn-sm';
            if (btnTabDeposits) btnTabDeposits.className = 'btn btn-outline btn-sm';
            this.renderForeignImportPreview();
        });

        // Confirm Save Extracted Deposits
        document.getElementById('btn-confirm-foreign-import')?.addEventListener('click', () => {
            this.savePendingForeignDeposits();
        });

        // Filters & Search
        document.getElementById('btn-foreign-apply-filters')?.addEventListener('click', () => {
            this.foreignPage = 1;
            this.applyForeignFilters();
        });
        document.getElementById('btn-foreign-clear-filters')?.addEventListener('click', () => {
            const df = document.getElementById('foreign-date-from');
            const dt = document.getElementById('foreign-date-to');
            const si = document.getElementById('foreign-search-input');
            if (df) df.value = '';
            if (dt) dt.value = '';
            if (si) si.value = '';
            this.foreignQuickFilter = 'all';
            document.querySelectorAll('[data-foreign-quick-filter]').forEach(btn => {
                const isAll = btn.getAttribute('data-foreign-quick-filter') === 'all';
                btn.className = isAll ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
            });
            this.foreignPage = 1;
            this.applyForeignFilters();
        });
        document.getElementById('foreign-search-input')?.addEventListener('input', () => {
            this.foreignPage = 1;
            this.applyForeignFilters();
        });
        document.getElementById('foreign-date-from')?.addEventListener('change', () => {
            this.foreignPage = 1;
            this.applyForeignFilters();
        });
        document.getElementById('foreign-date-to')?.addEventListener('change', () => {
            this.foreignPage = 1;
            this.applyForeignFilters();
        });

        // Date Presets
        document.querySelectorAll('[data-foreign-date-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-foreign-date-preset');
                const df = document.getElementById('foreign-date-from');
                const dt = document.getElementById('foreign-date-to');
                if (!df || !dt) return;
                if (preset === 'all') {
                    df.value = '';
                    dt.value = '';
                } else {
                    const today = new Date();
                    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    let start = new Date(today);
                    let end = new Date(today);
                    if (preset === '7d') start.setDate(today.getDate() - 6);
                    else if (preset === 'this_month') {
                        start = new Date(today.getFullYear(), today.getMonth(), 1);
                        end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    } else if (preset === 'last_month') {
                        start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                        end = new Date(today.getFullYear(), today.getMonth(), 0);
                    }
                    df.value = fmt(start);
                    dt.value = fmt(end);
                }
                this.foreignPage = 1;
                this.applyForeignFilters();
            });
        });

        // Quick Filter Pills
        document.querySelectorAll('[data-foreign-quick-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.foreignQuickFilter = btn.getAttribute('data-foreign-quick-filter') || 'all';
                document.querySelectorAll('[data-foreign-quick-filter]').forEach(b => {
                    const active = b.getAttribute('data-foreign-quick-filter') === this.foreignQuickFilter;
                    b.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
                });
                this.foreignPage = 1;
                this.applyForeignFilters();
            });
        });

        // Column Sorting
        document.querySelectorAll('.foreign-sort-trigger').forEach(trigger => {
            trigger.addEventListener('click', () => {
                const col = trigger.getAttribute('data-sort-col');
                if (!col) return;
                if (this.foreignSortCol === col) {
                    this.foreignSortAsc = !this.foreignSortAsc;
                } else {
                    this.foreignSortCol = col;
                    this.foreignSortAsc = col === 'student_id' || col === 'extracted_name';
                }
                document.querySelectorAll('.foreign-sort-trigger .sort-indicator').forEach(ind => { ind.textContent = ''; });
                const ind = trigger.querySelector('.sort-indicator');
                if (ind) ind.textContent = this.foreignSortAsc ? '▲' : '▼';
                this.applyForeignFilters();
            });
        });

        // Pagination
        document.getElementById('foreign-page-size')?.addEventListener('change', (e) => {
            this.foreignPageSize = parseInt(e.target.value, 10) || 50;
            this.foreignPage = 1;
            this.renderForeignTransactionsTable();
        });
        document.getElementById('foreign-btn-prev')?.addEventListener('click', () => {
            if (this.foreignPage > 1) {
                this.foreignPage--;
                this.renderForeignTransactionsTable();
            }
        });
        document.getElementById('foreign-btn-next')?.addEventListener('click', () => {
            const totalPages = Math.max(1, Math.ceil(this.filteredForeignTransactions.length / this.foreignPageSize));
            if (this.foreignPage < totalPages) {
                this.foreignPage++;
                this.renderForeignTransactionsTable();
            }
        });
        this.pageJump.bind('foreign', () => Math.max(1, Math.ceil(this.filteredForeignTransactions.length / this.foreignPageSize)), (target) => {
            this.foreignPage = target;
            this.renderForeignTransactionsTable();
        });

        // Action Buttons: Detect Duplicates, Double Payments, Auto-Match Names, Export ERP, Copy Email, Export Excel
        document.getElementById('btn-foreign-detect-duplicates')?.addEventListener('click', () => {
            this.detectForeignDuplicates();
        });
        document.getElementById('btn-foreign-double-payments')?.addEventListener('click', () => {
            this.openForeignDoublePaymentsModal();
        });
        document.getElementById('btn-foreign-automatch')?.addEventListener('click', () => {
            this.runForeignAutoMatchNames();
        });
        document.getElementById('btn-foreign-export-excel')?.addEventListener('click', () => {
            this.exportForeignTransactionsExcel();
        });

        // Student Directory Live Search inside #modal-foreign-fix
        const searchInput = document.getElementById('foreign-fix-student-search');
        const resultsBox = document.getElementById('foreign-fix-search-results');
        if (searchInput && resultsBox) {
            searchInput.addEventListener('input', () => {
                const q = normalizePersonName(searchInput.value);
                if (!q || q.length < 2) {
                    resultsBox.style.display = 'none';
                    resultsBox.innerHTML = '';
                    return;
                }
                const students = this.allStudents || [];
                const matches = students.filter(s => {
                    const idStr = String(s.student_id || '').toLowerCase();
                    const en = normalizePersonName(s.full_name || '');
                    const ar = normalizePersonName(s.arabic_name || '');
                    const g = normalizePersonName(s.guardian_name || '');
                    return idStr.includes(q) || en.includes(q) || ar.includes(q) || g.includes(q);
                }).slice(0, 12);

                if (matches.length === 0) {
                    resultsBox.style.display = 'block';
                    resultsBox.innerHTML = `<div style="padding: 0.6rem 0.8rem; color: var(--text-muted); font-size: 0.8rem;">No matching students in directory</div>`;
                    return;
                }
                resultsBox.style.display = 'block';
                resultsBox.innerHTML = matches.map((s, idx) => `
                    <div class="foreign-student-pick-item" data-idx="${idx}" style="padding: 0.55rem 0.8rem; border-bottom: 1px solid rgba(148,163,184,0.12); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
                        <div>
                            <div style="font-weight: 600; font-size: 0.84rem; color: var(--text-main);">${escapeHTML(s.full_name || s.arabic_name || '')}</div>
                            ${s.arabic_name ? `<div style="font-size: 0.78rem; color: #38bdf8;">${escapeHTML(s.arabic_name)}</div>` : ''}
                        </div>
                        <span class="badge" style="font-family: monospace; font-weight: 700; background: rgba(16,185,129,0.15); color: #10b981;">${escapeHTML(s.student_id)}</span>
                    </div>
                `).join('');

                resultsBox.querySelectorAll('.foreign-student-pick-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const s = matches[parseInt(el.getAttribute('data-idx'), 10)];
                        if (!s) return;
                        const idInput = document.getElementById('foreign-fix-student-id');
                        const nameInput = document.getElementById('foreign-fix-student-name');
                        if (idInput) idInput.value = s.student_id || '';
                        if (nameInput) nameInput.value = s.full_name || s.arabic_name || '';
                        resultsBox.style.display = 'none';
                    });
                });
            });
        }

        document.getElementById('btn-save-foreign-fix')?.addEventListener('click', () => {
            this.saveForeignTransactionFix();
        });
    }

    persistForeignTransactionsLocal() {
        try {
            localStorage.setItem(this.foreignStorageKey, JSON.stringify(this.foreignTransactions || []));
        } catch (_e) {
            // ignore quota errors
        }
    }

    async ensureStudentsLoadedForForeign() {
        if (Array.isArray(this.allStudents) && this.allStudents.length > 0) {
            this.syncStudentMasterMapFromCache();
            return this.allStudents;
        }
        if (Array.isArray(this.allStudentsData) && this.allStudentsData.length > 0) {
            this.allStudents = this.allStudentsData;
            this.syncStudentMasterMapFromCache();
            return this.allStudents;
        }
        await this.ensureStudentLevelMap();
        return this.allStudents || [];
    }

    async loadForeignTransactions() {
        const requestId = (this._fxLoadRequestId = (this._fxLoadRequestId || 0) + 1);
        const tbody = document.getElementById('foreign-transactions-body');

        // Render cached local rows immediately (0ms) or show a loading skeleton while fetching
        if (Array.isArray(this.foreignTransactions) && this.foreignTransactions.length > 0) {
            this.applyForeignFilters();
        } else if (tbody) {
            tbody.innerHTML = Array(5).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(9) + '</tr>').join('');
        }

        try {
            const data = await fetchAll('foreign_transactions', '*', null, 'id');
            if (requestId !== this._fxLoadRequestId) return;

            if (Array.isArray(data)) {
                const cloudRefs = new Set(data.map(r => r.reference_number).filter(Boolean));
                const unsyncedLocal = (this.foreignTransactions || []).filter(r => r.reference_number && !cloudRefs.has(r.reference_number));

                const byRef = new Map();
                (this.foreignTransactions || []).forEach(r => byRef.set(r.reference_number, r));
                data.forEach(r => byRef.set(r.reference_number, r));
                this.foreignTransactions = [...byRef.values()].map((r, i) => this.normalizeForeignTransactionRow(r, i));

                // Resolve student_level only for rows missing a persisted DB student_level
                const legacyForeignRows = this.foreignTransactions.filter(
                    r => r && !Object.prototype.hasOwnProperty.call(r, 'student_level')
                );
                if (legacyForeignRows.length > 0) {
                    await this.ensureStudentLevelsForRows(legacyForeignRows);
                    if (requestId !== this._fxLoadRequestId) return;
                }

                this.persistForeignTransactionsLocal();

                if (unsyncedLocal.length > 0 && this.hasRole('operator')) {
                    this.syncForeignTransactionsToSupabase({ silent: true, rows: unsyncedLocal })
                        .then(res => {
                            if (res?.synced > 0) {
                                Toast.show(`Synced ${res.synced} local foreign transaction(s) to Supabase`, 'success');
                            }
                        })
                        .catch(() => {});
                }
            } else if (Array.isArray(this.foreignTransactions)) {
                this.foreignTransactions = this.foreignTransactions.map((r, i) => this.normalizeForeignTransactionRow(r, i));
                const legacyForeignRows = this.foreignTransactions.filter(
                    r => r && !Object.prototype.hasOwnProperty.call(r, 'student_level')
                );
                if (legacyForeignRows.length > 0) {
                    await this.ensureStudentLevelsForRows(legacyForeignRows);
                    if (requestId !== this._fxLoadRequestId) return;
                }
            }
            this.markTabLoaded('foreign-transactions');
        } catch (_e) {
            if (requestId !== this._fxLoadRequestId) return;
            if (Array.isArray(this.foreignTransactions)) {
                this.foreignTransactions = this.foreignTransactions.map((r, i) => this.normalizeForeignTransactionRow(r, i));
            }
        }
        this.applyForeignFilters();
    }

    async loadPdfJsLibrary() {
        if (window.pdfjsLib) return window.pdfjsLib;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.onload = () => {
                if (window.pdfjsLib) {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    resolve(window.pdfjsLib);
                } else {
                    reject(new Error('PDF.js failed to initialize'));
                }
            };
            script.onerror = () => reject(new Error('Failed to load PDF reader library from CDN'));
            document.head.appendChild(script);
        });
    }

    async extractTextFromPdfFile(file) {
        const pdfjsLib = await this.loadPdfJsLibrary();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pagesItems = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const items = (textContent.items || []).map(item => ({
                str: item.str || '',
                x: item.transform ? item.transform[4] : 0,
                y: item.transform ? item.transform[5] : 0
            }));
            pagesItems.push(items);
        }

        return reconstructBanqueMisrPdfLinesFromPages(pagesItems);
    }

    async parseSingleForeignStatementFile(file) {
        const name = String(file.name || '').toLowerCase();
        if (name.endsWith('.pdf')) {
            const pdfText = await this.extractTextFromPdfFile(file);
            return parseBanqueMisrPdfText(pdfText);
        }
        if (name.endsWith('.csv')) {
            return new Promise((resolve, reject) => {
                Papa.parse(file, {
                    header: false,
                    skipEmptyLines: false,
                    complete: (res) => resolve(parseBankStatementGrid(res.data || [])),
                    error: (err) => reject(err)
                });
            });
        }
        // Excel (.xlsx / .xls)
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        const grid = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
        return parseBankStatementGrid(grid);
    }

    async handleForeignStatementFiles(files) {
        if (!files || files.length === 0) return;
        try {
            Toast.show(`Reading ${files.length} bank statement file(s)...`, 'info');
            const students = await this.ensureStudentsLoadedForForeign();

            let combinedDeposits = [];
            let combinedReversals = [];
            let combinedTreasury = [];
            let lastMeta = {};

            for (const file of files) {
                const parsed = await this.parseSingleForeignStatementFile(file);
                lastMeta = parsed.metadata || lastMeta;
                combinedDeposits.push(...(parsed.deposits || []));
                combinedReversals.push(...(parsed.excludedReversals || []));
                combinedTreasury.push(...(parsed.excludedTreasury || []));
            }

            // Try every automatic fix first: Student Directory name matching + Manual Fixes + previous manual assignments
            const existingManualByRef = new Map();
            (this.foreignTransactions || []).forEach(r => {
                if (r.reference_number && r.match_source === 'manual' && r.student_id) {
                    existingManualByRef.set(r.reference_number, r);
                }
            });

            const matchedDeposits = matchForeignDepositsToStudents(combinedDeposits, students).map((d, idx) => {
                const norm = this.normalizeForeignTransactionRow(d, idx);
                const prevManual = existingManualByRef.get(norm.reference_number);
                if ((!norm.student_id || norm.id_status !== 'Valid') && prevManual) {
                    norm.student_id = prevManual.student_id;
                    norm.matched_student_name = prevManual.matched_student_name || norm.matched_student_name;
                    norm.id_status = validateID(prevManual.student_id);
                    norm.match_source = 'manual';
                }
                return norm;
            });

            this.pendingForeignExtraction = {
                metadata: lastMeta,
                deposits: matchedDeposits,
                excludedReversals: combinedReversals,
                excludedTreasury: combinedTreasury
            };

            this.foreignPreviewTab = 'deposits';
            document.getElementById('foreign-import-preview-panel')?.classList.remove('hidden');
            const btnConfirm = document.getElementById('btn-confirm-foreign-import');
            if (btnConfirm) {
                btnConfirm.disabled = matchedDeposits.length === 0;
                btnConfirm.innerHTML = `<i data-lucide="check-circle"></i> Import ${matchedDeposits.length.toLocaleString()} Student Deposit${matchedDeposits.length === 1 ? '' : 's'}`;
            }

            this.renderForeignImportPreview();
            if (window.lucide) lucide.createIcons({ root: document.getElementById('modal-foreign-import') });
            Toast.show(`Extracted ${matchedDeposits.length} student deposits (${combinedReversals.length} reversal rows & ${combinedTreasury.length} bank ops excluded)`, 'success');
        } catch (err) {
            console.error('Error parsing bank statement:', err);
            Toast.show('Failed to parse statement: ' + (err.message || err), 'error');
        }
    }

    renderForeignImportPreview() {
        const ext = this.pendingForeignExtraction;
        if (!ext) return;

        const metaBanner = document.getElementById('foreign-import-meta-banner');
        const currency = ext.metadata?.currency || 'USD';
        const totalDepositAmt = (ext.deposits || []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
        const exactIds = (ext.deposits || []).filter(d => d.match_source === 'statement_id').length;
        const nameMatches = (ext.deposits || []).filter(d => d.match_source === 'name_match').length;
        const unmatched = (ext.deposits || []).length - exactIds - nameMatches;

        if (metaBanner) {
            metaBanner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                    <span><strong>Account:</strong> <code style="color: #38bdf8;">${escapeHTML(ext.metadata?.accountNumber || 'Banque Misr')}</code></span>
                    <span><strong>Currency:</strong> <span class="badge" style="background: rgba(16,185,129,0.15); color: #10b981;">${escapeHTML(currency)}</span></span>
                    <span><strong>Bank:</strong> <code style="color: #10b981;">${escapeHTML(DEFAULT_FOREIGN_BANK)}</code></span>
                    ${ext.metadata?.dateFrom ? `<span><strong>Period:</strong> ${escapeHTML(ext.metadata.dateFrom)} &rarr; ${escapeHTML(ext.metadata.dateTo || '')}</span>` : ''}
                </div>
                <div style="display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap;">
                    <span style="color: var(--success);">Exact ID: <strong>${exactIds}</strong></span>
                    <span style="color: #38bdf8;">Name Matched: <strong>${nameMatches}</strong></span>
                    <span style="color: var(--warning, #f59e0b);">Missing ID: <strong>${unmatched}</strong></span>
                    <span style="color: var(--danger);">Reversed Excluded: <strong>${(ext.excludedReversals || []).length}</strong></span>
                </div>
            `;
        }

        const depCountEl = document.getElementById('foreign-preview-deposits-count');
        const excCountEl = document.getElementById('foreign-preview-excluded-count');
        const totalLabelEl = document.getElementById('foreign-preview-total-label');
        if (depCountEl) depCountEl.textContent = (ext.deposits || []).length;
        if (excCountEl) excCountEl.textContent = (ext.excludedReversals || []).length + (ext.excludedTreasury || []).length;
        if (totalLabelEl) totalLabelEl.textContent = `Total Student Deposits: ${currency} ${formatMoney(totalDepositAmt)}`;

        const thead = document.getElementById('foreign-import-preview-head');
        const tbody = document.getElementById('foreign-import-preview-body');
        if (!thead || !tbody) return;

        if (this.foreignPreviewTab === 'excluded') {
            thead.innerHTML = `
                <tr>
                    <th>Value Date</th>
                    <th>Ref / Code</th>
                    <th>Event</th>
                    <th style="text-align: right;">Credit</th>
                    <th style="text-align: right;">Debit</th>
                    <th>Description</th>
                    <th>Why Excluded</th>
                </tr>
            `;
            const allExcluded = [...(ext.excludedReversals || []), ...(ext.excludedTreasury || [])];
            if (allExcluded.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No excluded rows in this statement.</td></tr>`;
                return;
            }
            tbody.innerHTML = allExcluded.map(r => `
                <tr>
                    <td style="white-space: nowrap;">${escapeHTML(r.value_date || r.transaction_date || '-')}</td>
                    <td style="font-family: monospace; font-size: 0.78rem;">${escapeHTML(r.external_ref || r.transaction_ref || '-')} <span class="badge" style="font-size: 0.68rem;">${escapeHTML(r.transaction_code || '')}</span></td>
                    <td><span class="badge" style="background: rgba(239,68,68,0.15); color: var(--danger); font-size: 0.7rem;">${escapeHTML(r.event || '')}</span></td>
                    <td style="text-align: right; font-family: monospace;">${r.credit > 0 ? escapeHTML(formatMoney(r.credit)) : '-'}</td>
                    <td style="text-align: right; font-family: monospace; color: var(--danger);">${r.debit > 0 ? escapeHTML(formatMoney(r.debit)) : '-'}</td>
                    <td style="font-size: 0.78rem; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(r.description || '')}">${escapeHTML(r.description || '')}</td>
                    <td><span class="badge" style="background: rgba(245,158,11,0.14); color: #f59e0b; font-size: 0.72rem;">${escapeHTML(r.exclude_reason || 'Excluded')}</span></td>
                </tr>
            `).join('');
            return;
        }

        thead.innerHTML = `
            <tr>
                <th>Ref Number</th>
                <th>Date</th>
                <th>Student ID</th>
                <th>Item Price (${escapeHTML(currency)})</th>
                <th>Description</th>
                <th>Mapping</th>
                <th>Bank</th>
                <th>ID Status</th>
            </tr>
        `;
        if (!ext.deposits || ext.deposits.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No student deposits found in this file.</td></tr>`;
            return;
        }

        tbody.innerHTML = ext.deposits.map(d => {
            const isValid = d.id_status === 'Valid';
            const statusBadge = isValid
                ? `<span class="badge valid">Valid</span>`
                : `<span class="badge missing">${escapeHTML(d.id_status || 'Missing ID')}</span>`;
            const stuLevelBadge = this.renderStudentLevelBadge(this.getTransactionStudentLevel(d));

            return `
                <tr>
                    <td style="white-space: nowrap;"><strong>${escapeHTML(d.reference_number)}</strong></td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(d.value_date || d.payment_date || '-'))}</td>
                    <td style="font-weight: 700;">${escapeHTML(d.student_id || '')}${stuLevelBadge}</td>
                    <td style="white-space: nowrap;">${escapeHTML(currency)} ${escapeHTML(formatMoney(d.amount))}</td>
                    <td style="font-size: 0.78rem; max-width: 280px; color: var(--text-secondary);" title="${escapeHTML(d.description || '')}">
                        ${escapeHTML(d.description || '-')}
                    </td>
                    <td style="white-space: nowrap;">${escapeHTML(d.mapping || DEFAULT_FOREIGN_MAPPING)}</td>
                    <td style="white-space: nowrap;">${escapeHTML(d.bank || DEFAULT_FOREIGN_BANK)}</td>
                    <td>${statusBadge}</td>
                </tr>
            `;
        }).join('');
    }

    async savePendingForeignDeposits() {
        const ext = this.pendingForeignExtraction;
        if (!ext || !Array.isArray(ext.deposits) || ext.deposits.length === 0) return;

        const baseIdx = (this.foreignTransactions || []).length;
        const incomingRows = ext.deposits.map((d, i) => {
            const norm = this.normalizeForeignTransactionRow(d, baseIdx + i);
            norm._uid = `${norm.reference_number}_${Date.now()}_${baseIdx + i}`;
            return norm;
        });

        // Append incoming rows so if duplicate statements/transactions were imported, Detect Duplicates can inspect & remove them
        this.foreignTransactions = [...(this.foreignTransactions || []), ...incomingRows];
        this.persistForeignTransactionsLocal();

        // Also upsert into Supabase foreign_transactions if table exists
        const syncRes = await this.syncForeignTransactionsToSupabase({ silent: true, rows: incomingRows });

        const accBadge = document.getElementById('foreign-stat-account-badge');
        if (accBadge) {
            accBadge.textContent = `Bank: ${DEFAULT_FOREIGN_BANK} · ${ext.metadata?.currency || 'USD'}`;
        }

        document.getElementById('modal-foreign-import')?.classList.add('hidden');
        this.pendingForeignExtraction = null;
        this.erpBaseKey = null;
        this.applyForeignFilters();
        if (syncRes.error) {
            Toast.show(`Saved ${incomingRows.length} locally, but Supabase sync failed: ${syncRes.error.message}`, 'warning');
        } else {
            Toast.show(`Saved ${incomingRows.length} student deposits to BM Transactions`, 'success');
        }
    }

    applyForeignFilters() {
        const dateFrom = document.getElementById('foreign-date-from')?.value || '';
        const dateTo = document.getElementById('foreign-date-to')?.value || '';
        const searchRaw = (document.getElementById('foreign-search-input')?.value || '').trim().toLowerCase();
        const searchNorm = normalizePersonName(searchRaw);

        this.foreignTransactions = (this.foreignTransactions || []).map((r, i) => this.normalizeForeignTransactionRow(r, i));
        let rows = [...this.foreignTransactions];

        if (dateFrom) {
            rows = rows.filter(r => toDateOnly(r.value_date || r.payment_date || r.transaction_date || '') >= dateFrom);
        }
        if (dateTo) {
            rows = rows.filter(r => toDateOnly(r.value_date || r.payment_date || r.transaction_date || '') <= dateTo);
        }
        if (this.foreignQuickFilter === 'valid_id') {
            rows = rows.filter(r => getEffectiveIdStatus(r) === 'Valid');
        } else if (this.foreignQuickFilter === 'name_match') {
            rows = rows.filter(r => r.match_source === 'name_match');
        } else if (this.foreignQuickFilter === 'missing_id') {
            rows = rows.filter(r => !isNonInvalidTransaction(r) && (!r.student_id || String(r.id_status || '').includes('Missing')));
        } else if (this.foreignQuickFilter === 'error_id') {
            rows = rows.filter(r => !isNonInvalidTransaction(r) && Boolean(r.student_id) && !String(r.id_status || '').includes('Missing'));
        }

        if (searchRaw) {
            rows = rows.filter(r => {
                const hayRaw = `${r.reference_number || ''} ${r.transaction_ref || ''} ${r.student_id || ''} ${r.extracted_name || ''} ${r.matched_student_name || ''} ${r.handler_name || ''} ${r.description || ''} ${r.mapping || ''} ${r.bank || ''}`.toLowerCase();
                if (hayRaw.includes(searchRaw)) return true;
                if (searchNorm) {
                    const hayNorm = normalizePersonName(`${r.extracted_name || ''} ${r.matched_student_name || ''} ${r.handler_name || ''} ${r.description || ''}`);
                    return hayNorm.includes(searchNorm);
                }
                return false;
            });
        }

        const col = this.foreignSortCol || 'value_date';
        const dir = this.foreignSortAsc ? 1 : -1;
        rows.sort((a, b) => {
            if (col === 'amount' || col === 'item_price') {
                return ((Number(a.amount) || 0) - (Number(b.amount) || 0)) * dir;
            }
            const va = String(a[col] ?? '').toLowerCase();
            const vb = String(b[col] ?? '').toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });

        this.filteredForeignTransactions = rows;
        this.renderForeignTransactionsTable();
    }

    renderForeignTransactionsTable() {
        const rows = this.filteredForeignTransactions || [];
        const currency = rows[0]?.currency || this.foreignTransactions?.[0]?.currency || 'USD';
        const totalAmt = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        const validCount = rows.filter(r => getEffectiveIdStatus(r) === 'Valid').length;
        const exemptCount = rows.filter(r => getEffectiveIdStatus(r) === 'Exempt').length;
        const nameMatchedCount = rows.filter(r => r.match_source === 'name_match').length;
        const invalidCount = Math.max(0, rows.length - validCount - exemptCount);

        const setEl = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        setEl('foreign-stat-count', rows.length.toLocaleString());
        setEl('foreign-stat-amount', `${currency} ${formatMoney(totalAmt)}`);
        setEl('foreign-stat-valid', validCount.toLocaleString());
        setEl('foreign-stat-name-matched', nameMatchedCount.toLocaleString());
        setEl('foreign-stat-invalid', invalidCount.toLocaleString());

        const tbody = document.getElementById('foreign-transactions-body');
        if (!tbody) return;

        if (rows.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2.5rem;">
                        No BM transactions match the current filters. Click <strong>Import Bank Statement (PDF / Excel)</strong> to load statement deposits.
                    </td>
                </tr>
            `;
            setEl('foreign-page-info', 'Page 1 of 1');
            return;
        }

        const totalPages = Math.max(1, Math.ceil(rows.length / this.foreignPageSize));
        if (this.foreignPage > totalPages) this.foreignPage = totalPages;
        const startIdx = (this.foreignPage - 1) * this.foreignPageSize;
        const pageRows = rows.slice(startIdx, startIdx + this.foreignPageSize);

        setEl('foreign-page-info', `Page ${this.foreignPage} of ${totalPages}`);
        const prevBtn = document.getElementById('foreign-btn-prev');
        const nextBtn = document.getElementById('foreign-btn-next');
        if (prevBtn) prevBtn.disabled = this.foreignPage <= 1;
        if (nextBtn) nextBtn.disabled = this.foreignPage >= totalPages;
        const fxJumpInput = document.getElementById('foreign-jump-page');
        if (fxJumpInput) fxJumpInput.max = String(totalPages);

        tbody.innerHTML = pageRows.map((t, idx) => {
            const { statusClass, statusText, shortStatus } = formatIdStatusMeta(t, { defaultStatus: 'Missing ID' });

            const rowCurrency = t.currency || currency;
            const stuLevelBadge = this.renderStudentLevelBadge(this.getTransactionStudentLevel(t));

            return `
                <tr class="foreign-tx-row" data-idx="${idx}" style="cursor: pointer;" title="Click to inspect full transaction details">
                    <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong></td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.value_date || t.payment_date || t.transaction_date))}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 165px; font-size: 0.85rem; line-height: 1.3;"><strong>${escapeHTML(t.student_id || '')}</strong>${stuLevelBadge}</td>
                    <td style="white-space: nowrap;">${escapeHTML(rowCurrency)} ${formatMoney(t.amount ?? t.item_price)}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 260px; font-size: 0.8rem; line-height: 1.3;">${escapeHTML(t.description || t.item_name || '')}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.mapping || DEFAULT_FOREIGN_MAPPING)}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.second_mapping) || '-'}</td>
                    <td style="white-space: nowrap;">${escapeHTML(t.bank || DEFAULT_FOREIGN_BANK)}</td>
                    <td>
                        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                            <span class="badge ${statusClass}">${escapeHTML(shortStatus)}</span>
                            <button type="button" class="tx-quick-fix-btn ${statusClass} foreign-fix-btn" data-idx="${idx}" title="Fix / Edit Student ID for ${escapeHTML(t.reference_number)}">
                                <i data-lucide="wrench"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.foreign-fix-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const row = pageRows[parseInt(btn.getAttribute('data-idx'), 10)];
                if (row) this.openForeignFixModal(row);
            });
        });

        tbody.querySelectorAll('.foreign-tx-row').forEach(tr => {
            tr.addEventListener('click', () => {
                const row = pageRows[parseInt(tr.getAttribute('data-idx'), 10)];
                if (row) this.openForeignTransactionDetailsModal(row);
            });
        });

        if (window.lucide) lucide.createIcons({ root: tbody });
    }

    async openForeignTransactionDetailsModal(row) {
        const modal = document.getElementById('modal-tx-details');
        const body = document.getElementById('modal-tx-details-body');
        if (!modal || !body || !row) return;

        const { statusClass, statusText } = formatIdStatusMeta(row, { defaultStatus: 'Missing ID' });

        const currency = String(row.currency || 'USD').toUpperCase();
        const valueDate = toDateOnly(row.value_date || row.payment_date || row.transaction_date) || '-';
        const matchLabel = row.match_source === 'statement_id'
            ? 'Statement ID'
            : row.match_source === 'name_match'
                ? 'Name Matched'
                : row.match_source === 'manual'
                    ? 'Manual Fix'
                    : 'Unmatched';

        body.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.75rem 1rem; border-radius: 8px; background: var(--bg-subtle); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="color: var(--text-muted); font-size: 0.82rem;">Reference:</span>
                    <strong style="font-size: 1.05rem;">${escapeHTML(row.reference_number || '-')}</strong>
                    <button type="button" class="btn btn-outline btn-sm" id="btn-tx-detail-copy-ref" style="padding: 0.12rem 0.45rem; font-size: 0.72rem;">Copy</button>
                </div>
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <span class="badge ${statusClass}">${escapeHTML(statusText)}</span>
                    <span class="badge" style="background: rgba(56, 189, 248, 0.14); color: #38bdf8;">${escapeHTML(matchLabel)}</span>
                    ${row.erp_batch_number
                        ? `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b;">ERP: ${escapeHTML(row.erp_batch_number)}</span>`
                        : `<span class="badge" style="background: rgba(148, 163, 184, 0.18); color: var(--text-muted);">Same-Day Settlement</span>`}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem;">
                <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Student &amp; Depositor</h4>
                    <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.3rem;">
                        <div>Student ID: <strong>${escapeHTML(row.student_id || 'Missing')}</strong>${this.renderStudentLevelBadge(this.getTransactionStudentLevel(row))}</div>
                        <div id="tx-detail-student-lookup" style="color: var(--text-muted); font-size: 0.8rem;">Looking up Student Master...</div>
                        <div>Extracted Student Name: <strong dir="auto">${escapeHTML(row.extracted_name || '-')}</strong></div>
                        <div>Depositor / Handler: <strong dir="auto">${escapeHTML(row.handler_name || '-')}</strong></div>
                        <div>Value Date: <strong>${escapeHTML(valueDate)}</strong></div>
                    </div>
                </div>

                <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Bank &amp; Amount Breakdown</h4>
                    <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.3rem;">
                        <div>Amount: <strong style="color: var(--primary);">${escapeHTML(currency)} ${formatMoney(row.amount ?? row.item_price)}</strong></div>
                        <div>Bank Code: <strong>${escapeHTML(row.bank || DEFAULT_FOREIGN_BANK)}</strong></div>
                        <div>Account Number: <strong>${escapeHTML(row.account_number || '-')}</strong></div>
                        <div>Deposit Method: <strong>${escapeHTML(row.deposit_method || '-')}</strong></div>
                        <div>Transaction Ref / Code: <strong>${escapeHTML(row.transaction_ref || '-')} ${row.transaction_code ? `(${escapeHTML(row.transaction_code)})` : ''}</strong></div>
                        <div>Statement Date/Time: <strong>${escapeHTML(row.transaction_datetime || valueDate)}</strong></div>
                    </div>
                </div>
            </div>

            <div class="glass-card" style="padding: 0.85rem; margin: 0;">
                <h4 style="margin: 0 0 0.5rem 0; font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase;">Description, Mapping &amp; ERP Status</h4>
                <div style="font-size: 0.85rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 1rem;">
                    <div style="grid-column: 1 / -1;">Bank Statement Description:<br><strong dir="auto" style="display: inline-block; margin-top: 0.2rem; line-height: 1.45;">${escapeHTML(row.description || '-')}</strong></div>
                    <div>Mapping: <strong>${escapeHTML(row.mapping || DEFAULT_FOREIGN_MAPPING)}</strong></div>
                    <div>2nd Mapping: <strong>${escapeHTML(row.second_mapping || '-')}</strong></div>
                    <div>ERP Batch: <strong>${escapeHTML(row.erp_batch_number || '-')}</strong></div>
                    <div>ERP Voucher: <strong>${escapeHTML(row.erp_voucher || '-')}</strong></div>
                </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 0.65rem; flex-wrap: wrap;">
                ${this.hasRole('accountant') ? `
                <button type="button" class="btn btn-primary" id="btn-foreign-detail-fix">
                    <i data-lucide="wrench" style="width: 14px; height: 14px;"></i> Fix Student ID
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
            if (navigator.clipboard && row.reference_number) {
                navigator.clipboard.writeText(String(row.reference_number));
                Toast.show(`Copied Reference "${row.reference_number}"`, 'success');
            }
        });

        document.getElementById('btn-foreign-detail-fix')?.addEventListener('click', () => {
            modal.classList.add('hidden');
            this.openForeignFixModal(row);
        });

        // Student Master Lookup (prefer cached this.allStudents or query DB)
        const lookupEl = document.getElementById('tx-detail-student-lookup');
        if (lookupEl) {
            const sid = String(row.student_id || '').trim();
            if (!sid) {
                lookupEl.textContent = row.matched_student_name
                    ? `Matched Name: ${row.matched_student_name}`
                    : 'No Student ID assigned yet';
            } else {
                const cachedStudent = this.lookupStudentBySid(sid) || (this.allStudents || []).find(s => String(s.student_id || '').trim() === sid);
                if (cachedStudent) {
                    const colProg = [cachedStudent.college, cachedStudent.program].filter(Boolean).join(' • ');
                    const displayName = cachedStudent.full_name || cachedStudent.arabic_name || 'N/A';
                    const lvlBadge = this.renderStudentLevelBadge(getStudentProgramLevel(cachedStudent));
                    lookupEl.innerHTML = `<span style="color: var(--success);">Student: <strong dir="auto">${escapeHTML(displayName)}</strong>${lvlBadge}${colProg ? ` (${escapeHTML(colProg)})` : ''}</span>`;
                } else {
                    try {
                        const { data: st } = await supabase
                            .from('student_master')
                            .select('full_name, arabic_name, college, program')
                            .eq('student_id', sid)
                            .maybeSingle();
                        if (st) {
                            const colProg = [st.college, st.program].filter(Boolean).join(' • ');
                            const displayName = st.full_name || st.arabic_name || 'N/A';
                            const lvlBadge = this.renderStudentLevelBadge(getStudentProgramLevel(st));
                            lookupEl.innerHTML = `<span style="color: var(--success);">Student: <strong dir="auto">${escapeHTML(displayName)}</strong>${lvlBadge}${colProg ? ` (${escapeHTML(colProg)})` : ''}</span>`;
                        } else {
                            lookupEl.innerHTML = `<span style="color: var(--warning, #f59e0b);">${row.matched_student_name ? `Matched: ${escapeHTML(row.matched_student_name)}` : 'Not found in Student Master'}</span>`;
                        }
                    } catch (_e) {
                        lookupEl.textContent = row.matched_student_name ? `Matched: ${row.matched_student_name}` : 'Lookup unavailable offline';
                    }
                }
            }
        }
    }

    async openForeignFixModal(row) {
        await this.ensureStudentsLoadedForForeign();
        const modal = document.getElementById('modal-foreign-fix');
        if (!modal) return;

        document.getElementById('foreign-fix-ref').value = row.reference_number || '';
        document.getElementById('foreign-fix-student-id').value = row.student_id || '';
        document.getElementById('foreign-fix-student-name').value = row.matched_student_name || row.extracted_name || '';
        const searchInput = document.getElementById('foreign-fix-student-search');
        const resultsBox = document.getElementById('foreign-fix-search-results');
        if (searchInput) searchInput.value = row.extracted_name || '';
        if (resultsBox) resultsBox.style.display = 'none';

        const box = document.getElementById('foreign-fix-narrative-box');
        if (box) {
            box.innerHTML = `
                <div><strong>Ref:</strong> <code>${escapeHTML(row.reference_number)}</code> &nbsp;|&nbsp; <strong>Date:</strong> ${escapeHTML(toDateOnly(row.value_date || row.payment_date || '-'))} &nbsp;|&nbsp; <strong>Amount:</strong> <span style="color: #38bdf8; font-weight: 700;">${escapeHTML(row.currency || 'USD')} ${escapeHTML(formatMoney(row.amount))}</span></div>
                <div style="margin-top: 0.35rem;"><strong>Extracted Student:</strong> ${escapeHTML(row.extracted_name || '-')} &nbsp;|&nbsp; <strong>Depositor (بمناولة):</strong> ${escapeHTML(row.handler_name || '-')}</div>
                <div style="margin-top: 0.35rem; color: var(--text-muted);"><strong>Description:</strong> ${escapeHTML(row.description || '')}</div>
            `;
        }

        modal.classList.remove('hidden');
        if (searchInput && searchInput.value) {
            searchInput.dispatchEvent(new Event('input'));
        }
        if (window.lucide) lucide.createIcons({ root: modal });
    }

    async saveForeignTransactionFix() {
        const ref = document.getElementById('foreign-fix-ref')?.value;
        const newId = (document.getElementById('foreign-fix-student-id')?.value || '').trim();
        const newName = (document.getElementById('foreign-fix-student-name')?.value || '').trim();
        if (!ref) return;

        const status = newId ? validateID(newId) : 'Missing ID';
        const matchingRows = (this.foreignTransactions || []).filter(r => r.reference_number === ref);
        if (matchingRows.length === 0) return;

        matchingRows.forEach(target => {
            target.student_id = newId;
            target.matched_student_name = newName || target.matched_student_name;
            target.id_status = status;
            target.match_source = newId ? 'manual' : 'unmatched';
        });

        // Also sync with Manual Fixes (this.allFixesData + manual_fixes table) so bulk/manual fixes stay unified
        if (newId) {
            const fixRecord = {
                reference_number: ref,
                correct_id: newId,
                item_name: null,
                mapping: DEFAULT_FOREIGN_MAPPING,
                second_mapping: null
            };
            if (Array.isArray(this.allFixesData)) {
                const key = String(ref).trim().toLowerCase();
                this.allFixesData = this.allFixesData.filter(f => String(f.reference_number || '').trim().toLowerCase() !== key);
                this.allFixesData.push(fixRecord);
                this.allFixesData.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));
                this.updateFixesStatsAndDropdowns(this.allFixesData);
            }
            try {
                await supabase.from('manual_fixes').upsert([fixRecord], { onConflict: 'reference_number' });
            } catch (_e) {
                // ignore if offline
            }
        }

        this.persistForeignTransactionsLocal();
        try {
            await supabase.from('foreign_transactions').update({
                student_id: newId,
                matched_student_name: newName,
                id_status: status,
                match_source: newId ? 'manual' : 'unmatched'
            }).eq('reference_number', ref);
        } catch (_e) {
            // ignore if table not migrated yet
        }

        document.getElementById('modal-foreign-fix')?.classList.add('hidden');
        this.erpBaseKey = null;
        this.applyForeignFilters();
        if (document.getElementById('view-erp-export')?.classList.contains('active')) {
            await this.loadErpExport({ refresh: true });
        }
        Toast.show(newId ? `Saved Student ID ${newId} for Ref ${ref}` : `Updated Ref ${ref}`, 'success');
    }

    async detectForeignDuplicates() {
        const btn = document.getElementById('btn-foreign-detect-duplicates');
        const originalText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Detecting...';
            btn.disabled = true;
            renderIcons(btn);
        }

        try {
            const allData = (this.foreignTransactions || []).map((r, i) => this.normalizeForeignTransactionRow(r, i));
            this.foreignTransactions = allData;

            const grouped = {};
            for (const tx of allData) {
                if (!tx.reference_number) continue;
                const normDesc = String(tx.description || tx.item_name || '').replace(/\s+/g, ' ').trim();
                const check = tx.check_column != null
                    ? String(tx.check_column).replace(/\s+/g, ' ').trim()
                    : `${tx.reference_number}-${normDesc}`;
                // Group by reference_number + price + normalized check_column (same mechanism as Fawry detectDuplicates)
                const key = `${tx.reference_number}|${Number(tx.amount || tx.item_price || 0).toFixed(2)}|${check}`;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(tx);
            }

            // Also group by transaction_ref + price + date when one row used external_ref and another used transaction_ref
            const txRefGrouped = {};
            for (const tx of allData) {
                if (!tx.transaction_ref) continue;
                const txKey = `${tx.transaction_ref}|${Number(tx.amount || tx.item_price || 0).toFixed(2)}|${toDateOnly(tx.value_date || tx.payment_date)}`;
                if (!txRefGrouped[txKey]) txRefGrouped[txKey] = [];
                txRefGrouped[txKey].push(tx);
            }

            const duplicates = [];
            const toDeleteUidsSet = new Set();

            const processGroup = (txs) => {
                if (txs.length <= 1) return;
                // Prefer rows with Valid Student ID or manual fix
                txs.sort((a, b) => {
                    const aScore = (a.id_status === 'Valid' ? 100 : 0) + (a.match_source === 'manual' ? 50 : 0) + (a.external_ref ? 25 : 0);
                    const bScore = (b.id_status === 'Valid' ? 100 : 0) + (b.match_source === 'manual' ? 50 : 0) + (b.external_ref ? 25 : 0);
                    return bScore - aScore;
                });

                let addedAny = false;
                for (let i = 1; i < txs.length; i++) {
                    if (!toDeleteUidsSet.has(txs[i]._uid)) {
                        toDeleteUidsSet.add(txs[i]._uid);
                        addedAny = true;
                    }
                }
                if (addedAny) {
                    duplicates.push({
                        ref: txs[0].reference_number,
                        name: txs[0].description || txs[0].item_name || '',
                        price: txs[0].amount ?? txs[0].item_price,
                        trimmedCheck: txs[0].check_column || `${txs[0].reference_number}-${txs[0].description || ''}`,
                        untrimmedCheck: txs[1].check_column || `${txs[1].reference_number}-${txs[1].description || ''}`
                    });
                }
            };

            Object.values(grouped).forEach(processGroup);
            Object.values(txRefGrouped).forEach(processGroup);

            window.duplicateCleanupMode = 'foreign';
            window.duplicateForeignUidsToDelete = [...toDeleteUidsSet];

            const summaryEl = document.getElementById('duplicates-summary');
            if (summaryEl) {
                summaryEl.innerText = `Found ${duplicates.length} duplicated foreign transaction(s) (${toDeleteUidsSet.size} extra row(s) will be removed). Valid / manually matched copies are always kept.`;
            }
            const tbody = document.getElementById('duplicates-body');
            if (tbody) {
                tbody.innerHTML = duplicates.length > 0
                    ? duplicates.map(d => `
                        <tr>
                            <td>${escapeHTML(d.ref)}</td>
                            <td>${escapeHTML(d.name)}</td>
                            <td>${escapeHTML(formatMoney(d.price))}</td>
                            <td><pre style="margin:0; font-size:0.8rem; white-space: pre-wrap;">'${escapeHTML(d.trimmedCheck)}'</pre></td>
                            <td><pre style="margin:0; font-size:0.8rem; white-space: pre-wrap;">'${escapeHTML(d.untrimmedCheck)}'</pre></td>
                        </tr>
                    `).join('')
                    : `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No duplicate BM transactions found.</td></tr>`;
            }

            const btnCleanup = document.getElementById('btn-cleanup-duplicates');
            if (btnCleanup) {
                btnCleanup.style.display = toDeleteUidsSet.size > 0 ? 'inline-flex' : 'none';
            }
            document.getElementById('modal-detect-duplicates')?.classList.remove('hidden');
            renderIcons(document.getElementById('modal-detect-duplicates'));
        } catch (err) {
            Toast.show('Error detecting duplicates: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.innerHTML = originalText;
                btn.disabled = false;
                renderIcons(btn);
            }
        }
    }

    async cleanupForeignDuplicates() {
        const uids = new Set(window.duplicateForeignUidsToDelete || []);
        if (uids.size === 0) return;

        const btn = document.getElementById('btn-cleanup-duplicates');
        const originalText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Deleting...';
            btn.disabled = true;
            renderIcons(btn);
        }

        try {
            const existingList = this.foreignTransactions || [];
            const removedRefs = new Set();
            const keptRows = [];
            existingList.forEach(r => {
                if (uids.has(r._uid)) {
                    if (r.reference_number) removedRefs.add(String(r.reference_number).trim());
                } else {
                    keptRows.push(r);
                }
            });
            const keptRefSet = new Set(keptRows.map(r => String(r.reference_number || '').trim()).filter(Boolean));
            const orphanedRefs = [...removedRefs].filter(ref => !keptRefSet.has(ref));

            const beforeCount = existingList.length;
            this.foreignTransactions = keptRows;
            const deletedCount = beforeCount - this.foreignTransactions.length;
            this.persistForeignTransactionsLocal();

            if (orphanedRefs.length > 0 && this.hasRole('admin')) {
                try {
                    const fxClient = supabase.from('foreign_transactions');
                    if (fxClient && typeof fxClient.delete === 'function') {
                        await fxClient.delete().in('reference_number', orphanedRefs);
                    }
                } catch (_e) {
                    // ignore if offline / table not migrated
                }
            }

            document.getElementById('modal-detect-duplicates')?.classList.add('hidden');
            window.duplicateForeignUidsToDelete = [];
            this.invalidateTabs('dashboard', 'erp-export');
            this.applyForeignFilters();
            Toast.show(`Successfully deleted ${deletedCount} duplicate foreign transaction(s).`, 'success');
        } catch (err) {
            Toast.show('Error deleting duplicates: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.innerHTML = originalText;
                btn.disabled = false;
                renderIcons(btn);
            }
        }
    }

    openForeignDoublePaymentsModal() {
        const daysWindow = parseInt(document.getElementById('double-payments-window')?.value ?? '3', 10);
        const windowDays = isNaN(daysWindow) ? 3 : daysWindow;
        const rows = (this.foreignTransactions || []).map((r, i) => this.normalizeForeignTransactionRow(r, i));

        // Group by student identifier (student_id if valid, else normalized extracted_name) + amount
        const byStudentAndAmt = new Map();
        for (const r of rows) {
            const studentKey = r.student_id || normalizePersonName(r.extracted_name || '');
            if (!studentKey) continue;
            const amtKey = Number(r.amount || 0).toFixed(2);
            const key = `${studentKey}|${amtKey}`;
            if (!byStudentAndAmt.has(key)) byStudentAndAmt.set(key, []);
            byStudentAndAmt.get(key).push(r);
        }

        const clusters = [];
        for (const group of byStudentAndAmt.values()) {
            if (group.length < 2) continue;
            group.sort((a, b) => String(a.value_date || '').localeCompare(String(b.value_date || '')));
            const firstDate = new Date(group[0].value_date || group[0].payment_date);
            const lastDate = new Date(group[group.length - 1].value_date || group[group.length - 1].payment_date);
            const diffDays = (!isNaN(firstDate) && !isNaN(lastDate))
                ? Math.round(Math.abs(lastDate - firstDate) / (1000 * 60 * 60 * 24))
                : 0;
            if (diffDays <= windowDays) {
                clusters.push({
                    student_id: group[0].student_id || 'Missing ID',
                    student_name: group[0].matched_student_name || group[0].extracted_name || '-',
                    college: '',
                    item_name: group[0].description || DEFAULT_FOREIGN_MAPPING,
                    mapping: DEFAULT_FOREIGN_MAPPING,
                    item_price: group[0].amount,
                    tx_count: group.length,
                    total_paid: group.reduce((s, x) => s + (Number(x.amount) || 0), 0),
                    first_payment: group[0].value_date,
                    last_payment: group[group.length - 1].value_date,
                    days_apart: diffDays,
                    reference_numbers: group.map(x => x.reference_number),
                    banks: [DEFAULT_FOREIGN_BANK]
                });
            }
        }

        this.doublePaymentClusters = clusters;
        const dpModal = document.getElementById('modal-double-payments');
        dpModal?.classList.remove('hidden');
        this.renderDoublePaymentsTable();
        renderIcons(dpModal);
    }

    async runForeignAutoMatchNames() {
        if (!this.foreignTransactions || this.foreignTransactions.length === 0) {
            Toast.show('No BM transactions loaded to match', 'warning');
            return;
        }
        if (this._foreignAutoMatching) return;
        this._foreignAutoMatching = true;

        try {
            await withDropdownTaskProgress(
                'btn-foreign-automatch',
                'Matching...',
                'Re-applying rules & loading student directory...',
                async (progressToast) => {
                    try {
                        const students = await this.ensureStudentsLoadedForForeign();
                        const totalCount = this.foreignTransactions.length;
                        progressToast.update(`Matching ${totalCount.toLocaleString()} foreign deposit(s)...`);
                        await new Promise(resolve => setTimeout(resolve, 0));

                        const beforeValid = this.foreignTransactions.filter(r => r.id_status === 'Valid').length;
                        this.foreignTransactions = matchForeignDepositsToStudents(this.foreignTransactions, students || [], this.allFixesData || [])
                            .map((r, i) => this.normalizeForeignTransactionRow(r, i));
                        const afterValid = this.foreignTransactions.filter(r => r.id_status === 'Valid').length;
                        this.persistForeignTransactionsLocal();

                        progressToast.update('Syncing matched deposits to database...');
                        await this.syncForeignTransactionsToSupabase({ silent: true });
                        this.applyForeignFilters();

                        progressToast.dismiss();
                        Toast.show(
                            `Auto-Match complete: ${afterValid - beforeValid} additional deposit(s) matched (${afterValid}/${this.foreignTransactions.length} Valid)`,
                            'success'
                        );
                    } catch (err) {
                        progressToast.dismiss();
                        Toast.show('Auto-Match failed: ' + (err?.message || String(err)), 'error');
                    }
                }
            );
        } finally {
            this._foreignAutoMatching = false;
        }
    }

    exportForeignTransactionsExcel() {
        const rows = this.filteredForeignTransactions?.length ? this.filteredForeignTransactions : this.foreignTransactions;
        if (!rows || rows.length === 0) {
            Toast.show('No BM transactions to export', 'warning');
            return;
        }
        const exportData = rows.map(r => ({
            'Ref Number': r.reference_number || '',
            'Date': toDateOnly(r.value_date || r.payment_date || r.transaction_date),
            'Student ID': r.student_id || '',
            'Level': formatStudentLevelTag(this.getTransactionStudentLevel(r)),
            'Item Price': Number(r.amount ?? r.item_price) || 0,
            'Currency': r.currency || 'USD',
            'Description': r.description || '',
            'Mapping': r.mapping || DEFAULT_FOREIGN_MAPPING,
            '2nd Mapping': r.second_mapping || '',
            'Bank': r.bank || DEFAULT_FOREIGN_BANK,
            'ID Status': r.id_status || 'Missing ID'
        }));
        const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(exportData));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'BM_Transactions');
        writeCompressedExcel(wb, `BM_Transactions_${toDateOnly(new Date())}.xlsx`);
        Toast.show(`Exported ${exportData.length} BM transactions to Excel`, 'success');
    }

    async copyForeignTransactionsForEmail() {
        const rows = this.filteredForeignTransactions?.length ? this.filteredForeignTransactions : this.foreignTransactions;
        if (!rows || rows.length === 0) {
            Toast.show('No BM transactions to copy', 'warning');
            return;
        }
        const tsv = [
            ['Ref Number', 'Date', 'Student ID', 'Level', 'Item Price', 'Description', 'Mapping', '2nd Mapping', 'Bank', 'ID Status'].join('\t'),
            ...rows.map(r => [
                r.reference_number || '',
                toDateOnly(r.value_date || r.payment_date || r.transaction_date),
                r.student_id || '',
                formatStudentLevelTag(this.getTransactionStudentLevel(r)),
                formatMoney(r.amount ?? r.item_price),
                r.description || '',
                r.mapping || DEFAULT_FOREIGN_MAPPING,
                r.second_mapping || '-',
                r.bank || DEFAULT_FOREIGN_BANK,
                r.id_status || 'Missing ID'
            ].join('\t'))
        ].join('\n');

        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(tsv);
            Toast.show(`Copied ${rows.length} BM transactions to clipboard`, 'success');
        }
    }

}

applyDashboardMixin(App);
applyAutoMatcherMixin(App);
applyErpExportMixin(App);
applyAdminAuditMixin(App);

export { App };

// Start app when static shell is already in the document
document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.app-layout')) {
        window.app = new App();
    }
});
