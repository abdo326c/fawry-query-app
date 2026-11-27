import { supabase } from './supabase.js';
import {
    validateID,
    getEffectiveIdStatus,
    isNonInvalidTransaction,
    fetchAll,
    escapeHTML,
    sanitizeExcelRows,
    toDateOnly,
    toPeriodMonth,
    findClosedPeriodsInRows,
    getStudentProgramLevel,
    formatStudentLevelTag,
    writeCompressedExcel
} from './rules.js';
import {
    parseBankStatementGrid,
    parseBanqueMisrPdfText,
    reconstructBanqueMisrPdfLinesFromPages,
    analyzeBanqueMisrPdfLayout,
    pairStatementFiles,
    mergeForeignCloudAndLocal,
    matchForeignDepositsToStudents,
    normalizePersonName,
    DEFAULT_FOREIGN_BANK,
    DEFAULT_FOREIGN_MAPPING
} from './foreign-transactions.js';
import {
    runConcurrent,
    ensureXlsx,
    ensureImportLibs,
    renderIcons,
    inlineIcon,
    formatIdStatusMeta,
    formatMoney,
    Toast,
    withDropdownTaskProgress
} from './app-utils.js';

/** Student-match columns of a BM deposit that a statement re-import must not wipe. */
export const FOREIGN_STUDENT_MATCH_FIELDS = Object.freeze(['student_id', 'student_level', 'id_status', 'match_source', 'matched_student_name']);

/**
 * True when the stored deposit's student match must survive a re-import / re-sync of the same
 * reference: it is already posted to the ERP, it was matched by hand, or it has a Valid student
 * ID while the new parse does not.
 */
export function shouldKeepExistingForeignMatch(existing, incoming) {
    if (!existing) return false;
    if (String(existing.erp_batch_number || '').trim()) return true;
    if (String(existing.match_source || '').trim().toLowerCase() === 'manual') return true;
    return existing.id_status === 'Valid' && incoming?.id_status !== 'Valid';
}

/**
 * Returns the row to upsert: the incoming statement row, with the stored student-match fields
 * kept when shouldKeepExistingForeignMatch() says so (description, amounts, dates still update).
 */
export function mergeExistingForeignMatch(incoming, existing) {
    if (!shouldKeepExistingForeignMatch(existing, incoming)) return incoming;
    const out = { ...incoming };
    for (const f of FOREIGN_STUDENT_MATCH_FIELDS) out[f] = existing[f] ?? null;
    return out;
}

/** Keep-copy score for BM duplicate groups: ERP-posted > Valid ID > manual match > external ref. */
export function scoreForeignDuplicateKeepCopy(r) {
    return (String(r?.erp_batch_number || '').trim() ? 1000 : 0)
        + (r?.id_status === 'Valid' ? 100 : 0)
        + (r?.match_source === 'manual' ? 50 : 0)
        + (r?.external_ref ? 25 : 0);
}

/** A BM row that duplicate cleanup must never delete: ERP-posted or in a closed accounting period. */
export function isProtectedForeignRow(r, isDateClosed) {
    if (!r) return false;
    if (String(r.erp_batch_number || '').trim()) return true;
    const d = r.value_date || r.transaction_date || r.payment_date;
    return Boolean(d && typeof isDateClosed === 'function' && isDateClosed(d));
}

class ForeignUiMixin {
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

        const { blockedRows, closedMonths } = findClosedPeriodsInRows(
            dbRows,
            this.closedPeriodSet,
            r => r.value_date || r.transaction_date
        );
        if (blockedRows.length > 0) {
            const msg = `Blocked: ${blockedRows.length} foreign deposit(s) fall inside closed accounting period(s): ${closedMonths.join(', ')}.`;
            if (!silent) Toast.show(msg, 'error');
            return { synced: 0, error: new Error(msg) };
        }

