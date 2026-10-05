// Run before styles and React, including under the production script-src 'self' CSP.
// The site is permanently dark (route A): no storage read, no light branch.
(() => {
  const root = document.documentElement;
  root.classList.add('zeus');
  root.classList.add('dark');
  root.style.colorScheme = 'dark';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', '#262626');
})();
