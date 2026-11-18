import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { AppTab, FawryAppController, UserRole } from '../types/domain';

declare global {
  interface Window {
    app?: FawryAppController;
    lucide?: { createIcons: (opts?: { root?: Element | null }) => void };
  }
}

export interface AppContextValue {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  userEmail: string | null;
  userRole: UserRole;
  controller: FawryAppController | null;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTabState] = useState<AppTab>('dashboard');
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('light')
      ? 'light'
      : 'dark'
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('spdb-sidebar-rail') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole>('viewer');
  const [controller, setController] = useState<FawryAppController | null>(() =>
    typeof window !== 'undefined' && window.app ? window.app : null
  );

  useEffect(() => {
    const syncFromController = () => {
      if (typeof window !== 'undefined' && window.app) {
        setController(window.app);
        setUserEmail(window.app.currentUser?.email ?? null);
        setUserRole((window.app.userRole as UserRole) || 'viewer');
      }
      if (typeof document !== 'undefined') {
        setTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
        const activeNav = document.querySelector('.nav-link.active[data-tab]');
        const tabAttr = activeNav?.getAttribute('data-tab') as AppTab | null;
        if (tabAttr) {
          setActiveTabState(tabAttr);
        }
      }
    };

    syncFromController();
    const onNavClick = (e: Event) => {
      const target = (e.target as Element | null)?.closest?.('.nav-link[data-tab]');
      const tab = target?.getAttribute('data-tab') as AppTab | null;
      if (tab) {
        setActiveTabState(tab);
      }
      syncFromController();
    };

    document.addEventListener('click', onNavClick);
    return () => {
      document.removeEventListener('click', onNavClick);
    };
  }, []);

  const setActiveTab = useCallback((tab: AppTab) => {
    setActiveTabState(tab);
    const navLink = document.querySelector(`.nav-link[data-tab="${tab}"]`) as HTMLElement | null;
    if (navLink) {
      navLink.click();
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const htmlEl = document.documentElement;
    const wasLight = htmlEl.classList.contains('light');
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      btn.click();
    }
    const isNowLight = htmlEl.classList.contains('light');
    if (isNowLight === wasLight) {
      if (wasLight) {
        htmlEl.classList.remove('light');
        htmlEl.classList.add('dark');
      } else {
        htmlEl.classList.remove('dark');
        htmlEl.classList.add('light');
      }
    }
    setTheme(htmlEl.classList.contains('light') ? 'light' : 'dark');
  }, []);

  const toggleSidebar = useCallback(() => {
    const btn = document.getElementById('btn-toggle-sidebar-rail');
    if (btn) {
      btn.click();
      const layout = document.querySelector('.app-layout');
      setSidebarCollapsed(Boolean(layout?.classList.contains('sidebar-collapsed')));
    } else {
      setSidebarCollapsed(prev => !prev);
    }
  }, []);

  return (
    <AppContext.Provider
      value={{
        activeTab,
        setActiveTab,
        theme,
        toggleTheme,
        sidebarCollapsed,
        toggleSidebar,
        userEmail,
        userRole,
        controller
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return ctx;
}
