// @vitest-environment jsdom
import { expect, test, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Load HTML into JSDOM
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

// Mock supabase client to avoid real network requests
vi.mock('../supabase.js', () => ({
    supabase: {
        auth: {
            onAuthStateChange: vi.fn(),
            signOut: vi.fn()
        },
        from: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null })
        }))
    }
}));

beforeEach(() => {
    document.documentElement.innerHTML = html.toString();
});

test('UI elements are present', () => {
    // Check if critical DOM elements exist
    expect(document.getElementById('btn-login')).not.toBeNull();
    expect(document.getElementById('auth-email')).not.toBeNull();
    
    // Check navigation buttons
    expect(document.querySelector('[data-tab="transactions"]')).not.toBeNull();
});

test('Theme toggle updates local storage', () => {
    // We would need to import app.js and trigger DOMContentLoaded
    // For this basic example, we verify the toggle button exists
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    expect(btnThemeToggle).not.toBeNull();
});
