export type UserRole = 'viewer' | 'operator' | 'accountant' | 'admin' | 'none' | 'deactivated';

export type AppTab =
  | 'dashboard'
  | 'transactions'
  | 'foreign-transactions'
  | 'settlement'
  | 'mappings'
  | 'fixes'
  | 'automatcher'
  | 'student-master'
  | 'payment-links'
  | 'erp-export'
  | 'users-roles';

export type StudentLevel = 'UG' | 'PG' | '' | null;

export type IdStatus =
  | 'Valid'
  | 'Exempt'
  | 'Missing ID'
  | 'Error: Text/Name detected'
  | string;

export interface TransactionRecord {
  id?: number;
  reference_number: string;
  payment_date: string | null;
  student_id: string | null;
  original_student_id?: string | null;
  raw_student_id?: string | null;
  student_level?: StudentLevel;
  customer_mobile?: string | null;
  total_amount?: number;
  net_amount?: number;
  fawry_fees?: number;
  payment_status?: string;
  item_name: string;
  item_price: number;
  mapping?: string | null;
  second_mapping?: string | null;
  merchant_name?: string | null;
  bank: string;
  check_column?: string | null;
  file_name?: string | null;
  id_status: IdStatus;
  batch_id?: string | null;
  erp_batch_number?: string | null;
  erp_voucher?: string | null;
  is_settled?: boolean;
  settlement_batch?: string | null;
  import_date?: string;
}

export interface ForeignTransactionRecord {
  id?: number;
  reference_number: string;
  transaction_ref?: string | null;
  transaction_code?: string;
  event?: string;
  value_date: string | null;
  transaction_date?: string | null;
  transaction_datetime?: string | null;
  amount: number;
  currency: string;
  account_number?: string | null;
  student_id: string | null;
  student_level?: StudentLevel;
  extracted_name?: string | null;
  matched_student_name?: string | null;
  handler_name?: string | null;
  deposit_method?: string;
  description?: string | null;
  id_status?: IdStatus;
  match_source?: string;
  match_confidence?: number;
  mapping?: string | null;
  second_mapping?: string | null;
  bank?: string;
  erp_batch_number?: string | null;
  erp_voucher?: string | null;
}

export interface ItemMappingRecord {
  id?: number;
  item_name: string;
  adjusted_item_name?: string | null;
  mapping: string | null;
  second_mapping?: string | null;
  created_at?: string;
}

export interface ManualFixRecord {
  id?: number;
  reference_number: string;
  correct_id?: string | null;
  item_name?: string | null;
  mapping?: string | null;
  second_mapping?: string | null;
  created_at?: string;
}

export interface StudentMasterRecord {
  student_id: string;
  full_name?: string | null;
  arabic_name?: string | null;
  national_id?: string | null;
  email?: string | null;
  personal_email?: string | null;
  mobile?: string | null;
  guardian_name?: string | null;
  guardian_mobile?: string | null;
  college?: string | null;
  program?: string | null;
  source?: string | null;
  updated_at?: string;
}

export interface PaymentLinkRecord {
  id?: number;
  name: string;
  amount: number | null;
  invoice_number?: string | null;
  creation_date?: string | null;
  expiry_date?: string | null;
  invoice_link: string;
  created_at?: string;
}

export interface SettlementBatchRecord {
  id?: number;
  created_at?: string;
  user_email?: string | null;
  batch_label: string;
  files_count: number;
  total_stl_amount: number;
  total_sys_amount: number;
  net_variance: number;
  matched_count: number;
  mismatch_count: number;
  missing_sys_count: number;
  missing_stl_count: number;
  summary_data: Record<string, unknown>;
}

export interface UserRoleRecord {
  email: string;
  role: Exclude<UserRole, 'none' | 'deactivated'>;
  is_active: boolean;
  updated_by?: string | null;
  updated_at?: string;
}

export interface AuditLogRecord {
  id: number;
  user_email: string;
  action: string;
  affected_references?: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
}

export interface FxRateEntry {
  rate: number;
  source: string;
  updatedAt?: string;
  fallbackDate?: string;
}

export interface FxStore {
  mode?: string;
  customRate?: number | null;
  latest: {
    date: string;
    rate: number;
    source: string;
    provider?: string;
    updatedAt?: string;
  } | null;
  ratesByDate: Record<string, FxRateEntry>;
  lastNoonSyncDate?: string | null;
}

export interface BusinessRulesResult {
  studentId: string | null;
  itemName: string;
  mapping: string;
  secondMapping: string | null;
  idStatus: IdStatus;
  sources?: Record<string, string>;
}

export interface FawryAppController {
  currentUser: { email?: string } | null;
  userRole: UserRole;
  loadDashboard: () => Promise<void>;
  loadTransactions: () => Promise<void>;
  loadForeignTransactions: () => Promise<void>;
  loadMappings: () => Promise<void>;
  loadFixes: () => Promise<void>;
  loadStudents: () => Promise<void>;
  loadPaymentLinks: () => Promise<void>;
  loadErpExport: () => Promise<void>;
  loadUsersAndRoles: () => Promise<void>;
  runAutoMatcher: () => Promise<void>;
  [key: string]: unknown;
}
