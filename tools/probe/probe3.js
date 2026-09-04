// Probe 3b: end-to-end check of the dsh-sidechat plugin (robust selection).
// 1) open a conversation with settled assistant answers
// 2) negative: selecting inside the think block must NOT raise the Ask button
// 3) positive: selecting answer text must raise the button labelled 在侧边聊天提问
// 4) click the button -> side panel + inner iframe; assert temp session prefill
// 5) close panel -> teardown
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL_BASE = 'http://127.0.0.1:3080';
const OUT = path.join(__dirname, 'out3b.json');

async function main() {
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profiles', 'p3b'), {
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
      const text = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 80);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
      return { text, nodes: picked.length };
    });

  const selectThink = () =>
    page.evaluate(() => {
      const think = Array.from(document.querySelectorAll('[data-variant="think"]')).find((el) => (el.textContent || '').trim().length > 40);
      if (!think) return false;
      const range = document.createRange();
      range.selectNodeContents(think);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
      return true;
    });

  const askButtonInfo = () =>
    page.evaluate(() => {
      const b = document.querySelector('.dshsc-ask');
      return b ? { text: (b.textContent || '').trim(), x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y) } : null;
    });

  try {
    await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!globalThis.__DSH_BOOT__, { timeout: 20000 });
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => document.body.innerText.includes('可行性分析'), { timeout: 25000 });
    await page.waitForTimeout(2000);

    report.openSession = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div,span,li,a,p'));
      const cands = all.filter((e) => {
        const t = (e.textContent || '').trim();
        if (!/可行性分析/.test(t) || t.length > 100) return false;
        return !Array.from(e.children).some((c) => /可行性分析/.test((c.textContent || '').slice(0, 100)));
      });
      if (!cands.length) return false;
      cands[cands.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    await page.waitForTimeout(9000);
    await page.waitForFunction(() => document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length > 0, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-streaming]').length === 0, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    report.assistantSeats = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length);

    // 2) negative: think selection must not show the button
    report.thinkSelected = await selectThink();
    await page.waitForTimeout(600);
    report.askAfterThink = await askButtonInfo();

    // 3) positive: answer selection must show the labelled button
    report.answerSelected = await selectAnswer();
    await page.waitForTimeout(700);
    report.askButton = await askButtonInfo();

    // click the button (pointer down/up must not kill it)
    report.askPressed = await page.evaluate(() => {
      const b = document.querySelector('.dshsc-ask');
      if (!b) return false;
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window }));
      return true;
    });
    await page.waitForTimeout(200);
    report.askVisibleWhilePressed = await askButtonInfo();
    report.askClicked = await page.evaluate(() => {
      const b = document.querySelector('.dshsc-ask');
      if (!b) return false;
      b.click();
      return true;
    });

    await page.waitForSelector('.dshsc-panel', { timeout: 6000 });
    report.panelVisible = true;

    let frame = null;
    for (let i = 0; i < 50; i++) {
      frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('dsh_sidechat=1'));
      if (frame) break;
      await page.waitForTimeout(500);
    }
    report.innerFrameFound = !!frame;
    if (!frame) throw new Error('inner side-mode frame not found');

    let inner = {};
    for (let i = 0; i < 80; i++) {
      try {
        inner = await frame.evaluate(() => {
          const ta = document.querySelector('textarea');
          const val = ta ? ta.value : '';
          return { hasTextarea: !!ta, valueHead: val.replace(/\s+/g, ' ').slice(0, 140), valueLen: val.length };
        });
        if (inner.hasTextarea && inner.valueLen > 0) break;
      } catch (e) {}
      await page.waitForTimeout(500);
    }
    report.inner = inner;

    report.closeClicked = await page.evaluate(() => {
      const c = document.querySelector('.dshsc-close');
      if (!c) return false;
      c.click();
      return true;
    });
    await page.waitForTimeout(3000);
    report.panelGone = await page.evaluate(() => !document.querySelector('.dshsc-panel'));
  } catch (e) {
    report.fatal = String(e).slice(0, 600);
  }
  report.pageErrors = errs.slice(0, 12);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('wrote ' + OUT);
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
