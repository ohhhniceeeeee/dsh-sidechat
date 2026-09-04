// Probe 4: regression check for "Ask button flashes away during thinking".
// Simulates the auto-scroll that streaming appends cause: after the Ask button
// appears over an answer selection, scroll the conversation container and
// assert the button survives and re-anchors (old bug: any scroll hid it).
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:3080';
const OUT = path.join(__dirname, 'out4.json');

async function main() {
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profiles', 'p4'), {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const report = {};
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });

  const selectAnswer = () =>
    page.evaluate(() => {
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).reverse();
      let seat = null;
      let picked = [];
      for (const s of seats) {
        const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
        const cand = [];
        let node;
        while ((node = walker.nextNode())) {
          const p = node.parentElement;
          if (p && p.closest && p.closest('[data-variant="think"],[data-streaming]')) continue;
          cand.push(node);
          const acc = cand.reduce((n, x) => n + (x.textContent || '').length, 0);
          if (acc >= 80) break;
        }
        if (cand.length) { seat = s; picked = cand; break; }
      }
      if (!seat) return null;
      const range = document.createRange();
      range.setStart(picked[0], 0);
      let acc = 0;
      let endNode = picked[picked.length - 1];
      let endOff = (endNode.textContent || '').length;
      for (const n of picked) {
        const len = (n.textContent || '').length;
        if (acc + len >= 60) { endNode = n; endOff = 60 - acc; break; }
        acc += len;
      }
      range.setEnd(endNode, Math.max(0, Math.min(endOff, (endNode.textContent || '').length)));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
      return { nodes: picked.length };
    });

  const buttonY = () => page.evaluate(() => {
    const b = document.querySelector('.dshsc-ask');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), visible: r.y >= -4 && r.y < window.innerHeight + 4 };
  });

  try {
    await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 });
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => document.body.innerText.includes('可行性分析'), { timeout: 25000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div,span,li,a,p'));
      const cands = all.filter((e) => {
        const t = (e.textContent || '').trim();
        if (!/可行性分析/.test(t) || t.length > 100) return false;
        return !Array.from(e.children).some((c) => /可行性分析/.test((c.textContent || '').slice(0, 100)));
      });
      if (cands.length) cands[cands.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    await page.waitForTimeout(9000);
    await page.waitForFunction(() => document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length > 0, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-streaming]').length === 0, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);

    report.selected = await selectAnswer();
    await page.waitForTimeout(700);
    report.beforeScroll = await buttonY();
    if (!report.beforeScroll) throw new Error('ask button did not appear');

    // Simulate streaming auto-scroll: scroll the conversation container in small steps.
    const scrollSteps = await page.evaluate(() => {
      // find the scroll container that holds the conversation seats
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind]'));
      let container = null;
      let n = seats[0];
      while (n && n.parentElement) {
        n = n.parentElement;
        if (n.scrollHeight > n.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) { container = n; break; }
      }
      if (!container) return { found: false };
      const start = container.scrollTop;
      container.scrollTop = Math.max(0, start - 60); // scroll up so the selection stays visible
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { found: true, from: start, to: container.scrollTop };
    });
    report.scrollSteps = scrollSteps;
    await page.waitForTimeout(400);
    report.afterScroll1 = await buttonY();

    // a second scroll step (more auto-scroll)
    await page.evaluate(() => {
      const seats = Array.from(document.querySelectorAll('[data-chat-flow-kind]'));
      let n = seats[0];
      while (n && n.parentElement) {
        n = n.parentElement;
        if (n.scrollHeight > n.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) {
          n.scrollTop = Math.max(0, n.scrollTop - 40);
          n.dispatchEvent(new Event('scroll', { bubbles: true }));
          break;
        }
      }
    });
    await page.waitForTimeout(400);
    report.afterScroll2 = await buttonY();
    report.survivedScrolls = !!(report.afterScroll1 && report.afterScroll2);

    // selection cleared -> button must hide
    await page.evaluate(() => {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
    });
    await page.waitForTimeout(400);
    report.afterClear = await buttonY();
    report.hiddenAfterClear = report.afterClear === null;
  } catch (e) {
    report.fatal = String(e).slice(0, 600);
  }
  report.pageErrors = errs.slice(0, 12);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
