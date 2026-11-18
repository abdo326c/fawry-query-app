import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// Supports environment-based Staging / Preview deployments (Vite / Vercel env vars)
// while falling back cleanly to the production public URL and anon key for zero-build static hosting.
// The anon key is designed to be public; all data access is protected by PostgreSQL Row Level Security (RLS).
const env = (typeof import.meta !== 'undefined' && import.meta && import.meta.env) ? import.meta.env : {};
const supabaseUrl = env.VITE_SUPABASE_URL || 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export const supabase = createClient(supabaseUrl, supabaseKey);
