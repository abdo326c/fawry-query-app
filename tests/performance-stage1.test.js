import { describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../supabase.js', () => ({
  supabase: {}
}));

import {
  readIndexedDbCache,
  writeIndexedDbCache,
  clearIndexedDbCache
} from '../app-utils.js';

const rootDir = path.resolve(__dirname, '..');

describe('Stage 1 Multi-User Performance Optimizations & DB Storage Meter', () => {
  test('migration 2.11.6 and schema.sql define partial index, badge RPC, student version RPC, and storage meter RPC', () => {
    const migSql = fs.readFileSync(path.join(rootDir, 'migrations/2.11.6_multiuser_performance_and_storage_meter.sql'), 'utf8');
    const schemaSql = fs.readFileSync(path.join(rootDir, 'schema.sql'), 'utf8');

    const tokens = [
      'CREATE INDEX IF NOT EXISTS idx_transactions_nonvalid_id_status',
      'CREATE OR REPLACE FUNCTION public.get_unresolved_tx_count()',
      'CREATE OR REPLACE FUNCTION public.trg_touch_student_master_updated_at()',
      'CREATE TRIGGER trg_student_master_touch_updated_at',
      'CREATE OR REPLACE FUNCTION public.get_student_master_version()',
      'CREATE OR REPLACE FUNCTION public.get_database_storage_stats()'
    ];

    for (const sql of [migSql, schemaSql]) {
      for (const token of tokens) {
        expect(sql, `Missing SQL token: ${token}`).toContain(token);
      }
    }
  });

  test('rules.js caps parallel bursts to 4 concurrent requests per user', () => {
    const rulesSrc = fs.readFileSync(path.join(rootDir, 'rules.js'), 'utf8');
    expect(rulesSrc).toContain('const PARALLEL_CHUNKS = 4;');
    expect(rulesSrc).toContain('concurrency = 4) {');
    expect(rulesSrc).toContain('idChunkSize = 300, concurrency = 4');
    expect(rulesSrc).not.toContain('const PARALLEL_CHUNKS = 12;');
  });

  test('IndexedDB cache helpers degrade gracefully when indexedDB is unavailable', async () => {
    expect(await readIndexedDbCache('student_master_v1')).toBeNull();
    expect(await writeIndexedDbCache('student_master_v1', { rows: [] })).toBe(false);
    expect(await clearIndexedDbCache('student_master_v1')).toBe(false);
  });
});
