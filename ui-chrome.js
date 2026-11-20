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

        if (!globalListenersBound) {
            globalListenersBound = true;
            document.addEventListener('click', (e) => {
                document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
                // Click outside non-alert modal content closes the modal
                const target = e.target;
                if (target && target.classList && target.classList.contains('modal') && !target.classList.contains('modal-dialog-alert') && !target.classList.contains('hidden')) {
                    target.classList.add('hidden');
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
                    // If customConfirm is open, let its own Escape handler resolve(false)
                    const customConfirmModal = document.getElementById('modal-custom-confirm');
                    if (customConfirmModal && !customConfirmModal.classList.contains('hidden')) return;
                    // Close topmost visible modal
                    const openModals = Array.from(document.querySelectorAll('.modal:not(.hidden)'));
                    if (openModals.length > 0) {
                        openModals[openModals.length - 1].classList.add('hidden');
                    }
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
                            if (btn && !btn.disabled) {
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

    if (typeof window !== 'undefined') {
        window.initUiChrome = initUiChrome;
        window.addEventListener('load', ensureLucideIcons);
    }

    document.addEventListener('DOMContentLoaded', initUiChrome);
})();
