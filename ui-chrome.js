/* Workspace UI Chrome Enhancements — Works cleanly alongside app.js */
(function () {
    // 0. Service Worker registration & global error reporting
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => {
                    console.log('Service Worker Registered!', reg);
                    try { reg.update(); } catch (_e) { /* ignore */ }
                })
                .catch(err => console.error('Service Worker Registration Failed!', err));
        });
    }
    if (typeof window !== 'undefined') {
        window.onerror = function (msg, url, line) {
            console.error('JS Error: ' + msg + ' at line ' + line);
        };
        window.addEventListener('unhandledrejection', function (event) {
            console.error('Promise Error: ' + (event.reason && event.reason.message ? event.reason.message : event.reason));
        });
    }

    let globalListenersBound = false;
    let lucideRetryTimer = null;

    function ensureLucideIcons() {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
            if (lucideRetryTimer) {
                clearInterval(lucideRetryTimer);
                lucideRetryTimer = null;
            }
            return true;
        }
        return false;
    }

    function initUiChrome() {
        if (!ensureLucideIcons() && !lucideRetryTimer && typeof window !== 'undefined') {
            let attempts = 0;
            lucideRetryTimer = setInterval(() => {
                attempts++;
                if (ensureLucideIcons() || attempts >= 30) {
                    clearInterval(lucideRetryTimer);
                    lucideRetryTimer = null;
                }
            }, 120);
        }

        // 1. Sidebar Collapse Toggle
        const appLayout = document.querySelector('.app-layout');
        const btnCollapse = document.getElementById('btn-toggle-sidebar-rail');
        try {
            if (localStorage.getItem('spdb-sidebar-rail') === 'collapsed' && appLayout) {
                appLayout.classList.add('sidebar-collapsed');
            }
        } catch (_e) { /* ignore */ }

        if (btnCollapse && appLayout && !btnCollapse.dataset.chromeBound) {
            btnCollapse.dataset.chromeBound = '1';
            btnCollapse.addEventListener('click', () => {
                appLayout.classList.toggle('sidebar-collapsed');
                try {
                    localStorage.setItem(
                        'spdb-sidebar-rail',
                        appLayout.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded'
                    );
                } catch (_e) { /* ignore */ }
            });
        }

        // 2. Show / Hide Password toggle on Auth screen
        const btnEye = document.getElementById('btn-toggle-auth-password');
        const pwInput = document.getElementById('auth-password');
        if (btnEye && pwInput && !btnEye.dataset.chromeBound) {
            btnEye.dataset.chromeBound = '1';
            btnEye.addEventListener('click', () => {
                const isPw = pwInput.type === 'password';
                pwInput.type = isPw ? 'text' : 'password';
                btnEye.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
            });
        }

        // 3. Header "Tools" dropdown popovers
        document.querySelectorAll('[data-dropdown-toggle]').forEach(trigger => {
            if (trigger.dataset.chromeBound) return;
            trigger.dataset.chromeBound = '1';
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const menuId = trigger.getAttribute('data-dropdown-toggle');
                const menu = document.getElementById(menuId);
                if (!menu) return;
                const wasOpen = menu.classList.contains('open');
                document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
                if (!wasOpen) menu.classList.add('open');
            });
        });

        if (!globalListenersBound && !window.__spdbChromeListenersBound) {
            globalListenersBound = true;
            window.__spdbChromeListenersBound = true;
            bindModalManager();
            document.addEventListener('click', (e) => {
                document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
                const target = e.target;
                if (!target || !target.closest) return;
                // Explicit close controls: x buttons and Cancel buttons carry data-close-modal="<id>"
                const closer = target.closest('[data-close-modal]');
                if (closer) {
                    closeModal(closer.getAttribute('data-close-modal'));
                    return;
                }
                // Click on the backdrop (the .modal element itself) of a non-alert modal closes it
                if (target.classList && target.classList.contains('modal') && !target.classList.contains('hidden')) {
                    if (target.id === 'modal-custom-confirm') {
                        document.getElementById('btn-custom-confirm-cancel')?.click();
                    } else if (!target.classList.contains('modal-dialog-alert')) {
                        closeModal(target.id);
                    }
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
                    // Another layer (global search, column filter popover) already consumed this Escape
                    if (e.defaultPrevented || e.__spdbEscapeHandled) return;
                    const searchOverlay = document.getElementById('global-search-overlay');
                    if (searchOverlay && searchOverlay.classList.contains('active')) return;
                    // If customConfirm is open, let its own Escape handler resolve(false)
                    const customConfirmModal = document.getElementById('modal-custom-confirm');
                    if (customConfirmModal && !customConfirmModal.classList.contains('hidden')) return;
                    const top = getTopModal();
                    if (top) {
                        e.preventDefault();
                        closeModal(top.id);
                    }
                } else if (e.key === 'Tab') {
                    trapFocus(e);
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    // Ctrl+Enter submits the active edit modal
                    const modalSubmitMap = [
                        ['modal-fix', e.shiftKey ? 'btn-save-fix-next' : 'btn-save-fix'],
                        ['modal-foreign-fix', 'btn-save-foreign-fix'],
                        ['modal-mapping', 'btn-save-mapping'],
                        ['modal-student', 'btn-save-student'],
                        ['modal-link', 'btn-save-link']
                    ];
                    for (const [modalId, btnId] of modalSubmitMap) {
                        const modal = document.getElementById(modalId);
                        if (modal && !modal.classList.contains('hidden')) {
                            const btn = document.getElementById(btnId);
                            // Never click a disabled, hidden or role-hidden button
                            if (btn && !btn.disabled && isElementShown(btn)) {
                                e.preventDefault();
                                btn.click();
                            }
                            break;
                        }
                    }
                }
            });
        }
    }

    /* ------------------------------------------------------------------
     * Shared modal mechanism.
     * Every way of closing a modal (Escape, backdrop click, x / Cancel buttons,
     * programmatic) goes through closeModal(id), which consults per-modal guards
     * (e.g. "an import is running") and runs per-modal after-close hooks.
     * Opening is still done by removing the `hidden` class; a MutationObserver
     * tracks open order (for "topmost" on z-index ties) and handles focus
     * (move focus into the modal, return it to the opener on close).
     * ------------------------------------------------------------------ */
    const modalGuards = (window.__spdbModalGuards = window.__spdbModalGuards || {});
    const openModalStack = []; // [{ id, opener }]
    let lastFocusOutsideModal = null;
    let modalObserver = null;

    const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function isElementShown(el) {
        if (!el || !el.isConnected) return false;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            if (n.hidden) return false;
            if (n.classList && n.classList.contains('hidden')) return false;
            const style = window.getComputedStyle ? window.getComputedStyle(n) : n.style;
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        }
        return true;
    }

    function isModalOpen(el) {
        return !!(el && el.classList && el.classList.contains('modal') && !el.classList.contains('hidden'));
    }

    function zIndexOf(el) {
        const raw = window.getComputedStyle ? window.getComputedStyle(el).zIndex : el.style.zIndex;
        const z = parseInt(raw, 10);
        return Number.isFinite(z) ? z : 0;
    }

    function getOpenModals() {
        syncModalState();
        return Array.from(document.querySelectorAll('.modal:not(.hidden)'));
    }

    /** Topmost open modal: highest z-index, then most recently opened, then last in DOM. */
    function getTopModal() {
        const open = getOpenModals();
        if (open.length === 0) return null;
        const domIndex = new Map(open.map((m, i) => [m, i]));
        const openOrder = (m) => openModalStack.findIndex(entry => entry.id === m.id);
        open.sort((a, b) => (zIndexOf(a) - zIndexOf(b))
            || (openOrder(a) - openOrder(b))
            || (domIndex.get(a) - domIndex.get(b)));
        return open[open.length - 1];
    }

    function focusFirstIn(modal) {
        if (!isModalOpen(modal)) return;
        if (modal.contains(document.activeElement)) return;
        const focusables = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementShown);
        // Prefer the first form field, then the first non-close control, then anything
        const target = focusables.find(el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))
            || focusables.find(el => !el.classList.contains('btn-close'))
            || focusables[0];
        const content = modal.querySelector('.modal-content') || modal;
        try {
            if (target) target.focus();
            else {
                if (!content.hasAttribute('tabindex')) content.setAttribute('tabindex', '-1');
                content.focus();
            }
        } catch (_e) { /* ignore */ }
    }

    function onModalOpened(modal) {
        if (openModalStack.some(entry => entry.id === modal.id)) return;
        const active = document.activeElement;
        const opener = (active && active !== document.body && !(active.closest && active.closest('.modal')))
            ? active
            : lastFocusOutsideModal;
        openModalStack.push({ id: modal.id, opener });
        setTimeout(() => focusFirstIn(modal), 0);
    }

    function onModalClosed(modal) {
        const idx = openModalStack.findIndex(entry => entry.id === modal.id);
        if (idx === -1) return;
        const [entry] = openModalStack.splice(idx, 1);
        const active = document.activeElement;
        const focusWasInside = !active || active === document.body || modal.contains(active);
        if (!focusWasInside) return;
        const opener = entry.opener;
        if (opener && opener.isConnected && isElementShown(opener)) {
            try { opener.focus(); } catch (_e) { /* ignore */ }
        } else {
            const next = getTopModal();
            if (next) focusFirstIn(next);
        }
    }

    /** Reconcile the open-modal stack with the DOM (also used synchronously by closeModal). */
    function syncModalState() {
        openModalStack.slice().forEach(entry => {
            const el = document.getElementById(entry.id);
            if (!isModalOpen(el)) {
                if (el) onModalClosed(el);
                else openModalStack.splice(openModalStack.indexOf(entry), 1);
            }
        });
        document.querySelectorAll('.modal:not(.hidden)').forEach(el => {
            if (el.id && !openModalStack.some(entry => entry.id === el.id)) onModalOpened(el);
        });
    }

    /**
     * Register guard/hook for a modal.
     *   canClose(): return false to refuse closing (show your own toast).
     *   onClose(): runs after the modal was hidden, however it was closed.
     */
    function registerModalGuard(id, guard) {
        modalGuards[id] = Object.assign({}, modalGuards[id] || {}, guard || {});
    }

    /** Close a modal by id (or element). Returns true when the modal ends up closed. */
    function closeModal(id, options = {}) {
        const modal = typeof id === 'string' ? document.getElementById(id) : id;
        if (!modal) return false;
        if (modal.classList.contains('hidden')) return true;
        const guard = modalGuards[modal.id] || {};
        if (!options.force && typeof guard.canClose === 'function') {
            let ok = true;
            try { ok = guard.canClose() !== false; } catch (err) { console.error(err); }
            if (!ok) return false;
        }
        modal.classList.add('hidden');
        syncModalState();
        if (typeof guard.onClose === 'function') {
            try { guard.onClose(); } catch (err) { console.error(err); }
        }
        return true;
    }

    function trapFocus(e) {
        const top = getTopModal();
        if (!top) return;
        const focusables = Array.from(top.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementShown);
        if (focusables.length === 0) {
            e.preventDefault();
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!top.contains(active)) {
            e.preventDefault();
            first.focus();
        } else if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }

    function bindModalManager() {
        document.addEventListener('focusin', (e) => {
            const t = e.target;
            if (t && t !== document.body && t.closest && !t.closest('.modal')) lastFocusOutsideModal = t;
        });
        if (typeof MutationObserver !== 'undefined' && document.documentElement && !modalObserver) {
            modalObserver = new MutationObserver((mutations) => {
                if (mutations.some(m => m.target && m.target.classList && m.target.classList.contains('modal'))) {
                    syncModalState();
                }
            });
            modalObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
        }
        syncModalState();
    }

    if (typeof window !== 'undefined') {
        window.closeModal = closeModal;
        window.registerModalGuard = registerModalGuard;
        window.getTopModal = getTopModal;
        window.isElementShown = isElementShown;
    }

    if (typeof window !== 'undefined') {
        window.initUiChrome = initUiChrome;
        window.addEventListener('load', ensureLucideIcons);
    }

    document.addEventListener('DOMContentLoaded', initUiChrome);
})();
