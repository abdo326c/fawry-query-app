import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { AppProvider, useAppContext } from './context/AppContext';
import { App as FawryApp } from '../app.js';
import type { FawryAppController } from './types/domain';

const ReactStateMonitor: React.FC = () => {
  const { activeTab, theme, userRole } = useAppContext();
  return (
    <div
      id="react-runtime-bridge"
      data-react-version={React.version}
      data-active-tab={activeTab}
      data-theme={theme}
      data-user-role={userRole}
      hidden
    />
  );
};

let mountedRoot: Root | null = null;

export function mountReactApp(container?: HTMLElement | null): Root | null {
  if (typeof document === 'undefined') return null;

  // When mounting into an empty #root (e.g. react.html), render the full React 19 component tree
  // synchronously via flushSync and then initialize the FawryApp controller on the rendered DOM.
  const target = container ?? document.getElementById('root');
  if (target && !document.querySelector('.app-layout')) {
    mountedRoot = createRoot(target);
    flushSync(() => {
      mountedRoot!.render(<App />);
    });
    if (typeof window !== 'undefined') {
      window.app = new (FawryApp as unknown as new () => FawryAppController)();
      (window as unknown as { initUiChrome?: () => void }).initUiChrome?.();
      window.lucide?.createIcons();
    }
    return mountedRoot;
  }

  // Otherwise mount non-destructive React 19 state provider alongside the hydrated DOM shell
  let bridgeEl = document.getElementById('react-root-bridge');
  if (!bridgeEl) {
    bridgeEl = document.createElement('div');
    bridgeEl.id = 'react-root-bridge';
    bridgeEl.hidden = true;
    document.body.appendChild(bridgeEl);
  }
  mountedRoot = createRoot(bridgeEl);
  mountedRoot.render(
    <AppProvider>
      <ReactStateMonitor />
    </AppProvider>
  );
  return mountedRoot;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mountReactApp();
    });
  } else {
    mountReactApp();
  }
}
