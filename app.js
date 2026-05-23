import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';

class App {
    constructor() {
        this.initNavigation();
        this.initImport();
        this.initModals();
        this.initBulkUploads();
        this.initFilters();
        this.initExport();
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

                if (tabId === 'transactions') this.loadTransactions();
                if (tabId === 'mappings') this.loadMappings();
                if (tabId === 'fixes') this.loadFixes();
            });
        });
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

            const { error } = await supabase.from('item_mappings').insert([{
                item_name: original,
                adjusted_item_name: adjusted || null,
                mapping: category || null
            }]);

            if (error) alert('Error saving mapping: ' + error.message);
            else {
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

            const { error } = await supabase.from('manual_fixes').insert([{
                reference_number: ref,
                correct_id: correctId || null,
                item_name: correctName || null,
                mapping: correctMapping || null
            }]);

            if (error) alert('Error saving fix: ' + error.message);
            else {
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
                alert(`Successfully uploaded ${inserted} item mappings!`);
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
                alert(`Successfully uploaded ${inserted} manual fixes!`);
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

    initFilters() {
        document.getElementById('btn-apply-filters').addEventListener('click', () => {
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
            this.loadTransactions();
        });

        let searchTimeout;
        document.getElementById('search-input').addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.loadTransactions(), 500);
        });

        document.getElementById('status-filter').addEventListener('change', () => {
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
                    if (search) query = query.or(`student_id.ilike.%${search}%,reference_number.ilike.%${search}%`);
                    
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
        if (search) query = query.or(`student_id.ilike.%${search}%,reference_number.ilike.%${search}%`);
        
        if (status) {
            if (status === 'valid') query = query.eq('id_status', 'Valid');
            else if (status === 'missing') query = query.eq('id_status', 'Missing ID');
            else if (status === 'error') query = query.ilike('id_status', '%Error%');
        }

        const { data, error } = await query
            .order('payment_date', { ascending: false })
            .limit(50);

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
        const { data } = await supabase.from('item_mappings').select('*');
        if (!data) return;

        tbody.innerHTML = data.map(m => `
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
        const { data } = await supabase.from('manual_fixes').select('*');
        if (!data) return;

        tbody.innerHTML = data.map(f => `
            <tr>
                <td>${f.reference_number}</td>
                <td>${f.correct_id || '-'}</td>
                <td>${f.item_name || '-'}</td>
                <td>${f.mapping || '-'}</td>
                <td><button class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.75rem">Edit</button></td>
            </tr>
        `).join('');
    }
}

// Start app
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
