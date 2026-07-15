import { supabase } from './supabase.js';
import { FawryProcessor } from './csv-processor.js';

// Shared utility: escape HTML to prevent XSS
function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Shared utility: format money
function formatMoney(num) {
    return parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shared utility: sanitize user input for Supabase .or() filter strings
function sanitizeForFilter(str) {
    if (!str) return '';
    return String(str).replace(/[,.)(%\\]/g, '');
}

// Shared utility: standalone validateID (no need to instantiate FawryProcessor)
function validateID(id) {
    if (!id) return "Missing ID";
    const idText = String(id).trim().replace(/\u00A0/g, '');
    if (!idText || idText.length === 0) return "Missing ID";
    const idLength = idText.length;
    const onlyTextLeft = idText.replace(/[0-9]/g, '');
    if (idLength === 17 && idText.toUpperCase().startsWith("DIP")) {
        const remainder = idText.substring(3).replace(/[0-9]/g, '');
        if (remainder === "") return "Valid";
    }
    if (onlyTextLeft !== "") return "Error: Text/Name detected";
    if (idLength < 4) return `Error: ID Too Short (${idLength} digits)`;
    if (idLength > 9) return `Error: ID Too Long (${idLength} digits)`;
    if (idText.startsWith("2") && idLength !== 9) return `Error: Invalid 2-Series Length (${idLength} digits)`;
    return "Valid";
}

// Shared utility: fetch all rows from a table with pagination
async function fetchAll(table, selectCols = '*', queryFn = null) {
    let allData = [];
    let from = 0;
    let fetchMore = true;
    while (fetchMore) {
        let query = supabase.from(table).select(selectCols);
        if (queryFn) query = queryFn(query);
        query = query.range(from, from + 999);
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < 1000) fetchMore = false;
        else from += 1000;
    }
    return allData;
}

