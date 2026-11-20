import { supabase } from './supabase.js';
import {
    getEffectiveIdStatus,
    isNonInvalidTransaction,
    fetchAll,
    escapeHTML,
    sanitizeExcelValue,
    toDateOnly,
    writeCompressedExcel
} from './rules.js';
import { DEFAULT_FOREIGN_BANK, DEFAULT_FOREIGN_MAPPING } from './foreign-transactions.js';
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
import { renderIcons, SUPABASE_EXEMPT_OR_FILTER, Toast } from './app-utils.js';

class DashboardMixin {
    initDashboard() {
        const now = new Date();
        const dateFrom = document.getElementById('dashboard-date-from');
        const dateTo = document.getElementById('dashboard-date-to');
        const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        if (dateFrom && dateTo) {
            dateFrom.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            dateTo.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            
            dateFrom.addEventListener('change', () => this.loadDashboard());
            dateTo.addEventListener('change', () => this.loadDashboard());
        }

        // Date Range Presets
        document.querySelectorAll('[data-dash-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-dash-preset');
                const today = new Date();
                let start = new Date(today);
                let end = new Date(today);

                if (preset === 'today') {
                    // today to today
                } else if (preset === 'yesterday') {
                    start.setDate(today.getDate() - 1);
                    end.setDate(today.getDate() - 1);
                } else if (preset === '7d') {
                    start.setDate(today.getDate() - 6);
                } else if (preset === 'this_month') {
                    start = new Date(today.getFullYear(), today.getMonth(), 1);
                    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                } else if (preset === 'last_month') {
                    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                    end = new Date(today.getFullYear(), today.getMonth(), 0);
                } else if (preset === 'this_year') {
                    start = new Date(today.getFullYear(), 0, 1);
                    end = new Date(today.getFullYear(), 11, 31);
                } else if (preset === 'all_time') {
                    start = new Date(2020, 0, 1);
                    end = new Date(today.getFullYear() + 1, 11, 31);
                }

                if (dateFrom && dateTo) {
                    dateFrom.value = fmtLocal(start);
                    dateTo.value = fmtLocal(end);
                    this.loadDashboard();
                }
            });
        });

        ['dashboard-group-by', 'dashboard-sort-by', 'dashboard-status-filter', 'dashboard-show-share'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.loadDashboard());
        });

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.addEventListener('change', () => this.loadDashboard());
        });

        document.getElementById('btn-refresh-dashboard')?.addEventListener('click', () => this.loadDashboard());

        // USD -> EGP Daily Exchange Rate Controls
        this.fxStore = loadFxStore();
        this.fxDbLoaded = false;
        this.fxNoonTimer = null;
        this.scheduleDailyFxNoonSync();

        const fxModeEl = document.getElementById('dashboard-fx-mode');
        const fxRateInput = document.getElementById('dashboard-fx-rate-input');
        const btnSyncFx = document.getElementById('btn-dash-sync-fx');
        const btnApplyFx = document.getElementById('btn-dash-apply-fx');

        if (fxModeEl) {
            fxModeEl.value = this.fxStore.mode || 'historical';
            fxModeEl.addEventListener('change', () => {
                this.fxStore.mode = fxModeEl.value || 'historical';
                saveFxStore(this.fxStore);
                this.updateDashboardFxUI();
                this.loadDashboard();
            });
        }

        if (btnSyncFx) {
            btnSyncFx.addEventListener('click', async () => {
                const origHtml = btnSyncFx.innerHTML;
                btnSyncFx.disabled = true;
                btnSyncFx.innerHTML = '<i data-lucide="loader" class="spin" style="width:12px;height:12px;"></i> Syncing';
                try {
                    const foreignDates = (this.foreignTransactions || [])
                        .map(r => toDateOnly(r.value_date || r.payment_date || r.transaction_date))
                        .filter(Boolean);
                    const res = await this.syncDashboardFxRates({ dates: foreignDates, forceLatest: true });
                    this.updateDashboardFxUI();
                    await this.loadDashboard();
                    const active = resolveUsdToEgpRate(toDateOnly(new Date()), this.fxStore);
                    if (active.rate > 0) {
                        Toast.show(`FX synced (${res.updatedCount} rate(s) updated) · 1 USD = ${active.rate.toFixed(4)} EGP`, 'success');
                    } else {
                        Toast.show('Could not fetch online FX rate right now — enter a Manual Rate Override instead.', 'warning');
                    }
                } finally {
                    btnSyncFx.disabled = false;
                    btnSyncFx.innerHTML = origHtml;
                    if (window.lucide) lucide.createIcons({ root: document.getElementById('dashboard-fx-card') });
                }
            });
        }

        if (btnApplyFx && fxRateInput) {
            btnApplyFx.addEventListener('click', async () => {
                const val = parseFloat(fxRateInput.value);
                if (!val || val <= 0) {
                    Toast.show('Enter a valid positive USD → EGP rate (e.g. 49.50)', 'warning');
                    fxRateInput.focus();
                    return;
                }
                const todayStr = getEgyptDateTimeParts().dateStr;
                this.fxStore = setManualFxRate(this.fxStore, {
                    dateStr: todayStr,
                    rate: val,
                    applyAsLatest: true,
                    customMode: true
                });
                saveFxStore(this.fxStore);
                if (fxModeEl) fxModeEl.value = 'custom';
                try {
                    await supabase.from('exchange_rates').upsert([{
                        rate_date: todayStr,
                        currency_pair: 'USD_EGP',
                        rate: val,
                        source: 'manual',
                        updated_by: this.currentUser?.email || 'manual'
                    }], { onConflict: 'rate_date,currency_pair' });
                } catch (_e) {
                    // localStorage already persisted
                }
                this.updateDashboardFxUI();
                await this.loadDashboard();
                Toast.show(`Applied custom USD → EGP rate: ${val.toFixed(4)} EGP`, 'success');
            });
        }

        this.updateDashboardFxUI();

        // Expand / Collapse All Months button
        document.getElementById('btn-dashboard-toggle-months')?.addEventListener('click', () => {
            const pivotBody = document.getElementById('dashboard-pivot-body');
            if (!pivotBody) return;
            const toggles = Array.from(pivotBody.querySelectorAll('.month-toggle'));
            const dayRows = Array.from(pivotBody.querySelectorAll('.day-row'));
            if (toggles.length === 0) return;

            const anyCollapsed = toggles.some(t => !t.classList.contains('expanded'));
            toggles.forEach(t => t.classList.toggle('expanded', anyCollapsed));
            dayRows.forEach(r => { r.style.display = anyCollapsed ? 'table-row' : 'none'; });

            const labelEl = document.getElementById('dashboard-toggle-months-label');
            if (labelEl) {
                labelEl.textContent = anyCollapsed ? 'Collapse All Months' : 'Expand All Months';
            }
        });

        // Export Pivot to Excel
        document.getElementById('btn-export-pivot')?.addEventListener('click', () => {
            this.exportDashboardPivotExcel();
        });

        // KPI Stat Cards Drill-Down
        document.getElementById('dashboard-stats-row')?.addEventListener('click', (e) => {
            const card = e.target.closest('[data-dash-drill]');
            if (!card) return;
            const drillType = card.getAttribute('data-dash-drill');
            this.drillDownFromDashboard({ type: drillType });
        });

        // Top Categories Bar Drill-Down
        document.getElementById('dashboard-top-categories')?.addEventListener('click', (e) => {
            const badge = e.target.closest('[data-dash-category]');
            if (!badge) return;
            const cat = badge.getAttribute('data-dash-category');
            if (cat) {
                this.drillDownFromDashboard({ type: 'row', groupBy: 'mapping', key: cat });
            }
        });

        // Add event delegation for expand/collapse month rows and row drill-down
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
                    const allToggles = Array.from(pivotBody.querySelectorAll('.month-toggle'));
                    const anyCollapsed = allToggles.some(t => !t.classList.contains('expanded'));
                    const labelEl = document.getElementById('dashboard-toggle-months-label');
                    if (labelEl) labelEl.textContent = anyCollapsed ? 'Expand All Months' : 'Collapse All Months';
                    return;
                }

                const drillRow = e.target.closest('tr[data-drill-key]');
                if (drillRow) {
                    const groupBy = drillRow.getAttribute('data-drill-group');
                    const key = drillRow.getAttribute('data-drill-key');
                    if (groupBy && key) {
                        this.drillDownFromDashboard({ type: 'row', groupBy, key });
                    }
                }
            });
        }

        // Copy Table for Email (preserves classic 4-column Outlook/Gmail format)
        const btnCopy = document.getElementById('btn-copy-pivot');
        if (btnCopy) {
            btnCopy.addEventListener('click', () => {
                const table = document.getElementById('dashboard-pivot-table');
                if (!table) return;
                
                const clone = table.cloneNode(true);
                // Collapsed daily rows must not end up in the pasted email
                clone.querySelectorAll('tr').forEach(tr => {
                    if (tr.style.display === 'none') tr.remove();
                });
                // Remove UI-only % Share column & drill-down icons so pasted email stays clean
                clone.querySelectorAll('.pivot-share-col, .no-email-copy').forEach(el => el.remove());

                const headerThCount = clone.querySelectorAll('thead tr:last-child th').length;
                const titleTh = clone.querySelector('.pivot-title');
                if (titleTh && headerThCount > 0) {
                    titleTh.setAttribute('colspan', String(headerThCount));
                }

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
                    renderIcons(btnCopy);
                    setTimeout(() => {
                        btnCopy.innerHTML = orig;
                        renderIcons(btnCopy);
                    }, 2000);
                }).catch(err => {
                    Toast.show('Failed to copy: ' + err.message, 'error');
                });
            });
        }
    }

    drillDownFromDashboard({ type, groupBy, key } = {}) {
        const dateFrom = document.getElementById('dashboard-date-from')?.value || '';
        const dateTo = document.getElementById('dashboard-date-to')?.value || '';
        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]:checked');
        const selectedBanks = Array.from(checkboxes).map(cb => cb.value);

        if (type === 'erp_export') {
            const erpFrom = document.getElementById('erp-filter-date-from');
            const erpTo = document.getElementById('erp-filter-date-to');
            if (erpFrom && dateFrom) erpFrom.value = dateFrom;
            if (erpTo && dateTo) erpTo.value = dateTo;
            document.querySelector('.nav-link[data-tab="erp-export"]')?.click();
            this.loadErpExport({ refresh: true });
            return;
        }

        if (selectedBanks.length === 1 && selectedBanks[0] === DEFAULT_FOREIGN_BANK) {
            const fxFrom = document.getElementById('foreign-date-from');
            const fxTo = document.getElementById('foreign-date-to');
            if (type === 'row' && groupBy === 'date' && key) {
                if (fxFrom) fxFrom.value = key;
                if (fxTo) fxTo.value = key;
            } else {
                if (fxFrom) fxFrom.value = dateFrom;
                if (fxTo) fxTo.value = dateTo;
            }
            this.foreignQuickFilter = type === 'invalid_tx' ? 'needs_id' : 'all';
            document.querySelector('.nav-link[data-tab="foreign-transactions"]')?.click();
            this.loadForeignTransactions();
            return;
        }

        if (type === 'invalid_tx') {
            const amFrom = document.getElementById('automatcher-date-from');
            const amTo = document.getElementById('automatcher-date-to');
            if (amFrom && dateFrom) amFrom.value = dateFrom;
            if (amTo && dateTo) amTo.value = dateTo;
            document.querySelector('.nav-link[data-tab="automatcher"]')?.click();
            this.runAutoMatcher();
            return;
        }

        // Otherwise drill down into Orders Transactions
        const txFrom = document.getElementById('filter-date-from');
        const txTo = document.getElementById('filter-date-to');
        const txSearch = document.getElementById('search-input');

        if (txSearch) txSearch.value = '';
        this.headerFilters.transactions = {};
        if (selectedBanks.length === 1) {
            this.headerFilters.transactions.bank = [...selectedBanks];
        }

        if (type === 'row' && groupBy === 'date' && key) {
            if (txFrom) txFrom.value = key;
            if (txTo) txTo.value = key;
            this.txQuickFilter = 'all';
        } else {
            if (txFrom) txFrom.value = dateFrom;
            if (txTo) txTo.value = dateTo;
            this.txQuickFilter = 'all';

            if (type === 'valid_tx') {
                this.headerFilters.transactions.id_status = ['Valid'];
            } else if (type === 'unsettled_tx') {
                this.txQuickFilter = 'unsettled';
            } else if (type === 'row' && groupBy && key) {
                if (groupBy === 'mapping' || groupBy === 'second_mapping') {
                    this.headerFilters.transactions[groupBy] = [key === 'Unmapped' ? '(Empty / Unmapped)' : key];
                } else if (groupBy === 'item_name') {
                    this.headerFilters.transactions.item_name = [key];
                }
            }
        }

        // Sync Quick Filter buttons UI on Transactions view
        document.querySelectorAll('[data-tx-quick-filter]').forEach(b => {
            const isMatch = b.getAttribute('data-tx-quick-filter') === (this.txQuickFilter || 'all');
            b.classList.toggle('btn-primary', isMatch);
            b.classList.toggle('btn-outline', !isMatch);
        });
        document.querySelectorAll('[data-table="transactions"] .header-filter-icon').forEach(icon => {
            const col = icon.closest('.th-filter-wrapper')?.dataset.column;
            const hasActive = Boolean(col && this.headerFilters.transactions[col] && this.headerFilters.transactions[col].length > 0);
            icon.classList.toggle('active', hasActive);
        });

        this.currentPage = 1;
        document.querySelector('.nav-link[data-tab="transactions"]')?.click();
    }

    exportDashboardPivotExcel() {
        const table = document.getElementById('dashboard-pivot-table');
        if (!table) return;

        const tbody = table.querySelector('tbody');
        const visibleBodyRows = Array.from(tbody ? tbody.querySelectorAll('tr') : []).filter(tr => {
            if (tr.style.display === 'none') return false;
            const tds = tr.querySelectorAll('td');
            if (tds.length <= 1) return false; // Skip "Loading..." or "No data" placeholder row
            return true;
        });

        const report = this.lastDashboardReport;
        if (visibleBodyRows.length === 0 && (!report || (!report.dailyRows?.length && !report.groupedRows?.length))) {
            Toast.show('No pivot data available to export.', 'warning');
            return;
        }

        const dateFrom = document.getElementById('dashboard-date-from')?.value || 'Start';
        const dateTo = document.getElementById('dashboard-date-to')?.value || 'End';
        const groupBy = document.getElementById('dashboard-group-by')?.value || 'date';

        if (typeof XLSX === 'undefined' || !XLSX.utils || typeof XLSX.writeFile !== 'function') {
            Toast.show('Excel library not loaded.', 'error');
            return;
        }

        const wb = XLSX.utils.book_new();

        const buildStyledPivotSheet = (titleText, colHeaders, dataRows, totalRow) => {
            const numCols = colHeaders.length || 4;
            const aoa = [];
            const titleRow = new Array(numCols).fill('');
            titleRow[0] = titleText;
            aoa.push(titleRow);
            aoa.push(colHeaders.map(h => sanitizeExcelValue(h)));

            dataRows.forEach(r => {
                aoa.push(r.map((val, idx) => (idx === 0 || typeof val === 'string') ? sanitizeExcelValue(val) : val));
            });

            if (totalRow && totalRow.length > 0) {
                aoa.push(totalRow.map((val, idx) => (idx === 0 || typeof val === 'string') ? sanitizeExcelValue(val) : val));
            }

            const ws = XLSX.utils.aoa_to_sheet(aoa);
            if (numCols > 1) {
                ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } }];
            }
            for (let r = 2; r < aoa.length; r++) {
                for (let c = 1; c < numCols; c++) {
                    const cellRef = XLSX.utils.encode_cell({ r, c });
                    if (ws[cellRef] && typeof ws[cellRef].v === 'number') {
                        ws[cellRef].z = '#,##0.00';
                    }
                }
            }
            ws['!cols'] = colHeaders.map((h, idx) => ({ wch: idx === 0 ? 28 : Math.max(18, String(h).length + 4) }));
            return ws;
        };

        if (report && Array.isArray(report.colHeaders) && report.colHeaders.length > 0) {
            if (report.groupBy === 'date') {
                // Sheet 1: Daily Pivot (no double-counting with monthly rows)
                const dailyWs = buildStyledPivotSheet(
                    `${report.titleText || 'Total Collection Report'} - Daily Breakdown`,
                    report.colHeaders,
                    report.dailyRows || [],
                    report.grandTotalRow || []
                );
                XLSX.utils.book_append_sheet(wb, dailyWs, 'Daily Pivot');

                // Sheet 2: Monthly Summary
                if (Array.isArray(report.monthlyRows) && report.monthlyRows.length > 0) {
                    const monthlyHeaders = [...report.colHeaders];
                    monthlyHeaders[0] = 'Month';
                    const monthlyWs = buildStyledPivotSheet(
                        `${report.titleText || 'Total Collection Report'} - Monthly Summary`,
                        monthlyHeaders,
                        report.monthlyRows,
                        report.grandTotalRow || []
                    );
                    XLSX.utils.book_append_sheet(wb, monthlyWs, 'Monthly Summary');
                }
            } else {
                // Category / Bank / Status Pivot
                const groupedWs = buildStyledPivotSheet(
                    report.titleText || 'Total Collection Report',
                    report.colHeaders,
                    report.groupedRows || [],
                    report.grandTotalRow || []
                );
                XLSX.utils.book_append_sheet(wb, groupedWs, 'Category Pivot');
            }

            // Sheet 3: Executive Summary & KPIs
            if (Array.isArray(report.summaryAoa) && report.summaryAoa.length > 0) {
                const summaryWs = XLSX.utils.aoa_to_sheet(report.summaryAoa);
                for (let r = 0; r < report.summaryAoa.length; r++) {
                    for (let c = 1; c < (report.summaryAoa[r]?.length || 0); c++) {
                        const cellRef = XLSX.utils.encode_cell({ r, c });
                        if (summaryWs[cellRef] && typeof summaryWs[cellRef].v === 'number') {
                            summaryWs[cellRef].z = '#,##0.00';
                        }
                    }
                }
                summaryWs['!cols'] = [{ wch: 32 }, { wch: 22 }, { wch: 22 }, { wch: 20 }, { wch: 24 }];
                XLSX.utils.book_append_sheet(wb, summaryWs, 'Executive Summary');
            }
        } else {
            // Fallback DOM scrape if report state wasn't populated
            const headerRows = table.querySelectorAll('thead tr');
            const titleText = (headerRows[0]?.textContent || 'Total Collection Report').trim();
            const colHeaderCells = Array.from((headerRows[1] || headerRows[0])?.querySelectorAll('th') || []);
            const colHeaders = colHeaderCells.map(th => th.textContent.trim());

            const parseCellVal = (td, colIdx) => {
                const raw = (td.textContent || '').trim();
                if (colIdx === 0) return sanitizeExcelValue(raw);
                if (td.classList.contains('pivot-share-col') || raw.endsWith('%')) return sanitizeExcelValue(raw);
                const cleaned = raw.replace(/,/g, '');
                const num = Number(cleaned);
                return (!isNaN(num) && cleaned !== '') ? num : sanitizeExcelValue(raw);
            };

            const bodyRows = visibleBodyRows.map(tr => Array.from(tr.querySelectorAll('td')).map((td, idx) => parseCellVal(td, idx)));
            const tfootTr = table.querySelector('tfoot tr');
            const totalRow = tfootTr ? Array.from(tfootTr.querySelectorAll('td')).map((td, idx) => parseCellVal(td, idx)) : [];
            const ws = buildStyledPivotSheet(titleText, colHeaders, bodyRows, totalRow);
            XLSX.utils.book_append_sheet(wb, ws, 'Total Fawry Collection');
        }

        writeCompressedExcel(wb, `Collection_Report_${groupBy}_${dateFrom}_to_${dateTo}.xlsx`);
        Toast.show('Dashboard report exported to Excel!', 'success');
    }

    updateDashboardFxUI() {
        if (!this.fxStore) this.fxStore = loadFxStore();
        const modeEl = document.getElementById('dashboard-fx-mode');
        const inputEl = document.getElementById('dashboard-fx-rate-input');
        const badgeEl = document.getElementById('dashboard-fx-badge');
        const statusEl = document.getElementById('dashboard-fx-status');

        const mode = this.fxStore.mode || 'historical';
        if (modeEl && modeEl.value !== mode) modeEl.value = mode;

        const todayStr = getEgyptDateTimeParts().dateStr;
        const resolved = resolveUsdToEgpRate(todayStr, this.fxStore);

        if (badgeEl) {
            badgeEl.textContent = resolved.rate > 0
                ? `1 USD = ${resolved.rate.toFixed(4)} EGP`
                : 'Not synced';
            badgeEl.style.color = resolved.rate > 0 ? '#10b981' : 'var(--text-muted)';
        }

        if (inputEl && document.activeElement !== inputEl) {
            if (mode === 'custom' && this.fxStore.customRate > 0) {
                inputEl.value = String(this.fxStore.customRate);
            } else if (!inputEl.value && resolved.rate > 0) {
                inputEl.placeholder = resolved.rate.toFixed(4);
            }
        }

        if (statusEl) {
            const count = Object.keys(this.fxStore.ratesByDate || {}).length;
            if (mode === 'custom' && this.fxStore.customRate > 0) {
                statusEl.textContent = `Custom manual override active (${this.fxStore.customRate.toFixed(4)} EGP/USD across all foreign deposits).`;
            } else if (mode === 'latest') {
                statusEl.textContent = resolved.rate > 0
                    ? `Latest daily rate (${resolved.rateDate || todayStr}, ${resolved.source}) · auto-updates daily 12:00 PM Egypt.`
                    : `Click Sync or enter a Manual Rate Override to convert USD → EGP.`;
            } else {
                statusEl.textContent = count > 0
                    ? `Per-Tx Value Date active (${count} cached rate${count === 1 ? '' : 's'}) · auto-updates daily 12:00 PM Egypt.`
                    : `Per-Tx Value Date active · auto-updates daily at 12:00 PM Egypt.`;
            }
        }
    }

    scheduleDailyFxNoonSync() {
        if (this.fxNoonTimer) {
            clearTimeout(this.fxNoonTimer);
            this.fxNoonTimer = null;
        }
        const runNoonSyncIfDue = async () => {
            try {
                if (!this.fxStore) this.fxStore = loadFxStore();
                if (isRateStaleForEgyptNoon(this.fxStore.latest)) {
                    await this.syncDashboardFxRates();
                    if (typeof document !== 'undefined' && document.getElementById('dashboard-view')?.classList.contains('active')) {
                        await this.loadDashboard?.();
                    }
                }
            } catch (_e) {
                // Keep UI resilient if offline at noon; next visibilitychange or Dashboard load retries
            }
        };

        const delayMs = getMsUntilNextEgyptNoon();
        const safeDelayMs = Math.min(Math.max(1000, delayMs), 2147483647);
        this.fxNoonTimer = setTimeout(async () => {
            await runNoonSyncIfDue();
            this.scheduleDailyFxNoonSync();
        }, safeDelayMs);
        if (typeof this.fxNoonTimer?.unref === 'function') {
            this.fxNoonTimer.unref();
        }

        if (typeof document !== 'undefined' && !this._fxVisibilityBound) {
            this._fxVisibilityBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    runNoonSyncIfDue();
                }
            });
        }
    }

    async syncDashboardFxRates({ dates = [], forceLatest = false } = {}) {
        if (!this.fxStore) this.fxStore = loadFxStore();

        const shouldCheckDb = !this.fxDbLoaded || forceLatest || isRateStaleForEgyptNoon(this.fxStore.latest);
        if (shouldCheckDb) {
            this.fxDbLoaded = true;
            try {
                const { data, error } = await supabase
                    .from('exchange_rates')
                    .select('rate_date, rate, source, updated_at')
                    .eq('currency_pair', 'USD_EGP')
                    .order('rate_date', { ascending: false });
                if (!error && Array.isArray(data)) {
                    for (const row of data) {
                        const d = toDateOnly(row.rate_date);
                        const r = Number(row.rate);
                        if (!d || !(r > 0)) continue;
                        const existing = this.fxStore.ratesByDate[d];
                        const incomingMs = row.updated_at ? Date.parse(row.updated_at) : NaN;
                        const existingMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : NaN;
                        const incomingIsNewerAuto = existing
                            && existing.source !== 'manual'
                            && (row.source || 'auto') !== 'manual'
                            && Number.isFinite(incomingMs)
                            && (!Number.isFinite(existingMs) || incomingMs > existingMs);
                        // Prefer manual override or fresher server timestamp
                        if (!existing || (row.source === 'manual' && existing.source !== 'manual') || incomingIsNewerAuto) {
                            this.fxStore.ratesByDate[d] = {
                                rate: r,
                                source: row.source || 'auto',
                                provider: 'supabase',
                                updatedAt: row.updated_at || ''
                            };
                        }
                    }
                    const sortedDates = Object.keys(this.fxStore.ratesByDate).sort();
                    const newest = sortedDates[sortedDates.length - 1];
                    const newestEntry = newest ? this.fxStore.ratesByDate[newest] : null;
                    const latestMs = this.fxStore.latest?.updatedAt ? Date.parse(this.fxStore.latest.updatedAt) : NaN;
                    const newestMs = newestEntry?.updatedAt ? Date.parse(newestEntry.updatedAt) : NaN;
                    const sameDateFresher = this.fxStore.latest?.date === newest
                        && this.fxStore.latest?.source !== 'manual'
                        && (newestEntry?.source === 'manual' || (Number.isFinite(newestMs) && (!Number.isFinite(latestMs) || newestMs > latestMs)));
                    if (newest && (!this.fxStore.latest || this.fxStore.latest.date < newest || sameDateFresher)) {
                        this.fxStore.latest = {
                            date: newest,
                            rate: newestEntry.rate,
                            source: newestEntry.source,
                            updatedAt: newestEntry.updatedAt
                        };
                    }
                    saveFxStore(this.fxStore);
                }
            } catch (_e) {
                // Table may not exist yet; continue smoothly with localStorage cache + live API
            }
        }

        const res = await syncMissingFxRates(dates, this.fxStore, { forceLatest });
        if (res.updatedRecords.length > 0 || res.latestUpdated) {
            saveFxStore(this.fxStore);
            try {
                if (res.updatedRecords.length > 0) {
                    const dbPayload = res.updatedRecords.map(rec => ({
                        rate_date: rec.rate_date,
                        currency_pair: 'USD_EGP',
                        rate: rec.rate,
                        source: rec.source || 'auto',
                        updated_at: rec.updatedAt || new Date().toISOString()
                    }));
                    await supabase.from('exchange_rates').upsert(dbPayload, { onConflict: 'rate_date,currency_pair' });
                }
            } catch (_e) {
                // Ignore if DB table not migrated yet
            }
        }
        this.updateDashboardFxUI();
        return res;
    }

    async loadDashboard() {
        const dateFrom = document.getElementById('dashboard-date-from')?.value;
        const dateTo = document.getElementById('dashboard-date-to')?.value;
        const groupBy = document.getElementById('dashboard-group-by')?.value || 'date';
        const sortBy = document.getElementById('dashboard-sort-by')?.value || 'default';
        const statusFilter = document.getElementById('dashboard-status-filter')?.value || 'all';
        const showShare = document.getElementById('dashboard-show-share') ? document.getElementById('dashboard-show-share').checked : true;
        
        if (!dateFrom || !dateTo) return;

        const subtitleEl = document.getElementById('dashboard-period-subtitle');
        if (subtitleEl) {
            const subsetLabels = {
                all: 'All Transactions',
                valid: 'Valid Student IDs Only',
                invalid: 'Invalid / Missing IDs Only',
                settled: 'Fawry Settled Only',
                unsettled: 'Unsettled Only',
                erp_recorded: 'ERP Recorded Only',
                erp_unposted: 'ERP Unposted Only'
            };
            subtitleEl.textContent = `Period: ${dateFrom} to ${dateTo} • Subset: ${subsetLabels[statusFilter] || 'All Transactions'}`;
        }

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]:checked');
        const selectedBanks = Array.from(checkboxes).map(cb => cb.value);
        const fawryBanksSelected = selectedBanks.filter(b => b !== DEFAULT_FOREIGN_BANK);
        const includeForeignBank = selectedBanks.includes(DEFAULT_FOREIGN_BANK);

        const tbody = document.getElementById('dashboard-pivot-body');
        const tfoot = document.getElementById('dashboard-pivot-foot');
        if (!tbody || !tfoot) return;

        const formatMoney = (num) => Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const bankColCount = fawryBanksSelected.length + (includeForeignBank ? 2 : 0);
        const totalColSpan = bankColCount + 2 + (showShare ? 1 : 0);

        if (selectedBanks.length === 0) {
            this.lastDashboardExportRows = [];
            this.lastDashboardReport = null;
            tbody.innerHTML = '<tr><td colspan="2" style="text-align: center;">No bank selected</td></tr>';
            tfoot.innerHTML = '<tr><td>Grand Total</td><td>0.00</td></tr>';
            document.getElementById('stat-total-collections').textContent = 'EGP 0.00';
            document.getElementById('stat-total-transactions').textContent = '0';
            document.getElementById('stat-valid-pct').textContent = '0%';
            document.getElementById('stat-errors').textContent = '0';
            const setTxt = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
            setTxt('stat-avg-tx', 'Avg: EGP 0.00 / tx');
            setTxt('stat-active-days', '0 active days');
            setTxt('stat-valid-count', '0 valid tx');
            setTxt('stat-unmapped-count', '0 unmapped item(s)');
            setTxt('stat-settled-pct', '0%');
            setTxt('stat-settled-sub', '0 settled • 0 unsettled');
            setTxt('stat-erp-pct', '0%');
            setTxt('stat-erp-sub', '0 posted • 0 unposted');
            setTxt('dash-bank-badge-NUADCB136', '0.00');
            setTxt('dash-bank-badge-NUADIB64', '0.00');
            setTxt('dash-bank-badge-NuMisrUsd5', '0.00');
            setTxt('dashboard-split-cb136-val', 'EGP 0.00');
            setTxt('dashboard-split-ib64-val', 'EGP 0.00');
            setTxt('dashboard-split-misrusd5-val', 'USD 0.00');
            setTxt('dashboard-split-misrusd5-egp', '(≈ EGP 0.00)');
            setTxt('dashboard-bank-split-label', 'NUADCB136: 0% • NUADIB64: 0% • NuMisrUsd5: 0%');
            const topCat = document.getElementById('dashboard-top-categories');
            if (topCat) topCat.innerHTML = '<span style="color: var(--text-muted);">No bank selected</span>';
            return;
        }

        tbody.innerHTML = `<tr><td colspan="${totalColSpan}" style="text-align: center;">Loading...</td></tr>`;
        tfoot.innerHTML = '';

        try {
            let allData = [];
            let rpcSucceeded = false;
            let summaryRpcData = null;
            
            // 1. Query Fawry transactions only when at least one Fawry bank is checked
            if (fawryBanksSelected.length > 0) {
                const rpcArgs = {
                    start_date: dateFrom,
                    end_date: dateTo,
                    group_col: groupBy,
                    banks: fawryBanksSelected
                };
                if (statusFilter !== 'all') {
                    rpcArgs.status_filter = statusFilter;
                }
                const { data: summaryRes, error: summaryErr } = await supabase.rpc('get_dashboard_summary', rpcArgs);
                if (!summaryErr && summaryRes && summaryRes.kpis && Array.isArray(summaryRes.pivot)) {
                    rpcSucceeded = true;
                    summaryRpcData = summaryRes;
                    allData = summaryRes.pivot
                        .filter(row => fawryBanksSelected.includes(row.bank))
                        .map(row => ({
                            payment_date: groupBy === 'date' ? row.group_key : null,
                            mapping: groupBy === 'mapping' ? row.group_key : null,
                            second_mapping: groupBy === 'second_mapping' ? row.group_key : null,
                            item_name: groupBy === 'item_name' ? row.group_key : null,
                            bank: row.bank,
                            item_price: row.total_amount
                        }));
                } else if (statusFilter === 'all') {
                    const { data: pivotByData, error: pivotByErr } = await supabase.rpc('get_dashboard_pivot_by', {
                        start_date: dateFrom,
                        end_date: dateTo,
                        group_col: groupBy
                    });
                    if (!pivotByErr && Array.isArray(pivotByData)) {
                        rpcSucceeded = true;
                        allData = pivotByData
                            .filter(row => fawryBanksSelected.includes(row.bank))
                            .map(row => ({
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
                            allData = rpcData
                                .filter(row => fawryBanksSelected.includes(row.bank))
                                .map(row => ({
                                    payment_date: row.payment_date,
                                    bank: row.bank,
                                    item_price: row.daily_total
                                }));
                        }
                    }
                }
                
                // Fallback (RPC missing / failed, or a specific transaction subset filter is active)
                if (!rpcSucceeded) {
                    allData = await fetchAll(
                        'transactions',
                        'id, payment_date, bank, item_price, mapping, second_mapping, item_name, id_status, is_settled, erp_batch_number',
                        q => {
                            q = q.gte('payment_date', dateFrom)
                                .lte('payment_date', dateTo)
                                .in('bank', fawryBanksSelected);

                            if (statusFilter === 'valid') q = q.eq('id_status', 'Valid');
                            else if (statusFilter === 'invalid') q = q.neq('id_status', 'Valid').neq('id_status', 'Exempt');
                            else if (statusFilter === 'settled') q = q.eq('is_settled', true);
                            else if (statusFilter === 'unsettled') q = q.or('is_settled.is.null,is_settled.eq.false');
                            else if (statusFilter === 'erp_recorded') q = q.not('erp_batch_number', 'is', null).neq('erp_batch_number', '');
                            else if (statusFilter === 'erp_unposted') q = q.or('erp_batch_number.is.null,erp_batch_number.eq.');
                            return q;
                        },
                        'id'
                    );
                    if (statusFilter === 'invalid') {
                        allData = allData.filter(tx => !isNonInvalidTransaction(tx));
                    }
                }
            } else {
                rpcSucceeded = true;
            }

            // Include Foreign Transactions (NuMisrUsd5) from both Supabase and local session
            let foreignSourceRows = [];
            if (includeForeignBank) {
                try {
                    foreignSourceRows = await this.fetchForeignRowsForErp(dateFrom, dateTo);
                } catch (_) {
                    foreignSourceRows = (this.foreignTransactions || []).map((r, i) => this.normalizeForeignTransactionRow(r, i));
                }
            }

            const filteredForeignRaw = foreignSourceRows
                .map((r, i) => this.normalizeForeignTransactionRow(r, i))
                .filter(r => {
                    const pDate = toDateOnly(r.value_date || r.payment_date || r.transaction_date);
                    if (!pDate || pDate < dateFrom || pDate > dateTo) return false;
                    const isSettledRow = r.is_settled !== undefined ? Boolean(r.is_settled) : true;
                    if (statusFilter === 'valid') return r.id_status === 'Valid';
                    if (statusFilter === 'invalid') return !isNonInvalidTransaction(r);
                    if (statusFilter === 'settled') return isSettledRow;
                    if (statusFilter === 'unsettled') return !isSettledRow;
                    if (statusFilter === 'erp_recorded') return Boolean(r.erp_batch_number);
                    if (statusFilter === 'erp_unposted') return !r.erp_batch_number;
                    return true;
                });

            if (includeForeignBank && filteredForeignRaw.length > 0) {
                const neededDates = filteredForeignRaw
                    .map(r => toDateOnly(r.value_date || r.payment_date || r.transaction_date))
                    .filter(Boolean);
                await this.syncDashboardFxRates({ dates: neededDates });
            } else {
                this.updateDashboardFxUI();
            }

            const matchingForeignRows = filteredForeignRaw.map(r => {
                const pDate = toDateOnly(r.value_date || r.payment_date || r.transaction_date);
                const usdAmt = Number(r.amount ?? r.item_price) || 0;
                const fx = convertUsdToEgp(usdAmt, pDate, this.fxStore);
                return {
                    payment_date: pDate,
                    bank: DEFAULT_FOREIGN_BANK,
                    raw_usd: usdAmt,
                    fx_rate: fx.rate,
                    fx_date: fx.rateDate,
                    fx_source: fx.source,
                    item_price: fx.rate > 0 ? fx.egpAmount : usdAmt,
                    mapping: r.mapping || DEFAULT_FOREIGN_MAPPING,
                    second_mapping: r.second_mapping || '',
                    item_name: r.description || r.item_name || '',
                    id_status: r.id_status,
                    is_settled: r.is_settled !== undefined ? Boolean(r.is_settled) : true,
                    erp_batch_number: r.erp_batch_number || null
                };
            });

            if (includeForeignBank && matchingForeignRows.length > 0) {
                allData = [...allData, ...matchingForeignRows];
            }

            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

            let bankTotals = { Total: 0 };
            let misrUsd5UsdTotal = 0;
            ['NUADCB136', 'NUADIB64', DEFAULT_FOREIGN_BANK, ...selectedBanks].forEach(b => { if (bankTotals[b] === undefined) bankTotals[b] = 0; });

            const activeDaysSet = new Set();
            allData.forEach(tx => {
                if (!selectedBanks.includes(tx.bank)) return;
                const price = parseFloat(tx.item_price) || 0;
                bankTotals[tx.bank] = (bankTotals[tx.bank] || 0) + price;
                bankTotals.Total += price;
                if (tx.bank === DEFAULT_FOREIGN_BANK) {
                    misrUsd5UsdTotal += parseFloat(tx.raw_usd) || 0;
                }
                const pDate = toDateOnly(tx.payment_date);
                if (pDate) activeDaysSet.add(pDate);
            });

            // Update Bank Filter live badges & Bank Split progress bar (all amounts compared in EGP)
            ['NUADCB136', 'NUADIB64', DEFAULT_FOREIGN_BANK].forEach(b => {
                const badgeEl = document.getElementById(`dash-bank-badge-${b}`);
                if (badgeEl) badgeEl.textContent = formatMoney(bankTotals[b] || 0);
            });

            const cb136Val = bankTotals['NUADCB136'] || 0;
            const ib64Val = bankTotals['NUADIB64'] || 0;
            const misrUsd5EgpVal = bankTotals[DEFAULT_FOREIGN_BANK] || 0;
            const combinedBankTotal = cb136Val + ib64Val + misrUsd5EgpVal;
            const cb136Pct = combinedBankTotal > 0 ? ((cb136Val / combinedBankTotal) * 100) : 0;
            const ib64Pct = combinedBankTotal > 0 ? ((ib64Val / combinedBankTotal) * 100) : 0;
            const misrUsd5Pct = combinedBankTotal > 0 ? ((misrUsd5EgpVal / combinedBankTotal) * 100) : 0;

            const splitLabelEl = document.getElementById('dashboard-bank-split-label');
            if (splitLabelEl) splitLabelEl.textContent = `NUADCB136: ${cb136Pct.toFixed(1)}% • NUADIB64: ${ib64Pct.toFixed(1)}% • ${DEFAULT_FOREIGN_BANK}: ${misrUsd5Pct.toFixed(1)}%`;
            const bar136 = document.getElementById('dashboard-bar-cb136');
            const bar64 = document.getElementById('dashboard-bar-ib64');
            const barMisr = document.getElementById('dashboard-bar-misrusd5');
            if (bar136 && bar64) {
                bar136.style.width = `${combinedBankTotal > 0 ? cb136Pct : 34}%`;
                bar64.style.width = `${combinedBankTotal > 0 ? ib64Pct : 33}%`;
                if (barMisr) barMisr.style.width = `${combinedBankTotal > 0 ? misrUsd5Pct : 33}%`;
            }
            const split136El = document.getElementById('dashboard-split-cb136-val');
            const split64El = document.getElementById('dashboard-split-ib64-val');
            const splitMisrEl = document.getElementById('dashboard-split-misrusd5-val');
            const splitMisrEgpEl = document.getElementById('dashboard-split-misrusd5-egp');
            if (split136El) split136El.textContent = `EGP ${formatMoney(cb136Val)}`;
            if (split64El) split64El.textContent = `EGP ${formatMoney(ib64Val)}`;
            if (splitMisrEl) splitMisrEl.textContent = `USD ${formatMoney(misrUsd5UsdTotal)}`;
            if (splitMisrEgpEl) {
                const resolvedFx = resolveUsdToEgpRate(dateTo, this.fxStore);
                splitMisrEgpEl.textContent = resolvedFx.rate > 0
                    ? `(≈ EGP ${formatMoney(misrUsd5EgpVal)})`
                    : `(No FX rate synced)`;
            }

            // Render separate numeric columns for NuMisrUsd5 (USD) and NuMisrUsd5 (EGP Eq.) so DOM, Email copy, and Excel exports have pure numbers
            const renderBankTds = (rowObj, bankCode) => {
                const egpVal = rowObj[bankCode] || 0;
                const highlight = bankCode === 'NUADIB64' ? 'highlight-cell' : '';
                if (bankCode === DEFAULT_FOREIGN_BANK) {
                    const usdVal = rowObj._misrUsd || 0;
                    return `<td style="color: #10b981;">${formatMoney(usdVal)}</td><td class="${highlight}">${formatMoney(egpVal)}</td>`;
                }
                return `<td class="${highlight}">${formatMoney(egpVal)}</td>`;
            };

            const appendBankExportCols = (exportObj, rowObj) => {
                selectedBanks.forEach(b => {
                    if (b === DEFAULT_FOREIGN_BANK) {
                        exportObj['NuMisrUsd5 (USD)'] = Number((rowObj._misrUsd || 0).toFixed(2));
                        exportObj['NuMisrUsd5 (EGP Eq.)'] = Number((rowObj[b] || 0).toFixed(2));
                    } else {
                        exportObj[`${b} (EGP)`] = Number((rowObj[b] || 0).toFixed(2));
                    }
                });
            };

            const buildRowAoaValues = (firstColLabel, rowObj, isGrandTotal = false) => {
                const arr = [firstColLabel];
                selectedBanks.forEach(b => {
                    if (b === DEFAULT_FOREIGN_BANK) {
                        arr.push(Number((rowObj._misrUsd || 0).toFixed(2)));
                        arr.push(Number((rowObj[b] || 0).toFixed(2)));
                    } else {
                        arr.push(Number((rowObj[b] || 0).toFixed(2)));
                    }
                });
                arr.push(Number((rowObj.Total || 0).toFixed(2)));
                if (showShare) {
                    if (isGrandTotal) {
                        arr.push('100.0%');
                    } else {
                        const pct = bankTotals.Total > 0 ? `${((rowObj.Total / bankTotals.Total) * 100).toFixed(1)}%` : '0.0%';
                        arr.push(pct);
                    }
                }
                return arr;
            };

            const renderShareCell = (amount) => {
                if (!showShare) return '';
                const pct = bankTotals.Total > 0 ? ((amount / bankTotals.Total) * 100) : 0;
                const widthPct = Math.min(100, Math.max(0, pct));
                return `<td class="pivot-share-col" style="min-width: 110px;">
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.45rem;">
                        <div style="width: 44px; height: 5px; background: rgba(255,255,255,0.07); border-radius: 999px; overflow: hidden;">
                            <div style="width: ${widthPct.toFixed(1)}%; height: 100%; background: var(--primary);"></div>
                        </div>
                        <span style="font-size: 0.78rem; color: var(--text-muted); min-width: 40px; text-align: right;">${pct.toFixed(1)}%</span>
                    </div>
                </td>`;
            };

            let htmlOutput = '';
            this.lastDashboardExportRows = [];
            const reportDailyRows = [];
            const reportMonthlyRows = [];
            const reportGroupedRows = [];
            const btnToggleMonths = document.getElementById('btn-dashboard-toggle-months');

            bankTotals._misrUsd = misrUsd5UsdTotal;

            if (groupBy === 'date') {
                const monthlyPivot = {};
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    const pDate = toDateOnly(tx.payment_date);
                    if (!pDate) return;
                    const monthKey = pDate.substring(0, 7); // YYYY-MM
                    
                    if (!monthlyPivot[monthKey]) {
                        monthlyPivot[monthKey] = { Total: 0, _misrUsd: 0, days: {} };
                        selectedBanks.forEach(b => monthlyPivot[monthKey][b] = 0);
                    }
                    if (!monthlyPivot[monthKey].days[pDate]) {
                        monthlyPivot[monthKey].days[pDate] = { Total: 0, _misrUsd: 0 };
                        selectedBanks.forEach(b => monthlyPivot[monthKey].days[pDate][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    const rawUsd = tx.bank === DEFAULT_FOREIGN_BANK ? (parseFloat(tx.raw_usd) || 0) : 0;
                    monthlyPivot[monthKey].days[pDate][tx.bank] += price;
                    monthlyPivot[monthKey].days[pDate].Total += price;
                    monthlyPivot[monthKey].days[pDate]._misrUsd += rawUsd;
                    monthlyPivot[monthKey][tx.bank] += price;
                    monthlyPivot[monthKey].Total += price;
                    monthlyPivot[monthKey]._misrUsd += rawUsd;
                });

                const months = Object.keys(monthlyPivot).sort();
                const multiMonth = months.length > 1 && sortBy === 'default';

                if (btnToggleMonths) {
                    btnToggleMonths.classList.toggle('hidden', !multiMonth);
                    const labelEl = document.getElementById('dashboard-toggle-months-label');
                    if (labelEl) labelEl.textContent = 'Expand All Months';
                }

                months.forEach(m => {
                    const monthData = monthlyPivot[m];
                    const parts = m.split('-');
                    const monthLabel = `${monthNames[parseInt(parts[1]) - 1]} ${parts[0]}`;
                    reportMonthlyRows.push(buildRowAoaValues(monthLabel, monthData));
                });

                if (sortBy !== 'default') {
                    // Flat sorted daily rows when sorting by Grand Total
                    const allDayEntries = [];
                    months.forEach(m => {
                        Object.keys(monthlyPivot[m].days).forEach(d => {
                            allDayEntries.push({ date: d, row: monthlyPivot[m].days[d] });
                        });
                    });
                    allDayEntries.sort((a, b) => sortBy === 'total_desc' ? (b.row.Total - a.row.Total) : (a.row.Total - b.row.Total));

                    allDayEntries.forEach(({ date: d, row }) => {
                        const dateParts = d.split('-');
                        const dateLabel = `${parseInt(dateParts[2])}-${monthNames[parseInt(dateParts[1]) - 1]}-${dateParts[0]}`;
                        htmlOutput += `<tr class="day-row" data-drill-group="date" data-drill-key="${d}" style="cursor: pointer;" title="Click to view transactions for ${dateLabel}">
                            <td>${dateLabel}</td>`;
                        const exportRow = { "Date": d }; // Excel exports use yyyy-mm-dd
                        selectedBanks.forEach(b => {
                            htmlOutput += renderBankTds(row, b);
                        });
                        appendBankExportCols(exportRow, row);
                        htmlOutput += `<td>${formatMoney(row.Total)}</td>`;
                        htmlOutput += renderShareCell(row.Total);
                        htmlOutput += `</tr>`;
                        exportRow["Grand Total (EGP)"] = Number((row.Total || 0).toFixed(2));
                        if (showShare) exportRow["% Share"] = bankTotals.Total > 0 ? `${((row.Total / bankTotals.Total) * 100).toFixed(1)}%` : '0.0%';
                        this.lastDashboardExportRows.push(exportRow);
                        reportDailyRows.push(buildRowAoaValues(d, row));
                    });
                } else {
                    months.forEach(m => {
                        const monthData = monthlyPivot[m];
                        const days = Object.keys(monthData.days).sort();
                        
                        if (multiMonth) {
                            const parts = m.split('-');
                            const monthLabel = `${monthNames[parseInt(parts[1]) - 1]} ${parts[0]}`;
                            htmlOutput += `<tr class="month-row" data-month="${m}">
                                <td><div class="month-toggle"><i data-lucide="chevron-right"></i><span>${monthLabel}</span></div></td>`;
                            selectedBanks.forEach(b => {
                                htmlOutput += renderBankTds(monthData, b);
                            });
                            htmlOutput += `<td>${formatMoney(monthData.Total)}</td>`;
                            htmlOutput += renderShareCell(monthData.Total);
                            htmlOutput += `</tr>`;
                        }

                        days.forEach(d => {
                            const row = monthData.days[d];
                            const dateParts = d.split('-');
                            const dateLabel = `${parseInt(dateParts[2])}-${monthNames[parseInt(dateParts[1]) - 1]}-${dateParts[0]}`;
                            htmlOutput += `<tr class="day-row month-${m}" data-drill-group="date" data-drill-key="${d}" style="${multiMonth ? 'display: none;' : ''} cursor: pointer;" title="Click to view transactions for ${dateLabel}">
                                <td>${dateLabel}</td>`;
                            const exportRow = { "Date": d }; // Excel exports use yyyy-mm-dd
                            selectedBanks.forEach(b => {
                                htmlOutput += renderBankTds(row, b);
                            });
                            appendBankExportCols(exportRow, row);
                            htmlOutput += `<td>${formatMoney(row.Total)}</td>`;
                            htmlOutput += renderShareCell(row.Total);
                            htmlOutput += `</tr>`;
                            exportRow["Grand Total (EGP)"] = Number((row.Total || 0).toFixed(2));
                            if (showShare) exportRow["% Share"] = bankTotals.Total > 0 ? `${((row.Total / bankTotals.Total) * 100).toFixed(1)}%` : '0.0%';
                            this.lastDashboardExportRows.push(exportRow);
                            reportDailyRows.push(buildRowAoaValues(d, row));
                        });
                    });
                }

                if (months.length === 0) {
                    htmlOutput = `<tr><td colspan="${totalColSpan}" style="text-align: center;">No data for selected period</td></tr>`;
                }

            } else {
                if (btnToggleMonths) btnToggleMonths.classList.add('hidden');
                // Group by Mapping, 2nd Mapping, or Item Name
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
                        groupedData[key] = { Total: 0, _misrUsd: 0 };
                        selectedBanks.forEach(b => groupedData[key][b] = 0);
                    }
                    
                    const price = parseFloat(tx.item_price) || 0;
                    const rawUsd = tx.bank === DEFAULT_FOREIGN_BANK ? (parseFloat(tx.raw_usd) || 0) : 0;
                    groupedData[key][tx.bank] += price;
                    groupedData[key].Total += price;
                    groupedData[key]._misrUsd += rawUsd;
                });

                const keys = Object.keys(groupedData);
                if (sortBy === 'total_desc') {
                    keys.sort((a, b) => groupedData[b].Total - groupedData[a].Total);
                } else if (sortBy === 'total_asc') {
                    keys.sort((a, b) => groupedData[a].Total - groupedData[b].Total);
                } else {
                    keys.sort();
                }

                const groupLabel = groupBy === 'mapping' ? 'Mapping' : (groupBy === 'second_mapping' ? '2nd Mapping' : 'Item Name');
                
                keys.forEach(k => {
                    const row = groupedData[k];
                    htmlOutput += `<tr data-drill-group="${groupBy}" data-drill-key="${escapeHTML(k)}" style="cursor: pointer;" title="Click to view transactions for ${escapeHTML(k)}">
                        <td>${escapeHTML(k)}</td>`;
                    const exportRow = { [groupLabel]: k };
                    selectedBanks.forEach(b => {
                        htmlOutput += renderBankTds(row, b);
                    });
                    appendBankExportCols(exportRow, row);
                    htmlOutput += `<td>${formatMoney(row.Total)}</td>`;
                    htmlOutput += renderShareCell(row.Total);
                    htmlOutput += `</tr>`;
                    exportRow["Grand Total (EGP)"] = Number((row.Total || 0).toFixed(2));
                    if (showShare) exportRow["% Share"] = bankTotals.Total > 0 ? `${((row.Total / bankTotals.Total) * 100).toFixed(1)}%` : '0.0%';
                    this.lastDashboardExportRows.push(exportRow);
                    reportGroupedRows.push(buildRowAoaValues(k, row));
                });

                if (keys.length === 0) {
                    htmlOutput = `<tr><td colspan="${totalColSpan}" style="text-align: center;">No data for selected period</td></tr>`;
                }
            }

            if (this.lastDashboardExportRows.length > 0) {
                const firstKey = Object.keys(this.lastDashboardExportRows[0])[0];
                const totalExportRow = { [firstKey]: 'Grand Total' };
                appendBankExportCols(totalExportRow, bankTotals);
                totalExportRow["Grand Total (EGP)"] = Number((bankTotals.Total || 0).toFixed(2));
                if (showShare) totalExportRow["% Share"] = '100.0%';
                this.lastDashboardExportRows.push(totalExportRow);
            }

            tbody.innerHTML = htmlOutput;

            let footHtml = `<tr><td>Grand Total</td>`;
            selectedBanks.forEach(b => {
                footHtml += renderBankTds(bankTotals, b);
            });
            footHtml += `<td>${formatMoney(bankTotals.Total)}</td>`;
            if (showShare) {
                footHtml += `<td class="pivot-share-col">100.0%</td>`;
            }
            footHtml += `</tr>`;
            tfoot.innerHTML = footHtml;

            const label = groupBy === 'date' ? 'Date' : (groupBy === 'mapping' ? 'Mapping' : (groupBy === 'second_mapping' ? '2nd Mapping' : 'Item Name'));
            const colHeaders = [label];
            selectedBanks.forEach(b => {
                if (b === DEFAULT_FOREIGN_BANK) {
                    colHeaders.push('NuMisrUsd5 (USD)', 'NuMisrUsd5 (EGP Eq.)');
                } else {
                    colHeaders.push(`${b} (EGP)`);
                }
            });
            colHeaders.push('Grand Total (EGP)');
            if (showShare) colHeaders.push('% Share');

            const thead = document.querySelector('#dashboard-pivot-table thead');
            if (thead) {
                thead.innerHTML = `
                    <tr><th colspan="${totalColSpan}" class="pivot-title">Total Collection (EGP Equivalent)</th></tr>
                    <tr>
                        <th class="pivot-row-label">${label}</th>
                        ${selectedBanks.map(b => b === DEFAULT_FOREIGN_BANK
                            ? `<th class="pivot-col-label" style="color: #10b981;">NuMisrUsd5 (USD)</th><th class="pivot-col-label">NuMisrUsd5 (EGP Eq.)</th>`
                            : `<th class="pivot-col-label ${b === 'NUADIB64' ? 'highlight-col' : ''}">${b} (EGP)</th>`
                        ).join('')}
                        <th class="pivot-col-label">Grand Total (EGP)</th>
                        ${showShare ? '<th class="pivot-col-label pivot-share-col">% Share</th>' : ''}
                    </tr>
                `;
            }

            // Update Stat Cards & Top Categories
            const totalCollections = bankTotals.Total || 0;
            document.getElementById('stat-total-collections').textContent = `EGP ${formatMoney(totalCollections)}`;
            
            let validCount = 0;
            let exemptCount = 0;
            let totalCountAll = 0;
            let settledCount = 0;
            let erpRecordedCount = 0;
            let unmappedCount = 0;
            const categoryTotals = {};

            if (rpcSucceeded) {
                if (fawryBanksSelected.length > 0) {
                    const exemptFilter = () => supabase.from('transactions').select('*', { count: 'exact', head: true })
                        .gte('payment_date', dateFrom).lte('payment_date', dateTo).in('bank', fawryBanksSelected)
                        .neq('id_status', 'Valid')
                        .or(SUPABASE_EXEMPT_OR_FILTER);

                    if (summaryRpcData && summaryRpcData.kpis) {
                        validCount = Number(summaryRpcData.kpis.valid_count) || 0;
                        totalCountAll = Number(summaryRpcData.kpis.total_count) || 0;
                        settledCount = Number(summaryRpcData.kpis.settled_count) || 0;
                        erpRecordedCount = Number(summaryRpcData.kpis.erp_count) || 0;
                        unmappedCount = Number(summaryRpcData.kpis.unmapped_count) || 0;
                        try {
                            const { count: exCnt, error: exErr } = await exemptFilter();
                            if (!exErr && exCnt !== null && exCnt !== undefined) exemptCount += Number(exCnt) || 0;
                        } catch (_) {}
                        if (Array.isArray(summaryRpcData.categories)) {
                            summaryRpcData.categories.forEach(r => {
                                const k = r.group_key || 'Unmapped';
                                categoryTotals[k] = (categoryTotals[k] || 0) + (parseFloat(r.total_amount) || 0);
                            });
                        }
                    } else {
                        // Fallback when get_dashboard_summary RPC is unavailable: fetch Fawry KPI counts + top categories in parallel
                        const baseFilter = () => supabase.from('transactions').select('*', { count: 'exact', head: true })
                            .gte('payment_date', dateFrom).lte('payment_date', dateTo).in('bank', fawryBanksSelected);

                        const validQuery = baseFilter().eq('id_status', 'Valid');
                        const totalQuery = baseFilter();
                        const settledQuery = baseFilter().eq('is_settled', true);
                        const erpQuery = baseFilter().not('erp_batch_number', 'is', null).neq('erp_batch_number', '');
                        const unmappedQuery = baseFilter().or('mapping.is.null,mapping.eq.');
                        const exemptQuery = exemptFilter();
                        const catPromise = (groupBy === 'mapping')
                            ? Promise.resolve({ data: null })
                            : supabase.rpc('get_dashboard_pivot_by', { start_date: dateFrom, end_date: dateTo, group_col: 'mapping' });

                        const [
                            { count: vCnt, error: vErr },
                            { count: tCnt, error: tErr },
                            { count: sCnt },
                            { count: eCnt },
                            { count: uCnt },
                            { count: exCnt },
                            catRes
                        ] = await Promise.all([validQuery, totalQuery, settledQuery, erpQuery, unmappedQuery, exemptQuery, catPromise]);

                        if (vErr) throw vErr;
                        if (tErr) throw tErr;
                        validCount = vCnt || 0;
                        exemptCount += exCnt || 0;
                        totalCountAll = tCnt || 0;
                        settledCount = sCnt || 0;
                        erpRecordedCount = eCnt || 0;
                        unmappedCount = uCnt || 0;

                        if (groupBy === 'mapping') {
                            allData.forEach(tx => {
                                if (!fawryBanksSelected.includes(tx.bank)) return;
                                const k = tx.mapping || 'Unmapped';
                                categoryTotals[k] = (categoryTotals[k] || 0) + (parseFloat(tx.item_price) || 0);
                            });
                        } else if (catRes && Array.isArray(catRes.data)) {
                            catRes.data.forEach(r => {
                                if (!fawryBanksSelected.includes(r.bank)) return;
                                const k = r.group_key || 'Unmapped';
                                categoryTotals[k] = (categoryTotals[k] || 0) + (parseFloat(r.total_amount) || 0);
                            });
                        }
                    }
                }

                if (includeForeignBank && matchingForeignRows.length > 0) {
                    totalCountAll += matchingForeignRows.length;
                    validCount += matchingForeignRows.filter(tx => getEffectiveIdStatus(tx) === 'Valid').length;
                    exemptCount += matchingForeignRows.filter(tx => getEffectiveIdStatus(tx) === 'Exempt').length;
                    settledCount += matchingForeignRows.filter(tx => Boolean(tx.is_settled)).length;
                    erpRecordedCount += matchingForeignRows.filter(tx => tx.erp_batch_number && String(tx.erp_batch_number).trim() !== '').length;
                    unmappedCount += matchingForeignRows.filter(tx => !tx.mapping || String(tx.mapping).trim() === '').length;
                    matchingForeignRows.forEach(tx => {
                        const k = tx.mapping || DEFAULT_FOREIGN_MAPPING;
                        categoryTotals[k] = (categoryTotals[k] || 0) + (parseFloat(tx.item_price) || 0);
                    });
                }
            } else {
                // Full rows were already fetched and filtered by selectedBanks – count in memory
                totalCountAll = allData.length;
                allData.forEach(tx => {
                    if (!selectedBanks.includes(tx.bank)) return;
                    const eff = getEffectiveIdStatus(tx);
                    if (eff === 'Valid') validCount++;
                    else if (eff === 'Exempt') exemptCount++;
                    if (tx.is_settled) settledCount++;
                    if (tx.erp_batch_number && String(tx.erp_batch_number).trim() !== '') erpRecordedCount++;
                    if (!tx.mapping || String(tx.mapping).trim() === '') unmappedCount++;
                    const k = tx.mapping || 'Unmapped';
                    categoryTotals[k] = (categoryTotals[k] || 0) + (parseFloat(tx.item_price) || 0);
                });
            }
            
            document.getElementById('stat-total-transactions').textContent = (totalCountAll || 0).toLocaleString();
            
            const avgTx = totalCountAll > 0 ? (totalCollections / totalCountAll) : 0;
            const avgEl = document.getElementById('stat-avg-tx');
            if (avgEl) avgEl.textContent = `Avg: EGP ${formatMoney(avgTx)} / tx`;

            const activeDaysEl = document.getElementById('stat-active-days');
            if (activeDaysEl) {
                activeDaysEl.textContent = activeDaysSet.size > 0
                    ? `${activeDaysSet.size} active payment day(s)`
                    : `${totalCountAll.toLocaleString()} matching record(s)`;
            }

            const checkableTotal = Math.max(0, (totalCountAll || 0) - (exemptCount || 0));
            const validPct = checkableTotal > 0 ? ((validCount / checkableTotal) * 100).toFixed(1) : (totalCountAll > 0 ? '100.0' : 0);
            const errorCount = Math.max(0, (totalCountAll || 0) - (validCount || 0) - (exemptCount || 0));
            
            document.getElementById('stat-valid-pct').textContent = `${validPct}%`;
            document.getElementById('stat-errors').textContent = errorCount.toLocaleString();

            const validCountEl = document.getElementById('stat-valid-count');
            if (validCountEl) {
                validCountEl.textContent = exemptCount > 0
                    ? `${validCount.toLocaleString()} valid tx • ${exemptCount.toLocaleString()} exempt`
                    : `${validCount.toLocaleString()} valid tx`;
            }

            const unmappedEl = document.getElementById('stat-unmapped-count');
            if (unmappedEl) unmappedEl.textContent = `${unmappedCount.toLocaleString()} unmapped item(s)`;

            const settledPct = totalCountAll > 0 ? ((settledCount / totalCountAll) * 100).toFixed(1) : 0;
            const unsettledCount = Math.max(0, totalCountAll - settledCount);
            const settledPctEl = document.getElementById('stat-settled-pct');
            const settledSubEl = document.getElementById('stat-settled-sub');
            if (settledPctEl) settledPctEl.textContent = `${settledPct}%`;
            if (settledSubEl) settledSubEl.textContent = `${settledCount.toLocaleString()} settled • ${unsettledCount.toLocaleString()} unsettled`;

            const erpPct = totalCountAll > 0 ? ((erpRecordedCount / totalCountAll) * 100).toFixed(1) : 0;
            const erpUnpostedCount = Math.max(0, totalCountAll - erpRecordedCount);
            const erpPctEl = document.getElementById('stat-erp-pct');
            const erpSubEl = document.getElementById('stat-erp-sub');
            if (erpPctEl) erpPctEl.textContent = `${erpPct}%`;
            if (erpSubEl) erpSubEl.textContent = `${erpRecordedCount.toLocaleString()} posted • ${erpUnpostedCount.toLocaleString()} unposted`;

            const fxRefInfo = resolveUsdToEgpRate(dateTo, this.fxStore);
            const summaryAoa = [
                ['Executive Collection Summary & KPIs', '', '', '', ''],
                ['Period', `${dateFrom} to ${dateTo}`, 'Subset Filter', statusFilter, ''],
                ['USD/EGP Exchange Rate Used', Number((fxRefInfo.rate || 0).toFixed(4)), 'Rate Date / Source', `${fxRefInfo.rateDate || dateTo} (${fxRefInfo.source})`, ''],
                [],
                ['Bank Split Breakdown', 'Native Currency', 'Native Amount', 'EGP Equivalent', '% Share of Total'],
                ['NUADCB136', 'EGP', Number(cb136Val.toFixed(2)), Number(cb136Val.toFixed(2)), `${cb136Pct.toFixed(1)}%`],
                ['NUADIB64', 'EGP', Number(ib64Val.toFixed(2)), Number(ib64Val.toFixed(2)), `${ib64Pct.toFixed(1)}%`],
                [DEFAULT_FOREIGN_BANK, 'USD', Number(misrUsd5UsdTotal.toFixed(2)), Number(misrUsd5EgpVal.toFixed(2)), `${misrUsd5Pct.toFixed(1)}%`],
                ['Combined Total (Selected Banks)', 'EGP', '', Number(totalCollections.toFixed(2)), '100.0%'],
                [],
                ['Operational KPI Metric', 'Value', 'Details', '', ''],
                ['Total Collections (EGP Eq.)', Number(totalCollections.toFixed(2)), `Avg EGP ${formatMoney(avgTx)} / tx`, '', ''],
                ['Total Transactions', totalCountAll, `${activeDaysSet.size} active payment day(s)`, '', ''],
                ['Valid Student IDs', validCount, `${validPct}% valid (${errorCount} invalid/missing)`, '', ''],
                ['Bank Settlement Coverage', settledCount, `${settledPct}% settled (${unsettledCount} unsettled)`, '', ''],
                ['ERP Posting Coverage', erpRecordedCount, `${erpPct}% posted (${erpUnpostedCount} unposted)`, '', ''],
                ['Unmapped Transactions', unmappedCount, '', '', '']
            ];

            const sortedAllCats = Object.entries(categoryTotals)
                .filter(([, amt]) => amt > 0)
                .sort((a, b) => b[1] - a[1]);
            if (sortedAllCats.length > 0) {
                summaryAoa.push([], ['Category Breakdown (Mapping)', 'Total (EGP Eq.)', '% Share', '', '']);
                sortedAllCats.forEach(([cat, amt]) => {
                    const pct = totalCollections > 0 ? `${((amt / totalCollections) * 100).toFixed(1)}%` : '0.0%';
                    summaryAoa.push([cat, Number(amt.toFixed(2)), pct, '', '']);
                });
            }

            this.lastDashboardReport = {
                titleText: 'Total Collection (EGP Equivalent)',
                groupBy,
                dateFrom,
                dateTo,
                colHeaders,
                dailyRows: reportDailyRows,
                monthlyRows: reportMonthlyRows,
                groupedRows: reportGroupedRows,
                grandTotalRow: buildRowAoaValues('Grand Total', bankTotals, true),
                summaryAoa
            };

            // Render Top Categories badges
            const topCatContainer = document.getElementById('dashboard-top-categories');
            if (topCatContainer) {
                const sortedCats = Object.entries(categoryTotals)
                    .filter(([, amt]) => amt > 0)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4);
                if (sortedCats.length === 0) {
                    topCatContainer.innerHTML = '<span style="color: var(--text-muted);">No category breakdown for this period</span>';
                } else {
                    topCatContainer.innerHTML = sortedCats.map(([cat, amt]) => {
                        const pct = totalCollections > 0 ? ((amt / totalCollections) * 100).toFixed(1) : '0.0';
                        return `<button type="button" class="btn btn-outline btn-sm" data-dash-category="${escapeHTML(cat)}" style="padding: 0.2rem 0.6rem; font-size: 0.74rem; border-radius: 999px; display: inline-flex; align-items: center; gap: 0.35rem;" title="Click to view ${escapeHTML(cat)} transactions">
                            <strong style="color: var(--text-main);">${escapeHTML(cat)}</strong>
                            <span style="color: var(--primary);">EGP ${formatMoney(amt)}</span>
                            <span style="color: var(--text-muted); font-size: 0.7rem;">(${pct}%)</span>
                        </button>`;
                    }).join('');
                }
            }

            // Render Executive Insights (UG vs PG Split & Prior Period Delta)
            const execInsightsEl = document.getElementById('dashboard-exec-insights');
            if (execInsightsEl) {
                const pills = [];
                const lvl = summaryRpcData?.levels;
                if (lvl && (Number(lvl.ug_total || 0) > 0 || Number(lvl.pg_total || 0) > 0)) {
                    const ugAmt = Number(lvl.ug_total || 0);
                    const pgAmt = Number(lvl.pg_total || 0);
                    const lvlTotal = ugAmt + pgAmt;
                    const ugPct = lvlTotal > 0 ? ((ugAmt / lvlTotal) * 100).toFixed(0) : '0';
                    const pgPct = lvlTotal > 0 ? ((pgAmt / lvlTotal) * 100).toFixed(0) : '0';
                    pills.push(
                        `<span class="badge" style="background: var(--primary-soft); color: var(--text-main); border: 1px solid var(--primary-border); padding: 0.22rem 0.6rem; font-size: 0.72rem; font-family: var(--font-mono);" title="Undergraduate vs Postgraduate Fawry collections in this period">` +
                        `UG ${ugPct}% (EGP ${formatMoney(ugAmt)}) • PG ${pgPct}% (EGP ${formatMoney(pgAmt)})</span>`
                    );
                    summaryAoa.push(
                        [],
                        ['Student Level Mix (Fawry)', 'Transactions', 'Total (EGP)', '% Share', ''],
                        ['Undergraduate (UG)', Number(lvl.ug_count || 0), Number(ugAmt.toFixed(2)), `${ugPct}%`, ''],
                        ['Postgraduate (PG)', Number(lvl.pg_count || 0), Number(pgAmt.toFixed(2)), `${pgPct}%`, '']
                    );
                }
                const prevPeriod = summaryRpcData?.prev_period;
                if (prevPeriod && Number(prevPeriod.total_egp || 0) > 0) {
                    const prevVal = Number(prevPeriod.total_egp);
                    const curFawryVal = cb136Val + ib64Val;
                    const deltaPct = ((curFawryVal - prevVal) / prevVal) * 100;
                    const isUp = deltaPct >= 0;
                    const arrow = isUp ? '▲' : '▼';
                    const color = isUp ? 'var(--success)' : 'var(--danger)';
                    pills.push(
                        `<span class="badge" style="background: ${isUp ? 'var(--success-bg)' : 'var(--danger-bg)'}; color: ${color}; border: 1px solid ${isUp ? 'var(--success-border)' : 'var(--danger-border)'}; padding: 0.22rem 0.6rem; font-size: 0.72rem; font-family: var(--font-mono);" title="Compared to prior period (${escapeHTML(prevPeriod.start_date)} to ${escapeHTML(prevPeriod.end_date)}: EGP ${formatMoney(prevVal)})">` +
                        `${arrow} ${Math.abs(deltaPct).toFixed(1)}% vs prior period</span>`
                    );
                    summaryAoa.push(
                        [],
                        ['Period-over-Period Comparison', 'Current Period (EGP)', 'Prior Period (EGP)', 'Change (%)', 'Prior Window'],
                        ['Fawry Collections', Number(curFawryVal.toFixed(2)), Number(prevVal.toFixed(2)), `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`, `${prevPeriod.start_date} to ${prevPeriod.end_date}`]
                    );
                }
                execInsightsEl.innerHTML = pills.join('');
            }

            this.updateSidebarBadges();
            this.markTabLoaded('dashboard');
            renderIcons(document.getElementById('view-dashboard'));

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="${totalColSpan}" style="color: var(--danger);">Error: ${escapeHTML(err.message)}</td></tr>`;
        }
    }
}

export function applyDashboardMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(DashboardMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(DashboardMixin.prototype, name));
        }
    }
}
