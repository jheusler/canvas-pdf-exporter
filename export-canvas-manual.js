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

function parseCliArgs(argv, env = process.env) {
  const parsePositiveInt = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
  };

  const options = {
    start: parsePositiveInt(env.npm_config_start),
    end: parsePositiveInt(env.npm_config_end),
    overwrite: env.npm_config_overwrite === 'true' || env.npm_config_overwrite === '1',
  };
  const positionalNumbers = [];

  const readValue = (arg, index) => {
    const [, inlineValue] = arg.split('=', 2);
    if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
    return { value: argv[index + 1], nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }

    if (/^\d+$/.test(arg)) {
      positionalNumbers.push(Number.parseInt(arg, 10));
      continue;
    }

    if (arg === '--start' || arg.startsWith('--start=')) {
      const { value, nextIndex } = readValue(arg, i);
      options.start = Number.parseInt(value, 10);
      i = nextIndex;
      continue;
    }

    if (arg === '--end' || arg.startsWith('--end=')) {
      const { value, nextIndex } = readValue(arg, i);
      options.end = Number.parseInt(value, 10);
      i = nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.start === null && positionalNumbers.length > 0) {
    options.start = positionalNumbers[0];
  }

  if (options.end === null && positionalNumbers.length > 1) {
    options.end = positionalNumbers[1];
  }

  for (const key of ['start', 'end']) {
    if (options[key] !== null && (!Number.isInteger(options[key]) || options[key] < 1)) {
      throw new Error(`--${key} must be a positive lesson number.`);
    }
  }

  if (options.start !== null && options.end !== null && options.start > options.end) {
    throw new Error('--start must be less than or equal to --end.');
  }

  return options;
}

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

async function inspectReadableContent(context, label, url, area = 0) {
  try {
    const data = await context.evaluate(() => {
      const text = (document.body ? document.body.innerText : document.documentElement.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();
      const title = document.title || '';
      const heading = document.querySelector('h1, h2, [role="heading"]');
      return {
        title,
        heading: heading ? (heading.textContent || '').replace(/\s+/g, ' ').trim() : '',
        textLength: text.length,
        preview: text.slice(0, 500),
      };
    });

    return {
      label,
      url,
      area,
      title: data.title,
      heading: data.heading,
      textLength: data.textLength,
      preview: data.preview,
      context,
    };
  } catch (error) {
    return {
      label,
      url,
      area,
      title: '',
      heading: '',
      textLength: 0,
      preview: '',
      error: error.message,
      context,
    };
  }
}

async function inspectCaptureTargets(page) {
  const iframeElements = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map((frame, index) => {
      const rect = frame.getBoundingClientRect();
      return {
        index,
        src: frame.src || frame.getAttribute('src') || '',
        area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
      };
    })
  );

  const targets = [
    await inspectReadableContent(page, 'main page', page.url(), 0),
  ];

  const childFrames = page.frames().filter((frame) => frame !== page.mainFrame());
  for (let i = 0; i < childFrames.length; i += 1) {
    const frame = childFrames[i];
    const iframeElement = iframeElements[i] || {};
    targets.push(await inspectReadableContent(
      frame,
      `iframe ${i + 1}`,
      frame.url() || iframeElement.src || '',
      iframeElement.area || 0
    ));
  }

  const chosen = targets
    .slice()
    .sort((a, b) => {
      const scoreA = a.textLength + Math.min(a.area, 1000000) / 100;
      const scoreB = b.textLength + Math.min(b.area, 1000000) / 100;
      return scoreB - scoreA;
    })[0];

  return { iframeElements, targets, chosen };
}

function logCaptureInspection(contentType, inspection) {
  console.log(`  CONTENT TYPE: ${contentType || 'unknown'}`);
  console.log('  iframe src list:');
  if (inspection.iframeElements.length === 0) {
    console.log('    (none)');
  } else {
    inspection.iframeElements.forEach((frame, index) => {
      console.log(`    ${index + 1}. ${frame.src || '(blank)'} [area=${frame.area}]`);
    });
  }

  const chosen = inspection.chosen;
  console.log(`  chosen capture target: ${chosen.label} | url=${chosen.url || '(blank)'} | textLength=${chosen.textLength} | area=${chosen.area}`);
  if (chosen.error) {
    console.log(`  chosen capture target warning: ${chosen.error}`);
  }
}

