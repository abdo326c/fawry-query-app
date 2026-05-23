import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';

class App {
    constructor() {
        this.initNavigation();
        this.initImport();
        this.initModals();
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

    async loadTransactions() {
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = '<tr><td colspan="9">Loading...</td></tr>';

        const { data, error } = await supabase
            .from('transactions')
            .select('*')
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
