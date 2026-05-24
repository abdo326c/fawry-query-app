import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';

class App {
    constructor() {
        this.currentPage = 1;
        this.pageSize = 50;

        this.initNavigation();
        this.initImport();
        this.initModals();
        this.initBulkUploads();
        this.initFilters();
        this.initExport();
        this.initReapply();
        this.initDashboard();
        this.initStudentMaster();
        this.loadTransactions();
    }

    initNavigation() {
        const links = document.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tabId = link.getAttribute('data-tab');
                
                // Update active state
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                
                // Show view
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById(`view-${tabId}`).classList.add('active');

                if (tabId === 'dashboard') this.loadDashboard();
                if (tabId === 'transactions') this.loadTransactions();
                if (tabId === 'mappings') this.loadMappings();
                if (tabId === 'fixes') this.loadFixes();
                if (tabId === 'students') this.loadStudentMaster();
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

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.addEventListener('change', () => this.loadDashboard());
        });

        // Copy Table
        const btnCopy = document.getElementById('btn-copy-pivot');
        if (btnCopy) {
            btnCopy.addEventListener('click', () => {
                const table = document.getElementById('dashboard-pivot-table');
                
                const clone = table.cloneNode(true);
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
                    alert("Failed to copy: " + err.message);
                });
            });
        }
    }

    async loadDashboard() {
        const dateFrom = document.getElementById('dashboard-date-from')?.value;
        const dateTo = document.getElementById('dashboard-date-to')?.value;
        
        if (!dateFrom || !dateTo) return;

        const checkboxes = document.querySelectorAll('#dashboard-bank-filters input[type="checkbox"]:checked');
        const selectedBanks = Array.from(checkboxes).map(cb => cb.value);

        const tbody = document.getElementById('dashboard-pivot-body');
        const tfoot = document.getElementById('dashboard-pivot-foot');
        if (!tbody || !tfoot) return;

        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Loading...</td></tr>';
        tfoot.innerHTML = '';

        try {
            let allData = [];
            let fetchMore = true;
            let from = 0;
            while (fetchMore) {
                const { data, error } = await supabase.from('transactions')
                    .select('payment_date, bank, item_price')
                    .gte('payment_date', dateFrom)
                    .lte('payment_date', dateTo)
                    .range(from, from + 999);
                
                if (error) throw error;
                if (!data || data.length === 0) break;
                allData = allData.concat(data);
                if (data.length < 1000) fetchMore = false;
                else from += 1000;
            }

            const pivot = {};
            const formatMoney = (num) => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            let bankTotals = { Total: 0 };
            selectedBanks.forEach(b => bankTotals[b] = 0);

            allData.forEach(tx => {
                if (!selectedBanks.includes(tx.bank)) return;
                
                const pDate = tx.payment_date;
                if (!pivot[pDate]) {
                    pivot[pDate] = { Total: 0 };
                    selectedBanks.forEach(b => pivot[pDate][b] = 0);
                }
                const price = parseFloat(tx.item_price) || 0;
                pivot[pDate][tx.bank] += price;
                pivot[pDate].Total += price;

                bankTotals[tx.bank] += price;
                bankTotals.Total += price;
            });

            const dates = Object.keys(pivot).sort();

            tbody.innerHTML = dates.map(d => {
                const row = pivot[d];
                const dateParts = d.split('-');
                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const mName = monthNames[parseInt(dateParts[1]) - 1];
                const dateLabel = `${parseInt(dateParts[2])}-${mName}-${dateParts[0]}`;

                let html = `<tr><td>${dateLabel}</td>`;
                selectedBanks.forEach(b => {
                    const isHighlight = b === 'NUADIB64';
                    html += `<td class="${isHighlight ? 'highlight-cell' : ''}">${formatMoney(row[b])}</td>`;
                });
                html += `<td>${formatMoney(row.Total)}</td></tr>`;
                return html;
            }).join('');

            if (dates.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${selectedBanks.length + 2}" style="text-align: center;">No data for selected period</td></tr>`;
            }

            let footHtml = `<tr><td>Grand Total</td>`;
            selectedBanks.forEach(b => {
                const isHighlight = b === 'NUADIB64';
                footHtml += `<td class="${isHighlight ? 'highlight-cell' : ''}">${formatMoney(bankTotals[b])}</td>`;
            });
            footHtml += `<td>${formatMoney(bankTotals.Total)}</td></tr>`;
            tfoot.innerHTML = footHtml;

            const thead = document.querySelector('#dashboard-pivot-table thead');
            if (thead) {
                thead.innerHTML = `
                    <tr>
                        <th colspan="${selectedBanks.length + 2}" class="pivot-title">Total Fawry Collection</th>
                    </tr>
                    <tr>
                        <th class="pivot-row-label">Date</th>
                        ${selectedBanks.map(b => `<th class="pivot-col-label ${b === 'NUADIB64' ? 'highlight-col' : ''}">${b}</th>`).join('')}
                        <th class="pivot-col-label">Grand Total</th>
                    </tr>
                `;
            }

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="4" style="color: red;">Error: ${err.message}</td></tr>`;
        }
    }

    initImport() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');

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
            }
        });
    }

    async handleFiles(files) {
        document.getElementById('import-progress').classList.remove('hidden');
        document.getElementById('import-log').innerHTML = '';
        
        const processor = new FawryProcessor();
        await processor.processFiles(files);
        
        // Auto-switch back to transactions tab after 1.5 seconds
        setTimeout(() => {
            document.querySelector('[data-tab="transactions"]').click();
        }, 1500);
    }

    initModals() {
        // Open Mapping Modal
        document.getElementById('btn-add-mapping').addEventListener('click', () => {
            document.getElementById('modal-mapping').classList.remove('hidden');
        });

        // Open Fix Modal
        document.getElementById('btn-add-fix').addEventListener('click', () => {
            document.getElementById('modal-fix').classList.remove('hidden');
        });

        // Save Mapping
        document.getElementById('btn-save-mapping').addEventListener('click', async () => {
            const original = document.getElementById('map-original').value;
            const adjusted = document.getElementById('map-adjusted').value;
            const category = document.getElementById('map-category').value;
            
            if (!original) return alert('Original Item Name is required');

            const { error } = await supabase.from('item_mappings').upsert([{
                item_name: original,
                adjusted_item_name: adjusted || null,
                mapping: category || null
            }], { onConflict: 'item_name', ignoreDuplicates: false });

            if (error) alert('Error saving mapping: ' + error.message);
            else {
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data: existingTx } = await supabase.from('transactions').select('*').eq('item_name', original).range(from, from + 999);
                    if (!existingTx || existingTx.length === 0) break;
                    for (const tx of existingTx) {
                        if (adjusted) tx.item_name = adjusted;
                        if (category) tx.mapping = category;
                    }
                    await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                    if (existingTx.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                document.getElementById('modal-mapping').classList.add('hidden');
                document.getElementById('map-original').value = '';
                document.getElementById('map-adjusted').value = '';
                document.getElementById('map-category').value = '';
                this.loadMappings();
            }
        });

        // Save Fix
        document.getElementById('btn-save-fix').addEventListener('click', async () => {
            const ref = document.getElementById('fix-ref').value;
            const correctId = document.getElementById('fix-id').value;
            const correctName = document.getElementById('fix-name').value;
            const correctMapping = document.getElementById('fix-mapping').value;

            if (!ref) return alert('Reference Number is required');

            const { error } = await supabase.from('manual_fixes').upsert([{
                reference_number: ref,
                correct_id: correctId || null,
                item_name: correctName || null,
                mapping: correctMapping || null
            }], { onConflict: 'reference_number', ignoreDuplicates: false });

            if (error) alert('Error saving fix: ' + error.message);
            else {
                const { data: existingTx } = await supabase.from('transactions').select('*').eq('reference_number', ref);
                if (existingTx && existingTx.length > 0) {
                    for (const tx of existingTx) {
                        if (correctId) {
                            tx.student_id = correctId;
                            tx.id_status = new FawryProcessor().validateID(tx.student_id);
                        }
                        if (correctName) tx.item_name = correctName;
                        if (correctMapping) tx.mapping = correctMapping;
                    }
                    await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                }

                document.getElementById('modal-fix').classList.add('hidden');
                document.getElementById('fix-ref').value = '';
                document.getElementById('fix-id').value = '';
                document.getElementById('fix-name').value = '';
                document.getElementById('fix-mapping').value = '';
                this.loadFixes();
            }
        });
    }

    initBulkUploads() {
        const handleUpload = async (e, type) => {
            const file = e.target.files[0];
            if (!file) return;

            const buffer = await file.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

            if (data.length === 0) {
                alert("File is empty!");
                return;
            }

            e.target.value = ''; // Reset

            const getVal = (row, keyStr) => {
                const exact = row[keyStr];
                if (exact !== undefined && exact !== "") return exact;
                const foundKey = Object.keys(row).find(k => k.toLowerCase() === keyStr.toLowerCase());
                return foundKey ? row[foundKey] : null;
            };

            const chunkSize = 500;

            if (type === 'mappings') {
                const mappings = data.map(row => ({
                    item_name: getVal(row, 'Item Name'),
                    adjusted_item_name: getVal(row, 'Adjusted Item Name') || null,
                    mapping: getVal(row, 'Mapping') || null
                })).filter(m => m.item_name);

                let inserted = 0;
                for (let i = 0; i < mappings.length; i += chunkSize) {
                    const chunk = mappings.slice(i, i + chunkSize);
                    const { error } = await supabase.from('item_mappings').upsert(chunk, { onConflict: 'item_name', ignoreDuplicates: false });
                    if (error) return alert('Error uploading mappings: ' + error.message);
                    inserted += chunk.length;
                }

                const itemNames = mappings.map(m => m.item_name);
                for (let i = 0; i < itemNames.length; i += 50) {
                    const chunkItems = itemNames.slice(i, i + 50);
                    let fetchMore = true;
                    let from = 0;
                    while (fetchMore) {
                        const { data: existingTx } = await supabase.from('transactions').select('*').in('item_name', chunkItems).range(from, from + 999);
                        if (!existingTx || existingTx.length === 0) break;
                        for (const tx of existingTx) {
                            const mapDef = mappings.find(m => m.item_name === tx.item_name);
                            if (mapDef) {
                                if (mapDef.adjusted_item_name) tx.item_name = mapDef.adjusted_item_name;
                                if (mapDef.mapping) tx.mapping = mapDef.mapping;
                            }
                        }
                        await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                        if (existingTx.length < 1000) fetchMore = false;
                        else from += 1000;
                    }
                }

                alert(`Successfully uploaded ${inserted} item mappings and updated existing transactions!`);
                this.loadMappings();

            } else if (type === 'fixes') {
                const fixes = data.map(row => ({
                    reference_number: String(getVal(row, 'Reference Number')),
                    correct_id: getVal(row, 'Correct ID') || null,
                    item_name: getVal(row, 'Item Name') || null,
                    mapping: getVal(row, 'Mapping') || null
                })).filter(f => f.reference_number && f.reference_number !== "null");

                let inserted = 0;
                for (let i = 0; i < fixes.length; i += chunkSize) {
                    const chunk = fixes.slice(i, i + chunkSize);
                    const { error } = await supabase.from('manual_fixes').upsert(chunk, { onConflict: 'reference_number', ignoreDuplicates: false });
                    if (error) return alert('Error uploading fixes: ' + error.message);
                    inserted += chunk.length;
                }

                const refs = fixes.map(f => f.reference_number);
                for (let i = 0; i < refs.length; i += 200) {
                    const chunkRefs = refs.slice(i, i + 200);
                    const { data: existingTx } = await supabase.from('transactions').select('*').in('reference_number', chunkRefs);
                    if (existingTx && existingTx.length > 0) {
                        for (const tx of existingTx) {
                            const fix = fixes.find(f => String(f.reference_number) === String(tx.reference_number));
                            if (fix) {
                                if (fix.correct_id) {
                                    tx.student_id = fix.correct_id;
                                    tx.id_status = new FawryProcessor().validateID(tx.student_id);
                                }
                                if (fix.item_name) tx.item_name = fix.item_name;
                                if (fix.mapping) tx.mapping = fix.mapping;
                            }
                        }
                        await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                    }
                }

                alert(`Successfully uploaded ${inserted} manual fixes and updated existing transactions!`);
                this.loadFixes();
            }
        };

        document.getElementById('file-upload-mappings').addEventListener('change', (e) => handleUpload(e, 'mappings'));
        document.getElementById('file-upload-fixes').addEventListener('change', (e) => handleUpload(e, 'fixes'));

        // Templates
        document.getElementById('btn-template-mappings').addEventListener('click', () => {
            const worksheet = XLSX.utils.json_to_sheet([{
                "Item Name": "",
                "Adjusted Item Name": "",
                "Mapping": ""
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
                "Mapping": ""
            }]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
            XLSX.writeFile(workbook, "Manual_Fixes_Template.xlsx");
        });
    }

    initReapply() {
        document.getElementById('btn-reapply-rules').addEventListener('click', async () => {
            const btn = document.getElementById('btn-reapply-rules');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader"></i> Applying...';
            btn.disabled = true;

            try {
                let mappings = [];
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data } = await supabase.from('item_mappings').select('*').range(from, from + 999);
                    if (!data || data.length === 0) break;
                    mappings = mappings.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                let fixes = [];
                fetchMore = true;
                from = 0;
                while (fetchMore) {
                    const { data } = await supabase.from('manual_fixes').select('*').range(from, from + 999);
                    if (!data || data.length === 0) break;
                    fixes = fixes.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                let links = [];
                fetchMore = true;
                from = 0;
                while (fetchMore) {
                    const { data } = await supabase.from('links').select('*').range(from, from + 999);
                    if (!data || data.length === 0) break;
                    links = links.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                const fp = new FawryProcessor();
                fetchMore = true;
                from = 0;
                let updatedCount = 0;
                
                while (fetchMore) {
                    const { data: txs, error } = await supabase.from('transactions').select('*').range(from, from + 999);
                    if (error) throw error;
                    if (!txs || txs.length === 0) break;

                    let needsUpdate = false;

                    for (const tx of txs) {
                        let originalItemName = tx.check_column ? tx.check_column.substring(tx.reference_number.length + 1) : tx.item_name;
                        
                        let newStudentId = tx.student_id;
                        let newItemName = originalItemName;
                        let newMapping = null;

                        const link = links.find(l => String(l.payment_reference_number) === String(tx.reference_number));
                        if (link && link.custom_input_value) {
                            newStudentId = link.custom_input_value;
                        }

                        const mapDef = mappings.find(m => m.item_name === newItemName);
                        if (mapDef) {
                            if (mapDef.adjusted_item_name) newItemName = mapDef.adjusted_item_name;
                            if (mapDef.mapping) newMapping = mapDef.mapping;
                        }

                        const fix = fixes.find(f => String(f.reference_number) === String(tx.reference_number));
                        if (fix) {
                            if (fix.correct_id) newStudentId = fix.correct_id;
                            if (fix.item_name) newItemName = fix.item_name;
                            if (fix.mapping) newMapping = fix.mapping;
                        }

                        let newStatus = fp.validateID(newStudentId);

                        if (tx.student_id !== newStudentId || tx.item_name !== newItemName || tx.mapping !== newMapping || tx.id_status !== newStatus) {
                            tx.student_id = newStudentId;
                            tx.item_name = newItemName;
                            tx.mapping = newMapping;
                            tx.id_status = newStatus;
                            needsUpdate = true;
                        }
                    }

                    if (needsUpdate) {
                        const { error: upsertErr } = await supabase.from('transactions').upsert(txs, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                        if (upsertErr) throw upsertErr;
                        updatedCount += txs.length;
                    }

                    if (txs.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                alert(`Successfully re-applied all rules to all transactions!`);
                this.loadTransactions();

            } catch (err) {
                alert("Error re-applying rules: " + err.message);
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
            this.loadTransactions();
        });
        document.getElementById('btn-clear-filters').addEventListener('click', () => {
            document.getElementById('filter-date-from').value = '';
            document.getElementById('filter-date-to').value = '';
            document.getElementById('filter-bank').value = '';
            document.getElementById('filter-mapping').value = '';
            document.getElementById('filter-item').value = '';
            document.getElementById('search-input').value = '';
            document.getElementById('status-filter').value = '';
            this.currentPage = 1;
            this.loadTransactions();
        });

        let searchTimeout;
        document.getElementById('search-input').addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.currentPage = 1;
                this.loadTransactions();
            }, 500);
        });

        document.getElementById('status-filter').addEventListener('change', () => {
            this.currentPage = 1;
            this.loadTransactions();
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
                const bank = document.getElementById('filter-bank').value;
                const mapping = document.getElementById('filter-mapping').value;
                const item = document.getElementById('filter-item').value;
                const search = document.getElementById('search-input').value;
                const status = document.getElementById('status-filter').value;

                // Fetch all data in pages
                while (fetchMore) {
                    let query = supabase.from('transactions').select('*');
                    
                    if (dateFrom) query = query.gte('payment_date', dateFrom);
                    if (dateTo) query = query.lte('payment_date', dateTo);
                    if (bank) query = query.eq('bank', bank);
                    if (mapping) query = query.ilike('mapping', `%${mapping}%`);
                    if (item) query = query.ilike('item_name', `%${item}%`);
                    if (search) {
                        if (/^\d+$/.test(search)) {
                            query = query.or(`student_id.ilike.%${search}%,reference_number.eq.${search}`);
                        } else {
                            query = query.ilike('student_id', `%${search}%`);
                        }
                    }
                    
                    if (status) {
                        if (status === 'valid') query = query.eq('id_status', 'Valid');
                        else if (status === 'missing') query = query.eq('id_status', 'Missing ID');
                        else if (status === 'error') query = query.ilike('id_status', '%Error%');
                    }

                    const { data, error } = await query
                        .order('payment_date', { ascending: false })
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
                    alert("No data to export.");
                    return;
                }

                // Format exactly like the original Power Query Excel
                const formattedData = allData.map(t => {
                    let pDate = t.payment_date;
                    if (pDate) {
                        const parts = pDate.split('-');
                        // Use UTC to prevent timezone shifting
                        pDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
                    }

                    return {
                        "Reference Number": t.reference_number,
                        "Payment Date": pDate,
                        "Student ID": t.student_id,
                        "Customer Mobile Number": t.customer_mobile,
                        "Total Amount Plus Fees": t.total_amount,
                        "Net Amount": t.net_amount,
                        "Fawry Fees": t.fawry_fees,
                        "Payment Status": t.payment_status,
                        "Item Name": t.item_name,
                        "Item Price": t.item_price,
                        "Merchant Name": t.merchant_name,
                        "Bank": t.bank,
                        "Check Column": t.check_column,
                        "ID Status": t.id_status,
                        "Mapping": t.mapping
                    };
                });

                const worksheet = XLSX.utils.json_to_sheet(formattedData, { cellDates: true });
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Fawry Query");
                
                // Trigger download
                XLSX.writeFile(workbook, `Fawry_Query_Export_${new Date().toISOString().split('T')[0]}.xlsx`);

            } catch (err) {
                alert("Export failed: " + err.message);
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
                    const { data, error } = await supabase.from('item_mappings').select('*').range(from, from + 999);
                    if (error) throw error;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                if (allData.length === 0) return alert("No mappings to export.");

                const formattedData = allData.map(m => ({
                    "Item Name": m.item_name,
                    "Adjusted Item Name": m.adjusted_item_name || "",
                    "Mapping": m.mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Item Mappings");
                XLSX.writeFile(workbook, `Item_Mappings_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
            } catch (err) {
                alert("Export failed: " + err.message);
            }
        });

        document.getElementById('btn-export-fixes').addEventListener('click', async () => {
            try {
                let allData = [];
                let from = 0;
                let fetchMore = true;
                while (fetchMore) {
                    const { data, error } = await supabase.from('manual_fixes').select('*').range(from, from + 999);
                    if (error) throw error;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                if (allData.length === 0) return alert("No fixes to export.");

                const formattedData = allData.map(f => ({
                    "Reference Number": f.reference_number,
                    "Correct ID": f.correct_id || "",
                    "Item Name": f.item_name || "",
                    "Mapping": f.mapping || ""
                }));

                const worksheet = XLSX.utils.json_to_sheet(formattedData);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Manual Fixes");
                XLSX.writeFile(workbook, `Manual_Fixes_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
            } catch (err) {
                alert("Export failed: " + err.message);
            }
        });
    }

    async loadTransactions() {
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = '<tr><td colspan="9">Loading...</td></tr>';

        const dateFrom = document.getElementById('filter-date-from')?.value;
        const dateTo = document.getElementById('filter-date-to')?.value;
        const bank = document.getElementById('filter-bank')?.value;
        const mapping = document.getElementById('filter-mapping')?.value;
        const item = document.getElementById('filter-item')?.value;
        const search = document.getElementById('search-input')?.value;
        const status = document.getElementById('status-filter')?.value;

        let query = supabase.from('transactions').select('*');

        if (dateFrom) query = query.gte('payment_date', dateFrom);
        if (dateTo) query = query.lte('payment_date', dateTo);
        if (bank) query = query.eq('bank', bank);
        if (mapping) query = query.ilike('mapping', `%${mapping}%`);
        if (item) query = query.ilike('item_name', `%${item}%`);
        if (search) {
            if (/^\d+$/.test(search)) {
                query = query.or(`student_id.ilike.%${search}%,reference_number.eq.${search}`);
            } else {
                query = query.ilike('student_id', `%${search}%`);
            }
        }
        
        if (status) {
            if (status === 'valid') query = query.eq('id_status', 'Valid');
            else if (status === 'missing') query = query.eq('id_status', 'Missing ID');
            else if (status === 'error') query = query.ilike('id_status', '%Error%');
        }

        const fromRange = (this.currentPage - 1) * this.pageSize;
        const toRange = fromRange + this.pageSize - 1;

        const { data, error } = await query
            .order('payment_date', { ascending: false })
            .range(fromRange, toRange);

        // Update pagination UI
        document.getElementById('page-info').innerText = `Page ${this.currentPage}`;
        document.getElementById('btn-prev').disabled = this.currentPage === 1;
        document.getElementById('btn-next').disabled = !data || data.length < this.pageSize;

        if (error) {
            tbody.innerHTML = `<tr><td colspan="9" style="color:red">Error: ${error.message}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9">No transactions found. Go to Import CSV to add some!</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(t => {
            let statusClass = 'valid';
            if (t.id_status.includes('Missing')) statusClass = 'missing';
            if (t.id_status.includes('Error')) statusClass = 'error';

            return `
                <tr>
                    <td>${t.reference_number || ''}</td>
                    <td>${t.payment_date || ''}</td>
                    <td><strong>${t.student_id || ''}</strong></td>
                    <td>${t.customer_mobile || ''}</td>
                    <td>EGP ${t.net_amount || '0'}</td>
                    <td>${t.item_name || ''}</td>
                    <td>${t.mapping || '-'}</td>
                    <td>${t.bank || ''}</td>
                    <td><span class="badge ${statusClass}">${t.id_status || ''}</span></td>
                </tr>
            `;
        }).join('');
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        let allData = [];
        let from = 0;
        let fetchMore = true;
        while (fetchMore) {
            const { data } = await supabase.from('item_mappings').select('*').range(from, from + 999);
            if (!data || data.length === 0) break;
            allData = allData.concat(data);
            if (data.length < 1000) fetchMore = false;
            else from += 1000;
        }

        if (allData.length === 0) return;

        tbody.innerHTML = allData.map(m => `
            <tr>
                <td>${m.item_name}</td>
                <td>${m.adjusted_item_name || '-'}</td>
                <td>${m.mapping || '-'}</td>
                <td><button class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.75rem">Edit</button></td>
            </tr>
        `).join('');
    }

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        let allData = [];
        let from = 0;
        let fetchMore = true;
        while (fetchMore) {
            const { data } = await supabase.from('manual_fixes').select('*').range(from, from + 999);
            if (!data || data.length === 0) break;
            allData = allData.concat(data);
            if (data.length < 1000) fetchMore = false;
            else from += 1000;
        }

        if (allData.length === 0) return;

        tbody.innerHTML = allData.map(f => `
            <tr>
                <td>${f.reference_number}</td>
                <td>${f.correct_id || '-'}</td>
                <td>${f.item_name || '-'}</td>
                <td>${f.mapping || '-'}</td>
                <td><button class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.75rem">Edit</button></td>
            </tr>
        `).join('');
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

        const btnSearch = document.getElementById('btn-search-students');
        if (btnSearch) {
            btnSearch.addEventListener('click', async () => {
                const term = document.getElementById('student-search-input').value.trim();
                if (!term) return;
                
                try {
                    const { data, error } = await supabase
                        .from('student_master')
                        .select('*')
                        .or(`student_id.ilike.%${term}%,full_name.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%`)
                        .limit(50);
                        
                    if (error) throw error;
                    
                    const tbody = document.getElementById('students-table-body');
                    tbody.innerHTML = data.map(s => `
                        <tr>
                            <td>${s.student_id || ''}</td>
                            <td>${s.full_name || ''}</td>
                            <td>${s.email || ''}</td>
                            <td>${s.mobile || ''}</td>
                            <td>${s.college || ''}</td>
                            <td>${s.program || ''}</td>
                        </tr>
                    `).join('');
                } catch(err) {
                    console.error("Lookup error:", err);
                }
            });
        }
        
        const btnExport = document.getElementById('btn-export-students');
        if (btnExport) {
            btnExport.addEventListener('click', async () => {
                try {
                    btnExport.innerText = 'Exporting...';
                    const { data, error } = await supabase.from('student_master').select('*');
                    if (error) throw error;
                    
                    if (data && data.length > 0) {
                        const csv = Papa.unparse(data);
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(blob);
                        link.download = `Student_Master.csv`;
                        link.click();
                    }
                } catch(err) {
                    alert('Export failed: ' + err.message);
                } finally {
                    btnExport.innerHTML = '<i data-lucide="download"></i> Export Master List';
                    lucide.createIcons();
                }
            });
        }

        const dropZone = document.getElementById('student-upload-zone');
        const fileInput = document.getElementById('student-file-input');
        
        if (dropZone && fileInput) {
            dropZone.addEventListener('click', () => fileInput.click());
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--primary-color)';
                dropZone.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
            });
            dropZone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--border-color)';
                dropZone.style.backgroundColor = 'transparent';
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.style.borderColor = 'var(--border-color)';
                dropZone.style.backgroundColor = 'transparent';
                if (e.dataTransfer.files.length) {
                    this.handleStudentExcelUpload(e.dataTransfer.files[0]);
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    this.handleStudentExcelUpload(e.target.files[0]);
                }
            });
        }
        
        const btnRunMatcher = document.getElementById('btn-run-automatcher');
        if (btnRunMatcher) {
            btnRunMatcher.addEventListener('click', () => this.runAutoMatcher());
        }
        const selectAllMatcher = document.getElementById('automatcher-select-all');
        if(selectAllMatcher) {
            selectAllMatcher.addEventListener('change', (e) => {
                document.querySelectorAll('.automatch-checkbox').forEach(cb => cb.checked = e.target.checked);
            });
        }
        const btnApplyMatch = document.getElementById('btn-apply-automatch-fixes');
        if(btnApplyMatch) {
            btnApplyMatch.addEventListener('click', () => this.applyAutoMatches());
        }
    }
    
    loadStudentMaster() {
        lucide.createIcons();
    }

    async handleStudentExcelUpload(file) {
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing Excel file...`;
        lucide.createIcons();

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            
            if (!rows || rows.length === 0) throw new Error("File is empty.");

            let headers = rows[0];
            let dataRows = rows.slice(1);

            if (!headers.includes('Student ID') && !headers.includes('PEOPLE_ID1')) {
                if (rows.length > 1 && rows[1].includes('Student ID')) {
                    headers = rows[1];
                    dataRows = rows.slice(2);
                }
            }

            const headerMap = {};
            headers.forEach((h, i) => { if (h) headerMap[h.toString().trim()] = i; });

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Preparing data for upload...`;
            
            const records = [];
            for (const row of dataRows) {
                if (!row || row.length === 0) continue;
                
                const cleanPhone = (val) => val ? String(val).replace(/\s+/g, '').trim() : null;

                let student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source;

                if ('PEOPLE_ID1' in headerMap) {
                    student_id = String(row[headerMap['PEOPLE_ID1']] || '').trim();
                    full_name = row[headerMap['Full name']] || row[headerMap['FIRST_NAME1']] || '';
                    arabic_name = row[headerMap['ARABICNAME']];
                    national_id = row[headerMap['GOVERNMENT_ID1']];
                    email = row[headerMap['personalEmail']] || row[headerMap['Email1']];
                    mobile = cleanPhone(row[headerMap['PhoneNumber1']]);
                    guardian_name = row[headerMap['Guardian_NAME']];
                    guardian_mobile = cleanPhone(row[headerMap['Guardian_Mobile']]);
                    college = row[headerMap['University1']];
                    program = row[headerMap['PROGRAM1']];
                    source = 'ApplicantReport';
                } else if ('Student ID' in headerMap) {
                    student_id = String(row[headerMap['Student ID']] || '').trim();
                    full_name = row[headerMap['Student Name']];
                    email = row[headerMap['Email']];
                    mobile = cleanPhone(row[headerMap['Mobile Phone Number']]);
                    college = row[headerMap['College']];
                    program = row[headerMap['Program']];
                    source = 'StudentDetails';
                } else {
                    throw new Error("Unrecognized Excel format.");
                }

                if (student_id) {
                    records.push({
                        student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source
                    });
                }
            }

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${records.length} records to database...`;
            
            for (let i = 0; i < records.length; i += 1000) {
                const batch = records.slice(i, i + 1000);
                const { error } = await supabase.from('student_master').upsert(batch);
                if (error) throw error;
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.round((i/records.length)*100)}%`;
            }

            status.className = 'alert alert-success';
            status.innerHTML = `<i data-lucide="check-circle"></i> Successfully imported ${records.length} students!`;
            lucide.createIcons();

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${err.message}`;
            lucide.createIcons();
            console.error(err);
        }
    }

    async runAutoMatcher() {
        const btn = document.getElementById('btn-run-automatcher');
        const tbody = document.getElementById('automatcher-table-body');
        const btnApply = document.getElementById('btn-apply-automatch-fixes');
        
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching...`;
        btn.disabled = true;
        lucide.createIcons();

        try {
            const { data: invalidTx, error: err1 } = await supabase
                .from('transactions')
                .select('*')
                .eq('id_status', 'Invalid ID');
            if (err1) throw err1;

            if (!invalidTx || invalidTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center">No invalid IDs found.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }

            const { data: linksData, error: err2 } = await supabase.from('links').select('*');
            if (err2) throw err2;
            const linksMap = {};
            linksData.forEach(l => { linksMap[l.reference_number] = l; });

            const { data: students, error: err3 } = await supabase.from('student_master').select('*');
            if (err3) throw err3;

            this.automatchProposals = [];
            let html = '';

            for (const tx of invalidTx) {
                const link = linksMap[tx.reference_number];
                let proposedStudent = null;
                let matchReason = '';

                if (link && !proposedStudent) {
                    const lEmail = link.email ? link.email.trim().toLowerCase() : null;
                    const lMobile = link.mobile ? String(link.mobile).replace(/\s+/g, '') : null;
                    
                    proposedStudent = students.find(s => 
                        (lEmail && s.email && s.email.toLowerCase() === lEmail) ||
                        (lMobile && s.mobile && s.mobile === lMobile) ||
                        (lMobile && s.guardian_mobile && s.guardian_mobile === lMobile)
                    );
                    if (proposedStudent) matchReason = 'Exact match (Links Data)';
                }

                if (!proposedStudent) {
                    const searchNames = [];
                    if (tx.item_name) searchNames.push(tx.item_name.toLowerCase());
                    if (link && link.student_name) searchNames.push(link.student_name.toLowerCase());

                    for (const s of students) {
                        const sName = s.full_name ? s.full_name.toLowerCase() : '';
                        const gName = s.guardian_name ? s.guardian_name.toLowerCase() : '';
                        
                        for (const n of searchNames) {
                            if (sName && sName.length > 5 && n.includes(sName)) {
                                proposedStudent = s; matchReason = 'Fuzzy Name Match'; break;
                            }
                            if (gName && gName.length > 5 && n.includes(gName)) {
                                proposedStudent = s; matchReason = 'Fuzzy Guardian Match'; break;
                            }
                        }
                        if (proposedStudent) break;
                    }
                }

                if (proposedStudent) {
                    this.automatchProposals.push({
                        tx_id: tx.id,
                        student_id: proposedStudent.student_id,
                        student_name: proposedStudent.full_name,
                        reason: matchReason
                    });

                    html += `
                        <tr>
                            <td><input type="checkbox" class="automatch-checkbox" value="${tx.id}" checked></td>
                            <td>${tx.reference_number}</td>
                            <td>${tx.payment_date}</td>
                            <td>${tx.bank}</td>
                            <td>${tx.item_name}</td>
                            <td>${formatMoney(tx.item_price)}</td>
                            <td>
                                <span class="status-badge valid-id">Matched: ${proposedStudent.student_id}</span>
                                <br><small class="text-muted">${proposedStudent.full_name} (${matchReason})</small>
                            </td>
                        </tr>
                    `;
                } else {
                    html += `
                        <tr style="opacity: 0.6;">
                            <td><input type="checkbox" disabled></td>
                            <td>${tx.reference_number}</td>
                            <td>${tx.payment_date}</td>
                            <td>${tx.bank}</td>
                            <td>${tx.item_name}</td>
                            <td>${formatMoney(tx.item_price)}</td>
                            <td><span class="status-badge invalid-id">No Match Found</span></td>
                        </tr>
                    `;
                }
            }

            tbody.innerHTML = html || '<tr><td colspan="7" class="text-center">No proposals could be made.</td></tr>';
            btnApply.style.display = html ? 'inline-block' : 'none';

        } catch (err) {
            alert('Matcher Error: ' + err.message);
        } finally {
            btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
            btn.disabled = false;
            lucide.createIcons();
        }
    }

    async applyAutoMatches() {
        const checkboxes = document.querySelectorAll('.automatch-checkbox:checked');
        if (checkboxes.length === 0) {
            alert('Please select at least one proposed match to apply.');
            return;
        }

        const btn = document.getElementById('btn-apply-automatch-fixes');
        btn.innerText = 'Applying...';
        btn.disabled = true;

        try {
            for (const cb of checkboxes) {
                const tx_id = parseInt(cb.value);
                const proposal = this.automatchProposals.find(p => p.tx_id === tx_id);
                if (proposal) {
                    await supabase
                        .from('transactions')
                        .update({ 
                            student_id: proposal.student_id,
                            id_status: 'Valid ID'
                        })
                        .eq('id', tx_id);
                }
            }

            alert(`Successfully applied ${checkboxes.length} fixes!`);
            this.runAutoMatcher();
            this.loadDashboard();
        } catch(err) {
            alert('Error applying fixes: ' + err.message);
        } finally {
            btn.innerText = 'Apply Selected Fixes';
            btn.disabled = false;
        }
    }

}

// Start app
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});

