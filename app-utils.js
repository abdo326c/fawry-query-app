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

const isTestRuntime = Boolean(globalThis.process?.env?.VITEST || globalThis.process?.env?.NODE_ENV === 'test');
const importTestPkg = (pkg) => import(/* @vite-ignore */ pkg);

export async function ensureXlsx() {
    if (isTestRuntime) {
        if (typeof globalThis.XLSX === 'undefined') {
            const mod = await importTestPkg('xlsx');
            globalThis.XLSX = mod?.read ? mod : (mod?.default || mod);
        }
        if (typeof globalThis.JSZip === 'undefined') {
            const mod = await importTestPkg('jszip');
            globalThis.JSZip = mod?.default || mod;
        }
        return;
    }
    const tasks = [];
    if (typeof XLSX === 'undefined') tasks.push(loadScriptOnce('./vendor/xlsx.full.min.js'));
    if (typeof JSZip === 'undefined') tasks.push(loadScriptOnce('./vendor/jszip.min.js'));
    if (tasks.length > 0) await Promise.all(tasks);
}

export async function ensurePapa() {
    if (typeof globalThis.Papa !== 'undefined') return;
    if (isTestRuntime) {
        const mod = await importTestPkg('papaparse');
        globalThis.Papa = mod?.parse ? mod : (mod?.default || mod);
        return;
    }
    if (typeof Papa === 'undefined') {
        await loadScriptOnce('./vendor/papaparse.min.js');
    }
}

export async function ensureFuse() {
    if (typeof globalThis.Fuse !== 'undefined') return;
    if (isTestRuntime) {
        const mod = await importTestPkg('fuse.js');
        globalThis.Fuse = mod?.default || mod;
        return;
    }
    if (typeof Fuse === 'undefined') {
        await loadScriptOnce('./vendor/fuse.min.js');
    }
}

export async function ensureImportLibs() {
    await Promise.all([ensureXlsx(), ensurePapa()]);
}

const INLINE_SVG_PATHS = {
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'edit-2': '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
};

export function inlineIcon(name, size = 14) {
    const inner = INLINE_SVG_PATHS[name];
    if (!inner) return `<i data-lucide="${name}" style="width:${size}px;height:${size}px;"></i>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name}" aria-hidden="true">${inner}</svg>`;
}

export function renderIcons(root = null) {
    if (!window.lucide) return;
    try {
        if (root && typeof Element !== 'undefined' && root instanceof Element) {
            if (typeof root.querySelector === 'function' && !root.querySelector('[data-lucide]')) {
                return;
            }
            window.lucide.createIcons({ root });
        } else {
            window.lucide.createIcons();
        }
    } catch (_e) {
        window.lucide.createIcons();
    }
}

/**
 * Server-side (PostgREST-style .or()) twin of rules.js isIdValidationExempt():
 * a mapping / second_mapping is exempt when it contains the WORD dip, diploma, workshop or
 * workshops (rules.js uses /\b(dip|diploma|workshops?)\b/). The filter syntax has no word
 * boundaries, so every "token delimited by a separator or the string edge" form is enumerated
 * for the separators below. api/rpc.js EXEMPT_MAPPING_SQL implements the same rule in SQL; a test
 * (tests/money-erp-dashboard.test.js) keeps the three definitions in agreement.
 * ("PG Diploma" and "Dip-Workshop" are exempt; "Diplomacy" and "Workshop2026" are not.)
 */
export const EXEMPT_LABEL_TOKENS = Object.freeze(['dip', 'diploma', 'workshop', 'workshops']);
export const EXEMPT_FILTER_SEPARATORS = Object.freeze([' ', '-', '/', '.', '&']);

export function buildExemptOrFilter(columns = ['mapping', 'second_mapping']) {
    const terms = ['id_status.eq.Exempt'];
    for (const col of columns) {
        for (const t of EXEMPT_LABEL_TOKENS) {
            terms.push(`${col}.ilike.${t}`);
            for (const s of EXEMPT_FILTER_SEPARATORS) terms.push(`${col}.ilike.${t}${s}*`);
            for (const s of EXEMPT_FILTER_SEPARATORS) terms.push(`${col}.ilike.*${s}${t}`);
            for (const a of EXEMPT_FILTER_SEPARATORS) {
                for (const b of EXEMPT_FILTER_SEPARATORS) terms.push(`${col}.ilike.*${a}${t}${b}*`);
            }
        }
    }
    return terms.join(',');
}

export const SUPABASE_EXEMPT_OR_FILTER = buildExemptOrFilter();

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

/**
 * Format a timestamp (ISO string, Date or epoch ms) as "YYYY-MM-DD HH:mm" in local time.
 * Returns `fallback` for empty / unparseable input. Used for every user-facing timestamp so the
 * app shows one consistent, locale-independent date format.
 */
