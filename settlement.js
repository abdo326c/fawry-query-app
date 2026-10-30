const settlementEsc = (v) => (window.escapeHTML ? window.escapeHTML(v) : String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])));

const formatStlMoney = (num) => {
    const n = parseFloat(num || 0);
    return (isNaN(n) ? 0 : n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

class SettlementProcessor {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.settlementData = [];
        this.reconciliationResults = [];
        this.systemTransactions = [];
        this.processedFilesCount = 0;
        this.isProcessing = false;
        this.statusFilter = 'all';
        this.searchTerm = '';
        this.batchFilter = '';
        this.bankFilter = '';
        this.currentPage = 1;
        this.pageSize = 100;
        this.initUI();
    }

    initUI() {
        this.dropZone = document.getElementById('settlement-drop-zone');
        this.fileInput = document.getElementById('settlement-file-input');
        this.statusDiv = document.getElementById('settlement-status');
        this.resultsTable = document.getElementById('settlement-results-body');

        this.btnClear = document.getElementById('btn-clear-settlement');
        this.btnExportConsolidated = document.getElementById('btn-export-consolidated');
        this.btnExportRecon = document.getElementById('btn-export-recon');
        this.btnMarkSettled = document.getElementById('btn-mark-settled');
        this.btnMarkSettledLabel = document.getElementById('btn-mark-settled-label');

        this.checkMissingStlToggle = document.getElementById('settlement-check-missing-stl');
        this.searchInput = document.getElementById('settlement-search');
        this.batchSelect = document.getElementById('settlement-batch-filter');
        this.bankSelect = document.getElementById('settlement-bank-filter');

        if (!this.dropZone) return;

        this.dropZone.addEventListener('click', () => this.fileInput.click());
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('dragover');
        });
        this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('dragover'));
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) this.handleFiles(e.dataTransfer.files);
        });

        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const files = Array.from(e.target.files);
                e.target.value = ''; // allow selecting the same file(s) again
                this.handleFiles(files);
            }
        });

        this.btnClear?.addEventListener('click', () => this.clearReconciliation());
        this.btnExportConsolidated?.addEventListener('click', () => this.exportConsolidated());
        this.btnExportRecon?.addEventListener('click', () => this.exportReconciliation());
        this.btnMarkSettled?.addEventListener('click', () => this.markAsSettled());

        // Filter Pills
        document.querySelectorAll('[data-stl-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-stl-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.statusFilter = btn.getAttribute('data-stl-filter') || 'all';
                if (this.statusFilter === 'Missing in Settlement' && this.checkMissingStlToggle && !this.checkMissingStlToggle.checked) {
                    this.checkMissingStlToggle.checked = true;
                }
                this.currentPage = 1;
                this.renderResults();
            });
        });

        // Toggle Missing in Settlement
        this.checkMissingStlToggle?.addEventListener('change', () => {
            if (!this.checkMissingStlToggle.checked && this.statusFilter === 'Missing in Settlement') {
                this.statusFilter = 'all';
                document.querySelectorAll('[data-stl-filter]').forEach(b => {
                    b.classList.toggle('active', b.getAttribute('data-stl-filter') === 'all');
                });
            }
            this.currentPage = 1;
            if (this.reconciliationResults.length > 0) {
                this.renderResults();
            }
        });

        // Search input
        let searchTimer;
        this.searchInput?.addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                this.searchTerm = (e.target.value || '').trim().toLowerCase();
                this.currentPage = 1;
                this.renderResults();
            }, 200);
        });

        // Settlement Batch & Bank filters
        this.batchSelect?.addEventListener('change', (e) => {
            this.batchFilter = e.target.value || '';
            this.currentPage = 1;
            this.renderResults();
        });

        this.bankSelect?.addEventListener('change', (e) => {
            this.bankFilter = e.target.value || '';
            this.currentPage = 1;
            this.renderResults();
        });
    }

    clearReconciliation() {
        this.settlementData = [];
        this.reconciliationResults = [];
        this.systemTransactions = [];
        this.processedFilesCount = 0;
        this.statusFilter = 'all';
        this.searchTerm = '';
        this.batchFilter = '';
        this.bankFilter = '';
        this.currentPage = 1;

        if (this.searchInput) this.searchInput.value = '';
        if (this.batchSelect) this.batchSelect.innerHTML = '<option value="">All Settlement Nos</option>';
        if (this.bankSelect) this.bankSelect.value = '';
        document.querySelectorAll('[data-stl-filter]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-stl-filter') === 'all');
        });

        document.getElementById('recon-actions')?.classList.add('hidden');
        document.getElementById('settlement-summary-card')?.classList.add('hidden');
        const pager = document.getElementById('settlement-pagination');
        if (pager) pager.style.display = 'none';

        if (this.resultsTable) {
            this.resultsTable.innerHTML = '<tr><td colspan="9" class="text-center" style="color: var(--text-muted); padding: 2rem;">Upload Fawry settlement files to see reconciliation results.</td></tr>';
        }
        this.setStatus('');
    }

    setStatus(msg, isError = false) {
        if (!this.statusDiv) return;
        this.statusDiv.innerHTML = msg;
        this.statusDiv.className = isError ? 'text-danger' : 'text-primary';
        if (window.lucide) lucide.createIcons({ root: this.statusDiv });
    }

    async handleFiles(files) {
        if (this.isProcessing) {
            Toast.show('Settlement files are already being processed. Please wait.', 'warning');
            return;
        }
        this.isProcessing = true;
        this.setStatus('<i data-lucide="loader" class="spin"></i> Processing files...');
        this.settlementData = [];
        this.reconciliationResults = [];
        this.processedFilesCount = 0;
        // Each run starts fresh; only duplicates WITHIN the same selection are skipped.
        const seenInThisRun = new Set();

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const lower = file.name.toLowerCase();
                if (seenInThisRun.has(file.name)) {
                    Toast.show(`File ${file.name} was selected twice. Skipping the duplicate.`, 'info');
                    continue;
                }
                seenInThisRun.add(file.name);

                if (lower.endsWith('.zip')) {
                    await this.processZip(file);
                } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) {
                    if (!file.name.startsWith('~$')) {
                        await this.processExcel(file, file.name);
                    }
                }
            }

            this.setStatus(`<i data-lucide="check-circle"></i> Extracted ${this.settlementData.length} records from ${this.processedFilesCount} sheet(s). Reconciling...`);
            await this.reconcile();
        } catch (err) {
            console.error(err);
            this.setStatus(`Error: ${settlementEsc(err.message)}`, true);
        } finally {
            this.isProcessing = false;
        }
    }

    async processZip(file) {
        const zip = await JSZip.loadAsync(file);
        const excelFiles = Object.keys(zip.files).filter(name => {
            const lower = name.toLowerCase();
            return (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) &&
                !zip.files[name].dir &&
                !name.includes('~$') &&
                !name.includes('__MACOSX');
        });

        for (const name of excelFiles) {
            const content = await zip.files[name].async('arraybuffer');
            const blob = new Blob([content]);
            await this.processExcel(blob, name);
        }
    }

    async processExcel(fileBlob, fileName) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const firstSheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[firstSheetName];

                    // Convert to array of arrays
                    const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
                    if (!rawData || rawData.length === 0) return resolve();

                    // Dynamically detect header row within the first 15 rows (looking for SETTLEMENTNO or ORDER_REF_NUMBER),
                    // with fallback to row index 6 (Row 7 in standard Fawry Settlement Excel exports).
                    let headerRowIdx = -1;
                    for (let r = 0; r < Math.min(15, rawData.length); r++) {
                        const rowCells = (rawData[r] || []).map(c => c != null ? String(c).trim().toUpperCase() : '');
                        if (rowCells.includes('SETTLEMENTNO') || rowCells.includes('ORDER_REF_NUMBER')) {
                            headerRowIdx = r;
                            break;
                        }
                    }
                    if (headerRowIdx === -1) {
                        if (rawData.length <= 6) return resolve();
                        headerRowIdx = 6;
                    }

                    const headers = (rawData[headerRowIdx] || []).map(h => h ? String(h).trim() : '');

                    // Handle duplicate headers (like Power Query does)
                    const cleanHeaders = [];
                    const headerCounts = {};
                    for (const h of headers) {
                        if (!h) {
                            cleanHeaders.push(null);
                            continue;
                        }
                        if (headerCounts[h]) {
                            cleanHeaders.push(`${h}_${headerCounts[h]}`);
                            headerCounts[h]++;
                        } else {
                            cleanHeaders.push(h);
                            headerCounts[h] = 1;
                        }
                    }

                    let fileAddedRows = 0;
                    // Process data rows after headerRowIdx
                    for (let i = headerRowIdx + 1; i < rawData.length; i++) {
                        const row = rawData[i];
                        const rowData = { SOURCE_FILE: fileName };
                        let hasSettlementNo = false;

                        if (!row) continue;
                        for (let j = 0; j < cleanHeaders.length; j++) {
                            const colName = cleanHeaders[j];
                            if (colName) {
                                const val = row[j] === undefined ? null : row[j];
                                rowData[colName] = val;
                                if (colName === 'SETTLEMENTNO' && val !== null && String(val).trim() !== '') {
                                    hasSettlementNo = true;
                                }
                            }
                        }

                        if (hasSettlementNo) {
                            // Convert numeric amounts
                            ['TOTAL_PAYMENT', 'TOTAL_REFUND', 'ORDER_AMOUNT', 'REFUND_AMOUNT', 'CUSTOMER_FEES', 'MERCHANT_COMMISSION', 'NETAMOUNT', 'NETAMOUNT_REFUND'].forEach(col => {
                                if (rowData[col] !== undefined && rowData[col] !== null) {
                                    rowData[col] = parseFloat(String(rowData[col]).replace(/,/g, '')) || 0;
                                }
                            });

                            // Subtract refund from NETAMOUNT when present (avoid double subtraction on already-processed files)
                            if (rowData['NETAMOUNT_REFUND'] && !rowData['_REFUND_APPLIED']) {
                                rowData['NETAMOUNT'] = (rowData['NETAMOUNT'] || 0) - rowData['NETAMOUNT_REFUND'];
                                rowData['_REFUND_APPLIED'] = true;
                            }

                            // Convert dates to "YYYY-MM-DD" date-only text (strip time component)
                            ['SETTLEMENT_DATE', 'TRXDATE'].forEach(dateCol => {
                                if (rowData[dateCol] !== null && rowData[dateCol] !== undefined && rowData[dateCol] !== '') {
                                    rowData[dateCol] = SettlementProcessor.toDateOnly(rowData[dateCol]) || rowData[dateCol];
                                }
                            });

                            delete rowData['_REFUND_APPLIED'];
                            this.settlementData.push(rowData);
                            fileAddedRows++;
                        }
                    }

                    if (fileAddedRows > 0) {
                        this.processedFilesCount++;
                    }
                    resolve();
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = (err) => reject(err);
            reader.readAsArrayBuffer(fileBlob);
        });
    }

    async reconcile() {
        if (this.settlementData.length === 0) {
            this.setStatus('No valid settlement data found.', true);
            return;
        }

        // Group settlement data by ORDER_REF_NUMBER
        const stlGrouped = {};
        let skippedNoRef = 0;
        for (const row of this.settlementData) {
            const rawRef = row['ORDER_REF_NUMBER'];
            const ref = rawRef === null || rawRef === undefined ? '' : String(rawRef).trim();
            if (!ref) { skippedNoRef++; continue; }

            if (!stlGrouped[ref]) {
                stlGrouped[ref] = {
                    ORDER_REF_NUMBER: ref,
                    SETTLEMENTNO: row['SETTLEMENTNO'] != null ? String(row['SETTLEMENTNO']).trim() : '',
                    SETTLEMENT_DATE: SettlementProcessor.toDateOnly(row['SETTLEMENT_DATE']) || row['SETTLEMENT_DATE'] || null,
                    TRXDATE: SettlementProcessor.toDateOnly(row['TRXDATE']) || row['TRXDATE'] || null,
                    SOURCE_FILE: row['SOURCE_FILE'] || '',
                    NETAMOUNT: 0
                };
            }
            stlGrouped[ref].NETAMOUNT = Math.round((stlGrouped[ref].NETAMOUNT + (row['NETAMOUNT'] || 0)) * 100) / 100;
        }

        const settlementRefs = Object.keys(stlGrouped);

        // Collect the distinct TRXDATE dates present in the settlement files (and min/max fallback)
        const settlementDatesSet = new Set();
        let minTrxDateStr = '2099-12-31';
        let maxTrxDateStr = '1970-01-01';
        for (const ref of settlementRefs) {
            const dStr = SettlementProcessor.toDateOnly(stlGrouped[ref].TRXDATE);
            if (dStr) {
                settlementDatesSet.add(dStr);
                if (dStr < minTrxDateStr) minTrxDateStr = dStr;
                if (dStr > maxTrxDateStr) maxTrxDateStr = dStr;
            }
        }

        this.setStatus('<i data-lucide="loader" class="spin"></i> Fetching system transactions for reconciliation...');

        const txMap = new Map(); // deduplicate by id
        const detectedBanks = new Set();

        // 1. Fetch all references in the settlement explicitly to guarantee we don't miss them, and to DETECT the bank
        const chunkSize = 150;
        for (let i = 0; i < settlementRefs.length; i += chunkSize) {
            const chunk = settlementRefs.slice(i, i + chunkSize);
            let refTx;
            try {
                refTx = await this.fetchAllPages(() => this.supabase
                    .from('transactions')
                    .select('*')
                    .in('reference_number', chunk));
            } catch (refErr) {
                this.setStatus('Error fetching DB transactions by reference: ' + settlementEsc(refErr.message), true);
                return;
            }
            refTx.forEach(tx => {
                txMap.set(tx.id, tx);
                if (tx.bank) detectedBanks.add(tx.bank);
            });
        }

        const bankArray = detectedBanks.size > 0 ? Array.from(detectedBanks) : ['NUADCB136', 'NUADIB64'];

        // 2. Fetch DB transactions for the payment dates covered by the settlement to detect "Missing in Settlement"
        if (minTrxDateStr !== '2099-12-31') {
            let dateTx;
            try {
                dateTx = await this.fetchAllPages(() => this.supabase
                    .from('transactions')
                    .select('*')
                    .in('bank', bankArray)
                    .gte('payment_date', minTrxDateStr)
                    .lte('payment_date', maxTrxDateStr));
            } catch (dateErr) {
                this.setStatus('Error fetching DB transactions by date: ' + settlementEsc(dateErr.message), true);
                return;
            }
            dateTx.forEach(tx => txMap.set(tx.id, tx));
        }

        this.systemTransactions = Array.from(txMap.values());

        // Group DB transactions by reference_number (essential for multi-item NUADIB64 orders)
        const dbGrouped = {};
        for (const tx of this.systemTransactions) {
            const ref = tx.reference_number == null ? '' : String(tx.reference_number).trim();
            if (!ref) continue;
            const cleanTxDate = SettlementProcessor.toDateOnly(tx.payment_date) || tx.payment_date;
            if (!dbGrouped[ref]) {
                dbGrouped[ref] = {
                    reference_number: ref,
                    payment_date: cleanTxDate,
                    bank: tx.bank || '',
                    student_id: tx.student_id || '',
                    item_price: 0,
                    is_settled: !!tx.is_settled,
                    settlement_batch: tx.settlement_batch || null,
                    items: []
                };
            }
            dbGrouped[ref].item_price = Math.round((dbGrouped[ref].item_price + (parseFloat(tx.item_price) || 0)) * 100) / 100;
            // A reference counts as settled only when ALL of its items are settled
            dbGrouped[ref].is_settled = dbGrouped[ref].is_settled && !!tx.is_settled;
            if (!dbGrouped[ref].bank && tx.bank) dbGrouped[ref].bank = tx.bank;
            if (!dbGrouped[ref].student_id && tx.student_id) dbGrouped[ref].student_id = tx.student_id;
            if (!dbGrouped[ref].settlement_batch && tx.settlement_batch) dbGrouped[ref].settlement_batch = tx.settlement_batch;
            dbGrouped[ref].items.push(tx);
        }

        // Reconcile each settlement reference against DB
        this.reconciliationResults = [];
        const processedRefs = new Set();

        for (const ref of settlementRefs) {
            processedRefs.add(ref);
            const sData = stlGrouped[ref];
            const dData = dbGrouped[ref];

            if (dData) {
                const sysAmt = dData.item_price;
                const stlAmt = sData.NETAMOUNT;
                const variance = Math.round((stlAmt - sysAmt) * 100) / 100;
                const isMatched = Math.abs(variance) < 0.1;

                this.reconciliationResults.push({
                    reference: ref,
                    status: isMatched ? 'Matched' : 'Amount Mismatch',
                    bank: dData.bank || (detectedBanks.size === 1 ? Array.from(detectedBanks)[0] : ''),
                    student_id: dData.student_id || '',
                    sys_amount: sysAmt,
                    stl_amount: stlAmt,
                    variance: variance,
                    settlement_no: sData.SETTLEMENTNO,
                    payment_date: dData.payment_date || sData.TRXDATE,
                    settlement_date: sData.SETTLEMENT_DATE,
                    source_file: sData.SOURCE_FILE,
                    is_settled: dData.is_settled,
                    db_settlement_batch: dData.settlement_batch,
                    in_db: true
                });
            } else {
                // In Settlement file, but missing from DB
                const stlAmt = sData.NETAMOUNT;
                this.reconciliationResults.push({
                    reference: ref,
                    status: 'Missing in System',
                    bank: detectedBanks.size === 1 ? Array.from(detectedBanks)[0] : '',
                    student_id: '',
                    sys_amount: 0,
                    stl_amount: stlAmt,
                    variance: stlAmt,
                    settlement_no: sData.SETTLEMENTNO,
                    payment_date: sData.TRXDATE || null,
                    settlement_date: sData.SETTLEMENT_DATE || null,
                    source_file: sData.SOURCE_FILE,
                    is_settled: false,
                    db_settlement_batch: null,
                    in_db: false
                });
            }
        }

        // Check for "Missing in Settlement": unsettled DB transactions on the actual TRXDATE dates present in the uploaded settlement file(s)
        for (const ref in dbGrouped) {
            if (!processedRefs.has(ref)) {
                const dData = dbGrouped[ref];
                const dDate = SettlementProcessor.toDateOnly(dData.payment_date);
                const matchesSettlementDate = settlementDatesSet.size > 0
                    ? (dDate && settlementDatesSet.has(dDate))
                    : (dDate && dDate >= minTrxDateStr && dDate <= maxTrxDateStr);

                if (!dData.is_settled && matchesSettlementDate) {
                    this.reconciliationResults.push({
                        reference: ref,
                        status: 'Missing in Settlement',
                        bank: dData.bank || '',
                        student_id: dData.student_id || '',
                        sys_amount: dData.item_price,
                        stl_amount: 0,
                        variance: Math.round((0 - dData.item_price) * 100) / 100,
                        settlement_no: null,
                        payment_date: dData.payment_date,
                        settlement_date: null,
                        source_file: '',
                        is_settled: dData.is_settled,
                        db_settlement_batch: dData.settlement_batch,
                        in_db: true
                    });
                }
            }
        }

        // Sort: Discrepancies first (Amount Mismatch -> Missing in System -> Missing in Settlement -> Matched)
        const statusOrder = {
            'Amount Mismatch': 1,
            'Missing in System': 2,
            'Missing in Settlement': 3,
            'Matched': 4
        };
        this.reconciliationResults.sort((a, b) => {
            const oa = statusOrder[a.status] || 99;
            const ob = statusOrder[b.status] || 99;
            if (oa !== ob) return oa - ob;
            return String(b.payment_date || '').localeCompare(String(a.payment_date || ''));
        });

        // Populate Settlement Batch filter dropdown
        if (this.batchSelect) {
            const batches = [...new Set(this.reconciliationResults.map(r => r.settlement_no).filter(Boolean))].sort();
            this.batchSelect.innerHTML = '<option value="">All Settlement Nos</option>' +
                batches.map(b => `<option value="${settlementEsc(b)}">${settlementEsc(b)}</option>`).join('');
            this.batchFilter = '';
        }

        this.currentPage = 1;
        this.renderResults();

        const includeMissingStl = !this.checkMissingStlToggle || this.checkMissingStlToggle.checked;
        const activeResults = includeMissingStl
            ? this.reconciliationResults
            : this.reconciliationResults.filter(r => r.status !== 'Missing in Settlement');
        const matchCount = activeResults.filter(r => r.status === 'Matched').length;
        const issueCount = activeResults.length - matchCount;
        const noRefNote = skippedNoRef > 0 ? ` (${skippedNoRef} row(s) without ORDER_REF_NUMBER skipped)` : '';
        this.setStatus(`<i data-lucide="check-circle"></i> Reconciliation complete! Matches: ${matchCount.toLocaleString()}, Discrepancies: ${issueCount.toLocaleString()}${noRefNote}`);
        if (window.lucide) lucide.createIcons();
    }

    getFilteredResults() {
        const includeMissingStl = !this.checkMissingStlToggle || this.checkMissingStlToggle.checked;
        const sf = this.statusFilter || 'all';
        const q = (this.searchTerm || '').toLowerCase();
        const batch = this.batchFilter || '';
        const bank = this.bankFilter || '';

        return (this.reconciliationResults || []).filter(r => {
            if (!includeMissingStl && r.status === 'Missing in Settlement') return false;

            if (sf === 'issues' && r.status === 'Matched') return false;
            else if (sf === 'unsettled_matched' && !(r.status === 'Matched' && !r.is_settled)) return false;
            else if (sf !== 'all' && sf !== 'issues' && sf !== 'unsettled_matched' && r.status !== sf) return false;

            if (batch && String(r.settlement_no || '') !== batch) return false;
            if (bank && String(r.bank || '') !== bank) return false;

            if (q) {
                const haystacks = [
                    r.reference,
                    r.settlement_no,
                    r.bank,
                    r.student_id,
                    r.source_file,
                    r.payment_date,
                    r.settlement_date,
                    r.status
                ];
                const hit = haystacks.some(v => v && String(v).toLowerCase().includes(q));
                if (!hit) return false;
            }
            return true;
        });
    }

    updateSummaryAndActions() {
        const all = this.reconciliationResults || [];
        const summaryCard = document.getElementById('settlement-summary-card');
        const actionsBar = document.getElementById('recon-actions');

        if (all.length === 0) {
            summaryCard?.classList.add('hidden');
            actionsBar?.classList.add('hidden');
            return;
        }

        summaryCard?.classList.remove('hidden');
        actionsBar?.classList.remove('hidden');

        const includeMissingStl = !this.checkMissingStlToggle || this.checkMissingStlToggle.checked;
        const activePool = includeMissingStl ? all : all.filter(r => r.status !== 'Missing in Settlement');

        // Financial totals across active pool
        const totalStlAmount = activePool.reduce((acc, r) => acc + (Number(r.stl_amount) || 0), 0);
        const totalSysAmount = activePool.reduce((acc, r) => acc + (Number(r.sys_amount) || 0), 0);
        const netVariance = Math.round((totalStlAmount - totalSysAmount) * 100) / 100;

        const matchedCount = all.filter(r => r.status === 'Matched').length;
        const mismatchCount = all.filter(r => r.status === 'Amount Mismatch').length;
        const missingSysCount = all.filter(r => r.status === 'Missing in System').length;
        const missingStlCount = all.filter(r => r.status === 'Missing in Settlement').length;
        const unsettledMatchedCount = all.filter(r => r.status === 'Matched' && !r.is_settled).length;

        const setElText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        setElText('stl-stat-stl-amount', `EGP ${formatStlMoney(totalStlAmount)}`);
        setElText('stl-stat-sys-amount', `EGP ${formatStlMoney(totalSysAmount)}`);

        const varEl = document.getElementById('stl-stat-variance');
        if (varEl) {
            const sign = netVariance > 0.005 ? '+' : '';
            varEl.textContent = `EGP ${sign}${formatStlMoney(netVariance)}`;
            varEl.style.color = Math.abs(netVariance) < 0.05 ? 'var(--success)' : 'var(--danger)';
        }

        setElText('stl-stat-files', String(this.processedFilesCount || 1));
        setElText('stl-stat-matched', matchedCount.toLocaleString());
        setElText('stl-stat-mismatch', mismatchCount.toLocaleString());
        setElText('stl-stat-missing-sys', missingSysCount.toLocaleString());
        setElText('stl-stat-missing-stl', missingStlCount.toLocaleString());
        setElText('stl-stat-unsettled-matched', unsettledMatchedCount.toLocaleString());

        if (this.btnMarkSettledLabel) {
            this.btnMarkSettledLabel.textContent = `Mark Matched as Settled in DB (${unsettledMatchedCount.toLocaleString()})`;
        } else if (this.btnMarkSettled) {
            this.btnMarkSettled.innerHTML = `<i data-lucide="check-square"></i> Mark Matched as Settled in DB (${unsettledMatchedCount.toLocaleString()})`;
        }
        if (this.btnMarkSettled) {
            this.btnMarkSettled.disabled = unsettledMatchedCount === 0;
            this.btnMarkSettled.style.opacity = unsettledMatchedCount === 0 ? '0.6' : '1';
        }
    }

    renderResults() {
        if (!this.resultsTable) return;

        this.updateSummaryAndActions();

        const filtered = this.getFilteredResults();
        const pageSize = this.pageSize || 100;
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (!this.currentPage || this.currentPage > totalPages) this.currentPage = 1;

        if (total === 0) {
            this.resultsTable.innerHTML = `<tr><td colspan="9" class="text-center" style="color: var(--text-muted); padding: 2rem;">No reconciliation rows match the current filter criteria.</td></tr>`;
            const pager = document.getElementById('settlement-pagination');
            if (pager) pager.style.display = 'none';
            return;
        }

        const startIdx = (this.currentPage - 1) * pageSize;
        const pageItems = filtered.slice(startIdx, startIdx + pageSize);
        const esc = settlementEsc;

        this.resultsTable.innerHTML = pageItems.map(r => {
            // Native status badge styling
            let badgeClass = 'valid-id';
            let badgeStyle = '';
            if (r.status === 'Amount Mismatch') {
                badgeClass = 'missing-id';
                badgeStyle = 'background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.35);';
            } else if (r.status === 'Missing in System') {
                badgeClass = 'invalid-id';
            } else if (r.status === 'Missing in Settlement') {
                badgeClass = 'missing-id';
                badgeStyle = 'background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.35);';
            }

            // Variance formatting
            const variance = Number(r.variance ?? (Number(r.stl_amount || 0) - Number(r.sys_amount || 0)));
            const absVar = Math.abs(variance);
            let varianceHtml = `<span style="color: var(--text-muted);">0.00</span>`;
            if (absVar >= 0.01) {
                const sign = variance > 0 ? '+' : '';
                const varColor = r.status === 'Amount Mismatch' ? '#eab308' : 'var(--danger)';
                varianceHtml = `<strong style="color: ${varColor}; font-family: monospace;">${sign}${formatStlMoney(variance)}</strong>`;
            }

            // Reference cell (clickable if present in DB)
            const refHtml = r.in_db
                ? `<a href="#" class="stl-inspect-ref" data-ref="${esc(r.reference)}" style="color: var(--primary); font-family: monospace; font-weight: 600; text-decoration: none;" title="Click to inspect transaction in database">${esc(r.reference)}</a>`
                : `<span style="font-family: monospace; font-weight: 600;">${esc(r.reference)}</span>`;

            // Settlement No + source file subtitle
            const stlNoHtml = r.settlement_no
                ? `<div style="font-family: monospace; font-size: 0.83rem;">${esc(r.settlement_no)}</div>` +
                  (r.source_file ? `<div style="font-size: 0.72rem; color: var(--text-muted); max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(r.source_file)}">${esc(r.source_file)}</div>` : '')
                : '<span style="color: var(--text-muted);">-</span>';

            // Payment date + settlement date subtitle
            const dateHtml = `
                <div>${esc(r.payment_date || '-')}</div>
                ${r.settlement_date ? `<div style="font-size: 0.72rem; color: var(--text-muted);" title="Fawry Settlement Date">Stl: ${esc(r.settlement_date)}</div>` : ''}
            `;

            // DB Settled badge + quick action
            const settledBadge = r.is_settled
                ? `<span class="status-badge valid-id" style="font-size: 0.72rem; padding: 0.12rem 0.45rem;" title="${r.db_settlement_batch ? 'Batch: ' + esc(r.db_settlement_batch) : 'Marked as settled'}">Yes</span>`
                : `<span style="color: var(--text-muted); font-size: 0.78rem;">No</span>`;

            const inspectBtn = r.in_db
                ? `<button type="button" class="btn btn-outline btn-sm stl-inspect-ref" data-ref="${esc(r.reference)}" title="View Transaction Details" style="padding: 0.12rem 0.4rem; font-size: 0.72rem; height: auto;">Details</button>`
                : '';

            return `
                <tr>
                    <td>${refHtml}</td>
                    <td><span class="status-badge ${badgeClass}" style="${badgeStyle}">${esc(r.status)}</span></td>
                    <td>${r.bank ? `<span class="badge badge-gray" style="font-size: 0.74rem;">${esc(r.bank)}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                    <td style="font-family: monospace;">${formatStlMoney(r.sys_amount)}</td>
                    <td style="font-family: monospace;">${formatStlMoney(r.stl_amount)}</td>
                    <td>${varianceHtml}</td>
                    <td>${stlNoHtml}</td>
                    <td>${dateHtml}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 0.45rem;">
                            ${settledBadge}
                            ${inspectBtn}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        // Wire click-to-inspect reference links/buttons
        this.resultsTable.querySelectorAll('.stl-inspect-ref').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const ref = el.getAttribute('data-ref');
                if (ref && window.app && typeof window.app.openTransactionDetailsModal === 'function') {
                    window.app.openTransactionDetailsModal(ref);
                }
            });
        });

        // Render or update pagination bar for large settlement batches
        const tableContainer = this.resultsTable.closest('.table-container');
        if (tableContainer) {
            let pager = document.getElementById('settlement-pagination');
            if (!pager) {
                pager = document.createElement('div');
                pager.id = 'settlement-pagination';
                pager.className = 'pagination';
                tableContainer.appendChild(pager);
            }
            if (total > pageSize) {
                pager.style.display = 'flex';
                pager.innerHTML = `
                    <span style="font-size: 0.85rem; color: var(--text-muted);">Showing ${startIdx + 1}–${Math.min(startIdx + pageSize, total)} of ${total.toLocaleString()} references</span>
                    <div style="display: flex; gap: 1rem; align-items: center;">
                        <button class="btn btn-outline" id="btn-stl-prev" ${this.currentPage === 1 ? 'disabled' : ''}>Prev</button>
                        <span style="font-size: 0.85rem; color: var(--text-muted);">Page ${this.currentPage} of ${totalPages}</span>
                        <button class="btn btn-outline" id="btn-stl-next" ${this.currentPage >= totalPages ? 'disabled' : ''}>Next</button>
                    </div>
                `;
                pager.querySelector('#btn-stl-prev')?.addEventListener('click', () => {
                    if (this.currentPage > 1) { this.currentPage--; this.renderResults(); }
                });
                pager.querySelector('#btn-stl-next')?.addEventListener('click', () => {
                    if (this.currentPage < totalPages) { this.currentPage++; this.renderResults(); }
                });
            } else {
                pager.style.display = 'none';
            }
        }
    }

    exportConsolidated() {
        if (this.settlementData.length === 0) {
            Toast.show('No settlement data to export.', 'warning');
            return;
        }
        const ws = XLSX.utils.json_to_sheet(this.settlementData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Consolidated Settlement");
        XLSX.writeFile(wb, `Consolidated_Settlement_${new Date().toISOString().split('T')[0]}.xlsx`);
    }

    exportReconciliation() {
        if (this.reconciliationResults.length === 0) {
            Toast.show('No reconciliation data to export.', 'warning');
            return;
        }

        const formatRow = (r) => ({
            "Reference Number": r.reference,
            "Status": r.status,
            "Bank": r.bank || '',
            "Student ID": r.student_id || '',
            "System Amount (EGP)": Number(r.sys_amount || 0),
            "Settlement Amount (EGP)": Number(r.stl_amount || 0),
            "Variance (Stl - Sys)": Number(r.variance ?? (Number(r.stl_amount || 0) - Number(r.sys_amount || 0))),
            "Settlement No": r.settlement_no || '',
            "Payment Date": r.payment_date || '',
            "Settlement Date": r.settlement_date || '',
            "Source File": r.source_file || '',
            "Settled in DB": r.is_settled ? 'Yes' : 'No'
        });

        const includeMissingStl = !this.checkMissingStlToggle || this.checkMissingStlToggle.checked;
        const activeRows = includeMissingStl
            ? this.reconciliationResults
            : this.reconciliationResults.filter(r => r.status !== 'Missing in Settlement');

        const allFormatted = activeRows.map(formatRow);
        const discrepanciesFormatted = activeRows.filter(r => r.status !== 'Matched').map(formatRow);

        const colWidths = [
            { wch: 18 }, { wch: 22 }, { wch: 12 }, { wch: 14 },
            { wch: 18 }, { wch: 20 }, { wch: 18 }, { wch: 18 },
            { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 14 }
        ];

        const wb = XLSX.utils.book_new();

        // Sheet 1: All Reconciled (kept first for backwards-compatibility with any automated consumers)
        const wsAll = XLSX.utils.json_to_sheet(allFormatted);
        wsAll['!cols'] = colWidths;
        XLSX.utils.book_append_sheet(wb, wsAll, "Reconciliation Report");

        // Sheet 2: Discrepancies Only
        if (discrepanciesFormatted.length > 0) {
            const wsIssues = XLSX.utils.json_to_sheet(discrepanciesFormatted);
            wsIssues['!cols'] = colWidths;
            XLSX.utils.book_append_sheet(wb, wsIssues, "Discrepancies Only");
        }

        // Sheet 3: Summary KPIs
        const totalStl = activeRows.reduce((s, r) => s + (Number(r.stl_amount) || 0), 0);
        const totalSys = activeRows.reduce((s, r) => s + (Number(r.sys_amount) || 0), 0);
        const summaryRows = [
            { "Metric": "Files Processed", "Value": this.processedFilesCount || 1 },
            { "Metric": "Total Reconciled References", "Value": activeRows.length },
            { "Metric": "Matched References", "Value": activeRows.filter(r => r.status === 'Matched').length },
            { "Metric": "Amount Mismatches", "Value": activeRows.filter(r => r.status === 'Amount Mismatch').length },
            { "Metric": "Missing in System", "Value": activeRows.filter(r => r.status === 'Missing in System').length },
            { "Metric": "Missing in Settlement", "Value": activeRows.filter(r => r.status === 'Missing in Settlement').length },
            { "Metric": "Total Settlement Amount (EGP)", "Value": Math.round(totalStl * 100) / 100 },
            { "Metric": "Total System Amount (EGP)", "Value": Math.round(totalSys * 100) / 100 },
            { "Metric": "Net Variance (EGP)", "Value": Math.round((totalStl - totalSys) * 100) / 100 }
        ];
        const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
        wsSummary['!cols'] = [{ wch: 30 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

        XLSX.writeFile(wb, `Settlement_Reconciliation_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    }

    async markAsSettled() {
        const matches = this.reconciliationResults.filter(r => r.status === 'Matched' && !r.is_settled);
        if (matches.length === 0) {
            Toast.show('No new matched transactions to mark as settled.', 'info');
            return;
        }

        const totalMatchedAmt = matches.reduce((s, m) => s + (Number(m.stl_amount) || 0), 0);
        const question = `Are you sure you want to mark ${matches.length.toLocaleString()} matched reference(s) (EGP ${formatStlMoney(totalMatchedAmt)}) as settled in the database?`;
        const ok = window.customConfirm ? await window.customConfirm(question, 'Mark as Settled', 'Cancel') : confirm(question);
        if (!ok) return;

        this.btnMarkSettled.disabled = true;
        if (this.btnMarkSettledLabel) {
            this.btnMarkSettledLabel.textContent = 'Updating...';
        } else {
            this.btnMarkSettled.innerHTML = '<i data-lucide="loader" class="spin"></i> Updating...';
        }
        if (window.lucide) lucide.createIcons();

        try {
            // Group updates by settlement_batch to minimize API calls
            const updatesByBatch = {};
            for (const m of matches) {
                const batchKey = m.settlement_no == null ? '' : String(m.settlement_no);
                if (!updatesByBatch[batchKey]) updatesByBatch[batchKey] = [];
                updatesByBatch[batchKey].push(m.reference);
            }

            const tasks = [];
            const chunkSize = 200;
            for (const batch in updatesByBatch) {
                const refs = updatesByBatch[batch];
                for (let i = 0; i < refs.length; i += chunkSize) {
                    const chunk = refs.slice(i, i + chunkSize);
                    tasks.push(async () => {
                        const { error } = await this.supabase
                            .from('transactions')
                            .update({
                                is_settled: true,
                                settlement_batch: batch || null
                            })
                            .in('reference_number', chunk);
                        if (error) throw error;
                    });
                }
            }

            const concurrency = 4;
            for (let i = 0; i < tasks.length; i += concurrency) {
                await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
            }

            // Record audit trail if App instance is available
            if (window.app && typeof window.app.logAudit === 'function') {
                const distinctBatches = Object.keys(updatesByBatch).filter(Boolean);
                await window.app.logAudit(
                    'Settlement Batch Marked Settled',
                    `${matches.length} references (${distinctBatches.join(', ') || 'No Batch No'})`,
                    {
                        references_settled: matches.length,
                        total_amount: Math.round(totalMatchedAmt * 100) / 100,
                        settlement_batches: distinctBatches
                    }
                );
            }

            Toast.show(`Successfully marked ${matches.length.toLocaleString()} references as settled!`, 'success');

            // Update local state & re-render
            for (const m of matches) {
                m.is_settled = true;
                m.db_settlement_batch = m.settlement_no || null;
            }
            this.renderResults();

        } catch (err) {
            Toast.show('Error updating database: ' + err.message + ' – some references may already be marked. Re-run the reconciliation to see the current state.', 'error');
        } finally {
            this.updateSummaryAndActions();
            if (window.lucide) lucide.createIcons();
        }
    }

    // Runs a query repeatedly with .range() until every row is fetched (Supabase returns max 1,000 per request)
    async fetchAllPages(buildQuery, pageSize = 1000) {
        let all = [];
        let from = 0;
        while (true) {
            const { data, error } = await buildQuery().order('id').range(from, from + pageSize - 1);
            if (error) throw error;
            if (!data || data.length === 0) break;
            all = all.concat(data);
            if (data.length < pageSize) break;
            from += pageSize;
        }
        return all;
    }

    // Excel serial number → "YYYY-MM-DD" (date-only, stripping any fractional time)
    static excelSerialToText(serial) {
        const intSerial = Math.floor(Number(serial));
        if (typeof XLSX !== 'undefined' && XLSX.SSF && XLSX.SSF.parse_date_code) {
            const p = XLSX.SSF.parse_date_code(intSerial);
            if (p && p.y) {
                const pad = n => String(Math.floor(n)).padStart(2, '0');
                return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
            }
        }
        // Fallback: treat the integer serial as UTC date (no local shift)
        const d = new Date(Math.round((intSerial - 25569) * 86400 * 1000));
        return d.toISOString().substring(0, 10);
    }

    // Any date value from the settlement file → "YYYY-MM-DD" (or null)
    static toDateOnly(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'number') return SettlementProcessor.excelSerialToText(raw).substring(0, 10);
        const str = String(raw).trim();
        let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        m = str.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); // Fawry format: DD/MM/YYYY
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        const d = new Date(str);
        if (isNaN(d.getTime())) return null;
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
}

// Make it available globally so app.js can initialize it
window.SettlementProcessor = SettlementProcessor;
