import { supabase } from './supabase.js';
import {
    fetchAll,
    escapeHTML,
    sanitizeExcelRows,
    toDateOnly,
    toPeriodMonth,
    isDateInClosedPeriods,
    formatPeriodMonthLabel,
    writeCompressedExcel
} from './rules.js';
import { renderIcons, formatMoney, formatDateTime, Toast } from './app-utils.js';

class AdminAuditMixin {
    initUsersAndRoles() {
        this.allUserRoles = [];
        this.allAuditLogs = [];
        this.activeAdminSubtab = 'access';
        this.adminShowAllSections = false;
        this.auditCategoryFilter = 'all';

        this.initAdminSubtabs();

        const btnSaveRole = document.getElementById('btn-save-user-role');
        if (btnSaveRole) {
            btnSaveRole.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'assign user roles')) return;
                const emailInput = document.getElementById('role-user-email');
                const passwordInput = document.getElementById('role-user-password');
                const roleSelect = document.getElementById('role-user-select');
                const email = String(emailInput?.value || '').trim().toLowerCase();
                const password = String(passwordInput?.value || '');
                const role = String(roleSelect?.value || 'viewer').trim().toLowerCase();

                if (!email || !email.includes('@')) {
                    Toast.show('Please enter a valid user email address.', 'warning');
                    return;
                }
                if (email === 'ammahmoud@nu.edu.eg' && role !== 'admin') {
                    Toast.show('Primary Admin (Ammahmoud@nu.edu.eg) must retain the Admin role.', 'warning');
                    if (roleSelect) roleSelect.value = 'admin';
                    return;
                }
                if (password && password.length < 8) {
                    Toast.show('Password must be at least 8 characters.', 'warning');
                    passwordInput?.focus();
                    return;
                }

