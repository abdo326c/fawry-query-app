/* Workspace UI Chrome Enhancements — Works cleanly alongside app.js */
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.lucide) window.lucide.createIcons();

        // 1. Sidebar Collapse Toggle
        const appLayout = document.querySelector('.app-layout');
        const btnCollapse = document.getElementById('btn-toggle-sidebar-rail');
        try {
            if (localStorage.getItem('spdb-sidebar-rail') === 'collapsed' && appLayout) {
                appLayout.classList.add('sidebar-collapsed');
            }
        } catch (e) { /* ignore */ }

        if (btnCollapse && appLayout) {
            btnCollapse.addEventListener('click', () => {
                appLayout.classList.toggle('sidebar-collapsed');
                try {
                    localStorage.setItem(
                        'spdb-sidebar-rail',
                        appLayout.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded'
                    );
                } catch (e) { /* ignore */ }
            });
        }

        // 2. Show / Hide Password toggle on Auth screen
        const btnEye = document.getElementById('btn-toggle-auth-password');
        const pwInput = document.getElementById('auth-password');
        if (btnEye && pwInput) {
            btnEye.addEventListener('click', () => {
                const isPw = pwInput.type === 'password';
                pwInput.type = isPw ? 'text' : 'password';
                btnEye.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
            });
        }

        // 3. Header "Tools" dropdown popovers
        document.querySelectorAll('[data-dropdown-toggle]').forEach(trigger => {
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

        document.addEventListener('click', () => {
            document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.action-dropdown-menu.open').forEach(m => m.classList.remove('open'));
            }
        });
    });
})();
