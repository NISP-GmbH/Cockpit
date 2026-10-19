// The always-on-top pill while a program in a terminal may control the screen (screen-control.js
// paints it once a second). Stop revokes every grant at once, like Ctrl+Alt+Esc.
(function () {
  const api = window.sshApi;
  const text = document.getElementById('text');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  document.getElementById('stop').addEventListener('click', () => api.screenStop());
  api.onScreenIndicator((d) => {
    const items = (d && d.items) || [];
    const one = (it) => '<b>' + esc(it.title) + '</b>' + (it.left == null ? '' : ' · ' + it.left + ' min');
    text.innerHTML =
      (items.length === 1 ? one(items[0]) + ' controls the screen' : items.map(one).join(', ') + ' control the screen') +
      ' · ' + esc((d && d.stopKey) || 'Ctrl+Alt+Esc');
    text.title = text.textContent;
  });
})();
