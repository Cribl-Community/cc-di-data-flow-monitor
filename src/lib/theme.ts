import { useEffect } from 'react';
import type { UserPreferences } from './types';

// Capra's dark tokens are applied via a `.dark` class (see node_modules/@capra/theme/dist/base.css)
// rather than a `data-theme` attribute or prefers-color-scheme media query — there is no
// automatic system-preference handling built in, so "system" mode is resolved here and kept in
// sync with the OS setting for as long as the app is open.

function resolveIsDark(theme: UserPreferences['theme']): boolean {
  return theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
}

export function useApplyTheme(theme: UserPreferences['theme']): void {
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');

    const apply = () => {
      root.classList.toggle('dark', resolveIsDark(theme));
    };

    apply();

    if (theme === 'system' && media) {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    return undefined;
  }, [theme]);
}
