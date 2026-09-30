// render.mjs — draw a text projection the way a terminal shows it (light
// monospace on black, cells twice as tall as wide) and return PNG bytes. Uses
// the Playwright + Chromium the container ships with; imported lazily so the
// rest of the plugin layer never needs a browser.
import { createRequire } from 'node:module';

let browserP = null;
async function browser() {
  if (!browserP) {
    const req = createRequire(import.meta.url);
    let pw;
    try { pw = req('playwright'); } catch { pw = req('/opt/node22/lib/node_modules/playwright'); }
    browserP = pw.chromium.launch();
  }
  return browserP;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function renderTextPNG(text, { fontPx = 12 } = {}) {
  const b = await browser();
  const page = await b.newPage({ deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000">
      <pre id="t" style="margin:0;padding:6px;display:inline-block;font:${fontPx}px/${(2 * 0.602 * fontPx).toFixed(2)}px 'DejaVu Sans Mono',monospace;color:#e8e8e8;background:#000">${esc(text)}</pre></body></html>`);
    return await (await page.$('#t')).screenshot({ type: 'png' });
  } finally { await page.close(); }
}

export async function closeRenderer() { if (browserP) { (await browserP).close(); browserP = null; } }
