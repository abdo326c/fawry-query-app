import React, { useLayoutEffect, useRef } from 'react';

export interface StaticHtmlBlockProps {
  tag?: 'section' | 'div' | 'aside' | 'header';
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  html: string;
}

/**
 * Renders a self-contained HTML template block once on mount and freezes
 * React re-renders on its children so imperative DOM updates (tables, TomSelect,
 * Flatpickr, Lucide icons) are never overwritten by React reconciliation.
 */
export const StaticHtmlBlock: React.FC<StaticHtmlBlockProps> = React.memo(
  ({ tag = 'div', id, className, style, html }) => {
    const ref = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
      const el = ref.current;
      if (el && el.childElementCount === 0 && html) {
        el.innerHTML = html;
        if (typeof window !== 'undefined' && window.lucide) {
          try {
            window.lucide.createIcons({ root: el });
          } catch {
            window.lucide.createIcons();
          }
        }
      }
    }, [html]);

    return React.createElement(tag, {
      ref,
      id,
      className,
      style,
      suppressHydrationWarning: true,
      dangerouslySetInnerHTML: { __html: html }
    });
  },
  () => true
);
