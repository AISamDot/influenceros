'use client';

import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

/** Light/dark toggle. The initial theme is applied before paint by the inline script in the root layout. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('troupe-theme', next);
    } catch {}
    setTheme(next);
  };
  return (
    <button type="button" onClick={flip} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
      {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );
}
