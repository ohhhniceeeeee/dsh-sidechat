// DOM/iframe probe for the running DSH web GUI (read-only).
// Usage: node probe.js [outfile.json]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:3080';
const OUT = process.argv[2] || path.join(__dirname, 'out.json');

async function main() {
  const profileDir = path.join(__dirname, '.profiles', 'p' + Date.now());
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const report = { url: URL_BASE + '/?probe=1' };
  const consoleLogs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLogs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleLogs.push('pageerror: ' + String(e).slice(0, 300)));

  try {
    await page.goto(URL_BASE + '/?probe=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 }); report.boot = 'ok'; }
    catch { report.boot = 'MISSING'; }

    try { await page.waitForFunction(() => !!document.body && document.body.hasAttribute('data-ds-dark-theme'), { timeout: 30000 }); report.theme = 'ok'; }
    catch (e) { report.theme = 'timeout: ' + String(e); }

    await page.waitForTimeout(6000);

    // Phase 1: structural dump of the top-level app frame.
    report.structure = await page.evaluate(() => {
      const out = { classes: {}, textAreas: [], thinks: [], composer: null };
      const cn = (el) => (typeof el.className === 'string' ? el.className : '');
      // candidate app root: body > div tree, locate elements with big relative size
      const all = Array.from(document.querySelectorAll('div'));
      for (const el of all) {
        const c = cn(el);
        if (c.includes('pI_x6G_')) {
          const r = el.getBoundingClientRect();
          out.classes[c] = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), text: el.textContent.slice(0, 60).replace(/\s+/g, ' ') };
        }
      }
      // reasoning / thinking disclosure candidates
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (t.length > 0 && t.length < 60 && /^(思考|Reasoning|Think)/.test(t) && !el.querySelector('div,span,p')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) out.thinks.push({ text: t, cls: cn(el), w: Math.round(r.width) });
        }
      }
      // composer input candidates
      const inp = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      if (inp) {
        const chain = [];
        let n = inp;
        for (let i = 0; i < 6 && n; i++) { chain.push(n.tagName + '.' + cn(n).split(/\s+/).slice(0, 2).join('.')); n = n.parentElement; }
        out.composer = { cls: cn(inp), chain };
      }
      // body text length + any visible user/assistant row markers
      out.bodyTextLen = document.body.innerText.length;
      out.bodyTextHead = document.body.innerText.slice(0, 200).replace(/\n+/g, ' | ');
      return out;
    });

    // For each think label, climb to its message-ish container and record text span.
    const thinks = report.structure.thinks || [];
    report.messageSamples = await page.evaluate((thinks) => {
      const cn = (el) => (typeof el.className === 'string' ? el.className : '');
      const out = [];
      for (const th of thinks) {
        const label = Array.from(document.querySelectorAll('div,span,p')).find((el) => (el.textContent || '').trim() === th.text);
        if (!label) continue;
        let node = label;
        for (let i = 0; i < 8 && node; i++) {
          const txt = (node.textContent || '').trim();
          if (txt.length > 120) {
            out.push({ from: th.text.slice(0, 30), containerCls: cn(node), textHead: txt.replace(/\s+/g, ' ').slice(0, 180) });
            break;
          }
          node = node.parentElement;
        }
      }
      return out;
    }, thinks);

    // Phase 2: same-origin iframe second instance boot test.
    const iframeProbe = await page.evaluate(async () => {
      const iframe = document.createElement('iframe');
      iframe.id = 'probe-iframe';
      iframe.width = '720';
      iframe.height = '900';
      iframe.src = location.origin + '/?dsh_sidechat=1';
      document.body.appendChild(iframe);
      const res = { loaded: false };
      await new Promise((resolve) => {
        iframe.addEventListener('load', () => resolve(), { once: true });
        setTimeout(resolve, 15000);
      });
      try {
        const w = iframe.contentWindow;
        res.loaded = true;
        res.boot = !!w.__DSH_BOOT__;
        await new Promise((r) => setTimeout(r, 12000));
        const d = w.document;
        res.bodyTheme = d.body ? d.body.getAttribute('data-ds-dark-theme') : null;
        const cols = {};
        d.querySelectorAll('div').forEach((el) => {
          const c = typeof el.className === 'string' ? el.className : '';
          if (c.includes('pI_x6G_')) {
            const r = el.getBoundingClientRect();
            cols[c] = { w: Math.round(r.width), h: Math.round(r.height) };
          }
        });
        res.cols = cols;
        res.bodyTextHead = (d.body ? d.body.innerText : '').slice(0, 150).replace(/\n+/g, ' | ');
        res.consoleErr = [];
      } catch (e) {
        res.error = String(e);
      }
      iframe.remove();
      return res;
    });
    report.iframe = iframeProbe;
  } catch (e) {
    report.fatal = String(e);
  }
  report.consoleLogs = consoleLogs.slice(0, 20);
  await context.close();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
