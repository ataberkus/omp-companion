// Runs before the page paints (app.js loads at the end of <body>): the saved theme and sidebar width apply without a flash.
try {
  const t = localStorage.getItem('omp-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  const w = Number(localStorage.getItem('omp-side-w'));
  if (w >= 220 && w <= 520) document.documentElement.style.setProperty('--side-w', w + 'px');
} catch {}
