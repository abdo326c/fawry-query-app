import { supabase } from './supabase.js';
import {
    fetchAll,
    fetchByIn,
    escapeHTML,
    sanitizeExcelRows,
    toDateOnly,
    writeCompressedExcel
} from './rules.js';
import { renderIcons, formatMoney, Toast } from './app-utils.js';

class PaymentLinksUiMixin {
    // ==========================================
    // Payment Links Catalog
    // ==========================================
    initPaymentLinks() {
        this.paymentLinksPage = 1;
        this.paymentLinksSearch = '';
        this.paymentLinksStatusFilter = 'all';
        this.paymentLinksSort = 'created_desc';
        this.allPaymentLinks = null;
        this.filteredPaymentLinks = [];

        let linksSearchTimeout;
        const searchInput = document.getElementById('links-search');
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(linksSearchTimeout);
            linksSearchTimeout = setTimeout(() => {
                this.paymentLinksSearch = e.target.value.trim().toLowerCase();
                this.paymentLinksPage = 1;
                this.loadPaymentLinks();
            }, 220);
        });

        const sortSelect = document.getElementById('links-sort');
        sortSelect?.addEventListener('change', (e) => {
            this.paymentLinksSort = e.target.value || 'created_desc';
            this.paymentLinksPage = 1;
            this.loadPaymentLinks();
        });

        document.querySelectorAll('[data-link-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-link-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.paymentLinksStatusFilter = btn.getAttribute('data-link-filter') || 'all';
                this.paymentLinksPage = 1;
                this.loadPaymentLinks();
            });
        });

        document.getElementById('btn-clear-links-filters')?.addEventListener('click', () => {
            this.paymentLinksSearch = '';
            this.paymentLinksStatusFilter = 'all';
            this.paymentLinksSort = 'created_desc';
            this.paymentLinksPage = 1;
            if (searchInput) searchInput.value = '';
            if (sortSelect) sortSelect.value = 'created_desc';
            document.querySelectorAll('[data-link-filter]').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-link-filter') === 'all');
            });
            this.loadPaymentLinks();
        });

        document.getElementById('btn-add-link')?.addEventListener('click', () => {
            this.openPaymentLinkModal();
        });

        // Quick Expiry Date Presets (+7d, +14d, +30d)
        document.querySelectorAll('.link-expiry-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const days = parseInt(btn.getAttribute('data-days'), 10) || 7;
                const d = new Date();
                d.setDate(d.getDate() + days);
                d.setHours(23, 59, 0, 0);
                const tzoffset = d.getTimezoneOffset() * 60000;
                const localISOTime = new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
                const expInput = document.getElementById('link-expiry');
                if (expInput) expInput.value = localISOTime;
            });
        });

        // Auto-extract Invoice Number from URL when pasted & check duplicate invoice
        const urlInput = document.getElementById('link-url');
        const invInput = document.getElementById('link-invoice');
        const checkDuplicateInvoice = () => {
            const warnEl = document.getElementById('link-duplicate-warning');
            if (!warnEl || !invInput) return;
            const invVal = invInput.value.trim();
            const currentId = document.getElementById('link-id')?.value || '';
            if (!invVal) {
                warnEl.style.display = 'none';
                return;
            }
            const dup = (this.allPaymentLinks || []).find(l =>
                String(l.invoice_number || '').trim().toLowerCase() === invVal.toLowerCase() &&
                String(l.id) !== String(currentId)
            );
            if (dup) {
                warnEl.style.display = 'block';
                warnEl.innerHTML = `Invoice <strong>${escapeHTML(dup.invoice_number)}</strong> already exists (${escapeHTML(dup.name || 'Unnamed')}). <u>Click here to edit existing link instead</u>.`;
                warnEl.onclick = () => {
                    this.openPaymentLinkModal(dup, false);
                };
            } else {
                warnEl.style.display = 'none';
            }
        };

        invInput?.addEventListener('input', checkDuplicateInvoice);
        urlInput?.addEventListener('input', () => {
            const url = (urlInput.value || '').trim();
            if (url && invInput && !invInput.value.trim()) {
                const match = url.match(/\/(?:pay|invoice)\/([A-Za-z0-9_-]+)\/?$/i) || url.match(/\/([A-Za-z0-9_-]{4,24})\/?$/);
                if (match && match[1] && !['pay', 'invoice', 'atfawry'].includes(match[1].toLowerCase())) {
                    invInput.value = match[1];
                    checkDuplicateInvoice();
                }
            }
        });

        document.getElementById('btn-save-link')?.addEventListener('click', async () => {
            const saveBtn = document.getElementById('btn-save-link');
            // Double-click / Ctrl+Enter repeat guard: a second click while saving would insert a duplicate.
            if (this._savingPaymentLink || saveBtn?.disabled) return;
            const id = document.getElementById('link-id').value;
            const linkData = {
                name: document.getElementById('link-name').value.trim(),
                amount: parseFloat(document.getElementById('link-amount').value) || null,
                invoice_number: document.getElementById('link-invoice').value.trim() || null,
                creation_date: document.getElementById('link-created').value || null,
                expiry_date: document.getElementById('link-expiry').value ? new Date(document.getElementById('link-expiry').value).toISOString() : null,
                invoice_link: document.getElementById('link-url').value.trim()
            };
            
            if (!linkData.name || !linkData.invoice_link) {
                Toast.show("Item Name and Payment Link URL are required", "error");
                return;
            }

            this._savingPaymentLink = true;
            const originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Saving...';
                if (window.lucide) window.lucide.createIcons({ root: saveBtn });
            }
            try {
                if (id) {
                    const existing = (this.allPaymentLinks || []).find(l => String(l.id) === String(id));
                    const { error } = await supabase.from('payment_links').update(linkData).eq('id', id);
                    if (error) throw error;
                    await this.logAudit('UPDATE', 'payment_links', linkData.invoice_number || id, existing || null, linkData);
                    Toast.show("Link updated", "success");
                } else {
                    const { error } = await supabase.from('payment_links').insert(linkData);
                    if (error) throw error;
                    await this.logAudit('CREATE', 'payment_links', linkData.invoice_number || linkData.name, null, linkData);
                    Toast.show("Link added", "success");
                }
                document.getElementById('modal-link').classList.add('hidden');
                this.loadPaymentLinks({ forceReload: true });
            } catch (err) {
                Toast.show("Error: " + err.message, "error");
            } finally {
                this._savingPaymentLink = false;
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = originalBtnHtml;
                    if (window.lucide) window.lucide.createIcons({ root: saveBtn });
                }
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
            writeCompressedExcel(wb, "Payment_Links_Import_Template.xlsx");
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

                    const buffer = await file.arrayBuffer();
                    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
                    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                    const json = XLSX.utils.sheet_to_json(worksheet);

                    const parseDate = (val) => {
                        if (!val) return null;
                        if (val instanceof Date) { const d = new Date(val.getTime() - val.getTimezoneOffset() * 60000); return d.toISOString().split('T')[0]; }
                        if (typeof val === 'number') {
                            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                            const d = new Date(excelEpoch.getTime() + val * 86400000);
                            return d.toISOString().split('T')[0];
                        }
                        return String(val).trim() || null;
                    };
                    const parseDateTime = (val) => {
                        if (!val) return null;
                        if (val instanceof Date) return val.toISOString();
                        if (typeof val === 'number') {
                            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                            const d = new Date(excelEpoch.getTime() + val * 86400000);
                            return d.toISOString();
                        }
                        const d = new Date(val);
                        if (isNaN(d.getTime())) throw new Error(`Invalid Expiry Date: "${val}"`);
                        return d.toISOString();
                    };
                    const clean = v => (v === null || v === undefined) ? null : (String(v).trim() || null);

                    const rows = json.map(row => ({
                        name: clean(row['Name'] || row['Item Name'] || row['name']) || 'Unknown',
                        amount: parseFloat(String(row['Amount'] ?? row['amount'] ?? '').replace(/[^\d.-]/g, '')) || null,
                        invoice_number: clean(row['Invoice Number'] ?? row['invoice_number']),
                        creation_date: parseDate(row['Creation Date'] || row['creation_date']),
                        expiry_date: parseDateTime(row['Expiry Date'] || row['expiry_date']),
                        invoice_link: clean(row['Invoice Link'] || row['Payment Link'] || row['invoice_link'] || row['PAYMENT LINK'])
                    })).filter(r => r.invoice_link);

                    if (rows.length === 0) {
                        Toast.show("No valid links found in file.", "error");
                        return;
                    }

                    const withInvoice = Array.from(new Map(rows.filter(r => r.invoice_number).map(r => [r.invoice_number, r])).values());
                    const withoutInvoice = rows.filter(r => !r.invoice_number);

                    let imported = 0;
                    for (let i = 0; i < withInvoice.length; i += 1000) {
                        const chunk = withInvoice.slice(i, i + 1000);
                        const { error } = await supabase.from('payment_links').upsert(chunk, { onConflict: 'invoice_number' });
                        if (error) {
                            const existing = await fetchByIn('payment_links', 'id, invoice_number', 'invoice_number', chunk.map(r => r.invoice_number), 'id');
                            const existingByInvoice = new Map(existing.map(r => [String(r.invoice_number), r.id]));
                            const toInsert = chunk.filter(r => !existingByInvoice.has(String(r.invoice_number)));
                            for (const r of chunk.filter(r => existingByInvoice.has(String(r.invoice_number)))) {
                                const { error: upErr } = await supabase.from('payment_links').update(r).eq('invoice_number', r.invoice_number);
                                if (upErr) throw new Error(`Saved ${imported} links, then failed: ${upErr.message}`);
                                imported++;
                            }
                            if (toInsert.length > 0) {
                                const { error: insErr } = await supabase.from('payment_links').insert(toInsert);
                                if (insErr) throw new Error(`Saved ${imported} links, then failed: ${insErr.message}`);
                                imported += toInsert.length;
                            }
                        } else {
                            imported += chunk.length;
                        }
                    }
                    for (let i = 0; i < withoutInvoice.length; i += 1000) {
                        const chunk = withoutInvoice.slice(i, i + 1000);
                        const { error } = await supabase.from('payment_links').insert(chunk);
                        if (error) throw new Error(`Saved ${imported} links, then failed: ${error.message}`);
                        imported += chunk.length;
                    }

                    await this.recordBatch(file.name, 'payment_links', withInvoice.length + withoutInvoice.length, imported, null);

                    Toast.show(`Imported ${imported} links successfully`, "success");
                    this.loadPaymentLinks({ forceReload: true });
                } catch (err) {
                    Toast.show("Error importing: " + err.message, "error");
                    await this.recordBatch(file.name, 'payment_links', 0, 0, err.message);
                }
            };
            input.click();
        });

        // Export Links
        document.getElementById('btn-export-links')?.addEventListener('click', async () => {
            try {
                Toast.show("Preparing export...", "info");
                const source = (this.filteredPaymentLinks && this.filteredPaymentLinks.length > 0)
                    ? this.filteredPaymentLinks
                    : await fetchAll('payment_links', '*', null, 'id');

                const now = new Date();
                const exportRows = (source || []).map(l => {
                    const statusInfo = this.getPaymentLinkStatus(l, now);
                    return {
                        'Item Name': l.name || '',
                        'Amount (EGP)': l.amount ? Number(parseFloat(l.amount).toFixed(2)) : '',
                        'Invoice Number': l.invoice_number || '',
                        'Status': statusInfo.label,
                        'Creation Date': toDateOnly(l.creation_date) || '',
                        'Expiry Date': toDateOnly(l.expiry_date) || '',
                        'Payment Link': l.invoice_link || ''
                    };
                });

                const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(exportRows));
                ws['!cols'] = [
                    { wch: 42 }, { wch: 15 }, { wch: 18 },
                    { wch: 16 }, { wch: 15 }, { wch: 15 }, { wch: 55 }
                ];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Payment Links");
                writeCompressedExcel(wb, `Payment_Links_Export_${toDateOnly(new Date())}.xlsx`);
                Toast.show(`Exported ${exportRows.length.toLocaleString('en-US')} links`, "success");
            } catch (err) {
                Toast.show("Error exporting: " + err.message, "error");
            }
        });
        
        // Setup pagination
        document.getElementById('btn-links-prev')?.addEventListener('click', () => {
            if (this.paymentLinksPage > 1) {
                this.paymentLinksPage--;
                this.renderPaymentLinksPage();
            }
        });
        document.getElementById('btn-links-next')?.addEventListener('click', () => {
            this.paymentLinksPage++;
            this.renderPaymentLinksPage();
        });
        this.pageJump.bind('links', () => this.paymentLinksTotalPages || 1, (target) => {
            this.paymentLinksPage = target;
            this.renderPaymentLinksPage();
        });
    }

    openPaymentLinkModal(link = null, isDuplicate = false) {
        const modal = document.getElementById('modal-link');
        if (!modal) return;
        const warnEl = document.getElementById('link-duplicate-warning');
        if (warnEl) warnEl.style.display = 'none';

        const todayStr = new Date().toISOString().slice(0, 10);

        if (link && !isDuplicate) {
            document.getElementById('modal-link-title').textContent = 'Edit Payment Link';
            document.getElementById('link-id').value = link.id;
            document.getElementById('link-name').value = link.name || '';
            document.getElementById('link-amount').value = link.amount || '';
            document.getElementById('link-invoice').value = link.invoice_number || '';
            document.getElementById('link-created').value = toDateOnly(link.creation_date) || '';
            let expiryStr = '';
            if (link.expiry_date) {
                const d = new Date(link.expiry_date);
                if (!isNaN(d.getTime())) {
                    const tzoffset = (new Date()).getTimezoneOffset() * 60000;
                    expiryStr = (new Date(d - tzoffset)).toISOString().slice(0, 16);
                }
            }
            document.getElementById('link-expiry').value = expiryStr;
            document.getElementById('link-url').value = link.invoice_link || '';
        } else if (link && isDuplicate) {
            document.getElementById('modal-link-title').textContent = 'Renew / Duplicate Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = link.name || '';
            document.getElementById('link-amount').value = link.amount || '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = todayStr;
            const d = new Date();
            d.setDate(d.getDate() + 14);
            d.setHours(23, 59, 0, 0);
            const tzoffset = d.getTimezoneOffset() * 60000;
            document.getElementById('link-expiry').value = new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
            document.getElementById('link-url').value = '';
        } else {
            document.getElementById('modal-link-title').textContent = 'Add Payment Link';
            document.getElementById('link-id').value = '';
            document.getElementById('link-name').value = '';
            document.getElementById('link-amount').value = '';
            document.getElementById('link-invoice').value = '';
            document.getElementById('link-created').value = todayStr;
            document.getElementById('link-expiry').value = '';
            document.getElementById('link-url').value = '';
        }

        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    }

    getPaymentLinkStatus(link, now = new Date()) {
        if (!link.expiry_date) {
            return { key: 'active', label: 'Active (No Expiry)', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
        }
        const exp = new Date(link.expiry_date);
        if (isNaN(exp.getTime())) {
            return { key: 'active', label: 'Active', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
        }
        const diffMs = exp.getTime() - now.getTime();
        if (diffMs < 0) {
            return { key: 'expired', label: 'Expired', badgeClass: 'badge-danger', isExpired: true, isExpiringSoon: false };
        }
        const daysLeft = Math.ceil(diffMs / 86400000);
        if (daysLeft <= 7) {
            return { key: 'expiring', label: `Expiring (${daysLeft}d)`, badgeClass: 'badge-warning', isExpired: false, isExpiringSoon: true };
        }
        return { key: 'active', label: 'Active', badgeClass: 'badge-success', isExpired: false, isExpiringSoon: false };
    }

    updatePaymentLinksStats() {
        const list = this.allPaymentLinks || [];
        const now = new Date();
        let activeCount = 0;
        let expiringCount = 0;
        let expiredCount = 0;
        let activeValue = 0;

        list.forEach(l => {
            const st = this.getPaymentLinkStatus(l, now);
            const amt = parseFloat(l.amount || 0) || 0;
            if (st.isExpired) {
                expiredCount++;
            } else {
                activeCount++;
                activeValue += amt;
                if (st.isExpiringSoon) expiringCount++;
            }
        });

        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setEl('links-stat-total', list.length.toLocaleString('en-US'));
        setEl('links-stat-active', activeCount.toLocaleString('en-US'));
        setEl('links-stat-expiring', expiringCount.toLocaleString('en-US'));
        setEl('links-stat-expired', expiredCount.toLocaleString('en-US'));
        setEl('links-stat-value', `EGP ${formatMoney(activeValue)}`);
    }

    async loadPaymentLinks({ forceReload = false } = {}) {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;
        
        try {
            if (!this.allPaymentLinks || forceReload) {
                tbody.innerHTML = '<tr><td colspan="6" class="loading-state"><i data-lucide="loader" class="spin"></i> Loading links...</td></tr>';
                renderIcons(tbody);
                const all = await fetchAll('payment_links', '*', null, 'id');
                this.allPaymentLinks = all || [];
                this.updatePaymentLinksStats();
            }
            this.markTabLoaded('payment-links');

            const now = new Date();
            const search = (this.paymentLinksSearch || '').trim().toLowerCase();
            const searchNum = search.replace(/,/g, '');
            const statusFilter = this.paymentLinksStatusFilter || 'all';
            const sortMode = this.paymentLinksSort || 'created_desc';

            const clearBtn = document.getElementById('btn-clear-links-filters');
            if (clearBtn) {
                if (search || statusFilter !== 'all' || sortMode !== 'created_desc') {
                    clearBtn.classList.remove('hidden');
                } else {
                    clearBtn.classList.add('hidden');
                }
            }

            const filtered = (this.allPaymentLinks || []).filter(link => {
                const st = this.getPaymentLinkStatus(link, now);
                if (statusFilter === 'active' && st.isExpired) return false;
                if (statusFilter === 'expiring' && !st.isExpiringSoon) return false;
                if (statusFilter === 'expired' && !st.isExpired) return false;
                if (statusFilter === 'missing_invoice' && link.invoice_number && String(link.invoice_number).trim()) return false;

                if (search) {
                    const name = String(link.name || '').toLowerCase();
                    const inv = String(link.invoice_number || '').toLowerCase();
                    const url = String(link.invoice_link || '').toLowerCase();
                    const amtStr = link.amount != null ? String(link.amount) : '';
                    const match = name.includes(search) || inv.includes(search) || url.includes(search) || (searchNum && amtStr.includes(searchNum));
                    if (!match) return false;
                }
                return true;
            });

            filtered.sort((a, b) => {
                if (sortMode === 'created_desc' || sortMode === 'created_asc') {
                    const da = toDateOnly(a.creation_date) || '';
                    const db = toDateOnly(b.creation_date) || '';
                    if (da !== db) {
                        if (!da) return 1;
                        if (!db) return -1;
                        return sortMode === 'created_desc' ? db.localeCompare(da) : da.localeCompare(db);
                    }
                    return (b.id || 0) - (a.id || 0);
                }
                if (sortMode === 'expiry_asc' || sortMode === 'expiry_desc') {
                    const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
                    const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
                    return sortMode === 'expiry_asc' ? ea - eb : eb - ea;
                }
                if (sortMode === 'amount_desc' || sortMode === 'amount_asc') {
                    const aa = parseFloat(a.amount || 0) || 0;
                    const ab = parseFloat(b.amount || 0) || 0;
                    return sortMode === 'amount_desc' ? ab - aa : aa - ab;
                }
                if (sortMode === 'name_asc') {
                    return String(a.name || '').localeCompare(String(b.name || ''));
                }
                return 0;
            });

            this.filteredPaymentLinks = filtered;
            this.renderPaymentLinksPage();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">Error: ${escapeHTML(err.message)}</td></tr>`;
        }
    }

    renderPaymentLinksPage() {
        const tbody = document.getElementById('links-table-body');
        if (!tbody) return;

        const btnPrev = document.getElementById('btn-links-prev');
        const btnNext = document.getElementById('btn-links-next');
        const pageInfo = document.getElementById('links-page-info');

        const total = (this.filteredPaymentLinks || []).length;
        const pageSize = this.pageSize || 50;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (this.paymentLinksPage > totalPages) this.paymentLinksPage = totalPages;
        if (this.paymentLinksPage < 1) this.paymentLinksPage = 1;

        if (total === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            <i data-lucide="link" style="width: 42px; height: 42px; opacity: 0.5;"></i>
                            <h3>No payment links found</h3>
                            <p>Try adjusting your search or status filter, or add a new payment link.</p>
                        </div>
                    </td>
                </tr>`;
            if (btnPrev) btnPrev.disabled = true;
            if (btnNext) btnNext.disabled = true;
            if (pageInfo) pageInfo.textContent = '0 links';
            if (window.lucide) lucide.createIcons();
            return;
        }

        const startIdx = (this.paymentLinksPage - 1) * pageSize;
        const data = this.filteredPaymentLinks.slice(startIdx, startIdx + pageSize);
        const now = new Date();

        tbody.innerHTML = data.map(link => {
            const st = this.getPaymentLinkStatus(link, now);
            const expDateStr = toDateOnly(link.expiry_date);
            let statusBadgeStyle = 'background: rgba(16, 185, 129, 0.14); color: #10b981;';
            if (st.isExpired) statusBadgeStyle = 'background: rgba(239, 68, 68, 0.15); color: var(--danger);';
            else if (st.isExpiringSoon) statusBadgeStyle = 'background: rgba(245, 158, 11, 0.16); color: #f59e0b;';

            return `
                <tr>
                    <td>
                        <div class="truncate-text" style="font-weight: 500;" title="${escapeHTML(link.name || '')}">${escapeHTML(link.name) || '-'}</div>
                    </td>
                    <td style="white-space: nowrap;">
                        <span class="amount" style="font-weight: 600;">${link.amount ? escapeHTML(formatMoney(link.amount)) + ' EGP' : '-'}</span>
                    </td>
                    <td style="white-space: nowrap;">
                        <div style="display: inline-flex; gap: 0.35rem; align-items: center;">
                            <span class="badge badge-gray" style="font-family: monospace;">${escapeHTML(link.invoice_number || '-')}</span>
                            ${link.invoice_number ? `<button type="button" class="action-icon-btn copy-invoice-btn" data-invoice="${escapeHTML(link.invoice_number)}" title="Copy Invoice Number" aria-label="Copy Invoice Number"><i data-lucide="copy"></i></button>` : ''}
                        </div>
                    </td>
                    <td style="white-space: nowrap;">${link.creation_date ? escapeHTML(toDateOnly(link.creation_date)) : '-'}</td>
                    <td style="white-space: nowrap;">
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                            <span>${expDateStr ? escapeHTML(expDateStr) : '-'}</span>
                            <span class="badge" style="font-size: 0.72rem; padding: 0.15rem 0.55rem; ${statusBadgeStyle}">${escapeHTML(st.label)}</span>
                        </div>
                    </td>
                    <td style="text-align: right; white-space: nowrap;">
                        <div style="display: inline-flex; gap: 0.35rem; align-items: center;">
                            <button type="button" class="btn btn-outline btn-sm copy-link-btn" data-url="${escapeHTML(link.invoice_link || '')}" ${st.isExpired ? 'disabled title="Link Expired"' : 'title="Copy Payment Link URL"'} style="padding: 0.25rem 0.6rem; font-size: 0.76rem;">
                                <i data-lucide="copy" style="width: 13px; height: 13px;"></i> Copy Link
                            </button>
                            ${link.invoice_link ? `<a href="${escapeHTML(link.invoice_link)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" title="Open Payment Link in New Tab" style="padding: 0.25rem 0.45rem; font-size: 0.76rem; text-decoration: none;"><i data-lucide="external-link" style="width: 13px; height: 13px;"></i></a>` : ''}
                            ${this.hasRole('operator') ? `
                            <button type="button" class="btn btn-outline btn-sm edit-link-btn" data-id="${escapeHTML(link.id)}" title="Edit Link" style="padding: 0.25rem 0.45rem; font-size: 0.76rem;">
                                <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
                            </button>` : ''}
                            ${this.hasRole('admin') ? `
                            <button type="button" class="btn btn-outline btn-sm delete-link-btn" style="color: var(--danger); padding: 0.25rem 0.45rem; font-size: 0.76rem;" data-id="${escapeHTML(link.id)}" title="Delete Link">
                                <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
                            </button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.copy-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const url = e.currentTarget.dataset.url;
                if (!url) return;
                navigator.clipboard.writeText(url).then(() => {
                    Toast.show("Link copied to clipboard!", "success");
                });
            });
        });

        tbody.querySelectorAll('.copy-invoice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const invoice = e.currentTarget.dataset.invoice;
                navigator.clipboard.writeText(invoice).then(() => {
                    Toast.show("Invoice number copied!", "success");
                });
            });
        });

        tbody.querySelectorAll('.edit-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const link = data.find(l => String(l.id) === String(id));
                if (link) this.openPaymentLinkModal(link, false);
            });
        });

        tbody.querySelectorAll('.delete-link-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const existing = (this.allPaymentLinks || []).find(l => String(l.id) === String(id));
                if (await window.customConfirm("Are you sure you want to delete this payment link?", 'Delete', 'Cancel')) {
                    const { error } = await supabase.from('payment_links').delete().eq('id', id);
                    if (error) {
                        Toast.show("Error deleting link: " + error.message, "error");
                    } else {
                        await this.logAudit('DELETE', 'payment_links', existing?.invoice_number || id, existing || { id }, null);
                        Toast.show("Link deleted", "success");
                        this.loadPaymentLinks({ forceReload: true });
                    }
                }
            });
        });

        this.paymentLinksTotalPages = totalPages;
        if (pageInfo) {
            pageInfo.innerHTML = `Showing <strong>${(startIdx + 1).toLocaleString('en-US')}</strong>–<strong>${Math.min(startIdx + pageSize, total).toLocaleString('en-US')}</strong> of <strong>${total.toLocaleString('en-US')}</strong> links (Page ${this.paymentLinksPage} of ${totalPages})`;
        }
        if (btnPrev) btnPrev.disabled = this.paymentLinksPage <= 1;
        if (btnNext) btnNext.disabled = this.paymentLinksPage >= totalPages;
        const linksJumpInput = document.getElementById('links-jump-page');
        if (linksJumpInput) linksJumpInput.max = String(totalPages);

        renderIcons(document.getElementById('view-payment-links'));
    }

}

export function applyPaymentLinksUiMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(PaymentLinksUiMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(PaymentLinksUiMixin.prototype, name));
        }
    }
}
