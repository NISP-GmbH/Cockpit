'use strict';

// Runs inside each web <webview> guest. Adds Ctrl/Cmd + mouse-wheel page zoom
// (there is no browser chrome to do it for us) plus Ctrl/Cmd + 0 to reset, and
// forwards Ctrl/Cmd+F to the host so its find bar opens even when the page has focus.
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
