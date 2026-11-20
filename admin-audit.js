import { supabase } from './supabase.js';
import {
    fetchAll,
    escapeHTML,
    sanitizeExcelRows,
    toDateOnly,
    writeCompressedExcel
} from './rules.js';
import { renderIcons, formatMoney, Toast } from './app-utils.js';

class AdminAuditMixin {
    initUsersAndRoles() {
        this.allUserRoles = [];
        this.allAuditLogs = [];

        const btnSaveRole = document.getElementById('btn-save-user-role');
        if (btnSaveRole) {
            btnSaveRole.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'assign user roles')) return;
                const emailInput = document.getElementById('role-user-email');
                const roleSelect = document.getElementById('role-user-select');
                const email = String(emailInput?.value || '').trim().toLowerCase();
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

                btnSaveRole.disabled = true;
                try {
                    const { error } = await supabase.from('user_roles').upsert({
                        email,
                        role,
                        updated_by: this.currentUser?.email || 'Admin',
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'email' });
                    if (error) throw error;

                    await this.logAudit('User Role Assigned', email, { target_email: email, assigned_role: role });
                    Toast.show(`Assigned ${role.toUpperCase()} role to ${email}`, 'success');
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
                        ? `Synced ${inserted} new user(s) from Supabase Auth (Total: ${total}).`
                        : `All registered accounts are already in the directory (Total: ${total}).`, 'success');
                    await this.loadUsersAndRoles({ skipSync: true });
                } catch (err) {
                    Toast.show('Sync error: ' + err.message + ' (Run migration 2.3.1_sync_auth_users.sql in Supabase SQL editor)', 'warning');
                } finally {
                    btnSyncUsers.innerHTML = origHtml;
                    btnSyncUsers.disabled = false;
                    if (window.lucide) lucide.createIcons();
                }
            });
        }

        const searchAudit = document.getElementById('audit-log-search');
        if (searchAudit) {
            searchAudit.addEventListener('input', () => this.renderAuditLogsTable());
        }

        this.initColdStorageArchive();
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
            supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200)
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
        if (!tbody) return;
        const rows = this.allUserRoles || [];
        const countLabel = document.getElementById('user-roles-count-label');
        if (countLabel) countLabel.textContent = `${rows.length} user${rows.length === 1 ? '' : 's'}`;
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
            const updatedStr = r.updated_at ? new Date(r.updated_at).toLocaleString() : '-';
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
                    `Permanently delete user "${email}"? This deletes their account from Supabase Auth and removes all access.`,
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
        if (!tbody) return;
        const searchQ = (document.getElementById('audit-log-search')?.value || '').trim().toLowerCase();
        const logs = (this.allAuditLogs || []).filter(log => {
            if (!searchQ) return true;
            const hay = `${log.user_email || ''} ${log.action || ''} ${log.affected_references || ''} ${JSON.stringify(log.details || {})}`.toLowerCase();
            return hay.includes(searchQ);
        });

        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 1.5rem; color: var(--text-muted);">No matching audit log entries found.</td></tr>';
            return;
        }

        const isAdmin = this.hasRole('admin');
        tbody.innerHTML = logs.map(log => {
            const ts = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
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
            inpSearch.addEventListener('input', () => this.renderDoublePaymentsTable());
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

        const btnRevert = document.getElementById('btn-hygiene-revert');
        if (btnRevert) {
            btnRevert.addEventListener('click', async () => {
                if (!this.requireRole('admin', 'revert automated database hygiene changes')) return;
                if (!this.currentHygieneAudit?.id) return;

                const confirmed = confirm(`Are you sure you want to revert the deduplication clean from Audit #${this.currentHygieneAudit.id}? This will restore all previously removed mapping rules and manual fixes.`);
                if (!confirmed) return;

                btnRevert.disabled = true;
                btnRevert.innerHTML = '<i data-lucide="loader" class="spin"></i> Reverting...';

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
                    
                    // Reload rules tables if user is looking at them
                    this.loadMappings?.();
                    this.loadFixes?.();
                } catch (err) {
                    Toast.show('Rollback failed: ' + err.message, 'error');
                } finally {
                    btnRevert.disabled = false;
                    btnRevert.innerHTML = '<i data-lucide="undo-2"></i> Reverse Clean (Undo)';
                    if (window.lucide) lucide.createIcons();
                }
            });
        }

        // Manual trigger from Users & Roles tab header
        const btnViewHygiene = document.getElementById('btn-view-hygiene-report');
        if (btnViewHygiene) {
            btnViewHygiene.addEventListener('click', () => {
                if (!this.requireRole('admin', 'view hygiene audit report')) return;
                this.checkAndShowHygieneReportModal({ force: true });
            });
        }
    }

    async checkAndShowHygieneReportModal({ force = false } = {}) {
        if (!this.hasRole('admin')) return;

        try {
            const { data, error } = await supabase
                .from('audit_logs')
                .select('*')
                .eq('action', 'Database Hygiene Audit')
                .order('id', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error || !data) return;

            const auditId = data.id;
            const lastAckId = localStorage.getItem('fawry_acknowledged_hygiene_id');

            // If not forced and already acknowledged, don't show popup
            if (!force && lastAckId && Number(lastAckId) >= Number(auditId)) {
                return;
            }

            this.currentHygieneAudit = data;
            const details = data.details || {};
            const isReverted = details.is_reverted === true;
            const autoCleaned = details.auto_cleaned === true;
            const cleanedCount = (details.cleaned_mappings || 0) + (details.cleaned_fixes || 0);

            // Populate Modal Fields
            const scoreEl = document.getElementById('hygiene-modal-score');
            if (scoreEl) scoreEl.innerText = details.health_score || '99.2%';

            const txEl = document.getElementById('hygiene-modal-tx-count');
            if (txEl) txEl.innerText = (details.total_transactions || 0).toLocaleString();

            const dupMEl = document.getElementById('hygiene-modal-dup-mappings');
            if (dupMEl) dupMEl.innerText = details.duplicate_mappings || 0;

            const dupFEl = document.getElementById('hygiene-modal-dup-fixes');
            if (dupFEl) dupFEl.innerText = details.duplicate_fixes || 0;

            const identEl = document.getElementById('hygiene-modal-identical-dups');
            if (identEl) identEl.innerText = details.identical_tx_duplicates || 0;

            const unmapEl = document.getElementById('hygiene-modal-unmapped');
            if (unmapEl) unmapEl.innerText = details.unmapped_items || 0;

            const invIdEl = document.getElementById('hygiene-modal-invalid-ids');
            if (invIdEl) invIdEl.innerText = details.invalid_ids || 0;

            // Subtitle & Timestamp
            const subEl = document.getElementById('hygiene-modal-subtitle');
            const runDate = new Date(data.created_at);
            const timeStr = !isNaN(runDate) ? runDate.toLocaleString() : 'Recently';
            if (subEl) {
                subEl.innerText = `Audit #${auditId} • ${timeStr} • ${autoCleaned ? 'Auto-Clean Cloud Run' : 'Inspection Scan'}`;
            }

            // Explanation box text
            const expTextEl = document.getElementById('hygiene-modal-explanation-text');
            if (expTextEl) {
                if (isReverted) {
                    expTextEl.innerHTML = '<span style="color: var(--warning); font-weight: 600;">⚠️ This audit run was previously REVERTED. Cleaned rules have been restored to the database.</span>';
                } else if (cleanedCount > 0) {
                    expTextEl.innerHTML = `<strong>Auto-Clean Action Taken:</strong> Merged ${Number(details.cleaned_mappings || 0)} duplicate mapping rules and ${Number(details.cleaned_fixes || 0)} duplicate manual fixes. A complete safety snapshot was captured before removal. If needed, click <strong>"Reverse Clean (Undo)"</strong> below.`;
                } else {
                    const totalScanned = Number(details.total_transactions || 0).toLocaleString();
                    expTextEl.innerHTML = `<strong>Data Quality Status:</strong> All ${escapeHTML(totalScanned)} raw transactions and mapping rules are fully verified. No duplicate rules or records required modification.`;
                }
            }

            // Revert Button Visibility (only if cleaned rules exist and not yet reverted)
            const btnRevert = document.getElementById('btn-hygiene-revert');
            if (btnRevert) {
                btnRevert.style.display = (cleanedCount > 0 && !isReverted) ? 'inline-flex' : 'none';
            }

            // Google Drive Link (validated to prevent javascript: or untrusted URI injection)
            const driveRow = document.getElementById('hygiene-modal-drive-row');
            const driveLink = document.getElementById('hygiene-modal-drive-link');
            if (driveRow && driveLink) {
                const defaultDriveUrl = 'https://drive.google.com/drive/folders/1QY9kzLuFKufFCLmUJNbRfs2PFcfFfz-M';
                let safeDriveUrl = defaultDriveUrl;
                if (typeof details.drive_folder_url === 'string') {
                    try {
                        const parsedUrl = new URL(details.drive_folder_url);
                        if (parsedUrl.protocol === 'https:' && (parsedUrl.hostname === 'drive.google.com' || parsedUrl.hostname === 'docs.google.com')) {
                            safeDriveUrl = parsedUrl.href;
                        }
                    } catch (_e) {
                        // Fall back to default URL
                    }
                }
                driveLink.href = safeDriveUrl;
                driveRow.style.display = 'flex';
            }

            // Show Modal
            const hygieneModal = document.getElementById('modal-hygiene-report');
            hygieneModal?.classList.remove('hidden');
            renderIcons(hygieneModal);
        } catch (err) {
            console.warn('Failed to check hygiene audit report:', err);
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
