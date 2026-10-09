import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// Supabase project URL and the PUBLIC anon key.
// The anon key is designed to be public; data is protected by Row Level Security (see README).
const supabaseUrl = 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export const supabase = createClient(supabaseUrl, supabaseKey);
