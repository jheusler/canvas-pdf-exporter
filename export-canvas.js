/*
 * Canvas PDF Export Script
 * Collaboratively developed by Jessica Heusler, ChatGPT, and Codex.
 *
 * Purpose:
 * Export Canvas LMS course lesson/module content to local PDFs using Puppeteer.
 *
 * Current status:
 * - The script can log into Canvas.
 * - The script can expand modules.
 * - The script can filter lesson items.
 * - The script can open lesson pages.
 * - The script can generate PDFs.
 *
 * Known unresolved bug:
 * - The script does not reliably expand/advance the embedded lesson viewer’s internal
 *   down-arrow/next control, so PDFs may only capture the first visible lesson screen
 *   instead of the full expanded lesson.
 *
 * Current stopping point:
 * - Automatic detection/clicking of embedded lesson controls has been attempted but is
 *   not reliable enough.
 *
 * Recommended next steps:
 * 1. Continue debugging automatic embedded viewer expansion/clicking.
 * 2. Inspect the embedded viewer DOM/iframe manually.
 * 3. Consider switching to a human-assisted export workflow where the script opens each
 *    lesson, waits for Jessica to manually expand/advance the content, then saves the PDF.
 *
 * Note:
 * - Existing code behavior is intentionally preserved for now.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

const MODULES_URL = 'https://launchcode.instructure.com/courses/261/modules';
const OUTPUT_DIR = path.resolve(process.cwd(), 'canvas-module-pdfs');
const PROFILE_DIR = path.resolve(process.cwd(), '.canvas-profile');
const NAV_TIMEOUT = 60000;
const MAX_FILENAME_LENGTH = 120;

function cleanFileName(input) {
  const fallback = 'Untitled';
  const cleaned = String(input || fallback)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();

  const safe = cleaned || fallback;
  return safe.length > MAX_FILENAME_LENGTH ? safe.slice(0, MAX_FILENAME_LENGTH).trim() : safe;
}

async function autoScroll(page, maxRounds = 50) {
  await page.evaluate(async (rounds) => {
    await new Promise((resolve) => {
      let currentRound = 0;
      let previousPosition = -1;

      const timer = setInterval(() => {
        const doc = document.documentElement;
        const maxHeight = Math.max(
          document.body ? document.body.scrollHeight : 0,
          doc ? doc.scrollHeight : 0,
          doc ? doc.offsetHeight : 0
        );
        const step = Math.max(300, Math.floor(window.innerHeight * 0.5));
        const nextY = Math.min(window.scrollY + step, Math.max(0, maxHeight - window.innerHeight));
        window.scrollTo(0, nextY);
        currentRound += 1;

        if (currentRound >= rounds || nextY === previousPosition) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
        previousPosition = nextY;
      }, 250);
    });
  }, maxRounds);
}

async function expandVisibleContent(target) {
  await target.evaluate(() => {
    document.querySelectorAll('details:not([open]) > summary').forEach((el) => el.click());
    const selectors = [
      '[aria-expanded="false"]',
      '.element_toggler[aria-expanded="false"]',
      'button',
      '[role="button"]',
      'a[role="button"]',
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
        const shouldExpand =
          selector.includes('aria-expanded') ||
          text.includes('expand') ||
          text.includes('show more') ||
          text.includes('show') ||
          text.includes('open');

        if (shouldExpand) {
          el.click();
        }
      });
    });
  });
}

async function advanceEmbeddedLessonContent(page) {
  console.log('Advancing embedded lesson content...');
  let clickCount = 0;
  let clickedInMain = 0;
  let clickedInIframe = 0;

  const tryClickInContext = async (context, label) => {
    try {
      return await context.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, svg, i, span, div'));
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 12 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const looksLikeAdvance = (el) => {
          const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`.toLowerCase();
          return (
            text.includes('down') ||
            text.includes('next') ||
            text.includes('continue') ||
            text.includes('advance') ||
            text.includes('arrow') ||
            text.includes('chevron') ||
            text.includes('icon-down') ||
            text.includes('icon-next')
          );
        };

        for (const el of candidates) {
          if (!isVisible(el) || !looksLikeAdvance(el)) continue;
          const rect = el.getBoundingClientRect();
          const nearBottom = rect.top >= window.innerHeight * 0.45;
          if (!nearBottom) continue;
          el.click();
          return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  while (clickCount < 30) {
    let clicked = await tryClickInContext(page, 'main');
    if (clicked) {
      clickCount += 1;
      clickedInMain += 1;
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.7))));
      continue;
    }

    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    for (const frame of frames) {
      clicked = await tryClickInContext(frame, 'iframe');
      if (clicked) {
        clickCount += 1;
        clickedInIframe += 1;
        await page.waitForTimeout(1000);
        try {
          await frame.evaluate(() => window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.7))));
        } catch {
          // ignore frame scroll errors
        }
        break;
      }
    }

    if (!clicked) break;
  }

  console.log(`  Embedded lesson advance clicks: ${clickCount}`);
  console.log(`  Click contexts: main=${clickedInMain}, iframe=${clickedInIframe}`);
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function isLikelyModuleItem(url, modulesUrl) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:')) return false;

  let parsed;
  try {
    parsed = new URL(url, modulesUrl);
  } catch {
    return false;
  }

  const base = new URL(modulesUrl);
  if (parsed.origin !== base.origin) return false;
  if (!/^\/courses\/\d+\//.test(parsed.pathname)) return false;

  const blockedPathSegments = [
    '/modules',
    '/grades',
    '/users',
    '/announcements',
    '/discussion_topics',
    '/assignments/syllabus',
    '/settings',
    '/files/folder',
    '/files?'
  ];

  const fullPath = `${parsed.pathname}${parsed.search}`;
  if (parsed.hash) return false;
  if (blockedPathSegments.some((segment) => fullPath.includes(segment) && !/\/(pages|assignments|quizzes|discussion_topics|files)\//.test(parsed.pathname))) {
    return false;
  }

  if (/\/discussion_topics\//.test(parsed.pathname)) return false;
  if (/\/assignments\//.test(parsed.pathname)) return false;
  if (/\/quizzes\//.test(parsed.pathname)) return false;

  const allowedPatterns = [
    /\/pages\//,
    /\/modules\/items\//,
  ];

  return allowedPatterns.some((pattern) => pattern.test(parsed.pathname));
}

async function expandAllModules(page) {
  console.log('Expanding all collapsed modules...');
  const selectors = [
    '.context_module .expand_module_link',
    '.context_module button[aria-expanded="false"]',
  ];

  const clickCollapsedModules = async () => {
    for (const selector of selectors) {
      const buttons = await page.$$(selector);
      for (const button of buttons) {
        try {
          await button.click();
          await page.waitForTimeout(650);
        } catch {
          // ignore individual click errors and continue
        }
      }
    }
  };

  await clickCollapsedModules();
  await clickCollapsedModules();
  await page.waitForTimeout(2000);
  console.log('All modules expanded');
}

async function collectModuleLinks(page, modulesUrl) {
  const excludedTitlePatterns = [
    'discussion:',
    'practice:',
    'practice 1:',
    'practice 2:',
    'exit ticket:',
    'activating prior knowledge:',
    'assignment:',
    'quiz:',
    'checkpoint:',
    'reflection:',
    'survey:',
    'final practice:',
  ];

  const isExcludedTitle = (title) => {
    const normalized = String(title || '').toLowerCase();
    return excludedTitlePatterns.some((pattern) => normalized.includes(pattern));
  };

  const links = await page.evaluate((baseUrl) => {
    const toAbsolute = (href) => {
      try {
        return new URL(href, baseUrl).href;
      } catch {
        return null;
      }
    };

    const candidates = [];
    const moduleRoots = document.querySelectorAll('.context_modules, #context_modules, .modules, #modules');

    const pushLink = (a, source) => {
      const href = a.getAttribute('href');
      if (!href) return;
      const abs = toAbsolute(href);
      if (!abs) return;
      const title = (a.textContent || a.getAttribute('title') || source || '').trim();
      candidates.push({ url: abs, title: title || source || 'Untitled Item' });
    };

    if (moduleRoots.length > 0) {
      moduleRoots.forEach((root) => {
        const itemContainers = root.querySelectorAll('.context_module_item, .ig-row, li[id^="context_module_item_"]');
        if (itemContainers.length > 0) {
          itemContainers.forEach((container) => {
            const link = container.querySelector('a[href]');
            if (link) pushLink(link, 'module-item');
          });
        } else {
          root.querySelectorAll('a[href]').forEach((a) => pushLink(a, 'module-root'));
        }
      });
    } else {
      document.querySelectorAll('a[href]').forEach((a) => pushLink(a, 'fallback-all-links'));
    }

    return candidates;
  }, modulesUrl);

  const deduped = [];
  const seen = new Set();

  for (const link of links) {
    if (!isLikelyModuleItem(link.url, modulesUrl)) continue;
    if (isExcludedTitle(link.title)) continue;
    if (!String(link.title || '').trim().toLowerCase().startsWith('lesson:')) continue;
    const canonical = link.url.replace(/#.*$/, '');
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ url: canonical, title: link.title || 'Untitled Item' });
  }

  return deduped;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1440, height: 900 },
  });

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(NAV_TIMEOUT);

    console.log(`Opening modules page: ${MODULES_URL}`);
    await page.goto(MODULES_URL, { waitUntil: 'domcontentloaded' });

    await waitForEnter('\nLog into Canvas if needed, then press ENTER to continue... ');

    await page.goto(MODULES_URL, { waitUntil: 'networkidle2' });

    await expandAllModules(page);
    console.log('Scrolling modules page to load all dynamic content...');
    await autoScroll(page, 70);

    const items = await collectModuleLinks(page, MODULES_URL);
    console.log(`Found ${items.length} lesson module item links.`);
    console.log('Filtered Lesson-only export list:');
    items.forEach((item, idx) => {
      console.log(`  ${String(idx + 1).padStart(3, '0')}. ${item.title}`);
    });

    if (items.length === 0) {
      console.log('No valid module item links found. Exiting.');
      return;
    }

    await waitForEnter('\nReview this list. Press ENTER to begin PDF export, or Ctrl+C to cancel. ');

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const index = String(i + 1).padStart(3, '0');
      const safeTitle = cleanFileName(item.title);
      const fileName = `${index} - ${safeTitle}.pdf`;
      const outputPath = path.join(OUTPUT_DIR, fileName);

      console.log(`[${index}/${String(items.length).padStart(3, '0')}] Exporting: ${item.title}`);
      console.log(`  URL: ${item.url}`);

      let tab;
      try {
        tab = await browser.newPage();
        tab.setDefaultNavigationTimeout(NAV_TIMEOUT);
        tab.setDefaultTimeout(NAV_TIMEOUT);

        await tab.goto(item.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await tab.waitForSelector('body', { timeout: 15000 });
        await tab.waitForTimeout(2500);

        const iframeData = await tab.evaluate(() => {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          if (iframes.length === 0) return null;
          let best = null;
          for (const frame of iframes) {
            const rect = frame.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (!best || area > best.area) {
              best = {
                area,
                src: frame.src || '',
              };
            }
          }
          return best;
        });
        const hasIframeContent = Boolean(iframeData && iframeData.src && iframeData.src !== 'about:blank');
        if (hasIframeContent) {
          console.log(`  Iframe detected: yes (${iframeData.src})`);
          try {
            await tab.goto(iframeData.src, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
            await tab.waitForSelector('body', { timeout: 15000 });
            await tab.waitForTimeout(2500);
          } catch {
            console.log('  Iframe navigation unavailable, continuing with main page content.');
          }
        } else {
          console.log('  Iframe detected: no');
        }

        try {
          await tab.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
        } catch {
          // Continue even if the page keeps polling.
        }

        await advanceEmbeddedLessonContent(tab);
        await expandVisibleContent(tab);
        await autoScroll(tab, 120);
        await tab.waitForTimeout(500);
        await expandVisibleContent(tab);
        await autoScroll(tab, 120);

        // Help Canvas finish rendering lazy-loaded content before PDF export.
        await tab.evaluate(() => {
          document.body.style.zoom = '100%';
        });

        await tab.waitForTimeout(1000);
        const finalPageHeight = await tab.evaluate(() =>
          Math.max(
            document.body ? document.body.scrollHeight : 0,
            document.documentElement ? document.documentElement.scrollHeight : 0
          )
        );
        console.log(`  Lesson title: ${item.title}`);
        console.log(`  Final page height: ${finalPageHeight}px`);

        await tab.pdf({
          path: outputPath,
          format: 'Letter',
          printBackground: true,
          preferCSSPageSize: false,
          margin: { top: '0.5in', right: '0.4in', bottom: '0.5in', left: '0.4in' },
        });

        console.log(`  Saved: ${outputPath}`);
      } catch (error) {
        console.error(`  Failed (${item.url}): ${error.message}`);
      } finally {
        if (tab) {
          await tab.close().catch(() => {});
        }
      }
    }

    console.log('\nDone. PDF export complete.');
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exitCode = 1;
});