        try {
            const probeClient = supabase.from('foreign_transactions');
            if (!probeClient || typeof probeClient.upsert !== 'function') {
                return { synced: 0, error: null };
            }
            const chunkSize = 200;

            // An upsert by reference_number overwrites the stored row. Read what is stored first, so
            // a re-import / re-sync never wipes a manual match, a Valid match, or the student of an
            // ERP-posted deposit (see mergeExistingForeignMatch).
            const keptMatches = new Map();
            if (typeof probeClient.select === 'function') {
                for (let i = 0; i < dbRows.length; i += chunkSize) {
                    const refs = dbRows.slice(i, i + chunkSize).map(r => r.reference_number);
                    const { data: existingRows, error: readErr } = await supabase.from('foreign_transactions')
                        .select('reference_number, student_id, student_level, id_status, match_source, matched_student_name, erp_batch_number')
                        .in('reference_number', refs);
                    if (readErr) {
                        // Without the stored rows we cannot protect existing matches: do not write blind.
                        if (!silent) Toast.show(`Supabase sync failed: ${readErr.message}`, 'error');
                        return { synced: 0, error: readErr };
                    }
                    for (const ex of (Array.isArray(existingRows) ? existingRows : [])) {
                        const key = String(ex?.reference_number || '').trim();
                        const idx = dbRows.findIndex(r => r.reference_number === key);
                        if (idx === -1) continue;
                        const merged = mergeExistingForeignMatch(dbRows[idx], ex);
                        if (merged !== dbRows[idx]) {
                            dbRows[idx] = merged;
                            keptMatches.set(key, merged);
                        }
                    }
                }
            }

            for (let i = 0; i < dbRows.length; i += chunkSize) {
                const batch = dbRows.slice(i, i + chunkSize);
                const { error } = await supabase.from('foreign_transactions').upsert(batch, { onConflict: 'reference_number' });
                if (error) {
                    if (!silent) Toast.show(`Supabase sync failed: ${error.message}`, 'error');
                    return { synced: 0, error };
                }
            }

            // Keep this browser's copy in line with what was actually saved.
            if (keptMatches.size > 0) {
                (this.foreignTransactions || []).forEach(r => {
                    const kept = r && keptMatches.get(String(r.reference_number || '').trim());
                    if (!kept) return;
                    for (const f of FOREIGN_STUDENT_MATCH_FIELDS) r[f] = kept[f];
                });
            }
            // Saved: these rows are no longer "pending" in this browser's cache.
            const savedRefs = new Set(dbRows.map(r => r.reference_number));
            let cleared = false;
            (this.foreignTransactions || []).forEach(r => {
                if (r && r._pendingSync && savedRefs.has(r.reference_number)) {
                    delete r._pendingSync;
                    cleared = true;
                }
            });
            if (cleared) this.persistForeignTransactionsLocal();
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
            if (this.isDateInClosedPeriod(row.value_date || row.transaction_date)) {
                return row;
            }
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
            // Always start empty, however the window was closed last time (Esc / backdrop included).
            this.resetForeignImportModal();
            document.getElementById('modal-foreign-import')?.classList.remove('hidden');
            if (window.lucide) lucide.createIcons({ root: document.getElementById('modal-foreign-import') });
        });
        // Cancel and the × button discard the extracted statement.
        document.getElementById('modal-foreign-import')?.addEventListener('click', (e) => {
            if (e.target.closest('.btn-close, .modal-footer .btn-outline')) this.resetForeignImportModal();
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
                // Database rows win; cached rows missing from the database are re-uploaded only when
                // they are unsaved imports (_pendingSync). Others were deleted and must not come back.
                const { merged, pendingUpload: unsyncedLocal } = mergeForeignCloudAndLocal(this.foreignTransactions, data);
                this.foreignTransactions = merged.map((r, i) => this.normalizeForeignTransactionRow(r, i));

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
        // pdf.js 4.x (self-hosted in vendor/ for strict CSP and zero external CDN reliance).
        if (window.pdfjsLib) return window.pdfjsLib;
        const base = typeof window !== 'undefined' && window.location?.href
            ? new URL('./vendor/', window.location.href).href.replace(/\/$/, '')
            : './vendor';
        let lib;
        try {
            lib = await import(/* @vite-ignore */ `${base}/pdf.min.mjs`);
        } catch {
            throw new Error('Failed to load local PDF reader library');
        }
        if (!lib?.getDocument) throw new Error('PDF.js failed to initialize');
        lib.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.mjs`;
        window.pdfjsLib = lib;
        return lib;
    }

    async extractTextFromPdfFile(file) {
        const pdfjsLib = await this.loadPdfJsLibrary();
        const arrayBuffer = await file.arrayBuffer();
        // isEvalSupported:false: never compile font/function code with eval/new Function.
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
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

        return {
            text: reconstructBanqueMisrPdfLinesFromPages(pagesItems),
            layout: analyzeBanqueMisrPdfLayout(pagesItems)
        };
    }

    async parseSingleForeignStatementFile(file) {
        const name = String(file.name || '').toLowerCase();
        if (name.endsWith('.pdf')) {
            const { text, layout } = await this.extractTextFromPdfFile(file);
            return parseBanqueMisrPdfText(text, layout);
        }
        if (name.endsWith('.csv')) {
            await ensureImportLibs();
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
        await ensureXlsx();
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

            const parsedFiles = [];
            for (const file of files) {
                const parsed = await this.parseSingleForeignStatementFile(file);
                parsedFiles.push({ name: file.name, isPdf: /\.pdf$/i.test(file.name), parsed });
            }

            // The Excel/CSV statement is the data (exact cells). A PDF of the same account and period
            // is only used to cross-check it; a PDF without its Excel is imported with a warning.
            const { statements, integrity } = pairStatementFiles(parsedFiles);
            for (const st of statements) {
                lastMeta = st.parsed.metadata || lastMeta;
                combinedDeposits.push(...(st.parsed.deposits || []));
                combinedReversals.push(...(st.parsed.excludedReversals || []));
                combinedTreasury.push(...(st.parsed.excludedTreasury || []));
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
                excludedTreasury: combinedTreasury,
                integrity
            };

            this.foreignPreviewTab = 'deposits';
            document.getElementById('foreign-import-preview-panel')?.classList.remove('hidden');
            const btnConfirm = document.getElementById('btn-confirm-foreign-import');
            if (btnConfirm) {
                const blocked = integrity.errors.length > 0;
                btnConfirm.disabled = matchedDeposits.length === 0 || blocked;
                btnConfirm.innerHTML = blocked
                    ? '<i data-lucide="shield-alert"></i> Import blocked: fix the statement problems above'
                    : `<i data-lucide="check-circle"></i> Import ${matchedDeposits.length.toLocaleString()} Student Deposit${matchedDeposits.length === 1 ? '' : 's'}`;
            }

            this.renderForeignImportPreview();
            if (window.lucide) lucide.createIcons({ root: document.getElementById('modal-foreign-import') });
            if (integrity.errors.length > 0) {
                Toast.show(`Statement checks failed (${integrity.errors.length} problem(s)). The import is blocked until they are resolved.`, 'error');
            } else {
                Toast.show(`Extracted ${matchedDeposits.length} student deposits (${combinedReversals.length} reversal rows & ${combinedTreasury.length} bank ops excluded)`, 'success');
            }
        } catch (err) {
            console.error('Error parsing bank statement:', err);
            Toast.show('Failed to parse statement: ' + (err.message || err), 'error');
        }
    }

    renderForeignImportPreview() {
        const ext = this.pendingForeignExtraction;
        if (!ext) return;

        const metaBanner = document.getElementById('foreign-import-meta-banner');
        this.renderForeignIntegrityPanel(metaBanner, ext.integrity);
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

    /** Clears the statement import window back to its empty "drop files here" state. */
    resetForeignImportModal() {
        this.pendingForeignExtraction = null;
        this.foreignPreviewTab = 'deposits';
        document.getElementById('foreign-import-preview-panel')?.classList.add('hidden');
        for (const id of ['foreign-import-meta-banner', 'foreign-import-preview-body', 'foreign-preview-total-label']) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        document.getElementById('foreign-import-integrity')?.remove();
        for (const id of ['foreign-preview-deposits-count', 'foreign-preview-excluded-count']) {
            const el = document.getElementById(id);
            if (el) el.textContent = '0';
        }
        const input = document.getElementById('foreign-file-input');
        if (input) input.value = '';
        const btn = document.getElementById('btn-confirm-foreign-import');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i data-lucide="check-circle"></i> Save Student Deposits';
        }
    }

    renderForeignIntegrityPanel(afterEl, integrity) {
        if (!afterEl) return;
        let panel = document.getElementById('foreign-import-integrity');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'foreign-import-integrity';
            afterEl.insertAdjacentElement('afterend', panel);
        }
        const errors = integrity?.errors || [];
        const warnings = integrity?.warnings || [];
        const passed = integrity?.passed || [];
        const list = (items) => `<ul style="margin: 0.35rem 0 0 1.1rem; padding: 0;">${items.map(t => `<li style="margin: 0.2rem 0;">${escapeHTML(t)}</li>`).join('')}</ul>`;
        const box = (bg, border, color, title, items) => `<div style="padding: 0.65rem 0.9rem; border-radius: 8px; background: ${bg}; border: 1px solid ${border}; color: ${color}; font-size: 0.8rem; line-height: 1.45;"><strong>${title}</strong>${list(items)}</div>`;
        panel.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
        panel.innerHTML = [
            errors.length ? box('rgba(239,68,68,0.10)', 'rgba(239,68,68,0.45)', 'var(--danger)', `Import blocked: ${errors.length} problem(s) with the statement`, errors) : '',
            warnings.length ? box('rgba(245,158,11,0.10)', 'rgba(245,158,11,0.45)', 'var(--warning, #f59e0b)', `Check before importing: ${warnings.length} warning(s)`, warnings) : '',
            !errors.length && passed.length ? box('rgba(16,185,129,0.10)', 'rgba(16,185,129,0.40)', 'var(--success)', 'Statement checks passed', passed) : ''
        ].join('');
    }

    async savePendingForeignDeposits() {
        const ext = this.pendingForeignExtraction;
        if (!ext || !Array.isArray(ext.deposits) || ext.deposits.length === 0) return;
        if (ext.integrity?.errors?.length) {
            Toast.show('This statement failed its checks, so it cannot be imported. See the problems listed above the preview.', 'error');
            return;
        }

        const baseIdx = (this.foreignTransactions || []).length;
        const incomingRows = ext.deposits.map((d, i) => {
            const norm = this.normalizeForeignTransactionRow(d, baseIdx + i);
            norm._uid = `${norm.reference_number}_${Date.now()}_${baseIdx + i}`;
            // Marked until the database confirms the save; only marked rows are ever re-uploaded
            // from this browser's cache.
            norm._pendingSync = true;
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
        this.resetForeignImportModal();
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
            const { statusClass, shortStatus } = formatIdStatusMeta(t, { defaultStatus: 'Missing ID' });

            const rowCurrency = t.currency || currency;
            const stuLevelBadge = this.renderStudentLevelBadge(this.getTransactionStudentLevel(t));
            const refVal = String(t.reference_number || '').trim();
            const sidVal = String(t.student_id || '').trim();

            return `
                <tr class="foreign-tx-row" data-idx="${idx}" style="cursor: pointer;" title="Click to inspect full transaction details">
                    <td style="white-space: nowrap;"><strong>${escapeHTML(t.reference_number)}</strong>${refVal ? `<button type="button" class="inline-copy-btn" data-copy-text="${escapeHTML(refVal)}" data-copy-label="Reference" title="Copy Reference Number">${inlineIcon('copy', 12)}</button>` : ''}</td>
                    <td style="white-space: nowrap;">${escapeHTML(toDateOnly(t.value_date || t.payment_date || t.transaction_date))}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 165px; font-size: 0.85rem; line-height: 1.3;"><strong>${escapeHTML(t.student_id || '')}</strong>${sidVal ? `<button type="button" class="inline-copy-btn" data-copy-text="${escapeHTML(sidVal)}" data-copy-label="Student ID" title="Copy Student ID">${inlineIcon('copy', 12)}</button>` : ''}${stuLevelBadge}</td>
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

        tbody.querySelectorAll('[data-copy-text]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyTextWithToast(btn.getAttribute('data-copy-text'), btn.getAttribute('data-copy-label') || 'Value', btn);
            });
        });

        tbody.querySelectorAll('.foreign-fix-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const row = pageRows[parseInt(btn.getAttribute('data-idx'), 10)];
                if (row) this.openForeignFixModal(row);
            });
        });

        tbody.querySelectorAll('.foreign-tx-row').forEach(tr => {
            tr.addEventListener('click', () => {
                const idx = parseInt(tr.getAttribute('data-idx'), 10);
                const row = pageRows[idx];
                if (row) this.openForeignTransactionDetailsModal(row, { list: pageRows, index: idx });
            });
        });

        if (window.lucide) lucide.createIcons({ root: tbody });
    }

    async openForeignTransactionDetailsModal(row, navCtx = null) {
        const modal = document.getElementById('modal-tx-details');
        const body = document.getElementById('modal-tx-details-body');
        if (!modal || !body || !row) return;
        this.bindTxDrawerNav?.(navCtx);

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

        const closedRow = matchingRows.find(r => this.isDateInClosedPeriod(r.value_date || r.transaction_date));
        if (closedRow) {
            const closedMonth = toPeriodMonth(closedRow.value_date || closedRow.transaction_date);
            Toast.show(`Accounting period ${closedMonth} is closed. Ask an Admin for an audited unlock before editing Ref ${ref}.`, 'error');
            return;
        }

        // Sync with Manual Fixes (manual_fixes table first, respecting DB period-lock triggers)
        const fixRecord = newId ? {
            reference_number: ref,
            correct_id: newId,
            item_name: null,
            mapping: DEFAULT_FOREIGN_MAPPING,
            second_mapping: null
        } : null;

        if (fixRecord) {
            try {
                const { error: fixErr } = await supabase.from('manual_fixes').upsert([fixRecord], { onConflict: 'reference_number' });
                if (fixErr) {
                    Toast.show(`Failed to save fix for Ref ${ref}: ${fixErr.message}`, 'error');
                    return;
                }
            } catch (err) {
                if (err?.message && /closed/i.test(err.message)) {
                    Toast.show(err.message, 'error');
                    return;
                }
                // ignore offline errors in local mode
            }
        }

        try {
            const { error: fxErr } = await supabase.from('foreign_transactions').update({
                student_id: newId,
                matched_student_name: newName || matchingRows[0]?.matched_student_name || null,
                id_status: status,
                match_source: newId ? 'manual' : 'unmatched'
            }).eq('reference_number', ref);
            if (fxErr) {
                Toast.show(`Failed to update BM transaction ${ref}: ${fxErr.message}`, 'error');
                return;
            }
        } catch (err) {
            if (err?.message && /closed/i.test(err.message)) {
                Toast.show(err.message, 'error');
                return;
            }
            // ignore if table not migrated yet / offline
        }

        matchingRows.forEach(target => {
            target.student_id = newId;
            target.matched_student_name = newName || target.matched_student_name;
            target.id_status = status;
            target.match_source = newId ? 'manual' : 'unmatched';
        });

        if (fixRecord && Array.isArray(this.allFixesData)) {
            const key = String(ref).trim().toLowerCase();
            this.allFixesData = this.allFixesData.filter(f => String(f.reference_number || '').trim().toLowerCase() !== key);
            this.allFixesData.push(fixRecord);
            this.allFixesData.sort((a, b) => String(a.reference_number || '').localeCompare(String(b.reference_number || '')));
            this.updateFixesStatsAndDropdowns(this.allFixesData);
        }

        this.persistForeignTransactionsLocal();

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
                // The description is part of the key: this grouping crosses reference_numbers, so
                // two different deposits sharing a transaction_ref / amount / date must not merge.
                const txDesc = String(tx.description || tx.item_name || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const txKey = `${tx.transaction_ref}|${Number(tx.amount || tx.item_price || 0).toFixed(2)}|${toDateOnly(tx.value_date || tx.payment_date)}|${txDesc}`;
                if (!txRefGrouped[txKey]) txRefGrouped[txKey] = [];
                txRefGrouped[txKey].push(tx);
            }

            const duplicates = [];
            const toDeleteUidsSet = new Set();

            let protectedSkipped = 0;
            const processGroup = (txs) => {
                if (txs.length <= 1) return;
                // Keep the ERP-posted copy first, then Valid Student ID, then manual match
                txs.sort((a, b) => scoreForeignDuplicateKeepCopy(b) - scoreForeignDuplicateKeepCopy(a));

                let addedAny = false;
                for (let i = 1; i < txs.length; i++) {
                    // Never delete a posted deposit or one in a closed accounting period.
                    if (isProtectedForeignRow(txs[i], d => this.isDateInClosedPeriod?.(d))) {
                        protectedSkipped++;
                        continue;
                    }
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
                summaryEl.innerText = `Found ${duplicates.length} duplicated foreign transaction(s) (${toDeleteUidsSet.size} extra row(s) will be removed). ERP-posted, Valid and manually matched copies are always kept.${protectedSkipped > 0 ? ` ${protectedSkipped} ERP-posted / closed-period copy(ies) are never deleted.` : ''}`;
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
            const isProtected = r => isProtectedForeignRow(r, d => this.isDateInClosedPeriod?.(d));
            existingList.forEach(r => {
                // Re-checked at delete time: the row may have been posted since detection.
                if (uids.has(r._uid) && !isProtected(r)) {
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

            let dbDeleted = 0;
            let dbError = null;
            if (orphanedRefs.length > 0 && this.hasRole('admin')) {
                // Server-side guard as well: never delete a row that is (now) ERP-posted. Closed
                // periods are refused by the server / DB trigger, and that error is reported.
                for (let i = 0; i < orphanedRefs.length && !dbError; i += 200) {
                    const { data, error } = await supabase.from('foreign_transactions')
                        .delete()
                        .in('reference_number', orphanedRefs.slice(i, i + 200))
                        .is('erp_batch_number', null)
                        .select('reference_number');
                    if (error) dbError = error;
                    else dbDeleted += Array.isArray(data) ? data.length : 0;
                }
            }

            document.getElementById('modal-detect-duplicates')?.classList.add('hidden');
            window.duplicateForeignUidsToDelete = [];
            this.invalidateTabs('dashboard', 'erp-export');
            this.applyForeignFilters();
            const skippedProtected = uids.size - deletedCount;
            const protectedNote = skippedProtected > 0 ? ` ${skippedProtected} ERP-posted / closed-period row(s) were kept.` : '';
            if (dbError) {
                Toast.show(`Removed ${deletedCount} duplicate(s) from this browser, but the database delete FAILED (${dbError.message}); ${dbDeleted} of ${orphanedRefs.length} database row(s) were deleted. Reload BM Transactions before retrying.${protectedNote}`, 'error');
            } else if (orphanedRefs.length > 0 && dbDeleted < orphanedRefs.length && this.hasRole('admin')) {
                Toast.show(`Deleted ${deletedCount} duplicate foreign transaction(s); ${orphanedRefs.length - dbDeleted} database row(s) were left because they are ERP-posted or already gone.${protectedNote}`, 'warning');
            } else {
                Toast.show(`Successfully deleted ${deletedCount} duplicate foreign transaction(s).${protectedNote}`, 'success');
            }
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
                        // Start from the database's current rows: this saves every row back, so a
                        // page left open since before a delete must not resurrect deleted deposits.
                        await this.loadForeignTransactions();
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
        if (typeof XLSX === 'undefined') {
            ensureXlsx().then(() => this.exportForeignTransactionsExcel()).catch(() => Toast.show('Excel library failed to load.', 'error'));
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

export function applyForeignUiMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(ForeignUiMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(ForeignUiMixin.prototype, name));
        }
    }
}
