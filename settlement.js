class SettlementProcessor {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.settlementData = [];
        this.reconciliationResults = [];
        this.systemTransactions = [];
        this.merchant = 'NUADCB136'; // Default
        
        this.initUI();
    }

    initUI() {
        this.dropZone = document.getElementById('settlement-drop-zone');
        this.fileInput = document.getElementById('settlement-file-input');
        this.merchantSelect = document.getElementById('settlement-merchant');
        this.statusDiv = document.getElementById('settlement-status');
        this.resultsTable = document.getElementById('settlement-results-body');
        
        this.btnExportConsolidated = document.getElementById('btn-export-consolidated');
        this.btnExportRecon = document.getElementById('btn-export-recon');
        this.btnMarkSettled = document.getElementById('btn-mark-settled');

        if (!this.dropZone) return;

        this.merchantSelect.addEventListener('change', (e) => {
            this.merchant = e.target.value;
        });

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
            if (e.target.files.length > 0) this.handleFiles(e.target.files);
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
        this.setStatus('<i data-lucide="loader" class="spin"></i> Processing files...');
        if (window.lucide) lucide.createIcons();
        this.settlementData = [];
        this.reconciliationResults = [];

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.name.endsWith('.zip')) {
                    await this.processZip(file);
                } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.xlsm')) {
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
            this.setStatus(`Error: ${err.message}`, true);
        }
    }

    async processZip(file) {
        const zip = await JSZip.loadAsync(file);
        const excelFiles = Object.keys(zip.files).filter(name => 
            (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) && 
            !name.includes('~$') && 
            !name.includes('__MACOSX')
        );

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

                        for (let j = 0; j < cleanHeaders.length; j++) {
                            const colName = cleanHeaders[j];
                            if (colName) {
                                let val = row[j];
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
                            
                            // Convert dates safely
                            if (rowData['SETTLEMENT_DATE']) {
                                // Sometimes Excel dates come as numbers
                                if (typeof rowData['SETTLEMENT_DATE'] === 'number') {
                                    const d = new Date(Math.round((rowData['SETTLEMENT_DATE'] - 25569) * 86400 * 1000));
                                    rowData['SETTLEMENT_DATE'] = d.toISOString();
                                }
                            }

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
        for (const row of this.settlementData) {
            const ref = String(row['ORDER_REF_NUMBER']).trim();
            if (!ref) continue;
            
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

        // Fetch System Transactions that match these refs, OR that match the date range
        // Since we want to find missing ones on BOTH sides, we need to fetch a date range
        // Let's find min and max settlement dates
        let minDate = new Date('2099-01-01').getTime();
        let maxDate = new Date('1970-01-01').getTime();
        
        for (const ref of settlementRefs) {
            const dStr = stlGrouped[ref].SETTLEMENT_DATE;
            if (dStr) {
                const ms = new Date(dStr).getTime();
                if (!isNaN(ms)) {
                    if (ms < minDate) minDate = ms;
                    if (ms > maxDate) maxDate = ms;
                }
            }
        }

        let queryMinDate = new Date(minDate);
        queryMinDate.setDate(queryMinDate.getDate() - 5); // buffer
        let queryMaxDate = new Date(maxDate);
        queryMaxDate.setDate(queryMaxDate.getDate() + 5);

        this.setStatus('<i data-lucide="loader" class="spin"></i> Fetching system transactions for reconciliation...');
        
        // Fetch transactions from DB for the specified merchant
        const { data: dbTx, error } = await this.supabase
            .from('transactions')
            .select('*')
            .eq('bank', this.merchant) // Assuming bank column holds the merchant code like NUADCB136
            .gte('payment_date', queryMinDate.toISOString().split('T')[0])
            .lte('payment_date', queryMaxDate.toISOString().split('T')[0]);

        if (error) {
            this.setStatus('Error fetching DB transactions: ' + error.message, true);
            return;
        }

        this.systemTransactions = dbTx || [];

        // Group DB transactions by reference_number (essential for NUADIB64)
        const dbGrouped = {};
        for (const tx of this.systemTransactions) {
            const ref = String(tx.reference_number).trim();
            if (!ref) continue;
            if (!dbGrouped[ref]) {
                dbGrouped[ref] = {
                    reference_number: ref,
                    payment_date: tx.payment_date,
                    item_price: 0,
                    is_settled: tx.is_settled,
                    settlement_batch: tx.settlement_batch,
                    items: []
                };
            }
            dbGrouped[ref].item_price += parseFloat(tx.item_price || 0);
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

                // Calculate the exact min and max TRXDATE (payment_date) found in the settlement files
        let minTrxDateStr = '2099-12-31';
        let maxTrxDateStr = '1970-01-01';
        for (const ref of settlementRefs) {
            const trxRaw = stlGrouped[ref].TRXDATE;
            if (trxRaw) {
                const ms = new Date(trxRaw).getTime();
                if (!isNaN(ms)) {
                    const d = new Date(ms);
                    const dStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                    if (dStr < minTrxDateStr) minTrxDateStr = dStr;
                    if (dStr > maxTrxDateStr) maxTrxDateStr = dStr;
                }
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
        this.setStatus(`<i data-lucide="check-circle"></i> Reconciliation complete! Matches: ${matchCount}, Issues: ${mismatchCount}`);
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

            return `
                <tr>
                    <td>${r.reference}</td>
                    <td><span class="badge ${statusBadge}" style="padding:0.25rem 0.5rem; border-radius:4px;">${r.status}</span></td>
                    <td>${r.sys_amount.toFixed(2)}</td>
                    <td>${r.stl_amount.toFixed(2)}</td>
                    <td>${r.settlement_no || '-'}</td>
                    <td>${r.payment_date || '-'}</td>
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

        if (!confirm(`Are you sure you want to mark ${matches.length} transactions as settled in the database?`)) return;

        this.btnMarkSettled.disabled = true;
        this.btnMarkSettled.innerHTML = '<i data-lucide="loader" class="spin"></i> Updating...';
        if (window.lucide) lucide.createIcons();

        try {
            // Group updates by settlement_batch to minimize API calls
            const updatesByBatch = {};
            for (const m of matches) {
                if (!updatesByBatch[m.settlement_no]) updatesByBatch[m.settlement_no] = [];
                updatesByBatch[m.settlement_no].push(m.reference);
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
                            settlement_batch: batch
                        })
                        .in('reference_number', chunk);
                    
                    if (error) throw error;
                }
            }

            Toast.show(`Successfully marked ${matches.length} transactions as settled!`, 'success');
            
            // Re-fetch or just update local state
            for (const m of matches) m.is_settled = true;
            this.renderResults();

        } catch (err) {
            Toast.show('Error updating database: ' + err.message, 'error');
        } finally {
            this.btnMarkSettled.disabled = false;
            this.btnMarkSettled.innerHTML = '<i data-lucide="check-square"></i> Mark Matched as Settled in DB';
            if (window.lucide) lucide.createIcons();
        }
    }
}

// Make it available globally so app.js can initialize it
window.SettlementProcessor = SettlementProcessor;




