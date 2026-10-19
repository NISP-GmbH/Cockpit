'use strict';

// Runs inside each web <webview> guest. Adds Ctrl/Cmd + mouse-wheel page zoom
// (there is no browser chrome to do it for us) plus Ctrl/Cmd + 0 to reset, and
// forwards Ctrl/Cmd+F and Alt+Left/Right to the host so the find bar and history
// navigation work even when the page has focus.
const { webFrame, ipcRenderer } = require('electron');

const MIN = -4;
const MAX = 6;

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); // stop the page from also scrolling/zooming
    const step = e.deltaY < 0 ? 0.5 : -0.5;
    const z = Math.max(MIN, Math.min(MAX, webFrame.getZoomLevel() + step));
    webFrame.setZoomLevel(z);
  },
  { passive: false, capture: true }
);

// Alt+Left / Alt+Right = browser history, like Chrome. Deliberately NOT on the
// capture phase and skipped when the page already handled the key: web apps that
// implement their own back/forward (code-server, for one) call preventDefault, and
// Chrome lets them win too. Everywhere else the page ignores it and we navigate.
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.defaultPrevented) return;
  e.preventDefault();
  ipcRenderer.sendToHost('web-nav', e.key === 'ArrowLeft' ? 'back' : 'forward');
});

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '0') webFrame.setZoomLevel(0);
    else if (e.key === '+' || e.key === '=') webFrame.setZoomLevel(Math.min(MAX, webFrame.getZoomLevel() + 0.5));
    else if (e.key === '-' || e.key === '_') webFrame.setZoomLevel(Math.max(MIN, webFrame.getZoomLevel() - 0.5));
    else if ((e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
      e.preventDefault(); // suppress the page's own find so the host bar is the one that opens
      ipcRenderer.sendToHost('web-find');
    }
  },
  { capture: true }
);
