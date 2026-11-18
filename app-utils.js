import {
    isIdValidationExempt,
    escapeHTML,
    sanitizeExcelValue,
    sanitizeExcelRows,
    writeCompressedExcel
} from './rules.js';

// Helper to run async task functions with bounded concurrency
export async function runConcurrent(tasks, concurrency = 4) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
        results.push(...batch);
    }
    return results;
}

const _loadedScripts = new Map();
export function loadScriptOnce(src) {
    if (_loadedScripts.has(src)) return _loadedScripts.get(src);
    const promise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            _loadedScripts.delete(src);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
    _loadedScripts.set(src, promise);
    return promise;
}

export function renderIcons(root = null) {
    if (!window.lucide) return;
    try {
        if (root && typeof Element !== 'undefined' && root instanceof Element) {
            window.lucide.createIcons({ root });
        } else {
            window.lucide.createIcons();
        }
    } catch (_e) {
        window.lucide.createIcons();
    }
}

export const SUPABASE_EXEMPT_OR_FILTER = 'id_status.eq.Exempt,mapping.ilike.Dip,mapping.ilike.Dip *,mapping.ilike.Diploma*,mapping.ilike.*Workshop*,second_mapping.ilike.Dip,second_mapping.ilike.Dip *,second_mapping.ilike.Diploma*,second_mapping.ilike.*Workshop*';

/**
 * Returns normalized display metadata for a transaction's Student ID status badge.
 */
export function formatIdStatusMeta(tx, { defaultStatus = 'Missing ID' } = {}) {
    const raw = tx?.id_status ? String(tx.id_status).trim() : '';
    const effective = tx
        ? (raw === 'Valid' ? 'Valid' : (raw === 'Exempt' || isIdValidationExempt(tx) ? 'Exempt' : (raw || defaultStatus)))
        : defaultStatus;
    let statusClass = 'valid';
    if (effective === 'Exempt') statusClass = 'exempt';
    else if (effective.includes('Missing')) statusClass = 'missing';
    else if (effective.includes('Error') || effective !== 'Valid') statusClass = 'error';
    const shortStatus = statusClass === 'error' && effective.startsWith('Error') ? 'Error' : effective;
    return { statusText: effective, shortStatus, statusClass, isIssue: statusClass === 'missing' || statusClass === 'error' };
}

// Promise-based confirm dialog using the in-page modal
window.customConfirm = function(message, okText = 'OK', cancelText = 'Cancel') {
    if (typeof window._activeConfirmCancel === 'function') {
        window._activeConfirmCancel();
    }
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-custom-confirm');
        const msgEl = document.getElementById('custom-confirm-message');
        const btnOk = document.getElementById('btn-custom-confirm-ok');
        const btnCancel = document.getElementById('btn-custom-confirm-cancel');

        msgEl.innerText = message;
        btnOk.innerText = okText;
        btnCancel.innerText = cancelText;

        const cleanup = () => {
            if (window._activeConfirmCancel === onCancel) {
                window._activeConfirmCancel = null;
            }
            modal.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            window.removeEventListener('keydown', onKeyDown);
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onCancel();
            }
        };

        window._activeConfirmCancel = onCancel;
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        window.addEventListener('keydown', onKeyDown);

        modal.classList.remove('hidden');
    });
};

window.escapeHTML = escapeHTML;
window.sanitizeExcelValue = sanitizeExcelValue;
window.sanitizeExcelRows = sanitizeExcelRows;
window.writeCompressedExcel = writeCompressedExcel;

// Shared utility: format money
export function formatMoney(num) {
    return parseFloat(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shared utility: sanitize user input for Supabase .or() filter strings
export function sanitizeForFilter(str) {
    if (!str) return '';
    return String(str).replace(/[,)(%\\"*]/g, '').trim();
}

export class Toast {
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
        if (window.lucide) lucide.createIcons({ root: toast });

        setTimeout(() => {
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    static showLoading(msg) {
        const container = document.getElementById('toast-container');
        if (!container) {
            return { update() {}, dismiss() {} };
        }

        const toast = document.createElement('div');
        toast.className = 'toast toast-info toast-loading';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML = `
            <i data-lucide="loader-2" class="toast-icon spin"></i>
            <div class="toast-content">${escapeHTML(msg)}</div>
        `;

        container.appendChild(toast);
        if (window.lucide) lucide.createIcons({ root: toast });

        let dismissed = false;
        return {
            update(nextMsg) {
                if (dismissed) return;
                const contentEl = toast.querySelector('.toast-content');
                if (contentEl) contentEl.textContent = String(nextMsg ?? '');
            },
            dismiss() {
                if (dismissed) return;
                dismissed = true;
                toast.classList.add('toast-hiding');
                setTimeout(() => toast.remove(), 300);
            }
        };
    }
}

/** Runs an async dropdown action with a visible trigger-button spinner and persistent progress toast. */
export async function withDropdownTaskProgress(btnOrId, busyLabel, initialToastMsg, asyncTask) {
    const btn = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
    const triggerBtn = btn?.closest?.('.action-dropdown-wrap')?.querySelector('[data-dropdown-toggle]') || null;
    if (btn?.disabled || triggerBtn?.dataset.busy === '1') return;

    const originalBtnHtml = btn ? btn.innerHTML : null;
    const originalBtnDisabled = btn ? btn.disabled : false;
    const originalTriggerHtml = triggerBtn ? triggerBtn.innerHTML : null;
    const originalTriggerDisabled = triggerBtn ? triggerBtn.disabled : false;
    const busyMarkup = `<i data-lucide="loader-2" class="spin"></i> ${escapeHTML(busyLabel)}`;

    if (btn) {
        btn.innerHTML = busyMarkup;
        btn.disabled = true;
        if (window.lucide) lucide.createIcons({ root: btn });
    }
    if (triggerBtn) {
        triggerBtn.dataset.busy = '1';
        triggerBtn.innerHTML = busyMarkup;
        triggerBtn.disabled = true;
        if (window.lucide) lucide.createIcons({ root: triggerBtn });
    }

    const progressToast = Toast.showLoading(initialToastMsg);
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
        return await asyncTask(progressToast);
    } finally {
        progressToast.dismiss();
        if (btn) {
            btn.innerHTML = originalBtnHtml;
            btn.disabled = originalBtnDisabled;
            if (window.lucide) lucide.createIcons({ root: btn });
        }
        if (triggerBtn) {
            delete triggerBtn.dataset.busy;
            triggerBtn.innerHTML = originalTriggerHtml;
            triggerBtn.disabled = originalTriggerDisabled;
            if (window.lucide) lucide.createIcons({ root: triggerBtn });
        }
    }
}

window.Toast = Toast;
window.withDropdownTaskProgress = withDropdownTaskProgress;
