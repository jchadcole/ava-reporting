'use strict';
// Light and dark mode. Loaded in <head> so the page never flashes the wrong theme.
// Choice order: ?theme=light|dark|auto in the URL (handy for a Genesys Cloud Client App URL),
// then the viewer's saved choice, then Auto, which follows the computer's setting.
(function () {
  const KEY = 'ava-theme';
  const VALID = ['auto', 'light', 'dark'];
  const root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch { /* storage blocked, e.g. in some iframes */ }
  }

  let fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get('theme'); } catch { /* ignore */ }
  let choice = VALID.includes(fromUrl) ? fromUrl : (VALID.includes(saved()) ? saved() : 'auto');

  function apply() {
    // The stylesheet handles Auto through prefers-color-scheme; a forced choice sets data-theme.
    if (choice === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
    });
  }
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const sw = document.getElementById('theme-switch');
    if (!sw) return;
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme-choice]');
      if (!b) return;
      choice = b.dataset.themeChoice;
      save(choice);
      apply();
    });
  });
})();
