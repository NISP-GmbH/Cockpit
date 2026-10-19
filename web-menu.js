'use strict';

// The right-click menu of web tabs. Chromium hands the main process what was clicked (the
// context-menu params: an image's srcURL, a link, the selection, an editable field); this
// decides which entries that click gets and runs the one picked. Kept free of Electron so
// it can be tested on its own - main.js passes the page's webContents and a few helpers in.

const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
const LENS = 'https://lens.google.com/uploadbyurl?url=';
const SEARCH = 'https://www.google.com/search?q=';

function shorten(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * The entries for one right-click, top to bottom: { id, label, enabled?, arg? } or
 * { type: 'separator' }. nav = { canGoBack, canGoForward }.
 */
function webMenuItems(p = {}, nav = {}) {
  const out = [];
  const sep = () => {
    if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
  };
  const f = p.editFlags || {};
  const sel = String(p.selectionText || '').trim();
  const isImage = p.mediaType === 'image' && !!p.srcURL;

  // A misspelled word in a text field: the suggestions come first, as in Chrome.
  if (p.isEditable && p.misspelledWord) {
    const sugg = (p.dictionarySuggestions || []).slice(0, 5);
    for (const s of sugg) out.push({ id: 'spell', arg: s, label: s });
    if (!sugg.length) out.push({ id: 'none', label: 'No spelling suggestions', enabled: false });
    sep();
  }
  if (isImage) {
    const web = isHttp(p.srcURL); // a data: or blob: address is no use outside this page
    out.push(
      { id: 'img-save', label: 'Save image as…' },
      { id: 'img-copy', label: 'Copy image' },
      { id: 'img-copy-url', label: 'Copy image address', enabled: web },
      { id: 'img-open', label: 'Open image in new tab', enabled: web },
      { id: 'img-lens', label: 'Search image with Google Lens', enabled: web }
    );
    sep();
  }
  if (p.linkURL) {
    out.push(
      { id: 'link-open', label: 'Open link in new tab', enabled: isHttp(p.linkURL) },
      { id: 'link-copy', label: 'Copy link address' },
      { id: 'link-save', label: 'Save link as…', enabled: isHttp(p.linkURL) }
    );
    sep();
  }
  if (p.isEditable) {
    out.push(
      { id: 'cut', label: 'Cut', enabled: !!f.canCut },
      { id: 'copy', label: 'Copy', enabled: !!f.canCopy },
      { id: 'paste', label: 'Paste', enabled: !!f.canPaste },
      { id: 'selectall', label: 'Select all', enabled: f.canSelectAll !== false }
    );
    if (sel) out.push({ id: 'note', label: '📝 Save as a sticky note' });
    sep();
  } else if (sel) {
    out.push(
      { id: 'copy', label: 'Copy' },
      { id: 'note', label: '📝 Save as a sticky note' },
      { id: 'search', label: 'Search Google for "' + shorten(sel, 30) + '"' }
    );
    sep();
  }
  // Nothing in particular under the pointer: the page itself.
  if (!isImage && !p.linkURL && !p.isEditable && !sel) {
    out.push(
      { id: 'back', label: 'Back', enabled: !!nav.canGoBack },
      { id: 'forward', label: 'Forward', enabled: !!nav.canGoForward },
      { id: 'reload', label: 'Reload' }
    );
    sep();
  }
  out.push({ id: 'inspect', label: 'Inspect' });
  return out;
}

/**
 * Run one entry. wc = the page's webContents; deps = { clipboard, openTab(url), note(text),
 * nav: { goBack, goForward } }.
 */
function runWebMenu(item, p, wc, deps) {
  const sel = String(p.selectionText || '').trim();
  switch (item.id) {
    case 'spell':
      return wc.replaceMisspelling(item.arg);
    case 'img-save':
      return wc.downloadURL(p.srcURL); // the Save dialog comes from the session's download
    case 'img-copy':
      return wc.copyImageAt(p.x, p.y); // the pixels, as the page shows them
    case 'img-copy-url':
      return deps.clipboard.writeText(p.srcURL);
    case 'img-open':
      return deps.openTab(p.srcURL);
    case 'img-lens':
      return deps.openTab(LENS + encodeURIComponent(p.srcURL));
    case 'link-open':
      return deps.openTab(p.linkURL);
    case 'link-copy':
      return deps.clipboard.writeText(p.linkURL);
    case 'link-save':
      return wc.downloadURL(p.linkURL);
    case 'cut':
      return wc.cut();
    case 'copy':
      return wc.copy();
    case 'paste':
      return wc.paste();
    case 'selectall':
      return wc.selectAll();
    case 'note':
      return deps.note(sel);
    case 'search':
      return deps.openTab(SEARCH + encodeURIComponent(sel));
    case 'back':
      return deps.nav.goBack();
    case 'forward':
      return deps.nav.goForward();
    case 'reload':
      return wc.reload();
    case 'inspect':
      return wc.inspectElement(p.x, p.y);
    default:
      return undefined;
  }
}

module.exports = { webMenuItems, runWebMenu, isHttp, LENS, SEARCH };