export function formatDateTime(value, fallback = '-') {
    if (value === null || value === undefined || value === '') return fallback;
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return fallback;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Error/warning toasts stay up long enough to read (and have a close button); success/info are brief. */
export const TOAST_DURATIONS = { success: 3000, info: 3000, warning: 8000, error: 8000 };

export class Toast {
    static show(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const isAlert = type === 'error' || type === 'warning';
        toast.setAttribute('role', isAlert ? 'alert' : 'status');
        toast.setAttribute('aria-live', isAlert ? 'assertive' : 'polite');

        let iconName = 'info';
        if (type === 'success') iconName = 'check-circle';
        if (type === 'error') iconName = 'alert-circle';
        if (type === 'warning') iconName = 'alert-triangle';

        toast.innerHTML = `
            <i data-lucide="${iconName}" class="toast-icon"></i>
            <div class="toast-content">${escapeHTML(msg)}</div>
            <button type="button" class="toast-close" aria-label="Dismiss notification">&times;</button>
        `;

        let hideTimer = null;
        const dismiss = () => {
            if (toast.classList.contains('toast-hiding')) return;
            clearTimeout(hideTimer);
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 300);
        };
        toast.querySelector('.toast-close')?.addEventListener('click', dismiss);

        container.appendChild(toast);
        if (window.lucide) lucide.createIcons({ root: toast });

        hideTimer = setTimeout(dismiss, TOAST_DURATIONS[type] || TOAST_DURATIONS.info);
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

/**
 * Safely reads saved filter presets from localStorage.
 */
export function loadSavedFilterPresets(storageKey) {
    if (!storageKey) return [];
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && p.state && typeof p.state === 'object');
    } catch (_e) {
        return [];
    }
}

/**
 * Safely persists saved filter presets to localStorage.
 */
export function saveFilterPresetList(storageKey, presets) {
    if (!storageKey) return false;
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(storageKey, JSON.stringify(Array.isArray(presets) ? presets : []));
        return true;
    } catch (_e) {
        return false;
    }
}

/**
 * Inserts or updates a saved filter preset (case-insensitive by name), capped at 20 presets.
 */
export function upsertFilterPreset(presets, { name, state }) {
    const cleanName = String(name || '').trim();
    if (!cleanName || !state || typeof state !== 'object') {
        return Array.isArray(presets) ? [...presets] : [];
    }
    const list = Array.isArray(presets) ? [...presets] : [];
    const lower = cleanName.toLowerCase();
    const existing = list.find(p => String(p.name || '').trim().toLowerCase() === lower);
    const id = existing ? existing.id : `preset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextEntry = {
        id,
        name: cleanName,
        state: JSON.parse(JSON.stringify(state)),
        updatedAt: new Date().toISOString()
    };
    const filtered = list.filter(p => String(p.name || '').trim().toLowerCase() !== lower);
    filtered.unshift(nextEntry);
    return filtered.slice(0, 20);
}

/**
 * Removes a saved filter preset by ID and returns a new array.
 */
export function deleteFilterPreset(presets, id) {
    if (!Array.isArray(presets) || !id) return Array.isArray(presets) ? [...presets] : [];
    return presets.filter(p => p.id !== id);
}

const IDB_CACHE_DB = 'spdb-local-cache-v1';
const IDB_CACHE_STORE = 'kv';

function openLocalCacheDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(IDB_CACHE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_CACHE_STORE)) {
                    db.createObjectStore(IDB_CACHE_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (_e) {
            resolve(null);
        }
    });
}

/**
 * Reads a cached entry from IndexedDB safely (returns null if unavailable).
 */
export async function readIndexedDbCache(key) {
    if (!key) return null;
    const db = await openLocalCacheDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_CACHE_STORE, 'readonly');
            const store = tx.objectStore(IDB_CACHE_STORE);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
            tx.oncomplete = () => { try { db.close(); } catch (_e) {} };
        } catch (_e) {
            try { db.close(); } catch (_err) {}
            resolve(null);
        }
    });
}

/**
 * Writes a cached entry to IndexedDB safely (returns false if unavailable).
 */
export async function writeIndexedDbCache(key, value) {
    if (!key) return false;
    const db = await openLocalCacheDb();
    if (!db) return false;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_CACHE_STORE, 'readwrite');
            const store = tx.objectStore(IDB_CACHE_STORE);
            store.put(value, key);
            tx.oncomplete = () => { try { db.close(); } catch (_e) {} resolve(true); };
            tx.onerror = () => { try { db.close(); } catch (_e) {} resolve(false); };
        } catch (_e) {
            try { db.close(); } catch (_err) {}
            resolve(false);
        }
    });
}

/**
 * Clears a cached entry from IndexedDB safely (returns false if unavailable).
 */
export async function clearIndexedDbCache(key) {
    if (!key) return false;
    const db = await openLocalCacheDb();
    if (!db) return false;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_CACHE_STORE, 'readwrite');
            const store = tx.objectStore(IDB_CACHE_STORE);
            store.delete(key);
            tx.oncomplete = () => { try { db.close(); } catch (_e) {} resolve(true); };
            tx.onerror = () => { try { db.close(); } catch (_e) {} resolve(false); };
        } catch (_e) {
            try { db.close(); } catch (_err) {}
            resolve(false);
        }
    });
}

window.Toast = Toast;
window.withDropdownTaskProgress = withDropdownTaskProgress;
