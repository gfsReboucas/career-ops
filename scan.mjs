#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly. For other career
 * pages, falls back to a Playwright browser scan that extracts job-like
 * links from branded career pages. Applies title filters from portals.yml,
 * deduplicates against existing history, and appends new offers to
 * pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --api-only       # skip browser fallback
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const BROWSER_CONCURRENCY = 2;
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_BROWSER_JOBS_PER_COMPANY = 120;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Easycruit
  if (url.includes('easycruit.com')) {
    return { type: 'easycruit', url };
  }

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(value) {
  return cleanText(decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')));
}

function parseEasycruit(html, companyName, baseUrl) {
  const jobs = [];
  const rowRegex = /<div class="joblist-table-cell joblist-title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/div>[\s\S]*?<div class="joblist-table-cell joblist-departments"><div class="device">Avdeling:\s*<\/div>([\s\S]*?)<\/div>\s*<div class="joblist-table-cell joblist-location"><div class="device">Arbeidssted:\s*<\/div>([\s\S]*?)<\/div>/g;

  for (const match of html.matchAll(rowRegex)) {
    const [, href, titleHtml, departmentHtml, locationHtml] = match;
    const title = stripHtml(titleHtml);
    const department = stripHtml(departmentHtml);
    const location = stripHtml(locationHtml);
    if (!title || !href) continue;

    jobs.push({
      title,
      url: new URL(href, baseUrl).href,
      company: companyName,
      location,
      department,
    });
  }

  return jobs;
}

// ── Browser page parser ─────────────────────────────────────────────

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isUsefulJobTitle(title) {
  const text = cleanText(title);
  if (text.length < 4 || text.length > 140) return false;

  const lower = text.toLowerCase();
  const generic = new Set([
    'apply',
    'apply now',
    'careers',
    'career',
    'jobs',
    'job search',
    'job openings',
    'open positions',
    'open vacancies',
    'see vacancies',
    'see all vacancies',
    'view all jobs',
    'view vacancies',
    'learn more',
    'read more',
    'search',
  ]);

  if (generic.has(lower)) return false;
  if (/^(all|view|see|find|search)\s+(jobs|roles|positions|vacancies)$/i.test(text)) return false;
  if (/\b(we help|help drive|learn more|read more|meet our|life at|why join|who we are)\b/i.test(text)) return false;

  const roleLike =
    /\b(engineer|ingeniør|analyst|specialist|advisor|adviser|scientist|researcher|architect|consultant|developer|manager|lead|principal|director|head|expert|fellow)\b/i.test(text);
  if (!roleLike) return false;

  return true;
}

async function extractBrowserJobs(page, company) {
  const rows = await page.evaluate(() => {
    const currentUrl = location.href;
    const toAbsoluteUrl = (href) => {
      try {
        return new URL(href, currentUrl).href;
      } catch {
        return '';
      }
    };

    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const items = [];

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      const url = toAbsoluteUrl(href);
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const text = clean(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title'));
      const aria = clean(anchor.getAttribute('aria-label'));
      const title = clean(text || aria);
      const haystack = `${href} ${url} ${title} ${aria}`.toLowerCase();

      const looksLikeJobLink =
        haystack.includes('job') ||
        haystack.includes('career') ||
        haystack.includes('vacanc') ||
        haystack.includes('position') ||
        haystack.includes('opening') ||
        haystack.includes('recruit') ||
        haystack.includes('apply');

      if (!looksLikeJobLink) continue;

      let location = '';
      const container = anchor.closest('li, article, tr, [class*="job"], [class*="career"], [class*="position"], [class*="vacancy"], [data-testid*="job"]');
      if (container) {
        const containerText = clean(container.innerText || container.textContent);
        const chunks = containerText.split(/[\n\r|•·]+/).map(clean).filter(Boolean);
        const locationLike = chunks.find(part =>
          /\b(norway|oslo|kongsberg|trondheim|stavanger|bergen|drammen|asker|remote|hybrid|denmark|sweden|finland|germany|uk|united kingdom|europe|emea)\b/i.test(part) &&
          part.length <= 90 &&
          part !== title
        );
        location = locationLike || '';
      }

      items.push({ title, url, location });
    }

    return items;
  });

  const seen = new Set();
  const jobs = [];
  for (const row of rows) {
    const title = cleanText(row.title);
    const url = cleanText(row.url).replace(/[),.]+$/, '');
    if (!isUsefulJobTitle(title) || !url) continue;

    const key = `${title.toLowerCase()}::${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    jobs.push({
      title,
      url,
      company: company.name,
      location: cleanText(row.location),
    });

    if (jobs.length >= MAX_BROWSER_JOBS_PER_COMPANY) break;
  }

  return jobs;
}

function isKongsbergVacanciesPage(company) {
  try {
    const url = new URL(company.careers_url || '');
    return url.hostname === 'www.kongsberg.com' && url.pathname.startsWith('/careers/vacancies');
  } catch {
    return false;
  }
}

async function extractKongsbergJobs(page, company) {
  const rows = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const items = [];

    for (const anchor of document.querySelectorAll('a[href*="/careers/vacancies/"]')) {
      const url = anchor.href;
      if (!url || /\/careers\/vacancies\/?$/.test(new URL(url).pathname)) continue;

      const text = clean(anchor.innerText || anchor.textContent || '');
      const match = text.match(/^(.*?)\s+Location:\s*(.*?)\s+read more$/i);
      const title = clean(match ? match[1] : text.replace(/\s+read more$/i, ''));
      const location = clean(match ? match[2] : '');

      if (title) items.push({ title, url, location });
    }

    return items;
  });

  const seen = new Set();
  const jobs = [];
  for (const row of rows) {
    const title = cleanText(row.title);
    const url = cleanText(row.url).replace(/[),.]+$/, '');
    if (!title || !url) continue;

    const key = `${title.toLowerCase()}::${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    jobs.push({
      title,
      url,
      company: company.name,
      location: cleanText(row.location),
    });

    if (jobs.length >= MAX_BROWSER_JOBS_PER_COMPANY) break;
  }

  return jobs;
}

async function scanBrowserCompany(browser, company) {
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(company.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    // Let client-rendered job boards populate, then force lazy lists to load.
    await page.waitForTimeout(1500);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(400);
    }

    if (isKongsbergVacanciesPage(company)) {
      const jobs = await extractKongsbergJobs(page, company);
      if (jobs.length > 0) return jobs;
    }

    return await extractBrowserJobs(page, company);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  const positive = (locationFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());

  return (location) => {
    if (positive.length === 0 && negative.length === 0) return true;
    const lower = String(location || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  const pendingHeadings = ['## Pending'];
  const processedHeadings = ['## Processed'];
  const marker = '## Pending';
  const findHeading = headings => {
    for (const heading of headings) {
      const idx = text.indexOf(heading);
      if (idx !== -1) return { heading, idx };
    }
    return { heading: marker, idx: -1 };
  };

  const pending = findHeading(pendingHeadings);
  const idx = pending.idx;
  if (idx === -1) {
    // No pending section; append at end before the processed section if present.
    const processed = findHeading(processedHeadings);
    const procIdx = processed.idx;
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing pending content (next ## or end).
    const afterMarker = idx + pending.heading.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apiOnly = args.includes('--api-only');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Split enabled companies into structured API and browser fallback targets.
  const enabledCompanies = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  const targets = enabledCompanies
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const browserTargets = apiOnly
    ? []
    : enabledCompanies
      .filter(c => detectApi(c) === null)
      .filter(c => c.careers_url)
      .filter(c => c.scan_method !== 'manual');

  const skippedCount = enabledCompanies.length - targets.length - browserTargets.length;

  console.log(`Scanning ${targets.length} companies via API and ${browserTargets.length} via browser fallback (${skippedCount} skipped)`);
  if (apiOnly) console.log('(api-only — browser fallback disabled)');
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  function considerJob(job, source, sourceCompany = {}) {
    totalFound++;

    if (!titleFilter(job.title)) {
      totalFiltered++;
      return;
    }
    if (!buildLocationFilter(sourceCompany.location_filter)(job.location)) {
      totalFiltered++;
      return;
    }
    if (seenUrls.has(job.url)) {
      totalDupes++;
      return;
    }
    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      totalDupes++;
      return;
    }

    // Mark as seen to avoid intra-scan dupes.
    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    newOffers.push({ ...job, source });
  }

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const jobs = type === 'easycruit'
        ? parseEasycruit(await fetchText(url), company.name, url)
        : PARSERS[type](await fetchJson(url), company.name);
      for (const job of jobs) {
        considerJob(job, `${type}-api`, company);
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  if (browserTargets.length > 0) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const browserTasks = browserTargets.map(company => async () => {
        try {
          const jobs = await scanBrowserCompany(browser, company);
          for (const job of jobs) {
            considerJob(job, 'browser', company);
          }
        } catch (err) {
          errors.push({ company: company.name, error: `browser: ${err.message}` });
        }
      });

      await parallelFetch(browserTasks, BROWSER_CONCURRENCY);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length + browserTargets.length}`);
  console.log(`  API targets:         ${targets.length}`);
  console.log(`  Browser targets:     ${browserTargets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
