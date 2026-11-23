/**
 * TransPrice — theme helper for extension pages (ES module).
 * applyTheme('auto' | 'light' | 'dark') sets <html data-theme> (see tokens.css) and follows the OS in auto mode.
 * Typical boot: `applyTheme((await getSettings()).theme)`, then call it again from a settings-change listener.
 */

let mediaQuery = null;
let mediaListener = null;

/** 'light' | 'dark' for a setting value ('auto' → the OS preference). */
export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Apply a theme setting to `root` (default <html>); in 'auto' mode keep following OS changes until the next call. */
export function applyTheme(theme = 'auto', root = document.documentElement) {
  if (mediaQuery && mediaListener) mediaQuery.removeEventListener('change', mediaListener);
  mediaQuery = null;
  mediaListener = null;

  root.dataset.theme = resolveTheme(theme);

  if (theme === 'auto' && typeof matchMedia === 'function') {
    mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    mediaListener = () => {
      root.dataset.theme = resolveTheme('auto');
    };
    mediaQuery.addEventListener('change', mediaListener);
  }
}
