const settlementEsc = (v) => (window.escapeHTML ? window.escapeHTML(v) : String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])));

class SettlementProcessor {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.settlementData = [];
        this.reconciliationResults = [];
        this.systemTransactions = [];
        this.isProcessing = false;
        this.initUI();
    }

    initUI() {
        this.dropZone = document.getElementById('settlement-drop-zone');
        this.fileInput = document.getElementById('settlement-file-input');
        
        this.statusDiv = document.getElementById('settlement-status');
        this.resultsTable = document.getElementById('settlement-results-body');
        
        this.btnExportConsolidated = document.getElementById('btn-export-consolidated');
        this.btnExportRecon = document.getElementById('btn-export-recon');
        this.btnMarkSettled = document.getElementById('btn-mark-settled');

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

        this.btnExportConsolidated.addEventListener('click', () => this.exportConsolidated());
        this.btnExportRecon.addEventListener('click', () => this.exportReconciliation());
        this.btnMarkSettled.addEventListener('click', () => this.markAsSettled());
    }

    setStatus(msg, isError = false) {
        if (!this.statusDiv) return;
        this.statusDiv.innerHTML = msg;
        this.statusDiv.className = isError ? 'text-danger mt-2' : 'text-primary mt-2';
    }

    async handleFiles(files) {
        if (this.isProcessing) {
            Toast.show('Settlement files are already being processed. Please wait.', 'warning');
            return;
        }
        this.isProcessing = true;
        this.setStatus('<i data-lucide="loader" class="spin"></i> Processing files...');
        if (window.lucide) lucide.createIcons();
        this.settlementData = [];
        this.reconciliationResults = [];
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

            this.setStatus(`<i data-lucide="check-circle"></i> Extracted ${this.settlementData.length} records. Reconciling...`);
            if (window.lucide) lucide.createIcons();
            
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
                    
                    if (rawData.length <= 6) return resolve(); // Not enough rows

                    // Skip first 6 rows, row 7 is header
                    const headers = rawData[6].map(h => h ? String(h).trim() : '');
                    
                    // Handle duplicate headers (like Power Query does)
                    const cleanHeaders = [];
                    const headerCounts = {};
                    for (let h of headers) {
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

                    // Process data rows
                    for (let i = 7; i < rawData.length; i++) {
                        const row = rawData[i];
                        const rowData = { SOURCE_FILE: fileName };
                        let hasSettlementNo = false;

                        if (!row) continue;
                        for (let j = 0; j < cleanHeaders.length; j++) {
                            const colName = cleanHeaders[j];
                            if (colName) {
                                let val = row[j] === undefined ? null : row[j];
                                rowData[colName] = val;
                                if (colName === 'SETTLEMENTNO' && val !== null && String(val).trim() !== '') {
                                    hasSettlementNo = true;
                                }
                            }
                        }

                        if (hasSettlementNo) {
                            // Convert amounts
                            ['TOTAL_PAYMENT', 'TOTAL_REFUND', 'ORDER_AMOUNT', 'REFUND_AMOUNT', 'CUSTOMER_FEES', 'MERCHANT_COMMISSION', 'NETAMOUNT', 'NETAMOUNT_REFUND'].forEach(col => {
                                if (rowData[col] !== undefined && rowData[col] !== null) {
                                    rowData[col] = parseFloat(rowData[col]) || 0;
                                }
                            });
                            
                            // Subtract refund from NETAMOUNT
                            if (rowData['NETAMOUNT_REFUND']) {
                                rowData['NETAMOUNT'] = (rowData['NETAMOUNT'] || 0) - rowData['NETAMOUNT_REFUND'];
                            }
                            
                            // Convert Excel serial dates to local "YYYY-MM-DD HH:MM:SS" text
                            // (no UTC conversion, so late-evening payments stay on the right day)
                            ['SETTLEMENT_DATE', 'TRXDATE'].forEach(dateCol => {
                                if (rowData[dateCol] && typeof rowData[dateCol] === 'number') {
                                    rowData[dateCol] = SettlementProcessor.excelSerialToText(rowData[dateCol]);
                                }
                            });

                            this.settlementData.push(rowData);
                        }
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
                    SETTLEMENTNO: row['SETTLEMENTNO'],
                    SETTLEMENT_DATE: row['SETTLEMENT_DATE'],
                    TRXDATE: row['TRXDATE'],
                    NETAMOUNT: 0
                };
            }
            stlGrouped[ref].NETAMOUNT += (row['NETAMOUNT'] || 0);
        }

        const settlementRefs = Object.keys(stlGrouped);

        // Calculate the exact min and max TRXDATE (payment_date) found in the settlement files
        let minTrxDateStr = '2099-12-31';
        let maxTrxDateStr = '1970-01-01';
        for (const ref of settlementRefs) {
            const dStr = SettlementProcessor.toDateOnly(stlGrouped[ref].TRXDATE);
            if (dStr) {
                if (dStr < minTrxDateStr) minTrxDateStr = dStr;
                if (dStr > maxTrxDateStr) maxTrxDateStr = dStr;
            }
        }

        this.setStatus('<i data-lucide="loader" class="spin"></i> Fetching system transactions for reconciliation...');
        
        let allDbTx = [];
        const txMap = new Map(); // to deduplicate
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

        const bankArray = Array.from(detectedBanks);

        // 2. Fetch by precise payment date range AND detected banks to find "Missing in Settlement"
        if (minTrxDateStr !== '2099-12-31' && bankArray.length > 0) {
            let dateTx;
            try {
                // Paginated – a busy period easily has more than 1,000 transactions
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

        // Group DB transactions by reference_number (essential for NUADIB64)
        const dbGrouped = {};
        for (const tx of this.systemTransactions) {
            const ref = tx.reference_number == null ? '' : String(tx.reference_number).trim();
            if (!ref) continue;
            if (!dbGrouped[ref]) {
                dbGrouped[ref] = {
                    reference_number: ref,
                    payment_date: tx.payment_date,
                    item_price: 0,
                    is_settled: !!tx.is_settled,
                    settlement_batch: tx.settlement_batch,
                    items: []
                };
            }
            dbGrouped[ref].item_price += parseFloat(tx.item_price || 0);
            // A reference counts as settled only when ALL of its items are settled
            dbGrouped[ref].is_settled = dbGrouped[ref].is_settled && !!tx.is_settled;
            dbGrouped[ref].items.push(tx);
        }

        // Now, reconcile
        this.reconciliationResults = [];
        const processedRefs = new Set();
        let matchCount = 0;
        let mismatchCount = 0;

        for (const ref of settlementRefs) {
            processedRefs.add(ref);
            const sData = stlGrouped[ref];
            const dData = dbGrouped[ref];

            if (dData) {
                // Match exists, check amount
                const diff = Math.abs(sData.NETAMOUNT - dData.item_price);
                if (diff < 0.1) {
                    this.reconciliationResults.push({
                        reference: ref,
                        status: 'Matched',
                        sys_amount: dData.item_price,
                        stl_amount: sData.NETAMOUNT,
                        settlement_no: sData.SETTLEMENTNO,
                        payment_date: dData.payment_date,
                        is_settled: dData.is_settled
                    });
                    matchCount++;
                } else {
                    this.reconciliationResults.push({
                        reference: ref,
                        status: 'Amount Mismatch',
                        sys_amount: dData.item_price,
                        stl_amount: sData.NETAMOUNT,
                        settlement_no: sData.SETTLEMENTNO,
                        payment_date: dData.payment_date,
                        is_settled: dData.is_settled
                    });
                    mismatchCount++;
                }
            } else {
                // In Settlement but not in DB
                this.reconciliationResults.push({
                    reference: ref,
                    status: 'Missing in System',
                    sys_amount: 0,
                    stl_amount: sData.NETAMOUNT,
                    settlement_no: sData.SETTLEMENTNO,
                    payment_date: null,
                    is_settled: false
                });
                mismatchCount++;
            }
        }

                // Check for Missing in Settlement
        for (const ref in dbGrouped) {
            if (!processedRefs.has(ref)) {
                const dData = dbGrouped[ref];
                if (!dData.is_settled && dData.payment_date >= minTrxDateStr && dData.payment_date <= maxTrxDateStr) {
                    this.reconciliationResults.push({
                        reference: ref,
                        status: 'Missing in Settlement',
                        sys_amount: dData.item_price,
                        stl_amount: 0,
                        settlement_no: null,
                        payment_date: dData.payment_date,
                        is_settled: dData.is_settled
                    });
                    mismatchCount++;
                }
            }
        }

        this.renderResults();
        const noRefNote = skippedNoRef > 0 ? ` (${skippedNoRef} settlement row(s) without ORDER_REF_NUMBER were ignored)` : '';
        this.setStatus(`<i data-lucide="check-circle"></i> Reconciliation complete! Matches: ${matchCount}, Issues: ${mismatchCount}${noRefNote}`);
        if (window.lucide) lucide.createIcons();
    }

    renderResults() {
        if (!this.resultsTable) return;
        
        document.getElementById('recon-actions').classList.remove('hidden');

        // Sort: Mismatches/Missing first, then Matched
        this.reconciliationResults.sort((a, b) => {
            if (a.status === 'Matched' && b.status !== 'Matched') return 1;
            if (a.status !== 'Matched' && b.status === 'Matched') return -1;
            return 0;
        });

        this.resultsTable.innerHTML = this.reconciliationResults.map(r => {
            let statusBadge = 'bg-success text-white';
            if (r.status === 'Amount Mismatch') statusBadge = 'bg-warning text-dark';
            else if (r.status.includes('Missing')) statusBadge = 'bg-danger text-white';

            let dbSettledBadge = r.is_settled ? '<span class="badge" style="background:#3b82f6;color:white;font-size:0.7rem;">Yes</span>' : '';

            const esc = settlementEsc;

            return `
                <tr>
                    <td>${esc(r.reference)}</td>
                    <td><span class="badge ${statusBadge}" style="padding:0.25rem 0.5rem; border-radius:4px;">${esc(r.status)}</span></td>
                    <td>${r.sys_amount.toFixed(2)}</td>
                    <td>${r.stl_amount.toFixed(2)}</td>
                    <td>${esc(r.settlement_no || '-')}</td>
                    <td>${esc(r.payment_date || '-')}</td>
                    <td>${dbSettledBadge}</td>
                </tr>
            `;
        }).join('');
    }

    exportConsolidated() {
        if (this.settlementData.length === 0) {
            Toast.show('No settlement data to export.', 'warning');
            return;
        }
        const ws = XLSX.utils.json_to_sheet(this.settlementData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Consolidated Settlement");
        XLSX.writeFile(wb, "Consolidated_Settlement.xlsx");
    }

    exportReconciliation() {
        if (this.reconciliationResults.length === 0) {
            Toast.show('No reconciliation data to export.', 'warning');
            return;
        }
        const ws = XLSX.utils.json_to_sheet(this.reconciliationResults);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Reconciliation Report");
        XLSX.writeFile(wb, "Settlement_Reconciliation_Report.xlsx");
    }

    async markAsSettled() {
        const matches = this.reconciliationResults.filter(r => r.status === 'Matched' && !r.is_settled);
        if (matches.length === 0) {
            Toast.show('No new matched transactions to mark as settled.', 'info');
            return;
        }

        const question = `Are you sure you want to mark ${matches.length} references as settled in the database?`;
        const ok = window.customConfirm ? await window.customConfirm(question, 'Mark as Settled', 'Cancel') : confirm(question);
        if (!ok) return;

        this.btnMarkSettled.disabled = true;
        this.btnMarkSettled.innerHTML = '<i data-lucide="loader" class="spin"></i> Updating...';
        if (window.lucide) lucide.createIcons();

        try {
            // Group updates by settlement_batch to minimize API calls
            const updatesByBatch = {};
            for (const m of matches) {
                const batchKey = m.settlement_no == null ? '' : String(m.settlement_no);
                if (!updatesByBatch[batchKey]) updatesByBatch[batchKey] = [];
                updatesByBatch[batchKey].push(m.reference);
            }

            for (const batch in updatesByBatch) {
                const refs = updatesByBatch[batch];
                // Supabase limits .in() to somewhat small arrays, so chunk if necessary
                const chunkSize = 200;
                for (let i = 0; i < refs.length; i += chunkSize) {
                    const chunk = refs.slice(i, i + chunkSize);
                    const { error } = await this.supabase
                        .from('transactions')
                        .update({
                            is_settled: true,
                            settlement_batch: batch || null
                        })
                        .in('reference_number', chunk);
                    
                    if (error) throw error;
                }
            }

            Toast.show(`Successfully marked ${matches.length} references as settled!`, 'success');
            
            // Re-fetch or just update local state
            for (const m of matches) m.is_settled = true;
            this.renderResults();

        } catch (err) {
            Toast.show('Error updating database: ' + err.message + ' – some references may already be marked. Re-run the reconciliation to see the current state.', 'error');
        } finally {
            this.btnMarkSettled.disabled = false;
            this.btnMarkSettled.innerHTML = '<i data-lucide="check-square"></i> Mark Matched as Settled in DB';
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

    // Excel serial number → "YYYY-MM-DD HH:MM:SS" (wall-clock time as shown in Excel, no timezone shift)
    static excelSerialToText(serial) {
        if (typeof XLSX !== 'undefined' && XLSX.SSF && XLSX.SSF.parse_date_code) {
            const p = XLSX.SSF.parse_date_code(serial);
            if (p && p.y) {
                const pad = n => String(Math.floor(n)).padStart(2, '0');
                return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.H)}:${pad(p.M)}:${pad(p.S)}`;
            }
        }
        // Fallback: treat the serial as UTC and format it in UTC (no local shift)
        const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
        return d.toISOString().replace('T', ' ').substring(0, 19);
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





