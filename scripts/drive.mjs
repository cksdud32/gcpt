// Playwright driver for gcpt Electron app (Windows)
import { _electron as electron } from 'playwright-core';
import { resolve, join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR   = resolve(__dirname, '..');
const SHOT_DIR  = process.env.SCREENSHOT_DIR || join(APP_DIR, 'scripts', 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

async function launch() {
  const app = await electron.launch({
    executablePath: electronBin,
    args: ['--no-sandbox', '--disable-gpu', APP_DIR],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 30_000,
  });
  await new Promise(r => setTimeout(r, 3000));
  const page = app.windows().find(w => !w.url().startsWith('devtools://'))
            ?? await app.firstWindow();
  return { app, page };
}

async function screenshot(page, name) {
  const f = join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: f });
  console.log('screenshot:', f);
  return f;
}

(async () => {
  console.log('Launching gcpt...');
  const { app, page } = await launch();
  console.log('Windows:', app.windows().map(w => w.url()));

  await screenshot(page, '01-initial');

  // Run a mock discussion (click "실행" button)
  const runBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent?.includes('실행'));
    if (btn) { btn.click(); return 'clicked'; }
    return 'not found';
  });
  console.log('run button:', runBtn);

  // Wait for result
  await new Promise(r => setTimeout(r, 4000));
  await screenshot(page, '02-after-run');

  // Click first topic card
  const topicClicked = await page.evaluate(() => {
    const card = document.querySelector('.topic-card');
    if (card) { card.click(); return 'clicked'; }
    return 'not found';
  });
  console.log('topic click:', topicClicked);
  await new Promise(r => setTimeout(r, 500));
  await screenshot(page, '03-topic-selected');

  // Check for delete button
  const delBtn = await page.evaluate(() => {
    const btn = document.querySelector('.topic-del-btn');
    return btn ? btn.textContent?.trim() : 'not found';
  });
  console.log('delete button:', delBtn);

  // Check save button state (should be enabled since topic selected)
  const saveBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const save = btns.find(b => b.textContent?.trim() === '저장');
    return save ? { text: save.textContent?.trim(), disabled: save.disabled } : null;
  });
  console.log('save button:', saveBtn);

  // Run a second topic to test accumulation
  await page.evaluate(() => {
    // change sidebar selection to parsefail
    const items = [...document.querySelectorAll('.mode-item')];
    const parsefail = items.find(i => i.textContent?.includes('parsefail'));
    if (parsefail) parsefail.click();
  });
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent?.includes('실행'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 4000));
  await screenshot(page, '04-two-topics-accumulated');

  const topicCount = await page.evaluate(() =>
    document.querySelectorAll('.topic-card').length
  );
  console.log('topic count after 2 runs:', topicCount, '(should be > first run)');

  await app.close();
  console.log('Done. Screenshots in:', SHOT_DIR);
})().catch(e => { console.error(e); process.exit(1); });
