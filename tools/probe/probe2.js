// Probe 2: open an existing session and capture assistant message DOM markers + screenshot.
const { chromium } = require('playwright-core');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:3080';
const SHOT = path.join(__dirname, 'shot1.png');
const OUT = path.join(__dirname, 'out2.json');

async function main() {
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profiles', 'p2'), {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const report = {};
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)));
  try {
    await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 });
    await page.waitForTimeout(8000);

    // Open the session whose title mentions 划词/插件 (the feasibility-analysis chat).
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], li, div'));
      const target = els.find((el) => {
        const t = (el.textContent || '').trim();
        return t.length > 4 && t.length < 60 && /划词|插件/.test(t) && !el.querySelector('button,[role="button"]');
      });
      if (!target) return false;
      target.click();
      return true;
    });
    report.clicked = clicked;
    await page.waitForTimeout(9000);

    report.dom = await page.evaluate(() => {
      const out = { seats: [], thinkAttrs: [], streaming: 0, anchorKeys: new Set() };
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind]'));
      out.seatKinds = {};
      for (const s of seats) {
        const k = s.getAttribute('data-chat-flow-kind');
        out.seatKinds[k] = (out.seatKinds[k] || 0) + 1;
        out.anchorKeys.add(s.getAttribute('data-chat-anchor-key'));
      }
      out.anchorKeys = Array.from(out.anchorKeys).slice(0, 10);
      const thinks = Array.from(document.querySelectorAll('[data-variant="think"]'));
      out.thinkCount = thinks.length;
      if (thinks[0]) {
        const el = thinks[0];
        out.thinkSample = {
          variant: el.getAttribute('data-variant'),
          state: el.getAttribute('data-state'),
          textHead: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        };
        // climb to seat
        let n = el;
        for (let i = 0; i < 10 && n; i++) {
          if (n.hasAttribute && n.hasAttribute('data-chat-flow-kind')) { out.thinkSeatKind = n.getAttribute('data-chat-flow-kind'); break; }
          n = n.parentElement;
        }
      }
      out.streaming = document.querySelectorAll('[data-streaming]').length;
      // find an assistant seat sample incl. think + text
      for (const s of seats) {
        if (s.getAttribute('data-chat-flow-kind') === 'assistant-step') {
          const textLen = (s.textContent || '').length;
          out.assistantSeatSample = {
            hasThink: !!s.querySelector('[data-variant="think"]'),
            textLen,
            textHead: (s.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220),
          };
          break;
        }
      }
      return out;
    });

    await page.screenshot({ path: SHOT });
    report.consoleErrs = errs.slice(0, 10);
  } catch (e) {
    report.fatal = String(e).slice(0, 500);
  }
  require('fs').writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
