#!/usr/bin/env node

/**
 * extract-dayforce.mjs — Extract structured markdown from a Dayforce job URL.
 *
 * Usage:
 *   node extract-dayforce.mjs https://jobs.dayforcehcm.com/.../jobs/13126
 */

import { writeFileSync } from 'fs';

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanHtml(value = '') {
  return decodeHtml(value)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Dayforce __NEXT_DATA__ script not found');
  return JSON.parse(decodeHtml(match[1]));
}

function jobToMarkdown(job, sourceUrl) {
  const content = job.jobPostingContent || {};
  const location = (job.postingLocations || [])
    .map(l => l.formattedAddress || [l.cityName, l.stateCode, l.isoCountryCode].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');

  return `# ${job.jobTitle}

Source: ${sourceUrl}

## Location
${location || 'N/A'}

## Company
${cleanHtml(content.jobDescriptionHeader || '')}

## Description
${cleanHtml(content.jobDescription || '')}

## Footer / Benefits
${cleanHtml(content.jobDescriptionFooter || '')}
`;
}

function slug(value) {
  return String(value || 'dayforce-job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node extract-dayforce.mjs <dayforce-job-url> [output.md]');
    process.exit(1);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const data = extractNextData(html);
  const job = data?.props?.pageProps?.jobData;
  if (!job) throw new Error('Dayforce jobData not found');

  const outputPath = process.argv[3] || `output/${slug(job.jobTitle)}-dayforce.md`;
  const md = jobToMarkdown(job, url);
  writeFileSync(outputPath, md, 'utf8');
  console.log(outputPath);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
