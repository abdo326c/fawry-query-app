import { supabase } from './supabase.js';
import {
    getEffectiveIdStatus,
    isNonInvalidTransaction,
    fetchAll,
    escapeHTML,
    sanitizeExcelValue,
    toDateOnly,
    dateToExcelSerial,
    calculateSettlementDate,
    isSameDaySettlementBank,
    resolveErpJournalDate,
    writeCompressedExcel
} from './rules.js';
import { DEFAULT_FOREIGN_BANK, DEFAULT_FOREIGN_MAPPING } from './foreign-transactions.js';
import { renderIcons, formatMoney, Toast } from './app-utils.js';

class ErpExportMixin {
    initErpExport() {
        this.erpStatusFilter = 'all';
        this.erpSearchQuery = '';

        const dateFrom = document.getElementById('erp-filter-date-from');
        const dateTo = document.getElementById('erp-filter-date-to');
        const bankFilter = document.getElementById('erp-filter-bank');
        const batchFilter = document.getElementById('erp-filter-batch');
        const itemNameFilter = document.getElementById('erp-filter-item-name');
        const mappingFilter = document.getElementById('erp-filter-mapping');
        const searchInput = document.getElementById('erp-search');
        const btnExport = document.getElementById('btn-export-erp-file');
        const btnRecord = document.getElementById('btn-record-erp');
        const chkValidOnly = document.getElementById('erp-record-valid-only');

        const setDefaultMonthDates = () => {
            if (!dateFrom || !dateTo) return;
            const now = new Date();
            dateFrom.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            dateTo.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        };

        if (dateFrom && dateTo) {
            setDefaultMonthDates();
            dateFrom.addEventListener('change', () => this.loadErpExport());
            dateTo.addEventListener('change', () => this.loadErpExport());
        }

        if (bankFilter) {
            bankFilter.addEventListener('change', () => this.loadErpExport());
        }

        if (batchFilter) {
            batchFilter.addEventListener('change', () => this.loadErpExport({ refresh: false }));
        }

        let erpSearchTimeout;
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(erpSearchTimeout);
                erpSearchTimeout = setTimeout(() => {
                    this.erpSearchQuery = (e.target.value || '').trim().toLowerCase();
                    this.loadErpExport({ refresh: false });
                }, 200);
            });
        }

        document.querySelectorAll('.erp-date-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!dateFrom || !dateTo) return;
                const preset = btn.getAttribute('data-preset');
                const now = new Date();
                const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (preset === 'today') {
                    dateFrom.value = fmt(now);
                    dateTo.value = fmt(now);
                } else if (preset === 'yesterday') {
                    const y = new Date(now);
                    y.setDate(y.getDate() - 1);
                    dateFrom.value = fmt(y);
                    dateTo.value = fmt(y);
                } else if (preset === '7d') {
                    const s = new Date(now);
                    s.setDate(s.getDate() - 6);
                    dateFrom.value = fmt(s);
                    dateTo.value = fmt(now);
                } else if (preset === 'this_month') {
                    setDefaultMonthDates();
                } else if (preset === 'last_month') {
                    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    const last = new Date(now.getFullYear(), now.getMonth(), 0);
                    dateFrom.value = fmt(first);
                    dateTo.value = fmt(last);
                }
                this.loadErpExport();
            });
        });

        document.querySelectorAll('[data-erp-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-erp-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.erpStatusFilter = btn.getAttribute('data-erp-filter') || 'all';
                this.loadErpExport({ refresh: false });
            });
        });

        document.getElementById('btn-clear-erp-filters')?.addEventListener('click', () => {
            setDefaultMonthDates();
            if (bankFilter) bankFilter.value = '';
            if (batchFilter) batchFilter.value = '';
            if (searchInput) searchInput.value = '';
            this.erpSearchQuery = '';
            this.erpStatusFilter = 'all';
            document.querySelectorAll('[data-erp-filter]').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-erp-filter') === 'all');
            });
            if (this.erpItemNameSelect) this.erpItemNameSelect.clear(true);
            if (this.erpMappingSelect) this.erpMappingSelect.clear(true);
            this.loadErpExport();
        });

        chkValidOnly?.addEventListener('change', () => this.updateErpRecordButtonLabel());
        
        // Item / Mapping only narrow the already-loaded rows – no new request
        if (itemNameFilter && window.TomSelect) {
            this.erpItemNameSelect = itemNameFilter.tomselect || new TomSelect(itemNameFilter, {
                plugins: ['remove_button'],
                placeholder: "All Items",
                onChange: () => this.loadErpExport({ refresh: false })
            });
        } else if (itemNameFilter) {
            itemNameFilter.addEventListener('change', () => this.loadErpExport({ refresh: false }));
        }

        if (mappingFilter && window.TomSelect) {
            this.erpMappingSelect = mappingFilter.tomselect || new TomSelect(mappingFilter, {
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
     * Fills the Item Name / Mapping / ERP Batch dropdowns from rows already loaded for the current
     * date range + bank (no extra request).
     */
    updateErpDropdowns(baseData = this.erpBaseData || []) {
        const items = [...new Set(baseData.map(d => d.item_name).filter(Boolean))].sort();
        const mappings = [...new Set(baseData.map(d => d.mapping).filter(Boolean))].sort();
        const batches = [...new Set(baseData.map(d => d.erp_batch_number).filter(Boolean))].sort();

        const itemSelect = document.getElementById('erp-filter-item-name');
        const mappingSelect = document.getElementById('erp-filter-mapping');
        const batchSelect = document.getElementById('erp-filter-batch');

        if (batchSelect) {
            const currentBatch = batchSelect.value;
            batchSelect.innerHTML = `<option value="">All Batches (${batches.length})</option>` +
                batches.map(b => `<option value="${escapeHTML(b)}">${escapeHTML(b)}</option>`).join('');
            if (batches.includes(currentBatch)) batchSelect.value = currentBatch;
        }

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

    formatErpCurrencySummary(rows = []) {
        if (!rows || rows.length === 0) return 'EGP 0.00';
        const totals = new Map();
        for (const r of rows) {
            const cur = String(r.currency || 'EGP').toUpperCase();
            totals.set(cur, (totals.get(cur) || 0) + this.erpAmount(r));
        }
        return [...totals.entries()].map(([cur, amt]) => `${cur} ${formatMoney(amt)}`).join(' · ');
    }

    async fetchForeignRowsForErp(dateFrom, dateTo) {
        const byRef = new Map();
        const localByRef = new Map();
        (this.foreignTransactions || []).forEach(r => {
            const key = String(r.reference_number || '').trim();
            if (key) localByRef.set(key, r);
        });
        let dbLoaded = false;
        try {
            const dbForeign = await fetchAll(
                'foreign_transactions',
                'reference_number, transaction_ref, transaction_code, event, value_date, transaction_date, transaction_datetime, amount, currency, account_number, student_id, extracted_name, matched_student_name, handler_name, deposit_method, description, id_status, match_source, erp_batch_number, erp_voucher',
                fq => {
                    if (dateFrom) fq = fq.gte('value_date', dateFrom);
                    if (dateTo) fq = fq.lte('value_date', dateTo);
                    return fq;
                },
                // Must be a UNIQUE column: fetchAll pages with "> last value", so a non-unique
                // column (value_date) silently skipped same-day rows at every 1,000-row boundary.
                'reference_number'
            );
            if (Array.isArray(dbForeign)) {
                dbLoaded = true;
                // The database is the source of truth: student IDs corrected by other users,
                // ERP batches (including cleared ones) and deleted duplicates all come from here.
                // Locally cached fields only fill gaps the DB row doesn't have (e.g. mapping).
                dbForeign.forEach(r => {
                    const key = String(r.reference_number || '').trim();
                    if (!key) return;
                    const local = localByRef.get(key);
                    byRef.set(key, local ? { ...local, ...r, erp_batch_number: r.erp_batch_number ?? null, erp_voucher: r.erp_voucher ?? null } : r);
                });
            }
        } catch (err) {
            console.warn("Could not load BM (USD) deposits from Supabase; using this browser's cached copy:", err?.message || err);
        }
        if (!dbLoaded) {
            // Offline / table not migrated: fall back to the local cache only.
            localByRef.forEach((r, key) => byRef.set(key, r));
            Toast.show("BM (USD) deposits could not be loaded from the database; the ERP preview uses this browser's cached copy, which may be out of date.", 'warning');
        }

        const foreignRows = [];
        let idx = 0;
        for (const raw of byRef.values()) {
            const norm = this.normalizeForeignTransactionRow(raw, idx++);
            const effDate = toDateOnly(norm.value_date || norm.payment_date || norm.transaction_date);
            if (dateFrom && (!effDate || effDate < dateFrom)) continue;
            if (dateTo && (!effDate || effDate > dateTo)) continue;
            const erpRow = {
                ...norm,
                _erpSource: 'foreign',
                payment_date: effDate,
                item_price: Number(norm.amount ?? norm.item_price) || 0,
                item_name: norm.description || norm.item_name || '',
                mapping: norm.mapping || DEFAULT_FOREIGN_MAPPING,
                second_mapping: norm.second_mapping || '',
                bank: DEFAULT_FOREIGN_BANK,
                currency: norm.currency || 'USD'
            };
            erpRow._erpSearchHaystack = [
                erpRow.reference_number,
                erpRow.transaction_ref,
                erpRow.student_id,
                this.erpAccount(erpRow),
                erpRow.item_name,
                erpRow.matched_student_name,
                erpRow.extracted_name,
                erpRow.mapping,
                erpRow.second_mapping,
                erpRow.erp_batch_number,
                erpRow.erp_voucher
            ].filter(Boolean).join('\n').toLowerCase();
            foreignRows.push(erpRow);
        }
        return foreignRows;
    }

    /**
     * @param {{refresh?: boolean}} [opts]
     *   refresh – re-download the date/bank range from the database (default true).
     *             Item / Mapping / Status / Search filter changes pass false and just re-filter the loaded rows.
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
                const includeFawry = bank !== DEFAULT_FOREIGN_BANK;
                const includeForeign = !bank || bank === DEFAULT_FOREIGN_BANK;

                let fawryRows = [];
                if (includeFawry) {
                    const erpCols = 'id, reference_number, payment_date, student_id, original_student_id, customer_mobile, total_amount, net_amount, fawry_fees, payment_status, item_name, check_column, item_price, mapping, second_mapping, merchant_name, bank, id_status, is_settled, settlement_batch, erp_batch_number, erp_voucher';
                    fawryRows = await fetchAll('transactions', erpCols, q => {
                        if (dateFrom) q = q.gte('payment_date', dateFrom);
                        if (dateTo) q = q.lte('payment_date', dateTo);
                        if (bank) q = q.eq('bank', bank);
                        return q;
                    }, 'id');
                    for (let i = 0; i < fawryRows.length; i++) {
                        const t = fawryRows[i];
                        t._erpSource = 'fawry';
                        t.currency = t.currency || 'EGP';
                        t._erpSearchHaystack = [
                            t.reference_number,
                            t.student_id,
                            this.erpAccount(t),
                            t.item_name,
                            t.mapping,
                            t.second_mapping,
                            t.erp_batch_number,
                            t.erp_voucher
                        ].filter(Boolean).join('\n').toLowerCase();
                    }
                }

                const foreignRows = includeForeign ? await this.fetchForeignRowsForErp(dateFrom, dateTo) : [];
                baseData = [...fawryRows, ...foreignRows];
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

        // Read the item / mapping / batch / status / search selection AFTER the dropdowns were refreshed
        const itemNameSelect = document.getElementById('erp-filter-item-name');
        const mappingSelect = document.getElementById('erp-filter-mapping');
        const batchFilter = document.getElementById('erp-filter-batch')?.value || '';
        const statusFilter = this.erpStatusFilter || 'all';
        const q = (this.erpSearchQuery || '').trim().toLowerCase();
        
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
        this.erpData = (this.erpBaseData || []).filter(t => {
            if (itemSet.size > 0 && !itemSet.has(t.item_name)) return false;
            if (mappingSet.size > 0 && !mappingSet.has(t.mapping)) return false;
            if (batchFilter && (t.erp_batch_number || '') !== batchFilter) return false;

            const isValid = !t.id_status || t.id_status === 'Valid';
            const isRecorded = Boolean(t.erp_batch_number);

            if (statusFilter === 'ready' && (!isValid || isRecorded)) return false;
            if (statusFilter === 'unposted' && isRecorded) return false;
            if (statusFilter === 'recorded' && !isRecorded) return false;
            if (statusFilter === 'invalid' && isValid) return false;
            if (statusFilter === 'settled' && !t.is_settled) return false;

            if (q) {
                const hay = t._erpSearchHaystack ?? [
                    t.reference_number,
                    t.student_id,
                    this.erpAccount(t),
                    t.item_name,
                    t.mapping,
                    t.second_mapping,
                    t.erp_batch_number,
                    t.erp_voucher
                ].filter(Boolean).join('\n').toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        this.erpPage = 1;
        this.renderErpPreview();
        this.markTabLoaded('erp-export');
    }

    updateErpRecordButtonLabel() {
        const labelEl = document.getElementById('btn-record-erp-label');
        if (!labelEl) return;
        const rows = this.erpData || [];
        const validOnly = document.getElementById('erp-record-valid-only')?.checked ?? true;
        const eligible = rows.filter(r => !r.erp_batch_number && (!validOnly || !r.id_status || isNonInvalidTransaction(r)));
        labelEl.textContent = eligible.length > 0 ? `Save References (${eligible.length.toLocaleString()} lines)` : 'Save References';
    }

    openManualFixFromErp(tx) {
        if (!tx) return;
        document.getElementById('modal-erp-warning')?.classList.add('hidden');
        const modal = document.getElementById('modal-fix');
        if (!modal) return;
        this.resetFixModal('Add Manual Fix');
        const refInput = document.getElementById('fix-ref');
        if (refInput) {
            refInput.value = tx.reference_number || '';
            refInput.readOnly = false;
            refInput.dispatchEvent(new Event('input'));
        }
        const idInput = document.getElementById('fix-id');
        if (idInput) {
            idInput.value = (tx.id_status === 'Valid' && tx.student_id) ? tx.student_id : '';
            idInput.dispatchEvent(new Event('input'));
        }
        const itemInput = document.getElementById('fix-name');
        if (itemInput) itemInput.value = '';
        const mapInput = document.getElementById('fix-mapping');
        if (mapInput) mapInput.value = '';
        const map2Input = document.getElementById('fix-second-mapping');
        if (map2Input) map2Input.value = '';
        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    }

    renderErpPreview() {
        const tbody = document.getElementById('erp-preview-body');
        if (!tbody) return;

        const rows = this.erpData || [];
        const summaryCard = document.getElementById('erp-summary-card');
        if (summaryCard) {
            summaryCard.style.display = '';
            const validCnt = rows.filter(r => !r.id_status || isNonInvalidTransaction(r)).length;
            const invalidCnt = rows.length - validCnt;
            const recordedCnt = rows.filter(r => r.erp_batch_number).length;
            const readyCnt = rows.filter(r => (!r.id_status || isNonInvalidTransaction(r)) && !r.erp_batch_number).length;

            const elTotal = document.getElementById('erp-stat-total');
            const elAmount = document.getElementById('erp-stat-amount');
            const elReady = document.getElementById('erp-stat-ready');
            const elValid = document.getElementById('erp-stat-valid');
            const elInvalid = document.getElementById('erp-stat-invalid');
            const elRecorded = document.getElementById('erp-stat-recorded');

            if (elTotal) elTotal.textContent = rows.length.toLocaleString();
            if (elAmount) elAmount.textContent = this.formatErpCurrencySummary(rows);
            if (elReady) elReady.textContent = readyCnt.toLocaleString();
            if (elValid) elValid.textContent = validCnt.toLocaleString();
            if (elInvalid) elInvalid.textContent = invalidCnt.toLocaleString();
            if (elRecorded) elRecorded.textContent = recordedCnt.toLocaleString();
        }

        this.updateErpRecordButtonLabel();

        tbody.innerHTML = '';
        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">No transactions match the selected ERP filters.</td></tr>';
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
            const effStatus = row.id_status ? getEffectiveIdStatus(row) : 'Valid';
            const isValid = effStatus === 'Valid' || effStatus === 'Exempt';
            const isExempt = effStatus === 'Exempt';
            const descriptionTail = `/${row.item_name || ''}/${row.mapping || ''}/${row.second_mapping || ''}/${row.student_id || ''}`;
            const tr = document.createElement('tr');
            if (!isValid) {
                tr.style.background = 'rgba(239, 68, 68, 0.04)';
            }

            const accountCellHtml = isValid
                ? `<div>
                        <span style="font-family: monospace; font-weight: 600;">${escapeHTML(paddedAccount || '-')}</span>
                        ${isExempt ? `<div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">Exempt (Dip &amp; Workshop)</div>` : ''}
                   </div>`
                : `<div>
                        <span class="badge" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); font-family: monospace; font-weight: 700;">${escapeHTML(paddedAccount || 'Missing ID')}</span>
                        <div style="font-size: 0.72rem; color: var(--danger); margin-top: 2px;">${escapeHTML(row.id_status)}</div>
                   </div>`;

            let erpStatusHtml = '';
            const canManageErp = this.hasRole('accountant');
            const isForeignRow = isSameDaySettlementBank(row);
            if (row.erp_batch_number) {
                erpStatusHtml = `
                    <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
                        <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; font-size: 0.72rem;" title="${row.erp_voucher ? 'Voucher: ' + escapeHTML(row.erp_voucher) : 'Posted to ERP'}">
                            Batch: ${escapeHTML(row.erp_batch_number)}${row.erp_voucher ? ` (${escapeHTML(row.erp_voucher)})` : ''}
                        </span>
                        ${canManageErp ? `<button type="button" class="btn-icon erp-unlink-batch-btn" data-id="${escapeHTML(row.id ?? '')}" data-ref="${escapeHTML(row.reference_number || '')}" data-source="${isForeignRow ? 'foreign' : 'fawry'}" data-batch="${escapeHTML(row.erp_batch_number)}" title="Clear ERP Batch Reference" style="width: 22px; height: 22px; padding: 0; color: var(--text-muted);">
                            <i data-lucide="x" style="width: 13px; height: 13px;"></i>
                        </button>` : ''}
                    </div>`;
            } else if (!isValid) {
                erpStatusHtml = canManageErp ? `
                    <button type="button" class="btn btn-outline btn-sm erp-fix-row-btn" data-idx="${index}" style="padding: 0.2rem 0.55rem; font-size: 0.74rem; height: 26px; color: var(--warning, #f59e0b); border-color: rgba(245, 158, 11, 0.4);">
                        <i data-lucide="wrench" style="width: 12px; height: 12px;"></i> Fix ID
                    </button>` : `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: var(--danger); font-size: 0.72rem;">Needs Fix</span>`;
            } else {
                erpStatusHtml = `<span class="badge" style="background: rgba(16, 185, 129, 0.14); color: #10b981; font-size: 0.72rem;">Ready</span>`;
            }

            const payDate = toDateOnly(row.value_date || row.payment_date || row.transaction_date) || '';
            const stlDate = isForeignRow ? payDate : (calculateSettlementDate(payDate) || '');
            const stlDay = this.erpDayShort(stlDate);
            const dateCellHtml = `
                <div style="line-height: 1.25;">
                    <div style="font-weight: 500;">${escapeHTML(payDate)}</div>
                    ${isForeignRow
                        ? `<div style="font-size: 0.7rem; color: #10b981; margin-top: 2px;" title="Foreign bank deposit settles on the same Value Date (no next-day shift)">Same Date${stlDay ? ` (${escapeHTML(stlDay)})` : ''}</div>`
                        : (stlDate ? `<div style="font-size: 0.7rem; color: #38bdf8; margin-top: 2px;" title="Auto-calculated Fawry bank settlement date (Sun-Wed +1d, Thu/Fri/Sat -> Sun)">Settles: ${escapeHTML(stlDate)}${stlDay ? ` (${escapeHTML(stlDay)})` : ''}</div>` : '')
                    }
                </div>`;

            const rowCur = String(row.currency || 'EGP').toUpperCase();
            const creditDisplay = `${rowCur !== 'EGP' ? escapeHTML(rowCur) + ' ' : ''}${escapeHTML(formatMoney(this.erpAmount(row)))}`;

            tr.innerHTML = `
                <td style="white-space: nowrap;">${dateCellHtml}</td>
                <td>${accountCellHtml}</td>
                <td>
                    <a href="#" class="erp-ref-inspect-link" data-idx="${index}" style="font-family: monospace; font-weight: 600; color: var(--primary); text-decoration: none;" title="Click to inspect transaction details">${escapeHTML(row.reference_number || '')}</a><span style="color: var(--text-secondary);">${escapeHTML(descriptionTail)}</span>
                </td>
                <td style="text-align: right; font-weight: 600; white-space: nowrap;">${creditDisplay}</td>
                <td style="white-space: nowrap;">
                    <span>${escapeHTML(row.bank || '')}</span>
                    ${row.is_settled ? `<span class="badge badge-success" style="font-size: 0.68rem; margin-left: 4px; padding: 0.1rem 0.45rem;">Settled</span>` : ''}
                </td>
                <td style="white-space: nowrap;">${erpStatusHtml}</td>
                <td style="text-align: right; color: var(--text-muted);">${startIdx + index + 1}</td>
            `;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.erp-ref-inspect-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const idx = parseInt(link.getAttribute('data-idx'), 10);
                const tx = previewData[idx];
                if (tx && typeof this.openTransactionDetailsModal === 'function') {
                    this.openTransactionDetailsModal(tx);
                }
            });
        });

        tbody.querySelectorAll('.erp-fix-row-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                const tx = previewData[idx];
                if (!tx) return;
                if (isSameDaySettlementBank(tx)) {
                    this.openForeignFixModal(tx);
                } else {
                    this.openManualFixFromErp(tx);
                }
            });
        });

        tbody.querySelectorAll('.erp-unlink-batch-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                const ref = btn.getAttribute('data-ref');
                const source = btn.getAttribute('data-source') || 'fawry';
                const batch = btn.getAttribute('data-batch');
                if (source === 'fawry' && !id) return;
                if (source === 'foreign' && !ref) return;
                if (!await window.customConfirm(`Clear ERP Batch "${batch}" from this transaction so it can be re-exported?`, 'Clear Batch', 'Cancel')) {
                    return;
                }
                try {
                    if (source === 'foreign') {
                        const { error: fErr } = await supabase.from('foreign_transactions').update({ erp_batch_number: null, erp_voucher: null }).eq('reference_number', ref);
                        if (fErr) throw fErr;
                        (this.foreignTransactions || []).forEach(r => {
                            if (r.reference_number === ref) {
                                r.erp_batch_number = null;
                                r.erp_voucher = null;
                            }
                        });
                        this.persistForeignTransactionsLocal();
                        await this.logAudit('ERP Batch Unlinked (Foreign)', String(ref), {
                            reference_number: ref,
                            cleared_batch: batch
                        });
                    } else {
                        const prevRow = (this.erpData || []).find(r => String(r.id) === String(id));
                        const { error } = await supabase.from('transactions').update({ erp_batch_number: null, erp_voucher: null }).eq('id', id);
                        if (error) throw error;
                        await this.logAudit('ERP Batch Unlinked', String(prevRow?.reference_number || id), {
                            transaction_id: id,
                            cleared_batch: batch,
                            revert_data: {
                                table_name: 'transactions_erp',
                                operation: 'update',
                                previous_rows: [{ id, erp_batch_number: batch, erp_voucher: prevRow?.erp_voucher || null }]
                            }
                        });
                    }
                    Toast.show('Cleared ERP batch reference', 'success');
                    await this.loadErpExport({ refresh: true });
                } catch (err) {
                    Toast.show('Failed to clear batch: ' + err.message, 'error');
                }
            });
        });

        if (window.lucide) lucide.createIcons({ root: tbody });

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
                    <div class="pagination-controls" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn btn-icon" id="btn-erp-prev" ${this.erpPage <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
                        <span>Page ${this.erpPage} of ${totalPages}</span>
                        <button class="btn btn-icon" id="btn-erp-next" ${this.erpPage >= totalPages ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
                        ${this.pageJump.renderHtml('erp', totalPages)}
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
                this.pageJump.bind('erp', totalPages, (target) => {
                    this.erpPage = target;
                    this.renderErpPreview();
                }, pager);
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

    erpDayShort(dateStr) {
        const clean = toDateOnly(dateStr);
        if (!clean) return '';
        const parts = clean.split('-');
        if (parts.length !== 3) return '';
        const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
        if (isNaN(d.getTime())) return '';
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] || '';
    }

    resolveErpExportDate(row, dateMode = 'settlement', customDate = null) {
        return resolveErpJournalDate(row, dateMode, customDate);
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

        const invalidTransactions = rows.filter(row => row.id_status && !isNonInvalidTransaction(row));
        const validTransactions = rows.filter(row => !row.id_status || isNonInvalidTransaction(row));

        if (invalidTransactions.length > 0) {
            const canFixErp = this.hasRole('accountant');
            const tbody = document.getElementById('erp-warning-table-body');
            tbody.innerHTML = invalidTransactions.map((t, idx) => {
                const rowCur = String(t.currency || 'EGP').toUpperCase();
                return `
                <tr>
                    <td style="font-family: monospace; font-weight: 600;">${escapeHTML(t.reference_number || '')}</td>
                    <td style="color: var(--danger); font-weight: bold; font-family: monospace;">${escapeHTML(t.student_id || 'Missing')}</td>
                    <td style="text-align: right; font-weight: 600;">${rowCur !== 'EGP' ? escapeHTML(rowCur) + ' ' : ''}${escapeHTML(formatMoney(this.erpAmount(t)))}</td>
                    <td><span class="badge" style="background: rgba(239,68,68,0.15); color: var(--danger); font-size: 0.74rem;">${escapeHTML(t.id_status)}</span></td>
                    <td style="text-align: right;">
                        ${canFixErp ? `<button type="button" class="btn btn-outline btn-sm erp-modal-fix-btn" data-idx="${idx}" style="padding: 0.2rem 0.55rem; font-size: 0.74rem; height: 26px;">
                            <i data-lucide="wrench" style="width: 12px; height: 12px;"></i> Fix
                        </button>` : '-'}
                    </td>
                </tr>`;
            }).join('');

            tbody.querySelectorAll('.erp-modal-fix-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-idx'), 10);
                    const tx = invalidTransactions[idx];
                    if (!tx) return;
                    if (isSameDaySettlementBank(tx)) {
                        document.getElementById('modal-erp-warning')?.classList.add('hidden');
                        this.openForeignFixModal(tx);
                    } else {
                        this.openManualFixFromErp(tx);
                    }
                });
            });

            const btnExportValidOnly = document.getElementById('btn-erp-export-valid-only');
            if (btnExportValidOnly) {
                btnExportValidOnly.disabled = validTransactions.length === 0;
                btnExportValidOnly.innerHTML = `<i data-lucide="check-circle"></i> Export Valid Only (${validTransactions.length.toLocaleString()})`;
                btnExportValidOnly.onclick = () => {
                    document.getElementById('modal-erp-warning').classList.add('hidden');
                    if (validTransactions.length === 0) {
                        Toast.show('No valid transactions to export.', 'warning');
                        return;
                    }
                    this.openErpDateChoiceModal(validTransactions);
                };
            }

            const btnContinue = document.getElementById('btn-erp-continue-export');
            if (btnContinue) {
                btnContinue.textContent = `Export All (${rows.length.toLocaleString()})`;
                btnContinue.onclick = () => {
                    document.getElementById('modal-erp-warning').classList.add('hidden');
                    this.openErpDateChoiceModal(rows);
                };
            }

            document.getElementById('modal-erp-warning').classList.remove('hidden');
            if (window.lucide) lucide.createIcons({ root: document.getElementById('modal-erp-warning') });
        } else {
            this.openErpDateChoiceModal(rows);
        }
    }

    openErpDateChoiceModal(rows = this.erpData) {
        const modal = document.getElementById('modal-erp-date-choice');
        if (!modal) {
            this.generateErpExcel(rows, { dateMode: 'settlement' });
            return;
        }

        const subtitleEl = document.getElementById('erp-date-choice-subtitle');
        if (subtitleEl) {
            subtitleEl.textContent = `${rows.length.toLocaleString()} transaction line${rows.length === 1 ? '' : 's'} ready for Dynamics 365 export`;
        }

        const hasFawry = rows.some(r => !isSameDaySettlementBank(r));
        const hasForeign = rows.some(r => isSameDaySettlementBank(r));
        const descEl = document.getElementById('erp-date-settlement-desc');
        if (descEl) {
            if (hasForeign && !hasFawry) {
                descEl.innerHTML = `All selected lines belong to <strong>NuMisrUsd5</strong> — this bank&rsquo;s dates are same-day Value Dates (<strong>no next-day or weekend shift</strong> applied).`;
            } else if (hasForeign && hasFawry) {
                descEl.innerHTML = `Fawry orders shift <strong>Sun&ndash;Wed &rarr; Next Day (+1d)</strong> and <strong>Thu, Fri &amp; Sat &rarr; Sunday</strong>. <strong>NuMisrUsd5</strong> keeps its exact same Value Date.`;
            } else {
                descEl.innerHTML = `Automatically shifts each order to its bank transfer date: <strong>Sun&ndash;Wed &rarr; Next Day (+1d)</strong>, while <strong>Thu, Fri &amp; Sat &rarr; Sunday</strong>.`;
            }
        }

        // Build distinct payment_date -> settlement_date mapping preview (splitting Fawry vs Same-Day NuMisrUsd5)
        const dateCounts = new Map();
        rows.forEach(r => {
            const sameDay = isSameDaySettlementBank(r);
            const pDate = toDateOnly(r.value_date || r.payment_date || r.transaction_date) || 'Unknown';
            const key = `${sameDay ? 'same' : 'fawry'}|${pDate}`;
            const cur = dateCounts.get(key) || { sameDay, pDate, count: 0 };
            cur.count++;
            dateCounts.set(key, cur);
        });

        const sortedEntries = [...dateCounts.values()].sort((a, b) => a.pDate.localeCompare(b.pDate) || (a.sameDay ? 1 : -1));
        const previewEl = document.getElementById('erp-date-choice-preview');
        if (previewEl) {
            if (sortedEntries.length === 0) {
                previewEl.innerHTML = `<span style="color: var(--text-muted);">No dates in selection</span>`;
            } else {
                previewEl.innerHTML = sortedEntries.map(({ sameDay, pDate, count }) => {
                    const sDate = sameDay ? pDate : (calculateSettlementDate(pDate) || pDate);
                    const pDay = this.erpDayShort(pDate);
                    const sDay = this.erpDayShort(sDate);
                    const isWeekendBatch = !sameDay && (pDay === 'Thu' || pDay === 'Fri' || pDay === 'Sat');
                    return `
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.22rem 0; border-bottom: 1px dashed rgba(148, 163, 184, 0.12);">
                            <span style="font-family: monospace; color: var(--text-secondary);">
                                ${sameDay ? 'NuMisrUsd5:' : 'Paid:'} <strong>${escapeHTML(pDate)}</strong> ${pDay ? `<span style="color: ${isWeekendBatch ? '#f59e0b' : 'var(--text-muted)'};">(${escapeHTML(pDay)})</span>` : ''}
                            </span>
                            <span style="color: var(--text-muted);">&rarr;</span>
                            <span style="font-family: monospace; color: ${sameDay ? '#10b981' : '#38bdf8'}; font-weight: 600;">
                                ${sameDay ? `Same Date: ${escapeHTML(sDate)}` : `Settles: ${escapeHTML(sDate)}`} ${sDay ? `(${escapeHTML(sDay)})` : ''}
                            </span>
                            <span style="font-size: 0.72rem; color: var(--text-muted); white-space: nowrap;">${count.toLocaleString()} line${count === 1 ? '' : 's'}</span>
                        </div>
                    `;
                }).join('');
            }
        }

        const customDateInput = document.getElementById('erp-custom-settlement-date');
        if (customDateInput && !customDateInput.value) {
            const firstEntry = sortedEntries[0];
            customDateInput.value = (firstEntry && (firstEntry.sameDay ? firstEntry.pDate : calculateSettlementDate(firstEntry.pDate))) || toDateOnly(new Date());
        }

        const updateCardStyles = () => {
            const selected = modal.querySelector('input[name="erp-export-date-mode"]:checked')?.value || 'settlement';
            modal.querySelectorAll('.erp-date-mode-option').forEach(label => {
                const isActive = label.getAttribute('data-mode') === selected;
                label.style.borderColor = isActive ? 'rgba(56, 189, 248, 0.55)' : 'var(--border-color)';
                label.style.background = isActive ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255, 255, 255, 0.02)';
            });
        };

        modal.querySelectorAll('input[name="erp-export-date-mode"]').forEach(radio => {
            radio.onchange = updateCardStyles;
        });

        if (customDateInput) {
            const selectCustomMode = () => {
                const customRadio = modal.querySelector('input[name="erp-export-date-mode"][value="custom"]');
                if (customRadio) {
                    customRadio.checked = true;
                    updateCardStyles();
                }
            };
            customDateInput.onfocus = selectCustomMode;
            customDateInput.onchange = selectCustomMode;
        }

        updateCardStyles();

        const btnConfirm = document.getElementById('btn-confirm-erp-date-export');
        if (btnConfirm) {
            btnConfirm.onclick = () => {
                const dateMode = modal.querySelector('input[name="erp-export-date-mode"]:checked')?.value || 'settlement';
                const customDate = customDateInput?.value?.trim() || '';
                if (dateMode === 'custom' && !customDate) {
                    Toast.show('Please pick a custom bank transfer date', 'warning');
                    customDateInput?.focus();
                    return;
                }
                modal.classList.add('hidden');
                this.generateErpExcel(rows, { dateMode, customDate });
            };
        }

        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons({ root: modal });
    }

    generateErpExcel(rows = this.erpData, { dateMode = 'settlement', customDate = null } = {}) {
        const len = rows.length;
        const effectiveDates = new Array(len);
        const exportData = new Array(len);
        for (let index = 0; index < len; index++) {
            const row = rows[index];
            const effDate = this.resolveErpExportDate(row, dateMode, customDate);
            effectiveDates[index] = effDate;
            exportData[index] = {
                'Date': effDate,
                'Voucher': '',
                'Company': 'NU',
                'Account': sanitizeExcelValue(this.erpAccount(row)),
                'Name': '',
                'Description': sanitizeExcelValue(`${row.reference_number || ''}/${row.item_name || ''}/${row.mapping || ''}/${row.second_mapping || ''}/${row.student_id || ''}`),
                'Debit': 0,
                'Credit': this.erpAmount(row),
                'Currency': String(row.currency || 'EGP').toUpperCase(),
                'Offset account type': 'Bank',
                'Offset Non-ledger account': sanitizeExcelValue(row.bank),
                'Offset main account': '',
                'Method of payment': '',
                'Payment reference': sanitizeExcelValue(row.reference_number || ''),
                'Line number': index + 1
            };
        }

        const ws = XLSX.utils.json_to_sheet(exportData);
        for (let idx = 0; idx < len; idx++) {
            const serial = dateToExcelSerial(effectiveDates[idx]);
            if (serial !== null) {
                ws[`A${idx + 2}`] = { t: 'n', v: serial, z: 'yyyy-mm-dd' };
            }
        }
        ws['!cols'] = [
            { wch: 13 }, // Date
            { wch: 14 }, // Voucher
            { wch: 10 }, // Company
            { wch: 14 }, // Account
            { wch: 18 }, // Name
            { wch: 52 }, // Description
            { wch: 10 }, // Debit
            { wch: 14 }, // Credit
            { wch: 10 }, // Currency
            { wch: 18 }, // Offset account type
            { wch: 24 }, // Offset Non-ledger account
            { wch: 18 }, // Offset main account
            { wch: 18 }, // Method of payment
            { wch: 18 }, // Payment reference
            { wch: 12 }  // Line number
        ];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "ERP_Export");

        const dateStr = toDateOnly(new Date());
        writeCompressedExcel(wb, `Dynamics_365_Export_${dateStr}.xlsx`);
        const totalSummary = this.formatErpCurrencySummary(rows);
        const modeLabel = dateMode === 'payment' ? 'Payment / Value Date' : dateMode === 'custom' ? `Custom Date ${toDateOnly(customDate)}` : 'Settlement Date';
        Toast.show(`ERP file exported (${modeLabel}): ${exportData.length} lines, total ${totalSummary}`, 'success');
    }

    async recordErpReferences() {
        if (!this.erpData || this.erpData.length === 0) {
            Toast.show('No data selected', 'warning');
            return;
        }

        const batchNum = document.getElementById('erp-batch-number').value.trim();
        const startVoucher = document.getElementById('erp-voucher').value.trim();
        const validOnly = document.getElementById('erp-record-valid-only')?.checked ?? true;

        if (!batchNum) {
            Toast.show('Please enter a Journal Batch Number', 'warning');
            return;
        }

        const btn = document.getElementById('btn-record-erp');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Saving...';
        btn.disabled = true;

        try {
            let unexportedRows = this.erpData.filter(r => !r.erp_batch_number);
            const alreadyExported = this.erpData.length - unexportedRows.length;
            const skippedInvalid = validOnly ? unexportedRows.filter(r => r.id_status && !isNonInvalidTransaction(r)).length : 0;
            if (validOnly) {
                unexportedRows = unexportedRows.filter(r => !r.id_status || isNonInvalidTransaction(r));
            }
            
            if (unexportedRows.length === 0) {
                Toast.show(skippedInvalid > 0
                    ? `No valid unposted rows to stamp (${skippedInvalid} invalid-ID row(s) skipped).`
                    : 'All selected rows already have ERP references saved.', 'warning');
                return;
            }
            if (alreadyExported > 0) {
                if (!await window.customConfirm(`Warning: ${alreadyExported} rows already have ERP references. Only ${unexportedRows.length} new rows will be updated${skippedInvalid > 0 ? ` (${skippedInvalid} invalid rows skipped)` : ''}. Continue?`, 'Continue', 'Cancel')) {
                    return;
                }
            }

            const fawryRows = unexportedRows.filter(r => !isSameDaySettlementBank(r) && r.id !== undefined && r.id !== null);
            const foreignRows = unexportedRows.filter(r => isSameDaySettlementBank(r));
            const transactionIds = fawryRows.map(r => r.id);
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

            if (foreignRows.length > 0) {
                const foreignRefSet = new Set(foreignRows.map(r => String(r.reference_number || '').trim()).filter(Boolean));
                // Write to the database FIRST and fail loudly: a stamp that only lives in this
                // browser lets other users export (and post) the same deposits again.
                const foreignRefs = [...foreignRefSet];
                for (let i = 0; i < foreignRefs.length; i += batchSize) {
                    const { error: fErr } = await supabase.from('foreign_transactions')
                        .update({ erp_batch_number: batchNum, erp_voucher: startVoucher })
                        .in('reference_number', foreignRefs.slice(i, i + batchSize));
                    if (fErr) throw new Error(`Saving ERP batch on BM (USD) deposits failed: ${fErr.message}`);
                }
                (this.foreignTransactions || []).forEach(r => {
                    if (foreignRefSet.has(String(r.reference_number || '').trim())) {
                        r.erp_batch_number = batchNum;
                        r.erp_voucher = startVoucher;
                    }
                });
                this.persistForeignTransactionsLocal();
            }

            const totalStamped = unexportedRows.length;
            if (fawryRows.length > 0) {
                await this.logAudit('ERP References Recorded', batchNum, {
                    batch_number: batchNum,
                    voucher: startVoucher,
                    count: totalStamped,
                    skipped_invalid: skippedInvalid,
                    revert_data: {
                        table_name: 'transactions_erp',
                        operation: 'update',
                        batch_number: batchNum,
                        previous_rows: fawryRows.slice(0, 500).map(r => ({
                            id: r.id,
                            erp_batch_number: r.erp_batch_number || null,
                            erp_voucher: r.erp_voucher || null
                        }))
                    }
                });
            } else {
                await this.logAudit('ERP References Recorded (Foreign)', batchNum, {
                    batch_number: batchNum,
                    voucher: startVoucher,
                    count: foreignRows.length,
                    skipped_invalid: skippedInvalid,
                    revert_data: {
                        table_name: 'foreign_transactions_erp',
                        operation: 'update',
                        batch_number: batchNum,
                        previous_rows: foreignRows.slice(0, 500).map(r => ({
                            reference_number: r.reference_number,
                            erp_batch_number: r.erp_batch_number || null,
                            erp_voucher: r.erp_voucher || null
                        }))
                    }
                });
            }

            Toast.show(`Saved ERP batch "${batchNum}" on ${totalStamped.toLocaleString()} row(s)${skippedInvalid > 0 ? ` (${skippedInvalid} invalid skipped)` : ''}`, 'success');
            document.getElementById('erp-batch-number').value = '';
            document.getElementById('erp-voucher').value = '';
            this.invalidateTabs('dashboard', 'transactions', 'foreign-transactions', 'users');
            
            // Reload ERP data to reflect saved references
            await this.loadErpExport({ refresh: true });

        } catch (err) {
            Toast.show('Error saving: ' + err.message, 'error');
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
            this.updateErpRecordButtonLabel();
            renderIcons(btn);
        }
    }
}

export function applyErpExportMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(ErpExportMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(ErpExportMixin.prototype, name));
        }
    }
}
