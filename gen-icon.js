// One-off: render an app icon (green >_ on a dark gradient) and write
// assets/icon.png (256) + assets/icon.ico. Run: electron gen-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
  .box{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#1d1f21 0%,#25282c 55%,#0b3d2e 100%);}
  .p{font-family:Consolas,"Cascadia Mono",monospace;font-size:${SIZE / 2}px;font-weight:700;
    color:#4ade80;text-shadow:0 24px 88px rgba(0,0,0,.55);letter-spacing:-24px}
</style></head><body><div class="box"><span class="p">&gt;_</span></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    frame: false,
    show: false,
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.webContents.capturePage()).resize({ width: SIZE, height: SIZE });
  const dir = path.join(__dirname, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.png'), img.toPNG());
  const m = require('png-to-ico');
  const pngToIco = m.default || m;
  const ico = await pngToIco(path.join(dir, 'icon.png'));
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
  console.log('Wrote assets/icon.png and assets/icon.ico');
  app.exit(0);
});