class Toast {
    static show(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        let iconName = 'info';
        if (type === 'success') iconName = 'check-circle';
        if (type === 'error') iconName = 'alert-circle';
        if (type === 'warning') iconName = 'alert-triangle';
        
        toast.innerHTML = `
            <i data-lucide="${iconName}" class="toast-icon"></i>
            <div class="toast-content">${escapeHTML(msg)}</div>
        `;
        
        container.appendChild(toast);
        lucide.createIcons({ root: toast });
        
        setTimeout(() => {
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Export it so csv-processor can use it if needed, or attach to window
window.Toast = Toast;

class App {
    constructor() {
        this.currentUser = null;
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
        
        this.isImporting = false;
        this.initTheme();
        this.fetchUniqueFilters();

        this.initNavigation();
        this.initImport();
        this.initModals();
        this.initBulkUploads();
        this.initFilters();
        this.initPagination();
        this.initExport();
        this.initReapply();
        this.initPaymentLinks();
        this.initDashboard();
        this.initStudentMaster();
        this.initHistory();
        this.initAuth();
    }

    async initAuth() {
        // Handle Session State
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            this.setupUser(session.user);
        }

        supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                this.setupUser(session.user);
            } else if (event === 'SIGNED_OUT') {
                this.currentUser = null;
                document.getElementById('auth-overlay').classList.remove('hidden');
                document.getElementById('user-profile-section').style.display = 'none';
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
                lucide.createIcons();
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

    setupUser(user) {
        this.currentUser = user;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('user-profile-section').style.display = 'flex';
        document.getElementById('user-email-display').innerText = user.email;
        this.loadTransactions();
    }

    initTheme() {
        const btnToggle = document.getElementById('btn-theme-toggle');
        if (!btnToggle) return;

        const htmlEl = document.documentElement;
        const iconEl = document.getElementById('theme-icon');
        const textEl = document.getElementById('theme-text');

        // Check local storage or system preference
        const savedTheme = localStorage.getItem('fawry-theme');
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;

        if (savedTheme === 'light' || (!savedTheme && prefersLight)) {
            htmlEl.classList.remove('dark');
            htmlEl.classList.add('light');
            if(iconEl) iconEl.setAttribute('data-lucide', 'moon');
            if(textEl) textEl.innerText = 'Dark Mode';
        }

        btnToggle.addEventListener('click', () => {
            const isLight = htmlEl.classList.contains('light');
            if (isLight) {
                htmlEl.classList.remove('light');
                htmlEl.classList.add('dark');
                localStorage.setItem('fawry-theme', 'dark');
                if(iconEl) iconEl.setAttribute('data-lucide', 'sun');
                if(textEl) textEl.innerText = 'Light Mode';
            } else {
                htmlEl.classList.remove('dark');
                htmlEl.classList.add('light');
                localStorage.setItem('fawry-theme', 'light');
                if(iconEl) iconEl.setAttribute('data-lucide', 'moon');
                if(textEl) textEl.innerText = 'Dark Mode';
            }
            if (window.lucide) lucide.createIcons();
        });
    }

    async fetchUniqueFilters() {
        try {
            const { data, error } = await supabase.from('item_mappings').select('mapping, item_name');
            if (!error && data) {
                this.uniqueLists.mapping = [...new Set(data.map(d => d.mapping).filter(Boolean))].sort();
                this.uniqueLists.item_name = [...new Set(data.map(d => d.item_name).filter(Boolean))].sort();
            }
        } catch (err) {
            console.error('Error fetching distinct mappings:', err);
        }
    }

    initNavigation() {
        const btnMobileMenu = document.getElementById('btn-mobile-menu');
        const btnCloseSidebar = document.getElementById('btn-close-sidebar');
        const sidebar = document.querySelector('.sidebar');

        if (btnMobileMenu) {
            btnMobileMenu.addEventListener('click', () => {
                sidebar.classList.add('open');
            });
        }
        
        if (btnCloseSidebar) {
            btnCloseSidebar.addEventListener('click', () => {
                sidebar.classList.remove('open');
            });
        }

        const links = document.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tabId = link.getAttribute('data-tab');
                
                // Update active state
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                
                // Close sidebar on mobile after clicking
                if (window.innerWidth <= 768) {
                    sidebar.classList.remove('open');
                }
                
                // Show view
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById(`view-${tabId}`).classList.add('active');

                if (tabId === 'dashboard') this.loadDashboard();
                if (tabId === 'transactions') this.loadTransactions();
                if (tabId === 'mappings') this.loadMappings();
                if (tabId === 'fixes') this.loadFixes();
                if (tabId === 'history') this.loadHistory();
                if (tabId === 'payment-links') this.loadPaymentLinks();
                // Students Details does not require initial data load
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
                    Toast.show('Failed to copy: ' + err.message, 'error');
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
            tbody.innerHTML = `<tr><td colspan="4" style="color: var(--danger);">Error: ${escapeHTML(err.message)}</td></tr>`;
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
            await processor.processFiles(files);
            
            if (processor.skippedTransactions && processor.skippedTransactions.length > 0) {
                const summary = {};
                processor.skippedTransactions.forEach(t => {
                    const statusName = t.status ? String(t.status).trim() : 'Unknown';
                    summary[statusName] = (summary[statusName] || 0) + 1;
                });
                
                let msg = `IMPORTANT: Skipped ${processor.skippedTransactions.length} transactions due to invalid Payment Status.\n\nSummary:\n`;
                for (const [status, count] of Object.entries(summary)) {
                    msg += `- ${status}: ${count} transaction(s)\n`;
                }
                msg += `\nThese transactions were NOT imported.`;
                
                // Force the user to acknowledge
                alert(msg);
            }

            // Auto-switch back to transactions tab after 1.5 seconds
            setTimeout(() => {
                document.getElementById('import-progress').classList.add('hidden');
                document.querySelector('.nav-link[data-tab="transactions"]').click();
                this.loadTransactions();
            }, 1500);
        } finally {
            this.isImporting = false;
        }
    }

    initModals() {
        // Open Mapping Modal
        document.getElementById('btn-add-mapping').addEventListener('click', () => {
            document.getElementById('modal-mapping').classList.remove('hidden');
        });

        // Smart Mapping Auto-Suggest
        document.getElementById('map-original').addEventListener('input', async (e) => {
            const query = e.target.value.trim();
            const suggestDiv = document.getElementById('mapping-suggestion');
            if (query.length < 3) {
                suggestDiv.style.display = 'none';
                return;
            }

            // Fetch existing mappings to compare against
            const { data: mappings } = await supabase.from('item_mappings').select('item_name, mapping');
            if (mappings && mappings.length > 0) {
                const fuse = new Fuse(mappings, { keys: ['item_name'], threshold: 0.3 });
                const results = fuse.search(query);
                if (results.length > 0) {
                    const topMatch = results[0].item;
                    suggestDiv.innerText = `💡 Smart Suggestion: Click to map to "${topMatch.mapping}" (similar to ${topMatch.item_name})`;
                    suggestDiv.style.display = 'block';
                    suggestDiv.onclick = () => {
                        document.getElementById('map-category').value = topMatch.mapping;
                        suggestDiv.style.display = 'none';
                        Toast.show('Applied Smart Suggestion!', 'success');
                    };
                } else {
                    suggestDiv.style.display = 'none';
                }
            }
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
            
            if (!original) return Toast.show('Original Item Name is required', 'warning');

            const { error } = await supabase.from('item_mappings').upsert([{
                item_name: original,
                adjusted_item_name: adjusted || null,
                mapping: category || null
            }], { onConflict: 'item_name', ignoreDuplicates: false });

            if (error) Toast.show('Error saving mapping: ' + error.message, 'error');
            else {
                if (this.currentUser) {
                    await supabase.from('audit_logs').insert({
                        user_email: this.currentUser.email,
                        action: 'Single Mapping Added',
                        affected_references: original,
                        details: { original, adjusted, category }
                    });
                }
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

            if (!ref) return Toast.show('Reference Number is required', 'warning');

            const { error } = await supabase.from('manual_fixes').upsert([{
                reference_number: ref,
                correct_id: correctId || null,
                item_name: correctName || null,
                mapping: correctMapping || null
            }], { onConflict: 'reference_number', ignoreDuplicates: false });

            if (error) {
                Toast.show('Error saving fix: ' + error.message, 'error');
            } else {
                if (this.currentUser) {
                    await supabase.from('audit_logs').insert({
                        user_email: this.currentUser.email,
                        action: 'Single Manual Fix Added',
                        affected_references: ref,
                        details: { correctId, correctName, correctMapping }
                    });
                }
                
                Toast.show('Manual fix saved successfully!', 'success');
                const { data: existingTx } = await supabase.from('transactions').select('*').eq('reference_number', ref);
                if (existingTx && existingTx.length > 0) {
                    for (const tx of existingTx) {
                        if (correctId) {
                            tx.student_id = correctId;
                            tx.id_status = validateID(tx.student_id);
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
                Toast.show('File is empty!', 'warning');
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
                    if (error) return Toast.show('Error uploading mappings: ' + error.message, 'error');
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

                if (this.currentUser) {
                    await supabase.from('audit_logs').insert({
                        user_email: this.currentUser.email,
                        action: 'Bulk Mappings Uploaded',
                        affected_references: `Batch of ${inserted} items`,
                        details: { count: inserted }
                    });
                }
                Toast.show(`Successfully uploaded ${inserted} item mappings and updated existing transactions!`, 'success');
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
                    if (error) return Toast.show('Error uploading fixes: ' + error.message, 'error');
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
                                    tx.id_status = validateID(tx.student_id);
                                }
                                if (fix.item_name) tx.item_name = fix.item_name;
                                if (fix.mapping) tx.mapping = fix.mapping;
                            }
                        }
                        await supabase.from('transactions').upsert(existingTx, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                    }
                }

                if (this.currentUser) {
                    await supabase.from('audit_logs').insert({
                        user_email: this.currentUser.email,
                        action: 'Bulk Fixes Uploaded',
                        affected_references: `Batch of ${inserted} items`,
                        details: { count: inserted }
                    });
                }
                Toast.show(`Successfully uploaded ${inserted} manual fixes and updated existing transactions!`, 'success');
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
        // Event listener for the main "Re-apply Rules" button
        document.getElementById('btn-reapply-rules').addEventListener('click', async () => {
            const btn = document.getElementById('btn-reapply-rules');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader"></i> Computing...';
            btn.disabled = true;

            try {
                const mappings = await fetchAll('item_mappings');
                const fixes = await fetchAll('manual_fixes');
                const links = await fetchAll('links');

                // Build hash maps for O(1) lookups instead of O(n) find()
                const linksMap = new Map();
                links.forEach(l => linksMap.set(String(l.payment_reference_number), l));
                const fixesMap = new Map();
                fixes.forEach(f => fixesMap.set(String(f.reference_number), f));
                const mappingsMap = new Map();
                mappings.forEach(m => mappingsMap.set(m.item_name, m));

                let fetchMore = true;
                let from = 0;
                
                // Store proposals globally for the modal
                window.reapplyProposals = [];

                while (fetchMore) {
                    const { data: txs, error } = await supabase.from('transactions').select('*').range(from, from + 999);
                    if (error) throw error;
                    if (!txs || txs.length === 0) break;

                    for (const tx of txs) {
                        let originalItemName = tx.check_column ? tx.check_column.substring(tx.reference_number.length + 1) : tx.item_name;
                        
                        let newStudentId = tx.student_id;
                        let newItemName = originalItemName;
                        let newMapping = null;
                        
                        let reasons = [];

                        const link = linksMap.get(String(tx.reference_number));
                        if (link && link.custom_input_value) {
                            newStudentId = link.custom_input_value;
                            reasons.push("Student Link");
                        }

                        const mapDef = mappingsMap.get(newItemName);
                        if (mapDef) {
                            if (mapDef.adjusted_item_name) newItemName = mapDef.adjusted_item_name;
                            if (mapDef.mapping) newMapping = mapDef.mapping;
                            reasons.push("Mapping Rule");
                        }

                        const fix = fixesMap.get(String(tx.reference_number));
                        if (fix) {
                            if (fix.correct_id) newStudentId = fix.correct_id;
                            if (fix.item_name) newItemName = fix.item_name;
                            if (fix.mapping) newMapping = fix.mapping;
                            reasons.push("Manual Fix");
                        }

                        let newStatus = validateID(newStudentId);

                        if (tx.student_id !== newStudentId || tx.item_name !== newItemName || tx.mapping !== newMapping || tx.id_status !== newStatus) {
                            
                            // Determine what exactly changed
                            let oldValues = [];
                            let newValues = [];
                            let changeType = [];
                            if (tx.student_id !== newStudentId) {
                                changeType.push('ID');
                                oldValues.push(tx.student_id || 'Empty');
                                newValues.push(newStudentId || 'Empty');
                            }
                            if (tx.mapping !== newMapping) {
                                changeType.push('Mapping');
                                oldValues.push(tx.mapping || 'Empty');
                                newValues.push(newMapping || 'Empty');
                            }
                            if (tx.id_status !== newStatus && tx.student_id === newStudentId) {
                                changeType.push('Status');
                                oldValues.push(tx.id_status || 'Empty');
                                newValues.push(newStatus || 'Empty');
                            }

                            window.reapplyProposals.push({
                                originalTx: tx,
                                updatedTx: {
                                    ...tx,
                                    student_id: newStudentId,
                                    item_name: newItemName,
                                    mapping: newMapping,
                                    id_status: newStatus
                                },
                                changeType: changeType.join(', '),
                                oldStr: oldValues.join(', '),
                                newStr: newValues.join(', '),
                                reason: [...new Set(reasons)].join(' + ') || 'Status Re-validation'
                            });
                        }
                    }

                    if (txs.length < 1000) fetchMore = false;
                    else from += 1000;
                }

                if (window.reapplyProposals.length === 0) {
                    Toast.show('No rules need to be applied. Everything is up to date!', 'info');
                } else {
                    // Populate modal
                    const tbody = document.getElementById('reapply-preview-table-body');
                    tbody.innerHTML = window.reapplyProposals.map((prop, idx) => `
                        <tr>
                            <td><input type="checkbox" class="reapply-checkbox" data-index="${idx}" checked></td>
                            <td>${prop.originalTx.reference_number}</td>
                            <td><span class="badge" style="background: rgba(0, 229, 255, 0.1); color: var(--primary-color);">${prop.changeType}</span></td>
                            <td style="color: var(--text-muted); text-decoration: line-through;">${prop.oldStr}</td>
                            <td style="color: var(--success-color); font-weight: 500;">${prop.newStr}</td>
                            <td style="font-size: 0.85rem; color: var(--text-muted);">${prop.reason}</td>
                        </tr>
                    `).join('');
                    
                    document.getElementById('modal-reapply-preview').classList.remove('hidden');
                    if (window.lucide) lucide.createIcons();
                }

            } catch (err) {
                Toast.show('Error computing rules: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });

        // Event listener for "Select All" checkbox
        document.getElementById('reapply-select-all')?.addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('.reapply-checkbox');
            checkboxes.forEach(cb => cb.checked = e.target.checked);
        });

        // Event listener for the "Apply Selected" button in the modal
        document.getElementById('btn-apply-reapply-fixes')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-apply-reapply-fixes');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Applying...';
            btn.disabled = true;

            try {
                const checkboxes = document.querySelectorAll('.reapply-checkbox:checked');
                const selectedTxs = Array.from(checkboxes).map(cb => {
                    const idx = parseInt(cb.getAttribute('data-index'));
                    return window.reapplyProposals[idx].updatedTx;
                });

                if (selectedTxs.length === 0) {
                    Toast.show("No transactions selected.", "info");
                    document.getElementById('modal-reapply-preview').classList.add('hidden');
                    return;
                }

                // Chunk upserts
                let updatedCount = 0;
                for (let i = 0; i < selectedTxs.length; i += 1000) {
                    const chunk = selectedTxs.slice(i, i + 1000);
                    const { error } = await supabase.from('transactions').upsert(chunk, { onConflict: 'reference_number,item_price,check_column', ignoreDuplicates: false });
                    if (error) throw error;
                    updatedCount += chunk.length;
                }

                Toast.show(`Successfully updated ${updatedCount} transactions!`, 'success');
                document.getElementById('modal-reapply-preview').classList.add('hidden');
                this.loadTransactions();

            } catch(err) {
                Toast.show('Error applying rules: ' + err.message, 'error');
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
            document.getElementById('search-input').value = '';
            this.headerFilters.transactions = {};
            document.querySelectorAll('[data-table="transactions"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.currentPage = 1;
            this.loadTransactions();
        });

        document.getElementById('btn-clear-automatcher')?.addEventListener('click', () => {
            document.getElementById('automatcher-date-from').value = '';
            document.getElementById('automatcher-date-to').value = '';
            document.getElementById('automatcher-search').value = '';
            this.headerFilters.automatch = {};
            document.querySelectorAll('[data-table="automatch"] .header-filter-icon').forEach(icon => icon.classList.remove('active'));
            this.runAutoMatcher();
        });

        let automatchSearchTimeout;
        document.getElementById('automatcher-search')?.addEventListener('input', () => {
            clearTimeout(automatchSearchTimeout);
            automatchSearchTimeout = setTimeout(() => {
                this.runAutoMatcher();
            }, 300);
        });

        document.getElementById('automatcher-date-from')?.addEventListener('change', () => this.runAutoMatcher());
        document.getElementById('automatcher-date-to')?.addEventListener('change', () => this.runAutoMatcher());

        const searchInput = document.getElementById('search-input');
        let searchTimeout;
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.currentPage = 1;
                this.loadTransactions();
            }, 500);
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
                options = ['Valid', 'Missing ID', 'Error'];
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
                        const { data, error } = await query.limit(100);
                        if (!error && data) {
                            options = [...new Set(data.map(d => d[currentColumn]).filter(v => v !== null && v !== undefined))].sort();
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
                popover.style.top = `${rect.bottom + window.scrollY + 5}px`;
                popover.style.left = `${rect.left + window.scrollX}px`;
                
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
            this.headerFilters[currentTable][currentColumn] = [];
            currentWrapper.querySelector('.header-filter-icon').classList.remove('active');
            closePopover();
            if (currentTable === 'transactions') { this.currentPage = 1; this.loadTransactions(); }
            else { this.runAutoMatcher(); }
        });

        btnApply.addEventListener('click', () => {
            if (!currentWrapper) return;
            const checked = Array.from(listContainer.querySelectorAll('input:checked')).map(cb => cb.value);
            this.headerFilters[currentTable][currentColumn] = checked;
            
            if (checked.length > 0) currentWrapper.querySelector('.header-filter-icon').classList.add('active');
            else currentWrapper.querySelector('.header-filter-icon').classList.remove('active');
            
            closePopover();
            if (currentTable === 'transactions') { this.currentPage = 1; this.loadTransactions(); }
            else { this.runAutoMatcher(); }
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

        const pageSizeSelect = document.getElementById('page-size');
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', (e) => {
                this.pageSize = parseInt(e.target.value);
                this.currentPage = 1;
                this.loadTransactions();
            });
        }
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
                const search = document.getElementById('search-input').value;

                // Fetch all data in pages
                while (fetchMore) {
                    let query = supabase.from('transactions').select('*');
                    
                    if (dateFrom) query = query.gte('payment_date', dateFrom);
                    if (dateTo) query = query.lte('payment_date', dateTo);
                    
                    for (const [col, values] of Object.entries(this.headerFilters.transactions)) {
                        if (values && values.length > 0) {
                            if (col === 'id_status') {
                                const filters = [];
                                if (values.includes('Valid')) filters.push('id_status.eq.Valid');
                                if (values.includes('Missing ID')) filters.push('id_status.ilike.%Missing ID%');
                                if (values.includes('Error')) filters.push('id_status.ilike.%Error%');
                                if (filters.length > 0) query = query.or(filters.join(','));
                            } else {
                                query = query.in(col, values);
                            }
                        }
                    }
                    if (search) {
                        const safeSearch = sanitizeForFilter(search);
                        if (/^\d+$/.test(safeSearch)) {
                            query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
                        } else {
                            query = query.ilike('student_id', `%${safeSearch}%`);
                        }
                    }

                    const { data, error } = await query
                        .order('payment_date', { ascending: true })
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
                    Toast.show('No data to export.', 'warning');
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
                        "Mapping": t.mapping,
                        "Merchant Name": t.merchant_name,
                        "Bank": t.bank,
                        "Check Column": t.check_column,
                        "ID Status": t.id_status
                    };
                });

                const worksheet = XLSX.utils.json_to_sheet(formattedData, { cellDates: true });
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Fawry Query");
                
                // Trigger download
                XLSX.writeFile(workbook, `Fawry_Query_Export_${new Date().toISOString().split('T')[0]}.xlsx`);

            } catch (err) {
                Toast.show('Export failed: ' + err.message, 'error');
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

                if (allData.length === 0) return Toast.show('No mappings to export.', 'warning');

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
                Toast.show('Export failed: ' + err.message, 'error');
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

                if (allData.length === 0) return Toast.show('No fixes to export.', 'warning');

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
                Toast.show('Export failed: ' + err.message, 'error');
            }
        });
    }

    async loadTransactions() {
        const tbody = document.getElementById('transactions-body');
        tbody.innerHTML = Array(5).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(9) + '</tr>').join('');

        const dateFrom = document.getElementById('filter-date-from')?.value;
        const dateTo = document.getElementById('filter-date-to')?.value;
        const search = document.getElementById('search-input')?.value;

        let query = supabase.from('transactions').select('*', { count: 'exact' });

        if (dateFrom) query = query.gte('payment_date', dateFrom);
        if (dateTo) query = query.lte('payment_date', dateTo);
        for (const [col, values] of Object.entries(this.headerFilters.transactions)) {
            if (values && values.length > 0) {
                if (col === 'id_status') {
                    const filters = [];
                    if (values.includes('Valid')) filters.push('id_status.eq.Valid');
                    if (values.includes('Missing ID')) filters.push('id_status.ilike.%Missing ID%');
                    if (values.includes('Error')) filters.push('id_status.ilike.%Error%');
                    if (filters.length > 0) query = query.or(filters.join(','));
                } else {
                    query = query.in(col, values);
                }
            }
        }
        if (search) {
            const safeSearch = sanitizeForFilter(search);
            if (/^\d+$/.test(safeSearch)) {
                query = query.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
            } else {
                query = query.ilike('student_id', `%${safeSearch}%`);
            }
        }

        const fromRange = (this.currentPage - 1) * this.pageSize;
        const toRange = fromRange + this.pageSize - 1;

        const { data, count: totalCount, error } = await query
            .order('payment_date', { ascending: false })
            .range(fromRange, toRange);

        const totalPages = totalCount ? Math.ceil(totalCount / this.pageSize) : 1;

        // Update pagination UI
        document.getElementById('page-info').innerText = totalCount 
            ? `Page ${this.currentPage} of ${totalPages} (${totalCount.toLocaleString()} records)` 
            : `Page ${this.currentPage}`;
        document.getElementById('btn-prev').disabled = this.currentPage === 1;
        document.getElementById('btn-next').disabled = this.currentPage >= totalPages;

        if (error) {
            tbody.innerHTML = `<tr><td colspan="9" style="color: var(--danger);">${escapeHTML(error.message)}</td></tr>`;
            return;
        }

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><i data-lucide="inbox" style="width:48px;height:48px;opacity:0.5;"></i><h3>No transactions found</h3><p>Try adjusting your filters or go to Import CSV to add data.</p></div></td></tr>';
            if (window.lucide) lucide.createIcons();
            return;
        }

        tbody.innerHTML = data.map(t => {
            let statusClass = 'valid';
            if (t.id_status && t.id_status.includes('Missing')) statusClass = 'missing';
            if (t.id_status && t.id_status.includes('Error')) statusClass = 'error';

            const statusText = escapeHTML(t.id_status || '');
            const statusTitle = statusClass === 'error' ? ` title="${statusText}"` : '';
            const shortStatus = statusClass === 'error' ? 'Error' : statusText;

            return `
                <tr>
                    <td>${escapeHTML(t.reference_number)}</td>
                    <td>${escapeHTML(t.payment_date)}</td>
                    <td><strong>${escapeHTML(t.student_id)}</strong></td>
                    <td>EGP ${formatMoney(t.item_price)}</td>
                    <td style="white-space: normal; word-wrap: break-word; max-width: 250px;">${escapeHTML(t.item_name)}</td>
                    <td>${escapeHTML(t.mapping) || '-'}</td>
                    <td>${escapeHTML(t.bank)}</td>
                    <td><span class="badge ${statusClass}"${statusTitle}>${shortStatus}</span></td>
                </tr>
            `;
        }).join('');
    }

    async loadMappings() {
        const tbody = document.getElementById('mappings-body');
        tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(4) + '</tr>').join('');
        try {
            const allData = await fetchAll('item_mappings');

            if (allData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><i data-lucide="git-merge" style="width:48px;height:48px;opacity:0.5;"></i><h3>No mappings yet</h3><p>Click "Add Mapping" to create your first item mapping.</p></div></td></tr>';
                if (window.lucide) lucide.createIcons();
                return;
            }

            tbody.innerHTML = allData.map(m => `
                <tr>
                    <td>${escapeHTML(m.item_name)}</td>
                    <td>${escapeHTML(m.adjusted_item_name) || '-'}</td>
                    <td>${escapeHTML(m.mapping) || '-'}</td>
                    <td>
                        <button class="btn btn-outline btn-sm" data-edit-mapping="${escapeHTML(m.item_name)}">Edit</button>
                        <button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-mapping="${escapeHTML(m.item_name)}">Delete</button>
                    </td>
                </tr>
            `).join('');

            // Wire up Edit buttons
            tbody.querySelectorAll('[data-edit-mapping]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const itemName = btn.getAttribute('data-edit-mapping');
                    const mapping = allData.find(m => m.item_name === itemName);
                    if (mapping) {
                        document.getElementById('map-original').value = mapping.item_name || '';
                        document.getElementById('map-adjusted').value = mapping.adjusted_item_name || '';
                        document.getElementById('map-category').value = mapping.mapping || '';
                        document.getElementById('modal-mapping-title').innerText = 'Edit Mapping';
                        document.getElementById('modal-mapping').classList.remove('hidden');
                    }
                });
            });

            // Wire up Delete buttons
            tbody.querySelectorAll('[data-delete-mapping]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const itemName = btn.getAttribute('data-delete-mapping');
                    if (!confirm(`Delete mapping for "${itemName}"?`)) return;
                    const { error } = await supabase.from('item_mappings').delete().eq('item_name', itemName);
                    if (error) Toast.show('Error deleting mapping: ' + error.message, 'error');
                    else {
                        Toast.show('Mapping deleted', 'success');
                        this.loadMappings();
                    }
                });
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="4" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
        }
    }

    async loadFixes() {
        const tbody = document.getElementById('fixes-body');
        tbody.innerHTML = Array(3).fill('<tr class="skeleton-row">' + '<td><div class="skeleton-cell" style="width:80%"></div></td>'.repeat(5) + '</tr>').join('');
        try {
            const allData = await fetchAll('manual_fixes');

            if (allData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i data-lucide="wrench" style="width:48px;height:48px;opacity:0.5;"></i><h3>No manual fixes</h3><p>Click "Add Fix" to create a manual correction.</p></div></td></tr>';
                if (window.lucide) lucide.createIcons();
                return;
            }

            tbody.innerHTML = allData.map(f => `
                <tr>
                    <td>${escapeHTML(f.reference_number)}</td>
                    <td>${escapeHTML(f.correct_id) || '-'}</td>
                    <td>${escapeHTML(f.item_name) || '-'}</td>
                    <td>${escapeHTML(f.mapping) || '-'}</td>
                    <td>
                        <button class="btn btn-outline btn-sm" data-edit-fix="${escapeHTML(f.reference_number)}">Edit</button>
                        <button class="btn btn-outline btn-sm" style="color: var(--danger);" data-delete-fix="${escapeHTML(f.reference_number)}">Delete</button>
                    </td>
                </tr>
            `).join('');

            // Wire up Edit buttons
            tbody.querySelectorAll('[data-edit-fix]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const ref = btn.getAttribute('data-edit-fix');
                    const fix = allData.find(f => f.reference_number === ref);
                    if (fix) {
                        document.getElementById('fix-ref').value = fix.reference_number || '';
                        document.getElementById('fix-id').value = fix.correct_id || '';
                        document.getElementById('fix-name').value = fix.item_name || '';
                        document.getElementById('fix-mapping').value = fix.mapping || '';
                        document.getElementById('modal-fix-title').innerText = 'Edit Fix';
                        document.getElementById('modal-fix').classList.remove('hidden');
                    }
                });
            });

            // Wire up Delete buttons
            tbody.querySelectorAll('[data-delete-fix]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const ref = btn.getAttribute('data-delete-fix');
                    if (!confirm(`Delete fix for reference "${ref}"?`)) return;
                    const { error } = await supabase.from('manual_fixes').delete().eq('reference_number', ref);
                    if (error) Toast.show('Error deleting fix: ' + error.message, 'error');
                    else {
                        Toast.show('Fix deleted', 'success');
                        this.loadFixes();
                    }
                });
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger);">${escapeHTML(err.message)}</td></tr>`;
        }
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

        const tbodyGlobal = document.getElementById('students-table-body');
        if (tbodyGlobal) {
            tbodyGlobal.addEventListener('click', async (e) => {
                const target = e.target.closest('.copyable-email');
                if (target) {
                    const email = target.getAttribute('data-email');
                    if (email) {
                        try {
                            await navigator.clipboard.writeText(email);
                            Toast.show('Email copied to clipboard!', 'success');
                        } catch (err) {
                            Toast.show('Failed to copy email.', 'error');
                        }
                    }
                }
            });
        }

        const btnSearch = document.getElementById('btn-search-students');
        if (btnSearch) {
            btnSearch.addEventListener('click', async () => {
                const term = document.getElementById('student-search-input').value.trim();
                if (!term) return;
                
                try {
                    const { data, error } = await supabase
                        .from('student_master')
                        .select('*')
                        .or(`student_id.ilike.%${sanitizeForFilter(term)}%,full_name.ilike.%${sanitizeForFilter(term)}%,mobile.ilike.%${sanitizeForFilter(term)}%,email.ilike.%${sanitizeForFilter(term)}%`)
                        .limit(50);
                        
                    if (error) throw error;

                    const tbody = document.getElementById('students-table-body');
                    if (!data || data.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i data-lucide="users" style="width:48px;height:48px;opacity:0.5;"></i><h3>No students found</h3><p>Try a different search term.</p></div></td></tr>';
                        if (window.lucide) lucide.createIcons();
                        return;
                    }
                    tbody.innerHTML = data.map(s => `
                        <tr>
                            <td><strong>${escapeHTML(s.student_id)}</strong></td>
                            <td>${escapeHTML(s.full_name)}</td>
                            <td><span class="copyable-email" style="cursor: pointer; color: var(--primary); font-weight: 500;" data-email="${escapeHTML(s.email || '')}" title="Click to copy">${escapeHTML(s.email)}</span></td>
                            <td>${escapeHTML(s.mobile)}</td>
                            <td>${escapeHTML(s.college)}</td>
                            <td>${escapeHTML(s.program)}</td>
                        </tr>
                    `).join('');
                } catch(err) {
                    Toast.show('Search error: ' + err.message, 'error');
                }
            });
        }

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
                    this.handleStudentImport(e.dataTransfer.files[0]);
                }
            });
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    this.handleStudentImport(e.target.files[0]);
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
                    this.handleTargetedMatcherImport(e.target.files[0]);
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
                const csvData = this.automatchProposals.map(tx => ({
                    "Reference Number": tx.original_ref,
                    "Payment Date": tx.original_date,
                    "Bank": tx.original_bank,
                    "Item Name": tx.original_item,
                    "Amount": tx.original_amount,
                    "Current Status": tx.original_status,
                    "Proposed Fix (Student ID)": tx.proposedStudent ? tx.proposedStudent.student_id : 'No Match Found',
                    "Proposed Fix (Student Name)": tx.proposedStudent ? tx.proposedStudent.full_name : '',
                    "Match Reason": tx.matchReason
                }));
                const csv = Papa.unparse(csvData);
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement('a');
                const url = URL.createObjectURL(blob);
                link.href = url;
                link.download = `Auto_Matcher_Results.csv`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 100);
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
            btnApplyMatch.addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('.automatch-checkbox:checked');
                if (checkboxes.length === 0) {
                    Toast.show('Please select at least one proposed match to apply.', 'warning');
                    return;
                }
                document.getElementById('modal-automatch-confirm')?.classList.remove('hidden');
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
        
        // Setup revert buttons delegation
        const historyBody = document.getElementById('history-body');
        if (historyBody) {
            historyBody.addEventListener('click', async (e) => {
                const btn = e.target.closest('.btn-revert-batch');
                if (!btn) return;
                
                const batchId = btn.getAttribute('data-batch-id');
                const fileName = btn.getAttribute('data-file-name');
                const type = btn.getAttribute('data-type');
                
                if (type !== 'transactions') {
                    Toast.show('Only transaction batches can be reverted currently.', 'warning');
                    return;
                }

                if (!confirm(`Are you sure you want to revert the import for "${fileName}"? This will delete all its transactions.`)) return;
                
                btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Reverting...';
                btn.disabled = true;
                if (window.lucide) lucide.createIcons();

                try {
                    // Delete transactions
                    const { error: txError } = await supabase.from('transactions').delete().eq('file_name', fileName);
                    if (txError) throw txError;
                    
                    // Update batch status
                    const { error: batchError } = await supabase.from('import_batches').update({ status: 'reverted' }).eq('id', batchId);
                    if (batchError) throw batchError;
                    
                    Toast.show(`Successfully reverted ${fileName}`, 'success');
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
        if (window.lucide) lucide.createIcons();
        
        try {
            const { data, error } = await supabase.from('import_batches').select('*').order('created_at', { ascending: false }).limit(50);
            if (error) throw error;
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No import history found.</td></tr>';
                return;
            }
            
            tbody.innerHTML = data.map(b => {
                const date = new Date(b.created_at).toLocaleString();
                const type = b.details && b.details.type ? b.details.type : 'transactions';
                const canRevert = type === 'transactions' && b.status !== 'reverted' && b.status !== 'failed';
                
                let statusColor = 'var(--text-muted)';
                if (b.status === 'success') statusColor = 'var(--success)';
                else if (b.status === 'failed') statusColor = 'var(--danger)';
                else if (b.status === 'reverted') statusColor = 'var(--warning)';
                else if (b.status === 'partial') statusColor = '#eab308'; // yellow-500
                
                return `
                    <tr>
                        <td>${escapeHTML(b.file_name)} <span style="font-size: 0.75rem; color: var(--text-muted);">(${escapeHTML(type)})</span></td>
                        <td>${date}</td>
                        <td>${escapeHTML(b.user_email || 'System')}</td>
                        <td>${b.records_processed || 0}</td>
                        <td style="color: ${statusColor}; text-transform: capitalize;">${escapeHTML(b.status)}</td>
                        <td>
                            ${canRevert ? `<button class="btn btn-outline btn-revert-batch" data-batch-id="${b.id}" data-file-name="${escapeHTML(b.file_name)}" data-type="${escapeHTML(type)}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;"><i data-lucide="rotate-ccw" style="width: 14px; height: 14px;"></i> Revert</button>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');
            
            if (window.lucide) lucide.createIcons();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger); text-align: center;">Error loading history: ${escapeHTML(err.message)}</td></tr>`;
        }
    }
    
    async handleStudentImport(file) {
        const status = document.getElementById('student-upload-status');
        status.style.display = 'block';
        status.className = 'alert alert-info';
        status.innerHTML = `<i data-lucide="loader" class="spin"></i> Parsing Excel file...`;
        if (window.lucide) lucide.createIcons();

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
            
            const recordsMap = new Map();
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
                    recordsMap.set(student_id, {
                        student_id, full_name, arabic_name, national_id, email, mobile, guardian_name, guardian_mobile, college, program, source
                    });
                }
            }

            const records = Array.from(recordsMap.values());

            status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading ${records.length} records to database...`;
            
            let insertedCount = 0;
            for (let i = 0; i < records.length; i += 1000) {
                const batch = records.slice(i, i + 1000);
                const { error } = await supabase.from('student_master').upsert(batch);
                if (error) throw error;
                insertedCount += batch.length;
                status.innerHTML = `<i data-lucide="loader" class="spin"></i> Uploading... ${Math.round((i/records.length)*100)}%`;
            }

            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: file.name,
                    status: 'success',
                    records_processed: records.length,
                    records_inserted: insertedCount,
                    details: { type: 'student_master' }
                });
            }

            status.className = 'alert alert-success';
            status.innerHTML = `<i data-lucide="check-circle"></i> Successfully imported ${records.length} students!`;
            if (window.lucide) lucide.createIcons();

        } catch (err) {
            status.className = 'alert alert-danger';
            status.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${err.message}`;
            if (window.lucide) lucide.createIcons();
            console.error(err);
            if (this.currentUser) {
                await supabase.from('import_batches').insert({
                    user_email: this.currentUser.email,
                    file_name: file.name,
                    status: 'failed',
                    records_processed: 0,
                    records_inserted: 0,
                    details: { type: 'student_master', error: err.message }
                });
            }
        }
    }
    
    async handleTargetedMatcherImport(file) {
        const status = document.getElementById('automatcher-import-status');
        status.innerText = 'Parsing file...';
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet);
            
            const refs = [];
            for (const r of rows) {
                const ref = r['Ref Number'] || r['Reference Number'] || r['REF NUMBER'] || r['Reference_Number'];
                if (ref) refs.push(String(ref).trim());
            }
            if (refs.length === 0) throw new Error("No 'Reference Number' or 'Ref Number' column found in file.");
            
            this.targetedMatchRefs = refs;
            status.innerText = `Targeted ${refs.length} transactions! Filter applied. Click Run Auto-Match.`;
        } catch(err) {
            status.innerText = 'Error: ' + err.message;
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
            const dateFrom = document.getElementById('automatcher-date-from')?.value;
            const dateTo = document.getElementById('automatcher-date-to')?.value;
            const search = document.getElementById('automatcher-search')?.value;

            // First fetch the base invalidTx (with or without targeted filter)
            let queryFn = (q) => {
                q = q.neq('id_status', 'Valid');
                if (dateFrom) q = q.gte('payment_date', dateFrom);
                if (dateTo) q = q.lte('payment_date', dateTo);
                if (search) {
                    const safeSearch = sanitizeForFilter(search);
                    if (/^\d+$/.test(safeSearch)) {
                        q = q.or(`student_id.ilike.%${safeSearch}%,reference_number.eq.${safeSearch}`);
                    } else {
                        q = q.ilike('student_id', `%${safeSearch}%`);
                    }
                }
                if (this.targetedMatchRefs && this.targetedMatchRefs.length > 0 && this.targetedMatchRefs.length <= 500) {
                    q = q.in('reference_number', this.targetedMatchRefs);
                }
                return q;
            };

            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                console.warn("Large targeted filter, fetching all and filtering locally.");
            }

            let invalidTx = await fetchAll('transactions', '*', queryFn);
            this.invalidTx = invalidTx; // Store for header filter dropdowns
            
            // If the targeted match list was very large and bypassed the .in(), filter locally
            if (this.targetedMatchRefs && this.targetedMatchRefs.length > 500) {
                const targetSet = new Set(this.targetedMatchRefs);
                invalidTx = invalidTx.filter(t => targetSet.has(t.reference_number));
            }

            if (invalidTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center">No invalid IDs found matching criteria.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }
            
            // Generate distinct mappings and item names for the filters
            const distinctMappings = [...new Set(invalidTx.map(t => t.mapping).filter(Boolean))].sort();
            const distinctItems = [...new Set(invalidTx.map(t => t.item_name).filter(Boolean))].sort();
            
            // Store for header filters
            this.automatchDistinctMappings = distinctMappings;
            this.automatchDistinctItems = distinctItems;

            // Apply dynamic header filters for Auto-Matcher
            const activeFilters = this.headerFilters.automatch || {};
            for (const [col, values] of Object.entries(activeFilters)) {
                if (values && values.length > 0 && col !== 'proposed_fix') {
                    invalidTx = invalidTx.filter(t => values.includes(String(t[col])));
                }
            }
            
            let filteredTx = invalidTx;
            
            if (filteredTx.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center">No transactions match selected filters.</td></tr>';
                btnApply.style.display = 'none';
                return;
            }

            // Fetch Master List (Paginated to get all)
            let students = [];
            let fetchMoreStudents = true;
            let sFrom = 0;
            while(fetchMoreStudents) {
                const { data, error } = await supabase.from('student_master').select('*').range(sFrom, sFrom + 999);
                if (error) throw error;
                students = students.concat(data || []);
                if (!data || data.length < 1000) fetchMoreStudents = false;
                else sFrom += 1000;
            }
            
            // Fetch All Links (Paginated to get all)
            let links = [];
            let fetchMoreLinks = true;
            let lFrom = 0;
            while(fetchMoreLinks) {
                const { data, error } = await supabase.from('links').select('*').range(lFrom, lFrom + 999);
                if (error) throw error;
                links = links.concat(data || []);
                if (!data || data.length < 1000) fetchMoreLinks = false;
                else lFrom += 1000;
            }

            // Build lookups
            const linksMap = {};
            links.forEach(l => {
                linksMap[l.payment_reference_number] = l;
            });
            
            const studentMobileMap = new Map();
            const studentIdMap = new Map();
            const studentEmailMap = new Map();
            const studentNameMap = new Map();
            const studentNationalIdMap = new Map();
            students.forEach(s => {
                if (s.student_id) studentIdMap.set(String(s.student_id).trim(), s);
                if (s.email) studentEmailMap.set(String(s.email).toLowerCase().trim(), s);
                if (s.full_name) studentNameMap.set(String(s.full_name).toLowerCase().trim(), s);
                if (s.national_id) studentNationalIdMap.set(String(s.national_id).trim(), s);

                if (s.mobile) {
                    const clean = String(s.mobile).replace(/[^0-9]/g, '');
                    if (clean.length >= 10) studentMobileMap.set(clean.slice(-10), s);
                }
                if (s.guardian_mobile) {
                    const clean = String(s.guardian_mobile).replace(/[^0-9]/g, '');
                    if (clean.length >= 10) studentMobileMap.set(clean.slice(-10), s);
                }
            });

            this.automatchProposals = [];
            let html = '';
            
            const formatMoney = (num) => parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            let loopCount = 0;
            for (const tx of filteredTx) {
                loopCount++;
                if (loopCount % 25 === 0) {
                    btn.innerHTML = `<i data-lucide="loader" class="spin"></i> Matching... ${loopCount}/${filteredTx.length}`;
                    await new Promise(r => setTimeout(r, 0)); // Yield to browser to prevent freezing
                }

                const link = linksMap[tx.reference_number];
                let proposedStudent = null;
                let matchReason = '';

                // Try 1: ID
                if (link && link.custom_input_value) {
                    proposedStudent = studentIdMap.get(String(link.custom_input_value).trim());
                    if (proposedStudent) matchReason = 'Found exact ID in Link Info';
                }

                // Try 2: Mail
                if (!proposedStudent && link && link.customer_email) {
                    proposedStudent = studentEmailMap.get(String(link.customer_email).toLowerCase().trim());
                    if (proposedStudent) matchReason = 'Email matched via Link Info';
                }

                // Try 3: National ID
                if (!proposedStudent && link && link.customer_national_id) {
                    proposedStudent = studentNationalIdMap.get(String(link.customer_national_id).trim());
                    if (proposedStudent) matchReason = 'National ID matched via Link Info';
                }

                // Try 4: Phone (Link & Transaction)
                if (!proposedStudent && link && link.customer_mobile) {
                    const cleanMobile = String(link.customer_mobile).replace(/[^0-9]/g, '');
                    if (cleanMobile.length >= 10) proposedStudent = studentMobileMap.get(cleanMobile.slice(-10));
                    if (proposedStudent) matchReason = 'Phone number matched via Link Info';
                }
                if (!proposedStudent && tx.customer_mobile) {
                    const cleanMobile = String(tx.customer_mobile).replace(/[^0-9]/g, '');
                    if (cleanMobile.length >= 10) proposedStudent = studentMobileMap.get(cleanMobile.slice(-10));
                    if (proposedStudent) matchReason = 'Phone number matched via Transaction data';
                }

                // Try 5: Name (Link & Transaction)
                const enableNameMatch = document.getElementById('automatch-enable-name')?.checked;
                if (enableNameMatch) {
                    if (!proposedStudent && link && link.customer_name) {
                        proposedStudent = studentNameMap.get(String(link.customer_name).toLowerCase().trim());
                        if (proposedStudent) matchReason = 'Exact Name matched via Link Info';
                    }
                    if (!proposedStudent && tx.student_id) {
                        const searchStr = String(tx.student_id).trim().toLowerCase();
                        if (/[a-zA-Z]/.test(searchStr) && searchStr.length > 3) {
                            proposedStudent = studentNameMap.get(searchStr);
                            if (proposedStudent) matchReason = 'Exact Name matched via Transaction data';
                        }
                    }
                }
                
                // Track for export
                const proposalTx = {
                    tx_id: tx.id,
                    proposedStudent: proposedStudent,
                    matchReason: matchReason,
                    original_ref: tx.reference_number,
                    original_date: tx.payment_date,
                    original_bank: tx.bank,
                    original_mapping: tx.mapping,
                    original_item: tx.item_name,
                    original_amount: tx.item_price,
                    original_status: tx.id_status
                };

                this.automatchProposals.push(proposalTx);
            }

            // Sort matched proposals on top
            this.automatchProposals.sort((a, b) => {
                if (a.proposedStudent && !b.proposedStudent) return -1;
                if (!a.proposedStudent && b.proposedStudent) return 1;
                return 0;
            });

            // Generate HTML
            const pfFilter = activeFilters['proposed_fix'];
            for (const proposal of this.automatchProposals) {
                const pfStatus = proposal.proposedStudent ? 'Has Proposed Match' : 'No Match Found';
                const shouldRender = !pfFilter || pfFilter.length === 0 || pfFilter.includes(pfStatus);
                
                if (!shouldRender) continue;

                if (proposal.proposedStudent) {
                    const isNameMatch = proposal.matchReason.includes('Name');
                    html += `
                        <tr>
                            <td><input type="checkbox" class="automatch-checkbox" value="${proposal.tx_id}"></td>
                            <td>${escapeHTML(proposal.original_ref)}</td>
                            <td>${escapeHTML(proposal.original_date)}</td>
                            <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                            <td>${escapeHTML(proposal.original_item)}</td>
                            <td>${formatMoney(proposal.original_amount)}</td>
                            <td>
                                <span class="status-badge ${isNameMatch ? 'invalid-id' : 'valid-id'}" title="${escapeHTML(proposal.matchReason)}" ${isNameMatch ? 'style="background: rgba(234, 179, 8, 0.15); color: #eab308; border-color: rgba(234, 179, 8, 0.3);"' : ''}>
                                    Matched: ${escapeHTML(proposal.proposedStudent.student_id)} ${isNameMatch ? ' (By Name)' : ''}
                                </span>
                                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(proposal.proposedStudent.full_name)}</div>
                            </td>
                            <td style="white-space: normal; word-wrap: break-word; max-width: 200px;"><span style="font-size:0.85rem; color:var(--text-muted)">${proposal.matchReason}</span></td>
                        </tr>
                    `;
                } else {
                    html += `
                        <tr>
                            <td></td>
                            <td>${escapeHTML(proposal.original_ref)}</td>
                            <td>${escapeHTML(proposal.original_date)}</td>
                            <td>${escapeHTML(proposal.original_mapping || '-')}</td>
                            <td>${escapeHTML(proposal.original_item)}</td>
                            <td>${formatMoney(proposal.original_amount)}</td>
                            <td><span class="status-badge invalid-id">No Match Found</span></td>
                            <td><span style="color:var(--text-muted)">-</span></td>
                        </tr>
                    `;
                }
            }

            tbody.innerHTML = html || '<tr><td colspan="8" class="text-center">No fixable transactions found.</td></tr>';
            btnApply.style.display = this.automatchProposals.filter(p => p.proposedStudent).length > 0 ? 'inline-block' : 'none';
            
            const selectAllMatcher = document.getElementById('automatcher-select-all');
            if (selectAllMatcher) selectAllMatcher.checked = false;

        } catch (err) {
            Toast.show('Matcher Error: ' + err.message, 'error');
        } finally {
            btn.innerHTML = `<i data-lucide="zap"></i> Run Auto-Match`;
            btn.disabled = false;
            lucide.createIcons();
        }
    }

    async applyAutoMatches() {
        const checkboxes = document.querySelectorAll('.automatch-checkbox:checked');
        if (checkboxes.length === 0) {
            Toast.show('Please select at least one proposed match to apply.', 'warning');
            return;
        }

        const btn = document.getElementById('btn-confirm-automatch');
        if (btn) {
            btn.innerText = 'Applying...';
            btn.disabled = true;
        }
        const originalBtn = document.getElementById('btn-apply-automatch-fixes');
        if (originalBtn) {
            originalBtn.disabled = true;
        }

        try {
            const fp = new FawryProcessor(this.currentUser?.email || 'System');
            const appliedRefs = [];
            const manualFixesToInsert = [];

            const updateGroups = {};

            for (const cb of checkboxes) {
                const tx_id = parseInt(cb.value);
                const proposal = this.automatchProposals.find(p => p.tx_id === tx_id);
                if (proposal) {
                    const sid = proposal.proposedStudent.student_id;
                    if (!updateGroups[sid]) updateGroups[sid] = [];
                    updateGroups[sid].push(tx_id);
                    
                    manualFixesToInsert.push({
                        reference_number: proposal.original_ref,
                        correct_id: sid
                    });

                    appliedRefs.push(proposal.original_ref);
                }
            }

            // Execute batched updates
            for (const [sid, txIds] of Object.entries(updateGroups)) {
                // Batch up to 500 ids per request to avoid huge URLs
                for (let i = 0; i < txIds.length; i += 500) {
                    const chunk = txIds.slice(i, i + 500);
                    await supabase
                        .from('transactions')
                        .update({ 
                            student_id: sid,
                            id_status: validateID(sid)
                        })
                        .in('id', chunk);
                }
            }

            // Insert into manual_fixes
            if (manualFixesToInsert.length > 0) {
                await supabase.from('manual_fixes').upsert(manualFixesToInsert, { onConflict: 'reference_number', ignoreDuplicates: false });
            }

            // Audit Log
            if (this.currentUser && appliedRefs.length > 0) {
                await supabase.from('audit_logs').insert({
                    user_email: this.currentUser.email,
                    action: 'Applied Auto-Matches',
                    affected_references: appliedRefs.join(', '),
                    details: { count: appliedRefs.length }
                });
            }

            Toast.show(`Successfully applied ${checkboxes.length} fixes!`, 'success');
            this.runAutoMatcher();
            this.loadDashboard();
            this.loadTransactions();
        } catch (err) {
            Toast.show('Error applying fixes: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.innerText = 'Yes, Apply';
                btn.disabled = false;
            }
            if (originalBtn) {
                originalBtn.disabled = false;
            }
            document.getElementById('modal-automatch-confirm')?.classList.add('hidden');
        }
    }


    // ==========================================
    // Payment Links Catalog
    // ==========================================
    initPaymentLinks() {
        this.paymentLinksPage = 1;
        this.paymentLinksSearch = '';
        
        document.querySelectorAll('.nav-item').forEach(item => {
            if (item.getAttribute('data-target') === 'payment-links') {
                item.addEventListener('click', () => {
                    this.loadPaymentLinks();
                });
            }
        });
        
        document.getElementById('links-search')?.addEventListener('input', (e) => {
            this.paymentLinksSearch = e.target.value.toLowerCase();
            this.paymentLinksPage = 1;
            this.loadPaymentLinks();
        });

        document.getElementById('btn-add-link')?.addEventListener('click', () => {
            document.getElementById('modal-link-title').textContent = 'Add Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = '';
            document.getElementById('link-amount').value = '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = '';
            document.getElementById('link-expiry').value = '';
            document.getElementById('link-url').value = '';
            document.getElementById('modal-link').classList.remove('hidden');
        });

        document.getElementById('btn-save-link')?.addEventListener('click', async () => {
            const id = document.getElementById('link-id').value;
            const linkData = {
                name: document.getElementById('link-name').value,
                amount: parseFloat(document.getElementById('link-amount').value) || null,
                invoice_number: document.getElementById('link-invoice').value || null,
                creation_date: document.getElementById('link-created').value || null,
                expiry_date: document.getElementById('link-expiry').value ? new Date(document.getElementById('link-expiry').value).toISOString() : null,
                invoice_link: document.getElementById('link-url').value
            };
            
            if (!linkData.name || !linkData.invoice_link) {
                Toast.show("Name and Link URL are required", "error");
                return;
            }

            try {
                if (id) {
                    const { error } = await supabase.from('payment_links').update(linkData).eq('id', id);
                    if (error) throw error;
                    Toast.show("Link updated", "success");
                } else {
                    const { error } = await supabase.from('payment_links').insert(linkData);
                    if (error) throw error;
                    Toast.show("Link added", "success");
                }
                document.getElementById('modal-link').classList.add('hidden');
                this.loadPaymentLinks();
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
            // Set column widths for readability
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
            XLSX.writeFile(wb, "Payment_Links_Import_Template.xlsx");
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
                    
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                        const firstSheetName = workbook.SheetNames[0];
                        const worksheet = workbook.Sheets[firstSheetName];
                        const json = XLSX.utils.sheet_to_json(worksheet);
                        
                        // Helper: convert Excel date (serial number or Date object or string) to ISO string
                        const parseDate = (val) => {
                            if (!val) return null;
                            if (val instanceof Date) return val.toISOString().split('T')[0];
                            if (typeof val === 'number') {
                                // Excel serial date: days since 1899-12-30
                                const excelEpoch = new Date(1899, 11, 30);
                                const d = new Date(excelEpoch.getTime() + val * 86400000);
                                return d.toISOString().split('T')[0];
                            }
                            return String(val);
                        };
                        const parseDateTime = (val) => {
                            if (!val) return null;
                            if (val instanceof Date) return val.toISOString();
                            if (typeof val === 'number') {
                                const excelEpoch = new Date(1899, 11, 30);
                                const d = new Date(excelEpoch.getTime() + val * 86400000);
                                return d.toISOString();
                            }
                            return new Date(val).toISOString();
                        };

                        const upsertData = json.map(row => ({
                            name: row['Name'] || row['Item Name'] || row['name'] || 'Unknown',
                            amount: row['Amount'] || row['amount'] || null,
                            invoice_number: row['Invoice Number'] || row['invoice_number'] || null,
                            creation_date: parseDate(row['Creation Date'] || row['creation_date']),
                            expiry_date: parseDateTime(row['Expiry Date'] || row['expiry_date']),
                            invoice_link: row['Invoice Link'] || row['Payment Link'] || row['invoice_link'] || row['PAYMENT LINK'] || null
                        })).filter(r => r.invoice_link);
                        
                        if (upsertData.length === 0) {
                            Toast.show("No valid links found in file.", "error");
                            return;
                        }

                        let imported = 0;
                        for (let i = 0; i < upsertData.length; i += 1000) {
                            const chunk = upsertData.slice(i, i + 1000);
                            const { error } = await supabase.from('payment_links').upsert(chunk, { onConflict: 'invoice_number' });
                            if (error) {
                                const { error: insertErr } = await supabase.from('payment_links').insert(chunk);
                                if (insertErr) throw insertErr;
                            }
                            imported += chunk.length;
                        }
                        
                        Toast.show(`Imported ${imported} links successfully`, "success");
                        this.loadPaymentLinks();
                    };
                    reader.readAsArrayBuffer(file);
                } catch (err) {
                    Toast.show("Error importing: " + err.message, "error");
                }
            };
            input.click();
        });

        // Export Links
        document.getElementById('btn-export-links')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                let allData = [];
                let fetchMore = true;
                let from = 0;
                while (fetchMore) {
                    const { data, error } = await supabase.from('payment_links').select('*').range(from, from + 999);
                    if (error) throw error;
                    if (!data || data.length === 0) break;
                    allData = allData.concat(data);
                    if (data.length < 1000) fetchMore = false;
                    else from += 1000;
                }
                
                const ws = XLSX.utils.json_to_sheet(allData);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Payment Links");
                XLSX.writeFile(wb, "Payment_Links_Export.xlsx");
                Toast.show("Export complete", "success");
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
            }
        });
        
        // Setup pagination
        document.getElementById('btn-links-prev')?.addEventListener('click', () => {
            if (this.paymentLinksPage > 1) {
                this.paymentLinksPage--;
                this.loadPaymentLinks();
            }
        });
        document.getElementById('btn-links-next')?.addEventListener('click', () => {
            this.paymentLinksPage++;
            this.loadPaymentLinks();
        });
    }

    async loadPaymentLinks() {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;
        
        tbody.innerHTML = '<tr><td colspan="7" class="loading-state"><i data-lucide="loader" class="spin"></i> Loading links...</td></tr>';
        if (window.lucide) lucide.createIcons();

        try {
            let query = supabase.from('payment_links').select('*', { count: 'exact' });
            
            if (this.paymentLinksSearch) {
                query = query.or(`name.ilike.%${this.paymentLinksSearch}%,invoice_number.ilike.%${this.paymentLinksSearch}%`);
            }
            
            const from = (this.paymentLinksPage - 1) * this.pageSize;
            const to = from + this.pageSize - 1;
            
            // Order by the actual creation date from the link, not the database insert time
            const { data, count, error } = await query.order('creation_date', { ascending: false, nullsFirst: false }).range(from, to);
            
            if (error) throw error;
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No payment links found</td></tr>';
                document.getElementById('btn-links-prev').disabled = true;
                document.getElementById('btn-links-next').disabled = true;
                document.getElementById('links-page-info').textContent = 'Page 1 of 1';
                return;
            }
            
            // Sort data: expired at the bottom, otherwise keep DB sort
            const now = new Date();
            data.sort((a, b) => {
                const isAExpired = a.expiry_date && new Date(a.expiry_date) < now;
                const isBExpired = b.expiry_date && new Date(b.expiry_date) < now;
                
                if (isAExpired && !isBExpired) return 1;
                if (!isAExpired && isBExpired) return -1;
                
                // If both have same expiration status, ensure they stay sorted by creation_date DESC
                const dateA = a.creation_date ? new Date(a.creation_date).getTime() : 0;
                const dateB = b.creation_date ? new Date(b.creation_date).getTime() : 0;
                return dateB - dateA;
            });

            tbody.innerHTML = '';
            
            data.forEach(link => {
                const isExpired = link.expiry_date && new Date(link.expiry_date) < now;
                const dateBadge = isExpired ? `<span class="badge error">${new Date(link.expiry_date).toLocaleDateString()}</span>` 
                                          : (link.expiry_date ? new Date(link.expiry_date).toLocaleDateString() : '-');
                                          
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><div class="truncate-text" title="${link.name || ''}">${link.name || '-'}</div></td>
                    <td><span class="amount">${link.amount ? link.amount + ' EGP' : '-'}</span></td>
                    <td><span class="badge badge-gray">${link.invoice_number || '-'}</span></td>
                    <td>${link.creation_date ? new Date(link.creation_date).toLocaleDateString() : '-'}</td>
                    <td>${dateBadge}</td>
                    <td>
                        <div style="display: flex; gap: 0.5rem; align-items: center;">
                            <button class="btn btn-outline copy-link-btn" data-url="${link.invoice_link}" ${isExpired ? 'disabled title="Link Expired"' : ''}>Copy</button>
                            <button class="btn btn-outline edit-link-btn" data-id="${link.id}">Edit</button>
                            <button class="btn btn-outline delete-link-btn" style="color: var(--danger);" data-id="${link.id}">Delete</button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            
            tbody.querySelectorAll('.copy-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const url = e.currentTarget.getAttribute('data-url');
                    navigator.clipboard.writeText(url).then(() => {
                        Toast.show("Link copied to clipboard!", "success");
                    });
                });
            });
            
            tbody.querySelectorAll('.edit-link-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const id = e.currentTarget.getAttribute('data-id');
                    const link = data.find(l => l.id === id);
                    if (link) {
                        document.getElementById('modal-link-title').textContent = 'Edit Payment Link';
                        document.getElementById('link-id').value = link.id;
                        document.getElementById('link-name').value = link.name || '';
                        document.getElementById('link-amount').value = link.amount || '';
                        document.getElementById('link-invoice').value = link.invoice_number || '';
                        document.getElementById('link-created').value = link.creation_date ? link.creation_date.split('T')[0] : '';
                        
                        let expiryStr = '';
                        if (link.expiry_date) {
                            const d = new Date(link.expiry_date);
                            const tzoffset = (new Date()).getTimezoneOffset() * 60000;
                            const localISOTime = (new Date(d - tzoffset)).toISOString().slice(0, 16);
                            expiryStr = localISOTime;
                        }
                        document.getElementById('link-expiry').value = expiryStr;
                        document.getElementById('link-url').value = link.invoice_link || '';
                        document.getElementById('modal-link').classList.remove('hidden');
                    }
                });
            });
            
            tbody.querySelectorAll('.delete-link-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    if (confirm("Are you sure you want to delete this link?")) {
                        const id = e.currentTarget.getAttribute('data-id');
                        const { error } = await supabase.from('payment_links').delete().eq('id', id);
                        if (error) {
                            Toast.show("Error deleting link: " + error.message, "error");
                        } else {
                            Toast.show("Link deleted", "success");
                            this.loadPaymentLinks();
                        }
                    }
                });
            });

            const totalPages = Math.ceil(count / this.pageSize) || 1;
            document.getElementById('links-page-info').textContent = `Page ${this.paymentLinksPage} of ${totalPages}`;
            document.getElementById('btn-links-prev').disabled = this.paymentLinksPage === 1;
            document.getElementById('btn-links-next').disabled = this.paymentLinksPage === totalPages;

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state text-danger">Error: ${err.message}</td></tr>`;
        }
        
        if (window.lucide) lucide.createIcons();
    }

}

// Start app
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});