async function finalTextPreview(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : document.documentElement.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 700);
    });
  } catch (error) {
    return `(unable to read final text: ${error.message})`;
  }
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
    'discussion',
    'practice',
    'assignment',
    'quiz',
    'exit ticket',
    'reflection',
    'survey',
    'checkpoint',
    'activating prior knowledge',
  ];

  const isExcludedTitle = (title) => {
    const normalized = String(title || '').toLowerCase();
    return excludedTitlePatterns.some((pattern) => normalized.includes(pattern));
  };

  const rawLinks = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('.ig-title, .item_link, .module-item-title a, li.context_module_item a.title'));
    return anchors.map((a) => ({ url: a.href, title: (a.textContent || '').trim() }));
  });

  const fallbackLinks = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li.context_module_item'));
    return items.flatMap((item) => {
      const a = item.querySelector('a');
      return a ? [{ url: a.href, title: ((item.querySelector('.item_name, .title') || a).textContent || '').trim() }] : [];
    });
  });

  const allRaw = [...rawLinks, ...fallbackLinks];
  console.log(`RAW MODULE LINKS FOUND: ${allRaw.length}`);
  console.log('FIRST 10 RAW TITLES:');
  allRaw.slice(0, 10).forEach((link, idx) => {
    console.log(`  ${idx + 1}. ${link.title || '(untitled)'}`);
  });

  const deduped = [];
  const seen = new Set();

  for (const link of allRaw) {
    const canonical = link.url.replace(/#.*$/, '');
    if (!canonical || !canonical.startsWith('http')) continue;
    if (canonical.includes('/courses/') && canonical.endsWith('/modules')) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const title = String(link.title || '').trim();
    if (!title.toLowerCase().startsWith('lesson:')) continue;
    if (isExcludedTitle(title)) continue;

    deduped.push({ url: canonical, title });
  }

  console.log(`LESSON LINKS AFTER FILTER: ${deduped.length}`);
  return deduped;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Options: start=${options.start || 1}, end=${options.end || 'last'}, overwrite=${options.overwrite ? 'yes' : 'no'}`);

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

    const allLessonItems = await collectModuleLinks(page, MODULES_URL);
    const numberedLessonItems = allLessonItems.map((item, idx) => ({
      ...item,
      __originalOrder: idx + 1,
    }));
    const start = options.start || 1;
    const end = options.end || numberedLessonItems.length;
    const items = numberedLessonItems.filter((item) => item.__originalOrder >= start && item.__originalOrder <= end);

    if (options.start !== null || options.end !== null) {
      console.log(`Range mode: exporting lessons ${start} through ${end}`);
    }

    console.log(`Found ${items.length} lesson module item links.`);
    console.log('Filtered Lesson-only export list:');
    items.forEach((item) => {
      console.log(`  ${String(item.__originalOrder).padStart(3, '0')}. ${item.title}`);
    });

    if (items.length === 0) {
      console.log('No valid module item links found. Exiting.');
      return;
    }

    await waitForEnter('\nReview this list. Press ENTER to begin PDF export, or Ctrl+C to cancel. ');

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const lessonOrder = item.__originalOrder || (i + 1);
      const index = String(lessonOrder).padStart(3, '0');
      const safeTitle = cleanFileName(item.title);
      const fileName = `${index} - ${safeTitle}.pdf`;
      const outputPath = path.join(OUTPUT_DIR, fileName);

      console.log(`[${index}/${String(allLessonItems.length).padStart(3, '0')}] Exporting: ${item.title}`);
      console.log(`  URL: ${item.url}`);

      if (fs.existsSync(outputPath) && !options.overwrite) {
        console.log(`  Skipped existing PDF (use --overwrite to regenerate): ${outputPath}`);
        continue;
      }

      let tab;
      try {
        tab = await browser.newPage();
        tab.setDefaultNavigationTimeout(NAV_TIMEOUT);
        tab.setDefaultTimeout(NAV_TIMEOUT);

        const initialResponse = await tab.goto(item.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await tab.waitForSelector('body', { timeout: 15000 });
        await tab.waitForTimeout(2500);

        let contentType = initialResponse ? initialResponse.headers()['content-type'] : '';
        let inspection = await inspectCaptureTargets(tab);
        logCaptureInspection(contentType, inspection);

        const chosenUrl = inspection.chosen && inspection.chosen.url ? inspection.chosen.url : '';
        const shouldNavigateToChosenFrame =
          inspection.chosen &&
          inspection.chosen.label !== 'main page' &&
          chosenUrl &&
          chosenUrl !== 'about:blank' &&
          chosenUrl !== tab.url();

        if (shouldNavigateToChosenFrame) {
          try {
            const frameResponse = await tab.goto(chosenUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
            contentType = frameResponse ? frameResponse.headers()['content-type'] : contentType;
            await tab.waitForSelector('body', { timeout: 15000 });
            await tab.waitForTimeout(2500);
            inspection = await inspectCaptureTargets(tab);
            console.log('  chosen capture target: navigated to selected iframe content for PDF capture');
            console.log(`  CONTENT TYPE: ${contentType || 'unknown'}`);
          } catch {
            console.log('  chosen capture target: iframe navigation unavailable, continuing with current page content.');
          }
        }

        try {
          await tab.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
        } catch {
          // Continue even if the page keeps polling.
        }

        await waitForEnter('Manually expand/advance this lesson in the browser. When ready, press ENTER to save PDF. ');
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
        const preview = await finalTextPreview(tab);
        console.log(`  final captured text preview: ${preview || '(empty)'}`);

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
