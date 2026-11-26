/* Runs before first paint so a saved light/dark theme never flashes the other one.
   Keep the resolution rule in sync with src/theme.ts. */
(function () {
  try {
    var saved = localStorage.getItem('front-day-theme')
    var mode = saved === 'light' || saved === 'dark' ? saved : 'auto'
    var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#090f0c' : '#f2f4ee')
  } catch (error) {
    /* localStorage can be unavailable; the app applies the saved theme after load. */
  }
})()
