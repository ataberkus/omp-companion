// Runs before the page paints (app.js loads at the end of <body>): the saved theme and sidebar width apply without a flash.
try {
  const t = localStorage.getItem('omp-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  const w = Number(localStorage.getItem('omp-side-w'));
  if (w >= 220 && w <= 520) document.documentElement.style.setProperty('--side-w', w + 'px');
} catch {}
// Phones, touch screens and data-saving or slow links get html.lean (and .low-data) before the first paint, so app.css
// drops its costly effects from the start; app.js keeps the classes current (rotation, a changed connection).
try {
  const c = navigator.connection, low = !!c && (c.saveData === true || /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''));
  const lean = low || matchMedia('(max-width: 820px), (pointer: coarse)').matches;
  if (lean) document.documentElement.classList.add('lean');
  if (low) document.documentElement.classList.add('low-data');
} catch {}
