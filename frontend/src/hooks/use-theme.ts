import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('adk-theme-v2');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage can be blocked; fall through to the OS preference
  }
  // Light is the primary experience; dark is opt-in via the toggle.
  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('adk-theme-v2', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
