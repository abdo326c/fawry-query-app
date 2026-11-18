import React from 'react';
import { AppProvider } from './context/AppContext';
import { AuthOverlay } from './components/AuthOverlay';
import { Sidebar } from './components/Sidebar';
import { TopHeader } from './components/TopHeader';
import { DashboardView } from './components/views/DashboardView';
import { TransactionsView } from './components/views/TransactionsView';
import { ForeignTransactionsView } from './components/views/ForeignTransactionsView';
import { MappingsView } from './components/views/MappingsView';
import { FixesView } from './components/views/FixesView';
import { StudentsView } from './components/views/StudentsView';
import { AutoMatcherView } from './components/views/AutoMatcherView';
import { PaymentLinksView } from './components/views/PaymentLinksView';
import { ErpExportView } from './components/views/ErpExportView';
import { SettlementView } from './components/views/SettlementView';
import { UsersRolesView } from './components/views/UsersRolesView';
import { AppModals } from './components/modals/AppModals';

export const AppShell: React.FC = () => (
  <>
    <div id="toast-container" className="toast-container" />
    <AuthOverlay />
    <div className="app-layout">
      <Sidebar />
      <div className="workspace-column">
        <TopHeader />
        <main className="main-content">
          <DashboardView />
          <TransactionsView />
          <ForeignTransactionsView />
          <MappingsView />
          <FixesView />
          <StudentsView />
          <AutoMatcherView />
          <PaymentLinksView />
          <ErpExportView />
          <SettlementView />
          <UsersRolesView />
        </main>
      </div>
    </div>
    <AppModals />
  </>
);

export const App: React.FC = () => (
  <AppProvider>
    <AppShell />
  </AppProvider>
);

export default App;
