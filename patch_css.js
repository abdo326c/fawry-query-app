const fs = require('fs');

// 1. Update CSS
let css = fs.readFileSync('styles.css', 'utf8');

const oldUploadCSS = \.upload-zone {
    border: 2px dashed var(--border-color);
    border-radius: 1.25rem;
    padding: 4rem 2rem;
    text-align: center;
    transition: all 0.3s ease;
    cursor: pointer;
    background-color: rgba(0, 0, 0, 0.2);
    position: relative;
    overflow: hidden;
}

.upload-zone::after {
    content: '';
    position: absolute;
    top: -50%; left: -50%; width: 200%; height: 200%;
    background: radial-gradient(circle, var(--primary-glow) 0%, transparent 60%);
    opacity: 0;
    transition: opacity 0.3s;
    pointer-events: none;
}

.upload-zone:hover::after, .upload-zone.dragover::after {
    opacity: 1;
}

.upload-zone:hover, .upload-zone.dragover {
    border-color: var(--primary);
}

.upload-icon {
    width: 48px;
    height: 48px;
    color: var(--primary);
    margin-bottom: 1rem;
    filter: drop-shadow(0 0 8px var(--primary-glow));
}

.upload-zone h3 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--text-main);
}\;

const newUploadCSS = \.upload-zone {
    border: 2px dashed rgba(255, 255, 255, 0.15);
    border-radius: 1.5rem;
    padding: 5rem 2rem;
    text-align: center;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
    background: linear-gradient(145deg, rgba(30, 41, 59, 0.4), rgba(15, 23, 42, 0.6));
    backdrop-filter: blur(10px);
    position: relative;
    overflow: hidden;
    box-shadow: inset 0 0 20px rgba(0,0,0,0.2);
}

.upload-zone::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at center, var(--primary-glow) 0%, transparent 70%);
    opacity: 0;
    transition: opacity 0.4s ease;
    pointer-events: none;
    z-index: 0;
}

.upload-zone > * {
    position: relative;
    z-index: 1;
}

.upload-zone:hover, .upload-zone.dragover {
    border-color: var(--primary);
    transform: translateY(-2px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.3), inset 0 0 20px rgba(0,0,0,0.2);
}
.upload-zone:hover::before, .upload-zone.dragover::before {
    opacity: 0.15;
}

.upload-icon {
    width: 64px;
    height: 64px;
    color: var(--primary);
    margin-bottom: 1.5rem;
    filter: drop-shadow(0 0 12px var(--primary-glow));
    transition: transform 0.4s ease;
}

.upload-zone:hover .upload-icon {
    transform: scale(1.1) translateY(-5px);
}

.upload-zone h3 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--text-main);
    letter-spacing: -0.02em;
}\;

css = css.replace(oldUploadCSS, newUploadCSS);

const oldProgressCSS = \.progress-bar {
    width: 100%;
    height: 8px;
    background-color: rgba(0,0,0,0.4);
    border-radius: 999px;
    overflow: hidden;
    margin: 1rem 0;
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);
}

.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00b8d4, var(--primary));
    width: 0%;
    transition: width 0.3s ease;
}\;

const newProgressCSS = \.progress-bar {
    width: 100%;
    height: 14px;
    background-color: rgba(0,0,0,0.5);
    border-radius: 999px;
    overflow: hidden;
    margin: 1.5rem 0;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.6);
    position: relative;
}

.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00b8d4, var(--primary), #00b8d4);
    background-size: 200% 100%;
    width: 0%;
    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 999px;
    box-shadow: 0 0 15px var(--primary-glow);
    animation: gradientMove 2s linear infinite;
}

@keyframes gradientMove {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
}\;

css = css.replace(oldProgressCSS, newProgressCSS);

const oldLogCSS = \.log-console {
    background-color: #030509;
    border-radius: 0.75rem;
    padding: 1rem;
    font-family: 'Courier New', monospace;
    font-size: 0.8rem;
    color: #a3e635;
    height: 150px;
    overflow-y: auto;
    border: 1px solid var(--border-color);
}\;

const newLogCSS = \.log-console {
    background-color: rgba(10, 15, 25, 0.6);
    border-radius: 1rem;
    padding: 1.25rem;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 0.875rem;
    color: var(--text-muted);
    height: 220px;
    overflow-y: auto;
    border: 1px solid rgba(255,255,255,0.05);
    box-shadow: inset 0 4px 20px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.log-entry {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: rgba(255,255,255,0.02);
    animation: slideIn 0.3s ease forwards;
    opacity: 0;
    transform: translateY(10px);
    line-height: 1.4;
}

@keyframes slideIn {
    to { opacity: 1; transform: translateY(0); }
}

.log-time {
    font-variant-numeric: tabular-nums;
    color: #64748b;
    font-size: 0.75rem;
    margin-top: 0.1rem;
    white-space: nowrap;
}

.log-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
}

.log-info { border-left: 2px solid #3b82f6; color: #cbd5e1; }
.log-success { border-left: 2px solid #10b981; color: #a7f3d0; background: rgba(16, 185, 129, 0.05); }
.log-error { border-left: 2px solid #ef4444; color: #fecaca; background: rgba(239, 68, 68, 0.05); }

.log-info svg { color: #3b82f6; }
.log-success svg { color: #10b981; }
.log-error svg { color: #ef4444; }
\;

css = css.replace(oldLogCSS, newLogCSS);

fs.writeFileSync('styles.css', css);
console.log('CSS updated successfully!');