                btnSaveRole.disabled = true;
                try {
                    if (password) {
                        const { error } = await supabase.auth.adminCreateUser({ email, password, role });
                        if (error) throw error;
                        if (passwordInput) passwordInput.value = '';
                        await this.logAudit('User Account / Password Updated', email, { target_email: email, assigned_role: role });
                        Toast.show(`Saved ${role.toUpperCase()} role & password for ${email}`, 'success');
                    } else {
                        const { error } = await supabase.from('user_roles').upsert({
                            email,
                            role,
                            updated_by: this.currentUser?.email || 'Admin',
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'email' });
                        if (error) throw error;

                        await this.logAudit('User Role Assigned', email, { target_email: email, assigned_role: role });
                        Toast.show(`Assigned ${role.toUpperCase()} role to ${email}`, 'success');
                    }
                    if (emailInput) emailInput.value = '';
                    if (this.currentUser && String(this.currentUser.email).toLowerCase() === email) {
                        this.userRole = role;
                        this.applyRolePermissionsToUI();
                    }
                    await this.loadUsersAndRoles();
                } catch (err) {
                    Toast.show('Error saving role: ' + err.message, 'error');
                } finally {
                    btnSaveRole.disabled = false;
                }
            });
        }

        const btnRefresh = document.getElementById('btn-refresh-users-roles');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', () => this.loadUsersAndRoles());
        }

        const btnSyncUsers = document.getElementById('btn-sync-auth-users');
        if (btnSyncUsers) {
            btnSyncUsers.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'sync user accounts')) return;
                const origHtml = btnSyncUsers.innerHTML;
                btnSyncUsers.innerHTML = '<i data-lucide="loader" class="spin"></i> Syncing...';
                btnSyncUsers.disabled = true;
                if (window.lucide) lucide.createIcons();

                try {
                    const { data, error } = await supabase.rpc('sync_auth_users');
                    if (error) throw error;
                    const inserted = data?.inserted || 0;
                    const total = data?.total || (this.allUserRoles?.length || 0);
                    Toast.show(inserted > 0
                        ? `Synced ${inserted} new user(s) from User Directory (Total: ${total}).`
                        : `All registered accounts are already in the directory (Total: ${total}).`, 'success');
                    await this.loadUsersAndRoles({ skipSync: true });
                } catch (err) {
                    Toast.show('Sync error: ' + err.message, 'warning');
                } finally {
                    btnSyncUsers.innerHTML = origHtml;
                    btnSyncUsers.disabled = false;
                    if (window.lucide) lucide.createIcons();
                }
            });
        }

        const searchAudit = document.getElementById('audit-log-search');
        if (searchAudit) {
            let auditSearchTimer;
            searchAudit.addEventListener('input', () => {
                clearTimeout(auditSearchTimer);
                auditSearchTimer = setTimeout(() => this.renderAuditLogsTable(), 200);
            });
        }

        this.initAccountingPeriodLock();
        this.initColdStorageArchive();

        document.getElementById('btn-refresh-db-storage')?.addEventListener('click', () => {
            this.loadDatabaseStorageStats({ silent: false });
        });
    }

    initAdminSubtabs() {
        const subtabBtns = Array.from(document.querySelectorAll('[data-admin-subtab]'));
        const jumpCards = Array.from(document.querySelectorAll('[data-admin-jump]'));
        const btnShowAll = document.getElementById('btn-admin-show-all');
        const auditCatBtns = Array.from(document.querySelectorAll('[data-audit-category]'));

        const setShowAllUi = (showAll) => {
            this.adminShowAllSections = Boolean(showAll);
            if (!btnShowAll) return;
            btnShowAll.classList.toggle('active', this.adminShowAllSections);
            btnShowAll.innerHTML = this.adminShowAllSections
                ? '<i data-lucide="layers"></i> Tabbed View'
                : '<i data-lucide="layout-list"></i> Show All Sections';
            renderIcons(btnShowAll);
        };

        subtabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-admin-subtab') || 'access';
                if (this.adminShowAllSections) setShowAllUi(false);
                this.switchAdminSubtab(target);
            });
        });

        jumpCards.forEach(card => {
            const activate = () => {
                const target = card.getAttribute('data-admin-jump') || 'access';
                if (this.adminShowAllSections) setShowAllUi(false);
                this.switchAdminSubtab(target);
            };
            card.addEventListener('click', activate);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate();
                }
            });
        });

        if (btnShowAll) {
            btnShowAll.addEventListener('click', () => {
                const next = !this.adminShowAllSections;
                setShowAllUi(next);
                if (next) {
                    ['access', 'governance', 'storage', 'audit'].forEach(id => {
                        document.getElementById(`admin-panel-${id}`)?.classList.remove('hidden');
                    });
                } else {
                    this.switchAdminSubtab(this.activeAdminSubtab || 'access');
                }
            });
        }

        auditCatBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.getAttribute('data-audit-category') || 'all';
                this.auditCategoryFilter = cat;
                auditCatBtns.forEach(b => b.classList.toggle('active', b === btn));
                this.renderAuditLogsTable();
            });
        });

        this.switchAdminSubtab(this.activeAdminSubtab || 'access');
    }

    switchAdminSubtab(subtabId = 'access') {
        const validIds = ['access', 'governance', 'storage', 'audit'];
        const target = validIds.includes(subtabId) ? subtabId : 'access';
        this.activeAdminSubtab = target;

        validIds.forEach(id => {
            const panel = document.getElementById(`admin-panel-${id}`);
            if (panel) panel.classList.toggle('hidden', id !== target);
        });

        document.querySelectorAll('[data-admin-subtab]').forEach(btn => {
            const isMatch = btn.getAttribute('data-admin-subtab') === target;
            btn.classList.toggle('active', isMatch);
            btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
        });

        document.querySelectorAll('[data-admin-jump]').forEach(card => {
            const isMatch = card.getAttribute('data-admin-jump') === target;
            card.classList.toggle('active', isMatch);
        });
    }

    async loadDatabaseStorageStats({ silent = false } = {}) {
        const usedEl = document.getElementById('db-storage-used-label');
        const pctBadge = document.getElementById('db-storage-pct-badge');
        const headroomEl = document.getElementById('db-storage-headroom-label');
        const barEl = document.getElementById('db-storage-progress-bar');
        const tablesEl = document.getElementById('db-storage-tables-list');
        if (!usedEl) return null;

        try {
            if (typeof supabase.rpc !== 'function') throw new Error('RPC unavailable');
            const { data, error } = await supabase.rpc('get_database_storage_stats');
            if (error) throw error;
            if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.used_mb !== 'number') {
                throw new Error('Migration 2.11.6 not applied yet');
            }

            const usedMb = Number(data.used_mb || 0);
            const limitMb = Number(data.limit_mb || 500);
            const pct = Number(data.pct_used ?? Math.round((usedMb / Math.max(1, limitMb)) * 1000) / 10);
            const estRemaining = Math.max(0, Math.floor(((limitMb - usedMb) * 1024) / 1.6));

            usedEl.textContent = `${usedMb.toFixed(1)} MB / ${limitMb} MB`;
            const kpiStorageUsed = document.getElementById('admin-kpi-storage-used');
            const kpiStorageSub = document.getElementById('admin-kpi-storage-sub');
            if (kpiStorageUsed) kpiStorageUsed.textContent = `${usedMb.toFixed(1)} / ${limitMb} MB`;
            if (kpiStorageSub) kpiStorageSub.textContent = `${pct.toFixed(1)}% used · ~${estRemaining.toLocaleString()} tx headroom`;

            if (pctBadge) {
                pctBadge.textContent = `${pct.toFixed(1)}%`;
                if (pct >= 85) {
                    pctBadge.style.background = 'rgba(239, 68, 68, 0.16)';
                    pctBadge.style.color = 'var(--danger)';
                } else if (pct >= 65) {
                    pctBadge.style.background = 'rgba(245, 158, 11, 0.16)';
                    pctBadge.style.color = 'var(--warning, #f59e0b)';
                } else {
                    pctBadge.style.background = 'rgba(16, 185, 129, 0.16)';
                    pctBadge.style.color = 'var(--success, #10b981)';
                }
            }
            if (headroomEl) {
                headroomEl.textContent = `(~${estRemaining.toLocaleString()} more transactions fit before ${limitMb} MB cap)`;
            }
            if (barEl) {
                barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
                barEl.style.background = pct >= 85 ? 'var(--danger)' : (pct >= 65 ? 'var(--warning, #f59e0b)' : 'var(--primary)');
            }
            if (tablesEl) {
                const tables = Array.isArray(data.tables) ? data.tables : [];
                tablesEl.innerHTML = tables.map(t => (
                    `<span class="badge" style="background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-color); font-size: 0.74rem; padding: 0.28rem 0.55rem;">` +
                    `<span><strong>${escapeHTML(t.table_name)}</strong></span>` +
                    `<span style="color: var(--text-muted);">${Number(t.total_mb || 0).toFixed(1)} MB (${Number(t.est_rows || 0).toLocaleString()})</span>` +
                    `</span>`
                )).join('');
            }
            return data;
        } catch (err) {
            if (!silent && tablesEl) {
                usedEl.textContent = '-- MB / 500 MB';
                if (pctBadge) pctBadge.textContent = '--%';
                if (headroomEl) headroomEl.textContent = '';
                if (barEl) barEl.style.width = '0%';
                const kpiStorageUsed = document.getElementById('admin-kpi-storage-used');
                const kpiStorageSub = document.getElementById('admin-kpi-storage-sub');
                if (kpiStorageUsed) kpiStorageUsed.textContent = '-- / 500 MB';
                if (kpiStorageSub) kpiStorageSub.textContent = 'Run migration 2.11.6';
                tablesEl.innerHTML = `<span style="color: var(--text-muted);">Storage stats unavailable (${escapeHTML(err.message)}). Run migration <code>2.11.6_multiuser_performance_and_storage_meter.sql</code> in Supabase SQL Editor.</span>`;
            }
            return null;
        }
    }

    isDateInClosedPeriod(dateInput) {
        return isDateInClosedPeriods(dateInput, this.closedPeriodSet);
    }

    async loadClosedPeriods({ silent = true } = {}) {
        const tbody = document.getElementById('closed-periods-table-body');
        try {
            const { data, error } = await supabase
                .from('closed_periods')
                .select('*')
                .order('period_month', { ascending: false })
                .limit(500);
            if (error) throw error;

            const rows = Array.isArray(data) ? data : [];
            this.closedPeriods = rows;
            this.closedPeriodSet = new Set(rows.filter(r => r.is_closed).map(r => r.period_month));
            this.closedPeriodsError = null;
            this.renderClosedPeriodsCard();
            return rows;
        } catch (err) {
            this.closedPeriods = [];
            this.closedPeriodSet = new Set();
            this.closedPeriodsError = err.message;
            if (!silent && tbody) {
                tbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger); text-align: center; padding: 1rem;">Could not load closed_periods (${escapeHTML(err.message)}). Run migration <code>2.11.4_accounting_period_lock.sql</code> in Supabase SQL Editor.</td></tr>`;
            }
            return [];
        }
    }

    initAccountingPeriodLock() {
        const monthInput = document.getElementById('period-lock-month');
        const notesInput = document.getElementById('period-lock-notes');
        const btnClose = document.getElementById('btn-close-period');
        const statusEl = document.getElementById('period-lock-status');
        const unlockPanel = document.getElementById('period-unlock-panel');
        const unlockTargetLabel = document.getElementById('period-unlock-target-label');
        const unlockReasonInput = document.getElementById('period-unlock-reason');
        const btnConfirmUnlock = document.getElementById('btn-confirm-period-unlock');
        const btnCancelUnlock = document.getElementById('btn-cancel-period-unlock');
        const tbody = document.getElementById('closed-periods-table-body');

        if (!monthInput || !btnClose) return;

        if (!monthInput.value) {
            const d = new Date();
            d.setDate(1);
            d.setMonth(d.getMonth() - 1);
            monthInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }

        this._pendingUnlockMonth = null;

        const hideUnlockPanel = () => {
            this._pendingUnlockMonth = null;
            if (unlockPanel) unlockPanel.classList.add('hidden');
            if (unlockReasonInput) unlockReasonInput.value = '';
            if (unlockTargetLabel) unlockTargetLabel.textContent = '';
        };

        const togglePeriod = async (periodMonth, isClosed, notes) => {
            const cleanMonth = toPeriodMonth(periodMonth);
            if (!cleanMonth) {
                Toast.show('Select a valid YYYY-MM accounting month.', 'warning');
                return;
            }
            const cleanNotes = String(notes || '').trim();
            if (!isClosed && !cleanNotes) {
                Toast.show('An audit reason is required to unlock a closed accounting period.', 'warning');
                unlockReasonInput?.focus();
                return;
            }
            const { error } = await supabase.rpc('set_accounting_period_lock', {
                p_period_month: cleanMonth,
                p_is_closed: isClosed,
                p_notes: cleanNotes || null
            });
            if (error) throw error;

            this.invalidateTabs('erp-export', 'transactions', 'fixes', 'users');
            if (statusEl) {
                const actionWord = isClosed ? 'Closed' : 'Unlocked';
                statusEl.innerHTML = `<span style="color: ${isClosed ? 'var(--success)' : 'var(--warning, #f59e0b)'}; font-weight: 600;">✓ ${actionWord} ${escapeHTML(formatPeriodMonthLabel(cleanMonth))} (${escapeHTML(cleanMonth)})</span>.`;
            }
            Toast.show(
                isClosed
                    ? `Accounting period ${cleanMonth} is now CLOSED.`
                    : `Accounting period ${cleanMonth} unlocked (${cleanNotes}).`,
                'success'
            );
            await this.loadUsersAndRoles({ skipSync: true });
        };

        btnClose.addEventListener('click', async () => {
            if (!this.requireRole('admin', 'close an accounting period')) return;
            const month = toPeriodMonth(monthInput.value);
            if (!month) {
                Toast.show('Select a valid accounting month (YYYY-MM).', 'warning');
                return;
            }
            const notes = String(notesInput?.value || '').trim();
            const ok = await window.customConfirm(
                `Close accounting period ${formatPeriodMonthLabel(month)} (${month})? Once closed, nobody can backdate imports, edit manual fixes, or unlink ERP batches in this month without an audited Admin unlock.`,
                'Close Period',
                'Cancel'
            );
            if (!ok) return;

            const origHtml = btnClose.innerHTML;
            btnClose.disabled = true;
            btnClose.innerHTML = '<i data-lucide="loader" class="spin"></i> Closing...';
            renderIcons(btnClose);
            try {
                await togglePeriod(month, true, notes);
                if (notesInput) notesInput.value = '';
                hideUnlockPanel();
            } catch (err) {
                Toast.show('Failed to close accounting period: ' + err.message, 'error');
            } finally {
                btnClose.innerHTML = origHtml;
                btnClose.disabled = false;
                renderIcons(btnClose);
            }
        });

        btnCancelUnlock?.addEventListener('click', () => hideUnlockPanel());

        btnConfirmUnlock?.addEventListener('click', async () => {
            if (!this.requireRole('admin', 'unlock a closed accounting period')) return;
            const targetMonth = this._pendingUnlockMonth;
            const reason = String(unlockReasonInput?.value || '').trim();
            if (!targetMonth) return;
            if (!reason) {
                Toast.show('Enter an audit reason before unlocking a closed period.', 'warning');
                unlockReasonInput?.focus();
                return;
            }

            btnConfirmUnlock.disabled = true;
            try {
                await togglePeriod(targetMonth, false, reason);
                hideUnlockPanel();
            } catch (err) {
                Toast.show('Failed to unlock accounting period: ' + err.message, 'error');
            } finally {
                btnConfirmUnlock.disabled = false;
            }
        });

        if (tbody && !tbody.dataset.periodLockBound) {
            tbody.dataset.periodLockBound = '1';
            tbody.addEventListener('click', async (e) => {
                const btn = e.target.closest('.btn-toggle-period-lock');
                if (!btn) return;
                if (!this.requireRole('admin', 'manage accounting period locks')) return;

                const periodMonth = btn.getAttribute('data-month');
                const action = btn.getAttribute('data-action');
                if (!periodMonth) return;

                if (action === 'unlock') {
                    this._pendingUnlockMonth = periodMonth;
                    if (unlockTargetLabel) {
                        unlockTargetLabel.textContent = `${formatPeriodMonthLabel(periodMonth)} (${periodMonth})`;
                    }
                    if (unlockReasonInput) unlockReasonInput.value = '';
                    unlockPanel?.classList.remove('hidden');
                    unlockReasonInput?.focus();
                } else if (action === 'lock') {
                    const ok = await window.customConfirm(
                        `Re-close accounting period ${formatPeriodMonthLabel(periodMonth)} (${periodMonth})?`,
                        'Close Period',
                        'Cancel'
                    );
                    if (!ok) return;
                    btn.disabled = true;
                    try {
                        await togglePeriod(periodMonth, true, 'Re-closed by Admin');
                        hideUnlockPanel();
                    } catch (err) {
                        Toast.show('Failed to close accounting period: ' + err.message, 'error');
                    } finally {
                        btn.disabled = false;
                    }
                }
            });
        }
    }

    renderClosedPeriodsCard() {
        const tbody = document.getElementById('closed-periods-table-body');
        const rows = this.closedPeriods || [];
        const closedRows = rows
            .filter(r => r.is_closed !== false)
            .sort((a, b) => String(b.period_month || '').localeCompare(String(a.period_month || '')));
        const kpiLocked = document.getElementById('admin-kpi-locked-periods');
        const kpiLatest = document.getElementById('admin-kpi-latest-period');
        if (kpiLocked) kpiLocked.textContent = `${closedRows.length} Locked`;
        if (kpiLatest) {
            kpiLatest.textContent = closedRows.length > 0
                ? `Latest: ${formatPeriodMonthLabel(closedRows[0].period_month)}`
                : 'No closed periods yet';
        }
        if (!tbody) return;
        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 1rem; color: var(--text-muted);">No accounting periods closed yet. Select a month above to enforce month-end close.</td></tr>';
            return;
        }

        tbody.innerHTML = rows.map(r => {
            const month = String(r.period_month || '');
            const closed = r.is_closed !== false;
            const badge = closed
                ? '<span class="badge" style="background: rgba(239, 68, 68, 0.14); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3);">Locked</span>'
                : '<span class="badge" style="background: rgba(245, 158, 11, 0.14); color: var(--warning, #f59e0b); border: 1px solid rgba(245, 158, 11, 0.3);">Reopened</span>';
            const actor = closed ? (r.closed_by || 'Admin') : (r.reopened_by || r.closed_by || 'Admin');
            const ts = closed ? r.closed_at : (r.reopened_at || r.updated_at || r.closed_at);
            const tsStr = formatDateTime(ts, '—');
            const btnHtml = closed
                ? `<button type="button" class="btn btn-outline btn-sm btn-toggle-period-lock" data-action="unlock" data-month="${escapeHTML(month)}" style="padding: 0.25rem 0.6rem; font-size: 0.76rem; color: var(--warning, #f59e0b); border-color: rgba(245, 158, 11, 0.4);">Audited Unlock</button>`
                : `<button type="button" class="btn btn-outline btn-sm btn-toggle-period-lock" data-action="lock" data-month="${escapeHTML(month)}" style="padding: 0.25rem 0.6rem; font-size: 0.76rem;">Re-Lock</button>`;

            return `
                <tr>
                    <td><strong>${escapeHTML(formatPeriodMonthLabel(month))}</strong> <span class="text-muted" style="font-family: monospace; font-size: 0.78rem;">(${escapeHTML(month)})</span></td>
                    <td>${badge}</td>
                    <td style="font-size: 0.78rem;"><div>${escapeHTML(actor)}</div><div class="text-muted">${escapeHTML(tsStr)}</div></td>
                    <td style="font-size: 0.8rem;">${escapeHTML(r.notes || '—')}</td>
                    <td style="text-align: right;">${btnHtml}</td>
                </tr>
            `;
        }).join('');
    }

    initColdStorageArchive() {
        const cutoffInput = document.getElementById('archive-cutoff-date');
        const btnDryRun = document.getElementById('btn-archive-dry-run');
        const btnExecute = document.getElementById('btn-archive-execute');
        const statusEl = document.getElementById('archive-status-result');
        if (!cutoffInput || !btnDryRun || !btnExecute) return;

        if (!cutoffInput.value) {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 1);
            cutoffInput.value = toDateOnly(d);
        }

        this._lastArchivePreview = null;
        btnExecute.disabled = true;

        cutoffInput.addEventListener('change', () => {
            this._lastArchivePreview = null;
            btnExecute.disabled = true;
            if (statusEl) statusEl.innerHTML = '';
        });

        btnDryRun.addEventListener('click', async () => {
            if (!this.requireRole('admin', 'preview transaction archiving')) return;
            const cutoff = String(cutoffInput.value || '').trim();
            if (!cutoff) {
                Toast.show('Select a cutoff date first.', 'warning');
                return;
            }
            const origHtml = btnDryRun.innerHTML;
            btnDryRun.disabled = true;
            btnDryRun.innerHTML = '<i data-lucide="loader" class="spin"></i> Scanning...';
            renderIcons(btnDryRun);
            try {
                const { data, error } = await supabase.rpc('archive_settled_transactions', {
                    p_before_date: cutoff,
                    p_dry_run: true
                });
                if (error) throw error;
                const count = Number(data?.eligible_count || 0);
                const amount = Number(data?.eligible_amount_egp || 0);
                this._lastArchivePreview = { cutoff, count, amount };
                btnExecute.disabled = count <= 0;
                if (statusEl) {
                    statusEl.innerHTML = count > 0
                        ? `<span style="color: var(--warning); font-weight: 600;">Dry-run preview:</span> <strong>${count.toLocaleString()}</strong> settled &amp; ERP-posted transaction(s) before <code>${escapeHTML(cutoff)}</code> totaling <strong>EGP ${formatMoney(amount)}</strong> are eligible for cold-storage archiving.`
                        : `<span style="color: var(--text-muted);">Dry-run preview: No settled &amp; ERP-posted transactions found before <code>${escapeHTML(cutoff)}</code>.</span>`;
                }
            } catch (err) {
                this._lastArchivePreview = null;
                btnExecute.disabled = true;
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color: var(--danger);">${escapeHTML(err.message)}</span>`;
                }
                Toast.show('Archive preview failed: ' + err.message, 'error');
            } finally {
                btnDryRun.innerHTML = origHtml;
                btnDryRun.disabled = false;
                renderIcons(btnDryRun);
            }
        });

        btnExecute.addEventListener('click', async () => {
            if (!this.requireRole('admin', 'archive transactions to cold storage')) return;
            const cutoff = String(cutoffInput.value || '').trim();
            const preview = this._lastArchivePreview;
            if (!cutoff || !preview || preview.cutoff !== cutoff || preview.count <= 0) {
                Toast.show('Run a fresh Dry-Run Preview for this cutoff date first.', 'warning');
                btnExecute.disabled = true;
                return;
            }
            const ok = await window.customConfirm(
                `Move ${preview.count.toLocaleString()} settled & ERP-posted transaction(s) before ${cutoff} (EGP ${formatMoney(preview.amount)}) to cold storage (transactions_archive)?`,
                'Archive Transactions',
                'Cancel'
            );
            if (!ok) return;

            const origHtml = btnExecute.innerHTML;
            btnExecute.disabled = true;
            btnDryRun.disabled = true;
            btnExecute.innerHTML = '<i data-lucide="loader" class="spin"></i> Archiving...';
            renderIcons(btnExecute);
            try {
                const { data, error } = await supabase.rpc('archive_settled_transactions', {
                    p_before_date: cutoff,
                    p_dry_run: false
                });
                if (error) throw error;
                const archivedCount = Number(data?.archived_count ?? preview.count);
                const archivedAmt = Number(data?.archived_amount_egp ?? preview.amount);
                Toast.show(`Archived ${archivedCount.toLocaleString()} transaction(s) to cold storage.`, 'success');
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ Archived ${archivedCount.toLocaleString()} transaction(s)</span> before <code>${escapeHTML(cutoff)}</code> (<strong>EGP ${formatMoney(archivedAmt)}</strong>) into <code>transactions_archive</code>.`;
                }
                this._lastArchivePreview = null;
                this.invalidateTabs('dashboard', 'transactions', 'users');
                await this.loadUsersAndRoles({ skipSync: true });
            } catch (err) {
                Toast.show('Cold-storage archive failed: ' + err.message, 'error');
                btnExecute.disabled = false;
            } finally {
                btnExecute.innerHTML = origHtml;
                btnDryRun.disabled = false;
                renderIcons(btnExecute);
            }
        });
    }

    async loadUsersAndRoles({ skipSync = false } = {}) {
        if (!this.hasRole('admin')) {
            Toast.show('Admin permission is required to view Users & Roles.', 'warning');
            return;
        }

        // Auto-sync missing accounts from auth.users once per session unless forced
        if (!skipSync && !this._authUsersSynced) {
            try {
                await supabase.rpc('sync_auth_users');
                this._authUsersSynced = true;
            } catch (_e) {
                // Ignore if migration 2.3.1 not yet run in Supabase
            }
        }

        const rolesTbody = document.getElementById('user-roles-table-body');
        const auditTbody = document.getElementById('audit-logs-table-body');
        if (rolesTbody) {
            rolesTbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 1.5rem;"><i data-lucide="loader" class="spin"></i> Loading user roles...</td></tr>';
            renderIcons(rolesTbody);
        }
        if (auditTbody) {
            auditTbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 1.5rem;"><i data-lucide="loader" class="spin"></i> Loading audit log...</td></tr>';
            renderIcons(auditTbody);
        }

        const [rolesRes, logsRes] = await Promise.all([
            supabase.from('user_roles').select('*').order('updated_at', { ascending: false }),
            supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200),
            this.loadClosedPeriods({ silent: false }),
            this.loadDatabaseStorageStats({ silent: false })
        ]);

        if (rolesRes.error) {
            if (rolesTbody) {
                rolesTbody.innerHTML = `<tr><td colspan="5" style="color: var(--danger); text-align: center; padding: 1.25rem;">Could not load user_roles table (${escapeHTML(rolesRes.error.message)}). Run migration <code>2.3.0_user_roles_rbac.sql</code> in Supabase SQL Editor.</td></tr>`;
            }
        } else {
            const rows = Array.isArray(rolesRes.data) ? [...rolesRes.data] : [];
            if (!rows.some(r => String(r.email || '').toLowerCase() === 'ammahmoud@nu.edu.eg')) {
                rows.unshift({
                    email: 'ammahmoud@nu.edu.eg',
                    role: 'admin',
                    is_active: true,
                    updated_by: 'System Seed',
                    updated_at: new Date().toISOString()
                });
            }
            this.allUserRoles = rows;
            this.renderUserRolesTable();
        }

        if (logsRes.error) {
            if (auditTbody) {
                auditTbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger); text-align: center; padding: 1.25rem;">Error loading audit logs: ${escapeHTML(logsRes.error.message)}</td></tr>`;
            }
        } else {
            this.allAuditLogs = logsRes.data || [];
            this.renderAuditLogsTable();
        }
        this.markTabLoaded('users');
    }

    renderUserRolesTable() {
        const tbody = document.getElementById('user-roles-table-body');
        const rows = this.allUserRoles || [];
        const countLabel = document.getElementById('user-roles-count-label');
        if (countLabel) countLabel.textContent = `${rows.length} user${rows.length === 1 ? '' : 's'}`;
        const breakdownEl = document.getElementById('admin-kpi-roles-breakdown');
        if (breakdownEl) {
            const counts = { admin: 0, accountant: 0, operator: 0, viewer: 0 };
            for (const r of rows) {
                const rl = String(r.role || 'viewer').toLowerCase();
                if (Object.prototype.hasOwnProperty.call(counts, rl)) counts[rl] += 1;
                else counts.viewer += 1;
            }
            breakdownEl.textContent = `${counts.admin} Admin · ${counts.accountant} Accountant · ${counts.operator} Operator · ${counts.viewer} Viewer`;
        }
        if (!tbody) return;
        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 1.5rem; color: var(--text-muted);">No users found.</td></tr>';
            return;
        }

        const roleBadge = (r) => {
            const rl = String(r || 'viewer').toLowerCase();
            if (rl === 'admin') return '<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.35);">Admin (L4)</span>';
            if (rl === 'accountant') return '<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35);">Accountant (L3)</span>';
            if (rl === 'operator') return '<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35);">Operator (L2)</span>';
            return '<span class="badge" style="background: rgba(148, 163, 184, 0.15); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.3);">Viewer (L1)</span>';
        };

        const currentAdminEmail = String(this.currentUser?.email || '').trim().toLowerCase();

        tbody.innerHTML = rows.map(r => {
            const email = String(r.email || '').toLowerCase();
            const isPrimaryAdmin = email === 'ammahmoud@nu.edu.eg';
            const isSelf = currentAdminEmail && email === currentAdminEmail;
            const isActive = isPrimaryAdmin || r.is_active !== false;
            const updatedStr = formatDateTime(r.updated_at);
            const statusBadge = isActive
                ? '<span class="badge badge-valid">Active</span>'
                : '<span class="badge badge-error">Deactivated</span>';

            return `
                <tr style="${isActive ? '' : 'opacity: 0.72;'}">
                    <td>
                        <strong>${escapeHTML(r.email)}</strong>
                        ${isPrimaryAdmin ? '<span class="badge" style="margin-left: 0.4rem; font-size: 0.68rem; background: rgba(168,85,247,0.12); color: #a855f7;">Primary Admin</span>' : ''}
                    </td>
                    <td>${roleBadge(r.role)}</td>
                    <td>${statusBadge}</td>
                    <td style="font-size: 0.82rem; color: var(--text-muted);">
                        ${escapeHTML(r.updated_by || 'System')} &bull; ${escapeHTML(updatedStr)}
                    </td>
                    <td style="text-align: right; white-space: nowrap;">
                        <div style="display: inline-flex; gap: 0.35rem; align-items: center;">
                            <button type="button" class="btn btn-outline btn-sm" data-edit-user-role="${escapeHTML(email)}" data-role="${escapeHTML(r.role)}" style="padding: 0.2rem 0.55rem; font-size: 0.76rem;">
                                Edit Role
                            </button>
                            <button type="button" class="btn btn-outline btn-sm" data-reset-user-password="${escapeHTML(email)}" data-role="${escapeHTML(r.role)}" style="padding: 0.2rem 0.55rem; font-size: 0.76rem;">
                                Reset Password
                            </button>
                            ${(!isPrimaryAdmin && !isSelf) ? `
                            <button type="button" class="btn btn-outline btn-sm" data-toggle-user-active="${escapeHTML(email)}" data-active="${isActive ? '1' : '0'}" style="padding: 0.2rem 0.55rem; font-size: 0.76rem; ${isActive ? 'color: var(--warning);' : 'color: var(--success);'}">
                                ${isActive ? 'Deactivate' : 'Reactivate'}
                            </button>
                            <button type="button" class="btn btn-outline btn-sm" data-delete-user="${escapeHTML(email)}" title="Permanently Delete User" style="color: var(--danger); padding: 0.2rem 0.45rem; font-size: 0.76rem;">
                                <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
                            </button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        renderIcons(tbody);

        tbody.querySelectorAll('[data-edit-user-role]').forEach(btn => {
            btn.addEventListener('click', () => {
                const email = btn.getAttribute('data-edit-user-role');
                const role = btn.getAttribute('data-role') || 'viewer';
                const emailInput = document.getElementById('role-user-email');
                const roleSelect = document.getElementById('role-user-select');
                if (emailInput) {
                    emailInput.value = email;
                    emailInput.focus();
                }
                if (roleSelect) roleSelect.value = role;
            });
        });

        tbody.querySelectorAll('[data-reset-user-password]').forEach(btn => {
            btn.addEventListener('click', () => {
                const email = btn.getAttribute('data-reset-user-password');
                const role = btn.getAttribute('data-role') || 'viewer';
                const emailInput = document.getElementById('role-user-email');
                const roleSelect = document.getElementById('role-user-select');
                const passwordInput = document.getElementById('role-user-password');
                if (emailInput) emailInput.value = email;
                if (roleSelect) roleSelect.value = role;
                if (passwordInput) {
                    passwordInput.value = '';
                    passwordInput.focus();
                }
                Toast.show(`Enter a new password (8+ chars) for ${email} and click Save Role / Password`, 'info');
            });
        });

        tbody.querySelectorAll('[data-toggle-user-active]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'deactivate or reactivate users')) return;
                const email = btn.getAttribute('data-toggle-user-active');
                const currentlyActive = btn.getAttribute('data-active') === '1';
                const nextActive = !currentlyActive;
                if (!email || email === 'ammahmoud@nu.edu.eg') return;

                const confirmMsg = nextActive
                    ? `Reactivate "${email}" so they can sign in and access the workspace again?`
                    : `Deactivate "${email}"? Their active session will be revoked and they will be blocked from signing in.`;
                if (!await window.customConfirm(confirmMsg, nextActive ? 'Reactivate' : 'Deactivate', 'Cancel')) return;

                btn.disabled = true;
                try {
                    const { error } = await supabase.rpc('admin_set_user_active', {
                        target_email: email,
                        active: nextActive
                    });
                    if (error) {
                        const missingRpc = /admin_set_user_active|could not find the function|does not exist/i.test(error.message || '');
                        if (!missingRpc) throw error;

                        // App-level fallback if migration 2.6.0 hasn't been executed yet (blocks workspace entry if is_active column exists)
                        const upd = await supabase
                            .from('user_roles')
                            .update({
                                is_active: nextActive,
                                updated_by: this.currentUser?.email || 'Admin',
                                updated_at: new Date().toISOString()
                            })
                            .ilike('email', email);
                        if (upd.error) {
                            throw new Error('Run migration migrations/2.6.0_user_deactivation_and_delete.sql in Supabase SQL Editor first (' + upd.error.message + ').');
                        }
                    }

                    await this.logAudit(
                        nextActive ? 'User Reactivated' : 'User Deactivated',
                        email,
                        { target_email: email, is_active: nextActive }
                    );
                    Toast.show(`${email} has been ${nextActive ? 'reactivated' : 'deactivated'}.`, nextActive ? 'success' : 'warning');
                    await this.loadUsersAndRoles({ skipSync: true });
                } catch (err) {
                    Toast.show('Error updating user status: ' + err.message, 'error');
                } finally {
                    btn.disabled = false;
                }
            });
        });

        tbody.querySelectorAll('[data-delete-user]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'delete users')) return;
                const email = btn.getAttribute('data-delete-user');
                if (!email || email === 'ammahmoud@nu.edu.eg') return;

                const confirmed = await window.customConfirm(
                    `Permanently delete user "${email}"? This deletes their login account and removes all access.`,
                    'Delete User',
                    'Cancel'
                );
                if (!confirmed) return;

                btn.disabled = true;
                try {
                    const { error } = await supabase.rpc('admin_delete_user', { target_email: email });
                    if (error) {
                        const missingRpc = /admin_delete_user|could not find the function|does not exist/i.test(error.message || '');
                        if (missingRpc) {
                            throw new Error('Run migration migrations/2.6.0_user_deactivation_and_delete.sql in Supabase SQL Editor to enable full user deletion.');
                        }
                        throw error;
                    }

                    await this.logAudit('User Deleted', email, { target_email: email });
                    Toast.show(`Permanently deleted user ${email}.`, 'success');
                    this.allUserRoles = (this.allUserRoles || []).filter(r => String(r.email || '').toLowerCase() !== email);
                    this.renderUserRolesTable();
                    await this.loadUsersAndRoles({ skipSync: true });
                } catch (err) {
                    Toast.show('Error deleting user: ' + err.message, 'error');
                } finally {
                    btn.disabled = false;
                }
            });
        });
    }

    renderAuditLogsTable() {
        const tbody = document.getElementById('audit-logs-table-body');
        const allLogs = this.allAuditLogs || [];
        const auditCountEl = document.getElementById('admin-kpi-audit-count');
        if (auditCountEl) auditCountEl.textContent = `${allLogs.length} event${allLogs.length === 1 ? '' : 's'}`;
        if (!tbody) return;
        const catFilter = this.auditCategoryFilter || 'all';
        const searchQ = (document.getElementById('audit-log-search')?.value || '').trim().toLowerCase();
        const logs = allLogs.filter(log => {
            const action = String(log.action || '');
            if (catFilter === 'roles' && !/role|user|auth|hygiene/i.test(action)) return false;
            if (catFilter === 'periods' && !/period/i.test(action)) return false;
            if (catFilter === 'fixes' && !/fix|mapping|rule|automatch|duplicate|import/i.test(action)) return false;
            if (catFilter === 'erp' && !/erp|archive|settle/i.test(action)) return false;
            if (!searchQ) return true;
            const hay = `${log.user_email || ''} ${action} ${log.affected_references || ''} ${JSON.stringify(log.details || {})}`.toLowerCase();
            return hay.includes(searchQ);
        });

        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 1.5rem; color: var(--text-muted);">No matching audit log entries found.</td></tr>';
            return;
        }

        const isAdmin = this.hasRole('admin');
        tbody.innerHTML = logs.map(log => {
            const ts = formatDateTime(log.created_at);
            const detailsObj = log.details || {};
            const detailsStr = log.details ? JSON.stringify(log.details) : '-';
            const isReverted = detailsObj.is_reverted === true;
            const canRevert = isAdmin && !isReverted && (
                Boolean(detailsObj.revert_data) ||
                (log.action === 'Database Hygiene Audit' && detailsObj.auto_cleaned === true && ((detailsObj.cleaned_mappings || 0) + (detailsObj.cleaned_fixes || 0) > 0))
            );

            let actionCell = '<span style="color: var(--text-muted); font-size: 0.75rem;">-</span>';
            if (isReverted) {
                actionCell = `<span class="badge" style="background: rgba(245, 158, 11, 0.14); color: #f59e0b; font-size: 0.7rem;">Reverted</span>`;
            } else if (canRevert) {
                actionCell = `<button type="button" class="btn btn-outline btn-sm" data-revert-audit-id="${escapeHTML(log.id)}" style="padding: 0.18rem 0.55rem; font-size: 0.74rem; color: var(--warning, #f59e0b); border-color: rgba(245, 158, 11, 0.35);" title="Undo this change and restore previous state">
                    <i data-lucide="undo-2" style="width: 12px; height: 12px;"></i> Undo
                </button>`;
            }

            return `
                <tr>
                    <td style="white-space: nowrap; font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(ts)}</td>
                    <td style="font-size: 0.84rem;"><strong>${escapeHTML(log.user_email || 'System')}</strong></td>
                    <td><span class="badge" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); font-size: 0.74rem;">${escapeHTML(log.action || '-')}</span></td>
                    <td style="font-family: monospace; font-size: 0.8rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(log.affected_references || '')}">${escapeHTML(log.affected_references || '-')}</td>
                    <td style="font-family: monospace; font-size: 0.75rem; color: var(--text-secondary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(detailsStr)}">${escapeHTML(detailsStr)}</td>
                    <td style="text-align: right; white-space: nowrap;">${actionCell}</td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-revert-audit-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const auditId = btn.getAttribute('data-revert-audit-id');
                if (auditId) this.revertAuditLogEntry(auditId, btn);
            });
        });

        if (window.lucide) lucide.createIcons({ root: tbody });
    }

    async revertAuditLogEntry(auditId, btnEl = null) {
        if (!this.requireRole('admin', 'revert audit log actions')) return;
        const log = (this.allAuditLogs || []).find(l => String(l.id) === String(auditId));
        if (!log) return;

        const ok = await window.customConfirm(
            `Are you sure you want to undo Audit #${auditId} (${log.action}: "${log.affected_references || ''}") and restore the previous database state?`,
            'Undo Action', 'Cancel'
        );
        if (!ok) return;

        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<i data-lucide="loader" class="spin" style="width: 12px; height: 12px;"></i>';
            if (window.lucide) lucide.createIcons({ root: btnEl });
        }

        try {
            let rpcName = 'revert_audit_log_entry';
            if (log.action === 'Database Hygiene Audit' && !log.details?.revert_data) {
                rpcName = 'rollback_database_hygiene_audit';
            }

            const { data, error } = await supabase.rpc(rpcName, { p_audit_id: Number(auditId) });
            if (error) throw error;

            const tableName = log.details?.revert_data?.table_name;
            if (tableName === 'item_mappings') {
                this.mappingSuggestCache = null;
                this.loadMappings();
            } else if (tableName === 'manual_fixes') {
                const ref = log.affected_references;
                if (ref) {
                    const rows = await fetchAll('transactions', '*', q => q.eq('reference_number', ref), 'id');
                    await this.reapplyRulesTo(rows);
                }
                this.loadFixes();
            } else if (tableName === 'transactions_erp' || tableName === 'foreign_transactions_erp') {
                const batchNum = String(log.details?.revert_data?.batch_number || '').trim();
                const prevMap = new Map(
                    (log.details?.revert_data?.previous_rows || [])
                        .filter(r => r && r.reference_number)
                        .map(r => [String(r.reference_number), r])
                );
                let foreignChanged = false;
                (this.foreignTransactions || []).forEach(r => {
                    const prev = prevMap.get(String(r.reference_number || ''));
                    if (prev) {
                        r.erp_batch_number = prev.erp_batch_number || '';
                        r.erp_voucher = prev.erp_voucher || '';
                        foreignChanged = true;
                    } else if (batchNum && r.erp_batch_number === batchNum) {
                        r.erp_batch_number = '';
                        r.erp_voucher = '';
                        foreignChanged = true;
                    }
                });
                if (foreignChanged) {
                    this.persistForeignTransactionsLocal();
                    this.applyForeignFilters();
                }
                if (document.getElementById('view-erp-export')?.classList.contains('active')) {
                    this.loadErpExport({ refresh: true });
                }
            }

            Toast.show(data?.message || `Audit #${auditId} successfully reverted!`, 'success');
            await this.loadUsersAndRoles({ skipSync: true });
        } catch (err) {
            Toast.show('Revert failed: ' + err.message, 'error');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = '<i data-lucide="undo-2" style="width: 12px; height: 12px;"></i> Undo';
                if (window.lucide) lucide.createIcons({ root: btnEl });
            }
        }
    }

    // ==========================================
    // Double-Payment & Anomaly Detector
    // ==========================================
    initDoublePaymentsDetector() {
        this.doublePaymentClusters = [];
        const btnOpen = document.getElementById('btn-detect-double-payments');
        const selWindow = document.getElementById('double-payments-window');
        const inpSearch = document.getElementById('double-payments-search');
        const btnExport = document.getElementById('btn-export-double-payments');

        if (btnOpen) {
            btnOpen.addEventListener('click', () => {
                document.getElementById('modal-double-payments')?.classList.remove('hidden');
                if (window.lucide) lucide.createIcons();
                this.loadDoublePayments();
            });
        }

        if (selWindow) {
            selWindow.addEventListener('change', () => this.loadDoublePayments());
        }

        if (inpSearch) {
            let dpSearchTimer;
            inpSearch.addEventListener('input', () => {
                clearTimeout(dpSearchTimer);
                dpSearchTimer = setTimeout(() => this.renderDoublePaymentsTable(), 200);
            });
        }

        if (btnExport) {
            btnExport.addEventListener('click', () => this.exportDoublePayments());
        }
    }

    async loadDoublePayments() {
        const tbody = document.getElementById('double-payments-body');
        const summaryEl = document.getElementById('double-payments-summary');
        const daysWindow = parseInt(document.getElementById('double-payments-window')?.value ?? '3', 10);

        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 2rem; color: var(--text-muted);"><i data-lucide="loader" class="spin"></i> Scanning for potential double payments...</td></tr>';
            if (window.lucide) lucide.createIcons({ root: tbody });
        }
        if (summaryEl) summaryEl.textContent = 'Scanning...';

        try {
            const { data, error } = await supabase.rpc('detect_double_payments', {
                p_days_window: isNaN(daysWindow) ? 3 : daysWindow
            });
            if (error) throw error;

            this.doublePaymentClusters = Array.isArray(data) ? data : [];
            this.renderDoublePaymentsTable();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 1.5rem; color: var(--danger);">Error scanning double payments: ${escapeHTML(err.message)}</td></tr>`;
            }
            if (summaryEl) summaryEl.textContent = 'Scan failed';
        }
    }

    renderDoublePaymentsTable() {
        const tbody = document.getElementById('double-payments-body');
        const summaryEl = document.getElementById('double-payments-summary');
        if (!tbody) return;

        const q = (document.getElementById('double-payments-search')?.value || '').trim().toLowerCase();
        const filtered = (this.doublePaymentClusters || []).filter(c => {
            if (String(c.mapping || 'Tuition').trim().toLowerCase() !== 'tuition') return false;
            if (!q) return true;
            const hay = `${c.student_id || ''} ${c.student_name || ''} ${c.item_name || ''} ${c.mapping || ''} ${(c.reference_numbers || []).join(' ')}`.toLowerCase();
            return hay.includes(q);
        });

        const getClusterCount = (c) => parseInt(
            c.tx_count ?? c.occurrences ?? c.payment_count ?? (Array.isArray(c.reference_numbers) ? c.reference_numbers.length : 0),
            10
        ) || 0;
        const getClusterTotal = (c, cnt) => {
            const raw = c.total_paid ?? c.total_amount;
            if (raw !== undefined && raw !== null) return parseFloat(raw) || 0;
            return (parseFloat(c.item_price || 0) || 0) * cnt;
        };
        const getDaysApart = (c) => {
            if (c.days_apart !== undefined && c.days_apart !== null) return Number(c.days_apart) || 0;
            if (c.first_date && c.last_date) {
                const diff = Math.round((new Date(c.last_date) - new Date(c.first_date)) / 86400000);
                return isNaN(diff) ? 0 : Math.max(0, diff);
            }
            return 0;
        };

        const totalExcess = filtered.reduce((acc, c) => {
            const unit = parseFloat(c.item_price || 0) || 0;
            const cnt = getClusterCount(c);
            return acc + (cnt > 1 ? unit * (cnt - 1) : 0);
        }, 0);

        if (summaryEl) {
            summaryEl.innerHTML = `Found <strong>${filtered.length.toLocaleString()}</strong> Tuition cluster(s) &bull; Potential Duplicate Amount: <strong style="color: var(--warning, #f59e0b);">EGP ${formatMoney(totalExcess)}</strong>`;
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 2rem; color: var(--success);">No potential double Tuition payments found for the selected window!</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(c => {
            const refs = Array.isArray(c.reference_numbers) ? c.reference_numbers : [];
            const txCount = getClusterCount(c);
            const totalPaid = getClusterTotal(c, txCount);
            const daysApart = getDaysApart(c);
            const refsHtml = refs.map(ref =>
                `<a href="#" class="dp-ref-link badge" data-ref="${escapeHTML(ref)}" style="background: rgba(56, 189, 248, 0.12); color: var(--primary); font-family: monospace; text-decoration: none; margin: 2px;">${escapeHTML(ref)}</a>`
            ).join(' ');
            const dateSpan = c.first_date === c.last_date
                ? `${escapeHTML(c.first_date)} <span class="badge" style="background: rgba(239,68,68,0.15); color: var(--danger); font-size: 0.68rem;">Same Day</span>`
                : `${escapeHTML(c.first_date)} &rarr; ${escapeHTML(c.last_date)} <span style="color: var(--text-muted); font-size: 0.75rem;">(${daysApart}d)</span>`;

            return `
                <tr>
                    <td>
                        <a href="#" class="dp-student-link" data-sid="${escapeHTML(c.student_id)}" style="font-family: monospace; font-weight: 700; color: var(--primary); text-decoration: none;">${escapeHTML(c.student_id)}</a>${this.renderStudentLevelBadge(this.getStudentLevelBySid(c.student_id))}
                        <div style="font-size: 0.78rem; color: var(--text-muted);">${escapeHTML(c.student_name || 'N/A')}</div>
                    </td>
                    <td>
                        <div style="font-weight: 500;">${escapeHTML(c.item_name || '-')}</div>
                        <span class="badge" style="font-size: 0.7rem; background: rgba(16,185,129,0.12); color: #10b981;">${escapeHTML(c.mapping || 'Tuition')}</span>
                    </td>
                    <td style="text-align: right; font-family: monospace;">EGP ${formatMoney(c.item_price)}</td>
                    <td style="text-align: center;"><span class="badge" style="background: rgba(245,158,11,0.16); color: #f59e0b; font-weight: 700;">${txCount}x</span></td>
                    <td style="text-align: right; font-family: monospace; font-weight: 700; color: var(--warning, #f59e0b);">EGP ${formatMoney(totalPaid)}</td>
                    <td style="white-space: nowrap; font-size: 0.82rem;">${dateSpan}</td>
                    <td style="max-width: 260px;">${refsHtml}</td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.dp-student-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const sid = link.getAttribute('data-sid');
                if (!sid) return;
                document.getElementById('modal-double-payments')?.classList.add('hidden');
                document.querySelector('.nav-link[data-tab="student-master"]')?.click();
                this.loadStudentProfile(sid);
            });
        });

        tbody.querySelectorAll('.dp-ref-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const ref = link.getAttribute('data-ref');
                if (ref && typeof this.openTransactionDetailsModal === 'function') {
                    this.openTransactionDetailsModal(ref);
                }
            });
        });
    }

    exportDoublePayments() {
        const rows = (this.doublePaymentClusters || []).filter(
            c => String(c.mapping || 'Tuition').trim().toLowerCase() === 'tuition'
        );
        if (rows.length === 0) {
            Toast.show('No double-payment records to export.', 'warning');
            return;
        }
        const exportData = rows.map(c => {
            const txCount = parseInt(
                c.tx_count ?? c.occurrences ?? c.payment_count ?? (Array.isArray(c.reference_numbers) ? c.reference_numbers.length : 0),
                10
            ) || 0;
            const unitPrice = Number(c.item_price || 0);
            const totalPaid = Number(c.total_paid ?? c.total_amount ?? (unitPrice * txCount));
            const daysApart = c.days_apart !== undefined && c.days_apart !== null
                ? Number(c.days_apart)
                : (c.first_date && c.last_date ? Math.max(0, Math.round((new Date(c.last_date) - new Date(c.first_date)) / 86400000)) : 0);
            return {
                'Student ID': c.student_id || '',
                'Level': this.getStudentLevelLabelBySid(c.student_id),
                'Student Name': c.student_name || '',
                'Item Name': c.item_name || '',
                'Mapping Category': c.mapping || 'Tuition',
                'Unit Price (EGP)': unitPrice,
                'Transaction Count': txCount,
                'Total Paid (EGP)': totalPaid,
                'Potential Duplicate Excess (EGP)': Number((unitPrice * Math.max(0, txCount - 1)).toFixed(2)),
                'First Payment Date': c.first_date || '',
                'Last Payment Date': c.last_date || '',
                'Days Apart': daysApart,
                'Banks': (c.banks || []).join(', '),
                'Reference Numbers': (c.reference_numbers || []).join(', ')
            };
        });

        const ws = XLSX.utils.json_to_sheet(sanitizeExcelRows(exportData));
        ws['!cols'] = [
            { wch: 14 }, { wch: 26 }, { wch: 30 }, { wch: 20 },
            { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 24 },
            { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 36 }
        ];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Double Payments');
        writeCompressedExcel(wb, `Double_Payments_Report_${toDateOnly(new Date())}.xlsx`);
        Toast.show(`Exported ${exportData.length} double-payment cluster(s)`, 'success');
    }

    // ==========================================
    // Automated Deduplication & Hygiene Modal (Admin Only)
    // ==========================================
    initHygieneReportModal() {
        this.currentHygieneAudit = null;

        const btnClose = document.getElementById('btn-close-hygiene-modal');
        if (btnClose) {
            btnClose.addEventListener('click', () => {
                document.getElementById('modal-hygiene-report')?.classList.add('hidden');
            });
        }

        const btnAcknowledge = document.getElementById('btn-hygiene-acknowledge');
        if (btnAcknowledge) {
            btnAcknowledge.addEventListener('click', () => {
                if (this.currentHygieneAudit?.id) {
                    localStorage.setItem('fawry_acknowledged_hygiene_id', String(this.currentHygieneAudit.id));
                }
                document.getElementById('modal-hygiene-report')?.classList.add('hidden');
                Toast.show('Deduplication & Hygiene Report acknowledged.', 'success');
            });
        }

        const btnRunScan = document.getElementById('btn-hygiene-run-scan');
        if (btnRunScan) {
            btnRunScan.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'run a live database hygiene scan')) return;
                const origHtml = btnRunScan.innerHTML;
                btnRunScan.disabled = true;
                btnRunScan.innerHTML = '<i data-lucide="loader" class="spin"></i> Scanning...';
                renderIcons(btnRunScan);
                try {
                    const rec = await this.runLiveHygieneAudit({ clean: false, showToastOnError: true });
                    if (rec) {
                        Toast.show('Live Database Hygiene Scan completed.', 'success');
                    }
                } finally {
                    btnRunScan.innerHTML = origHtml;
                    btnRunScan.disabled = false;
                    renderIcons(btnRunScan);
                }
            });
        }

        const btnRunClean = document.getElementById('btn-hygiene-run-clean');
        if (btnRunClean) {
            btnRunClean.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'clean duplicate rules in the database')) return;
                const ok = await window.customConfirm(
                    'Safely merge and remove duplicate mapping rules and duplicate manual fixes? A full rollback snapshot will be captured in the Audit Log.',
                    'Auto-Clean Duplicates',
                    'Cancel'
                );
                if (!ok) return;

                const origHtml = btnRunClean.innerHTML;
                btnRunClean.disabled = true;
                btnRunClean.innerHTML = '<i data-lucide="loader" class="spin"></i> Cleaning...';
                renderIcons(btnRunClean);
                try {
                    await this.runLiveHygieneAudit({ clean: true, showToastOnError: true });
                } finally {
                    btnRunClean.innerHTML = origHtml;
                    btnRunClean.disabled = false;
                    renderIcons(btnRunClean);
                }
            });
        }

        const btnRevert = document.getElementById('btn-hygiene-revert');
        if (btnRevert) {
            btnRevert.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'revert automated database hygiene changes')) return;
                if (!this.currentHygieneAudit?.id) return;

                const confirmed = await window.customConfirm(
                    `Are you sure you want to revert the deduplication clean from Audit #${this.currentHygieneAudit.id}? This will restore all previously removed mapping rules and manual fixes.`,
                    'Reverse Clean (Undo)',
                    'Cancel'
                );
                if (!confirmed) return;

                btnRevert.disabled = true;
                btnRevert.innerHTML = '<i data-lucide="loader" class="spin"></i> Reverting...';
                renderIcons(btnRevert);

                try {
                    const { data, error } = await supabase.rpc('rollback_database_hygiene_audit', {
                        p_audit_id: this.currentHygieneAudit.id
                    });
                    if (error) throw error;

                    Toast.show(data?.message || 'Cleaned records successfully restored!', 'success');
                    if (this.currentHygieneAudit?.id) {
                        localStorage.setItem('fawry_acknowledged_hygiene_id', String(this.currentHygieneAudit.id));
                    }
                    document.getElementById('modal-hygiene-report')?.classList.add('hidden');

                    this.loadMappings?.();
                    this.loadFixes?.();
                    if (document.getElementById('view-users')?.classList.contains('active')) {
                        this.loadUsersAndRoles?.({ skipSync: true });
                    }
                } catch (err) {
                    Toast.show('Rollback failed: ' + err.message, 'error');
                } finally {
                    btnRevert.disabled = false;
                    btnRevert.innerHTML = '<i data-lucide="undo-2"></i> Reverse Clean (Undo)';
                    renderIcons(btnRevert);
                }
            });
        }

        // Interactive drill-down cards
        document.querySelectorAll('#modal-hygiene-report [data-hygiene-drill]').forEach(card => {
            const go = () => {
                const key = card.getAttribute('data-hygiene-drill');
                if (key) this.drillDownHygieneMetric(key);
            };
            card.addEventListener('click', go);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    go();
                }
            });
        });

        // Manual trigger from Users & Roles tab header: runs live scan on open
        const btnViewHygiene = document.getElementById('btn-view-hygiene-report');
        if (btnViewHygiene) {
            btnViewHygiene.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'view hygiene audit report')) return;
                const origHtml = btnViewHygiene.innerHTML;
                btnViewHygiene.disabled = true;
                btnViewHygiene.innerHTML = '<i data-lucide="loader" class="spin"></i> Scanning...';
                renderIcons(btnViewHygiene);
                try {
                    await this.checkAndShowHygieneReportModal({ force: true, runLive: true });
                } finally {
                    btnViewHygiene.innerHTML = origHtml;
                    btnViewHygiene.disabled = false;
                    renderIcons(btnViewHygiene);
                }
            });
        }
    }

    drillDownHygieneMetric(drillKey) {
        document.getElementById('modal-hygiene-report')?.classList.add('hidden');
        if (drillKey === 'dup-mappings') {
            document.querySelector('.nav-link[data-tab="mappings"]')?.click();
            return;
        }
        if (drillKey === 'dup-fixes') {
            document.querySelector('.nav-link[data-tab="fixes"]')?.click();
            return;
        }
        document.querySelector('.nav-link[data-tab="transactions"]')?.click();
        if (drillKey === 'identical-dups') {
            document.getElementById('btn-detect-duplicates')?.click();
            return;
        }

        const clearDateInput = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = '';
            if (el._flatpickr) el._flatpickr.setDate('', false);
        };
        clearDateInput('filter-date-from');
        clearDateInput('filter-date-to');
        const searchEl = document.getElementById('search-input');
        if (searchEl) searchEl.value = '';

        this.headerFilters = this.headerFilters || {};
        this.headerFilters.transactions = {};
        document.querySelectorAll('[data-table="transactions"] .header-filter-icon').forEach(icon => {
            icon.classList.remove('active');
        });

        if (drillKey === 'unmapped') {
            this.txQuickFilter = 'unmapped';
        } else if (drillKey === 'invalid-ids') {
            this.txQuickFilter = 'all';
            this.headerFilters.transactions.id_status = ['Missing ID', 'Error'];
            document.querySelector('.th-filter-wrapper[data-table="transactions"][data-column="id_status"] .header-filter-icon')?.classList.add('active');
        } else {
            this.txQuickFilter = 'all';
        }

        document.querySelectorAll('[data-tx-quick-filter]').forEach(btn => {
            const isActive = btn.getAttribute('data-tx-quick-filter') === (this.txQuickFilter || 'all');
            btn.classList.toggle('btn-primary', isActive);
            btn.classList.toggle('btn-outline', !isActive);
        });

        this.currentPage = 1;
        this.renderFilterChips?.('transactions');
        this.loadTransactions?.();
    }

    async runLiveHygieneAudit({ clean = false, showToastOnError = false } = {}) {
        if (!this.hasRole('admin')) return null;
        if (typeof supabase.rpc !== 'function') return null;

        try {
            const { data, error } = await supabase.rpc('run_database_hygiene_audit', {
                p_clean: Boolean(clean)
            });
            if (error) throw error;
            if (!data || typeof data !== 'object' || Array.isArray(data) || (data.total_transactions === undefined && data.health_score === undefined)) {
                return null;
            }

            const rawScore = data.health_score;
            const scoreStr = (rawScore === undefined || rawScore === null)
                ? '100%'
                : (String(rawScore).trim().endsWith('%') ? String(rawScore).trim() : `${Number(rawScore).toFixed(1)}%`);

            const record = {
                id: data.audit_id || Date.now(),
                created_at: data.created_at || new Date().toISOString(),
                details: {
                    ...data,
                    health_score: scoreStr,
                    auto_cleaned: Boolean(data.auto_cleaned ?? clean),
                    is_reverted: false
                }
            };

            this.renderHygieneAuditModal(record);

            if (clean) {
                const cleanedM = Number(data.cleaned_mappings || 0);
                const cleanedF = Number(data.cleaned_fixes || 0);
                Toast.show(
                    (cleanedM + cleanedF) > 0
                        ? `Cleaned ${cleanedM} duplicate mapping(s) and ${cleanedF} duplicate fix(es) with a rollback snapshot.`
                        : 'Live scan complete — no duplicate mappings or manual fixes needed cleaning.',
                    'success'
                );
                this.loadMappings?.();
                this.loadFixes?.();
            }

            this.invalidateTabs?.('users');
            return record;
        } catch (err) {
            if (showToastOnError) {
                Toast.show('Live hygiene scan failed: ' + err.message, 'error');
            }
            return null;
        }
    }

    renderHygieneAuditModal(data) {
        if (!data) return;
        this.currentHygieneAudit = data;
        const details = data.details || {};
        const auditId = data.id || 'Live';
        const isReverted = details.is_reverted === true;
        const autoCleaned = details.auto_cleaned === true;

        const totalTx = Number(details.total_transactions || 0);
        const dupMappings = Number(details.duplicate_mappings || 0);
        const dupFixes = Number(details.duplicate_fixes || 0);
        const identicalDups = Number(details.identical_tx_duplicates || 0);
        const conflictingCase = Number(details.conflicting_case_mappings || 0);
        const unmapped = Number(details.unmapped_items || 0);
        const invalidIds = Number(details.invalid_ids || 0);
        const cleanedMappings = Number(details.cleaned_mappings || 0);
        const cleanedFixes = Number(details.cleaned_fixes || 0);
        const cleanedCount = cleanedMappings + cleanedFixes;

        const dupTotal = dupMappings + dupFixes + identicalDups + conflictingCase;
        const pendingTotal = unmapped + invalidIds;

        // Populate Modal Fields
        const scoreEl = document.getElementById('hygiene-modal-score');
        if (scoreEl) scoreEl.textContent = details.health_score || '100%';

        const txEl = document.getElementById('hygiene-modal-tx-count');
        if (txEl) txEl.textContent = totalTx.toLocaleString();

        const dupMEl = document.getElementById('hygiene-modal-dup-mappings');
        if (dupMEl) dupMEl.textContent = dupMappings.toLocaleString();

        const dupFEl = document.getElementById('hygiene-modal-dup-fixes');
        if (dupFEl) dupFEl.textContent = dupFixes.toLocaleString();

        const identEl = document.getElementById('hygiene-modal-identical-dups');
        if (identEl) identEl.textContent = identicalDups.toLocaleString();

        const unmapEl = document.getElementById('hygiene-modal-unmapped');
        if (unmapEl) unmapEl.textContent = unmapped.toLocaleString();

        const invIdEl = document.getElementById('hygiene-modal-invalid-ids');
        if (invIdEl) invIdEl.textContent = invalidIds.toLocaleString();

        // Subtitle & Timestamp
        const subEl = document.getElementById('hygiene-modal-subtitle');
        const runDate = new Date(data.created_at);
        const timeStr = formatDateTime(runDate, 'Just now');
        if (subEl) {
            subEl.textContent = `Audit #${auditId} • ${timeStr} • ${autoCleaned ? 'Auto-Clean Run' : 'Live Inspection Scan'}`;
        }

        // Hero Banner Status & Accent
        const heroBanner = document.getElementById('hygiene-hero-banner');
        const statusTextEl = document.getElementById('hygiene-health-status-text');
        const hasIssues = dupTotal > 0 || pendingTotal > 0;
        const accentColor = hasIssues ? 'var(--warning, #f59e0b)' : 'var(--success)';

        if (statusTextEl) {
            if (dupTotal === 0 && pendingTotal === 0) {
                statusTextEl.textContent = 'Pristine Data Quality — 100% Verified';
            } else if (dupTotal === 0) {
                statusTextEl.textContent = `Rules Clean • ${pendingTotal.toLocaleString()} Ledger Item(s) Need Reconciliation`;
            } else {
                statusTextEl.textContent = `${dupTotal.toLocaleString()} Duplicate / Conflicting Record(s) Detected`;
            }
            statusTextEl.style.color = accentColor;
        }
        if (scoreEl) {
            scoreEl.style.color = accentColor;
        }
        if (heroBanner) {
            heroBanner.style.background = hasIssues
                ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.14), var(--primary-soft))'
                : 'linear-gradient(135deg, rgba(16, 185, 129, 0.12), var(--primary-soft))';
            heroBanner.style.borderColor = hasIssues
                ? 'rgba(245, 158, 11, 0.38)'
                : 'rgba(16, 185, 129, 0.3)';
        }

        // Explanation box text
        const expTextEl = document.getElementById('hygiene-modal-explanation-text');
        if (expTextEl) {
            if (isReverted) {
                expTextEl.innerHTML = '<span style="color: var(--warning); font-weight: 600;">This audit run was previously REVERTED. Cleaned rules have been restored to the database.</span>';
            } else if (cleanedCount > 0) {
                const pendingNote = pendingTotal > 0
                    ? `<br><span style="color: var(--warning, #f59e0b);">Remaining ledger items: ${unmapped.toLocaleString()} missing mapping(s), ${invalidIds.toLocaleString()} non-Valid ID status row(s). Click any card above to inspect.</span>`
                    : '';
                expTextEl.innerHTML = `<strong>Auto-Clean Action Taken:</strong> Merged ${cleanedMappings} duplicate mapping rule(s) and ${cleanedFixes} duplicate manual fix(es) with a full safety snapshot. If needed, click <strong>"Reverse Clean (Undo)"</strong> below.${pendingNote}`;
            } else {
                const dupParts = [];
                if (dupMappings > 0) dupParts.push(`${dupMappings.toLocaleString()} duplicate mapping rule(s)`);
                if (dupFixes > 0) dupParts.push(`${dupFixes.toLocaleString()} duplicate manual fix(es)`);
                if (identicalDups > 0) dupParts.push(`${identicalDups.toLocaleString()} identical duplicate transaction(s)`);
                if (conflictingCase > 0) dupParts.push(`${conflictingCase.toLocaleString()} conflicting case mapping(s)`);

                const ruleLine = dupParts.length > 0
                    ? `<strong>Duplicates Found (${totalTx.toLocaleString()} tx scanned):</strong> ${escapeHTML(dupParts.join(', '))}.`
                    : `<strong>Rules &amp; Duplicates (${totalTx.toLocaleString()} tx scanned):</strong> Zero duplicate mapping rules, duplicate manual fixes, or identical duplicate transactions.`;

                const reconLine = pendingTotal > 0
                    ? `<br><strong>Pending Ledger Reconciliation:</strong> ${unmapped.toLocaleString()} missing mapping(s) and ${invalidIds.toLocaleString()} non-Valid ID status transaction(s). Click any card above to inspect.`
                    : `<br><strong>Ledger Reconciliation:</strong> All mappings and Student IDs are verified.`;

                expTextEl.innerHTML = `${ruleLine}${reconLine}`;
            }
        }

        // Action Buttons Visibility
        const btnRunClean = document.getElementById('btn-hygiene-run-clean');
        if (btnRunClean) {
            btnRunClean.style.display = (dupMappings + dupFixes) > 0 ? 'inline-flex' : 'none';
        }

        const btnRevert = document.getElementById('btn-hygiene-revert');
        if (btnRevert) {
            btnRevert.style.display = (cleanedCount > 0 && !isReverted) ? 'inline-flex' : 'none';
        }

        // Google Drive Link (shown ONLY when a real Google Drive / Docs URL was recorded)
        const driveRow = document.getElementById('hygiene-modal-drive-row');
        const driveLink = document.getElementById('hygiene-modal-drive-link');
        if (driveRow && driveLink) {
            let safeDriveUrl = '';
            if (typeof details.drive_folder_url === 'string' && details.drive_folder_url.trim()) {
                try {
                    const parsedUrl = new URL(details.drive_folder_url.trim());
                    if (parsedUrl.protocol === 'https:' && (parsedUrl.hostname === 'drive.google.com' || parsedUrl.hostname === 'docs.google.com')) {
                        safeDriveUrl = parsedUrl.href;
                    }
                } catch (_e) {
                    safeDriveUrl = '';
                }
            }
            if (safeDriveUrl) {
                driveLink.href = safeDriveUrl;
                driveRow.style.display = 'flex';
            } else {
                driveLink.href = '#';
                driveRow.style.display = 'none';
            }
        }
    }

    async checkAndShowHygieneReportModal({ force = false, runLive = false } = {}) {
        if (!this.hasRole('admin')) return null;

        try {
            if (runLive) {
                const liveRecord = await this.runLiveHygieneAudit({ clean: false, showToastOnError: false });
                if (liveRecord) {
                    const hygieneModal = document.getElementById('modal-hygiene-report');
                    hygieneModal?.classList.remove('hidden');
                    renderIcons(hygieneModal);
                    return liveRecord;
                }
            }

            const { data, error } = await supabase
                .from('audit_logs')
                .select('*')
                .eq('action', 'Database Hygiene Audit')
                .order('id', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error || !data) {
                if (force) {
                    const hygieneModal = document.getElementById('modal-hygiene-report');
                    hygieneModal?.classList.remove('hidden');
                    renderIcons(hygieneModal);
                }
                return null;
            }

            const auditId = data.id;
            const lastAckId = localStorage.getItem('fawry_acknowledged_hygiene_id');

            // If not forced and already acknowledged, don't show popup
            if (!force && lastAckId && Number(lastAckId) >= Number(auditId)) {
                return null;
            }

            this.renderHygieneAuditModal(data);

            const hygieneModal = document.getElementById('modal-hygiene-report');
            hygieneModal?.classList.remove('hidden');
            renderIcons(hygieneModal);
            return data;
        } catch (err) {
            console.warn('Failed to check hygiene audit report:', err);
            return null;
        }
    }
}

export function applyAdminAuditMixin(AppClass) {
    for (const name of Object.getOwnPropertyNames(AdminAuditMixin.prototype)) {
        if (name !== 'constructor') {
            Object.defineProperty(AppClass.prototype, name, Object.getOwnPropertyDescriptor(AdminAuditMixin.prototype, name));
        }
    }
}
