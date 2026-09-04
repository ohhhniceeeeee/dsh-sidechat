// Diagnostic: why did answer selection fail? Dump session-open state details.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const URL_BASE = 'http://127.0.0.1:3080';
const OUT = path.join(__dirname, 'out-diag.json');

async function main() {
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profiles', 'pdiag'), {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const report = {};
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  try {
    await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 });
    await page.waitForTimeout(8000);
    report.hasFeasible = await page.waitForFunction(() => document.body.innerText.includes('可行性分析'), { timeout: 20000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1500);
    report.clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div,span,li,a,p'));
      const cands = all.filter((e) => {
        const t = (e.textContent || '').trim();
        if (!/可行性分析/.test(t) || t.length > 100) return false;
        return !Array.from(e.children).some((c) => /可行性分析/.test((c.textContent || '').slice(0, 100)));
      });
      if (!cands.length) return 'no-candidate';
      cands[cands.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked:' + cands.length;
    });
    await page.waitForTimeout(10000);
    report.state = await page.evaluate(() => {
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind]'));
      const kinds = {};
      seats.forEach((s) => { const k = s.getAttribute('data-chat-flow-kind'); kinds[k] = (kinds[k] || 0) + 1; });
      const as = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]'));
      const lens = as.map((s) => (s.textContent || '').length).sort((a, b) => b - a).slice(0, 6);
      return {
        kinds,
        streaming: document.querySelectorAll('[data-streaming]').length,
        topAssistantLens: lens,
        bodyTextHead: (document.body.innerText || '').slice(0, 220).replace(/\n+/g, ' | '),
      };
    });
  } catch (e) {
    report.fatal = String(e).slice(0, 400);
  }
  report.pageErrors = errs.slice(0, 8);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
