// Probe 2b: wait for session rows, click the '可行性分析' one, capture assistant DOM markers.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:3080';
const SHOT = path.join(__dirname, 'shot1.png');
const OUT = path.join(__dirname, 'out2b.json');

async function main() {
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profiles', 'p2b'), {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const report = {};
  try {
    await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 });
    // wait until a session row title appears
    let titles = [];
    try {
      await page.waitForFunction(() => document.body.innerText.includes('可行性分析'), { timeout: 25000 });
      await page.waitForTimeout(3000);
      titles = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button,[role="button"]'));
        return els.map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60), text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) })).filter((x) => x.text.length > 0);
      });
    } catch (e) { report.waitErr = String(e); }
    report.rowCandidates = titles.slice(0, 25);

    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div,span,li,a,p'));
      const cands = all.filter((e) => {
        const t = (e.textContent || '').trim();
        if (!/可行性分析/.test(t) || t.length > 100) return false;
        // leaf-ish: no descendant element that also matches
        return !Array.from(e.children).some((c) => /可行性分析/.test((c.textContent || '').slice(0, 100)));
      });
      if (!cands.length) return false;
      const el = cands[cands.length - 1];
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    report.clicked = clicked;
    await page.waitForTimeout(10000);

    report.dom = await page.evaluate(() => {
      const out = {};
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind]'));
      out.seatKinds = {};
      for (const s of seats) {
        const k = s.getAttribute('data-chat-flow-kind');
        out.seatKinds[k] = (out.seatKinds[k] || 0) + 1;
      }
      const thinks = Array.from(document.querySelectorAll('[data-variant="think"]'));
      out.thinkCount = thinks.length;
      if (thinks[0]) {
        out.thinkSample = {
          state: thinks[0].getAttribute('data-state'),
          textHead: (thinks[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150),
        };
        let n = thinks[0];
        for (let i = 0; i < 12 && n; i++) {
          if (n.hasAttribute && n.hasAttribute('data-chat-flow-kind')) { out.thinkSeatKind = n.getAttribute('data-chat-flow-kind'); break; }
          n = n.parentElement;
        }
      }
      out.streaming = document.querySelectorAll('[data-streaming]').length;
      for (const s of seats) {
        if (s.getAttribute('data-chat-flow-kind') === 'assistant-step') {
          out.assistantSeatSample = {
            hasThink: !!s.querySelector('[data-variant="think"]'),
            textLen: (s.textContent || '').length,
            textHead: (s.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
          };
          break;
        }
      }
      out.bodyTextHead = document.body.innerText.slice(0, 180).replace(/\n+/g, ' | ');
      return out;
    });

    await page.screenshot({ path: SHOT });
  } catch (e) {
    report.fatal = String(e).slice(0, 400);
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
