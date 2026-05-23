import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// The credentials provided by the user
const supabaseUrl = 'https://hjtxdyuevxcezxzbiiqk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ';

export const supabase = createClient(supabaseUrl, supabaseKey);
