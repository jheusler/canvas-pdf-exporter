const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MODULES_URL = 'https://launchcode.instructure.com/courses/261/modules';
const OUTPUT_DIR = path.join(__dirname, 'canvas-module-pdfs');
const USER_DATA_DIR = path.join(__dirname, '.browser-profile');

// CLI args: node export.js --start 36 --end 36 --overwrite
const argv = process.argv.slice(2);
function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}
const argStart = getArg('--start') ? parseInt(getArg('--start'), 10) - 1 : 0;
const argEnd   = getArg('--end')   ? parseInt(getArg('--end'),   10) - 1 : Infinity;
const argOverwrite = argv.includes('--overwrite');

const WRAPPER_PHRASES = [
  'this assignment does not count',
  'submitting an external tool',
  'exit course',
  'load in a new window',
];

function cleanFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// Returns { url, isIframe } — the best URL to load for actual lesson content.
// Logs diagnostics so we can see what Canvas is serving.
async function getContentTarget(tab) {
  // Give iframes time to initialize
  await new Promise((r) => setTimeout(r, 2500));

  const frameUrls = tab.frames()
    .map((f) => f.url())
    .filter((u) => u && u !== 'about:blank');
  console.log(`    Frames (${frameUrls.length}): ${frameUrls.join(' | ')}`);

  // Look for a non-Canvas iframe (SCORM/Rustici/external player)
  const externalFrame = tab.frames().find((f) => {
    const u = f.url();
    return u && u !== 'about:blank' && !u.includes('launchcode.instructure.com') && u.startsWith('http');
  });
  if (externalFrame) {
    console.log(`    External content frame: ${externalFrame.url()}`);
    return { url: externalFrame.url(), isIframe: true };
  }

  // Look for Canvas-hosted LTI iframe (retrieve/borderless URL)
  const iframeSrc = await tab.evaluate(() => {
    const el = document.querySelector(
      'iframe#tool_content, iframe.tool_launch, iframe[src*="retrieve"], iframe[src*="external_tools"]'
    );
    return el ? el.src : null;
  });
  if (iframeSrc) {
    console.log(`    LTI iframe src: ${iframeSrc}`);
    return { url: iframeSrc, isIframe: true };
  }

  // Log iframe dimensions for any iframes present
  const iframeInfo = await tab.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map((f) => ({
      src: f.src,
      w: f.offsetWidth,
      h: f.offsetHeight,
    }));
  });
  if (iframeInfo.length) console.log(`    iframes on page:`, JSON.stringify(iframeInfo));

  return { url: null, isIframe: false };
}

const IGNORE_PATTERNS = [
  /^https?:\/\/launchcode\.instructure\.com\/courses\/\d+\/modules$/,
  /\/files\//,
  /\/external_tools\//,
  /javascript:/i,
];

function isValidLink(href) {
  if (!href || !href.startsWith('http')) return false;
  if (IGNORE_PATTERNS.some((p) => p.test(href))) return false;
  return true;
}

(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('\nNavigating to Canvas Modules page...');
  await page.goto(MODULES_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('\nIf not logged in, please log in now in the browser window.');
  await waitForEnter('Press ENTER when you are logged in and can see the Modules page: ');

  await page.goto(MODULES_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Expand all collapsed modules
  console.log('Expanding all modules...');
  const expandButtons = await page.$$('.collapse_module_link[aria-expanded="false"], .expand_module_link');
  for (const btn of expandButtons) {
    try {
      await btn.click();
      await new Promise((r) => setTimeout(r, 300));
    } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 1500));

  // Scroll to load lazy content
  await autoScroll(page);
  await new Promise((r) => setTimeout(r, 1000));

  // Collect all module item links
  const rawLinks = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('.ig-title, .item_link, .module-item-title a, li.context_module_item a.title'));
    return anchors.map((a) => ({ href: a.href, title: a.textContent.trim() }));
  });

  // Fallback: grab all links inside module items
  const fallbackLinks = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li.context_module_item'));
    return items.flatMap((item) => {
      const a = item.querySelector('a');
      return a ? [{ href: a.href, title: (item.querySelector('.item_name, .title') || a).textContent.trim() }] : [];
    });
  });

  const allRaw = [...rawLinks, ...fallbackLinks];

  // Deduplicate by href
  const seen = new Set();
  const links = allRaw.filter(({ href, title }) => {
    if (!isValidLink(href)) return false;
    if (seen.has(href)) return false;
    seen.add(href);
    return title.length > 0;
  });

  console.log(`\nFound ${links.length} total items.`);
  const rangeEnd = Math.min(argEnd, links.length - 1);
  console.log(`Exporting items ${argStart + 1}–${rangeEnd + 1}.\n`);

  for (let i = argStart; i <= rangeEnd; i++) {
    const { href, title } = links[i];
    const index = String(i + 1).padStart(3, '0');
    const fileName = `${index} - ${cleanFileName(title)}.pdf`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    console.log(`\n[${index}/${links.length}] ${title}`);
    console.log(`    URL: ${href}`);

    if (!argOverwrite && fs.existsSync(filePath)) {
      console.log(`    Skipped (already exists — use --overwrite to replace)`);
      continue;
    }

    const tab = await browser.newPage();
    try {
      await tab.setViewport({ width: 1280, height: 900 });
      await tab.goto(href, { waitUntil: 'networkidle2', timeout: 45000 });

      const heightBefore = await tab.evaluate(() => document.body.scrollHeight);
      console.log(`    Page height before: ${heightBefore}px`);

      // Detect iframe/content frame
      const { url: contentUrl, isIframe } = await getContentTarget(tab);

      if (isIframe && contentUrl) {
        // Navigate directly to the actual lesson content URL
        console.log(`    Navigating into content: ${contentUrl}`);
        await tab.goto(contentUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      }

      await autoScroll(tab);
      await new Promise((r) => setTimeout(r, 1500));

      const heightAfter = await tab.evaluate(() => document.body.scrollHeight);
      console.log(`    Page height after:  ${heightAfter}px`);

      const textPreview = await tab.evaluate(() =>
        (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      );
      console.log(`    Preview: ${textPreview.slice(0, 200)}`);

      const isWrapper = WRAPPER_PHRASES.some((p) => textPreview.toLowerCase().includes(p));
      if (isWrapper) {
        console.warn(`    WARNING: Content looks like Canvas shell — PDF may be empty/wrong`);
      }

      await tab.pdf({
        path: filePath,
        format: 'Letter',
        printBackground: true,
        margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
      });
      console.log(`    Saved: ${fileName}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    } finally {
      await tab.close();
    }
  }

  console.log('\nAll done. PDFs saved to:', OUTPUT_DIR);
  await browser.close();
})();
