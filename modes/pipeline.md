# Mode: pipeline - URL Inbox (Second Brain)

Process job posting URLs accumulated in `data/pipeline.md`. The user can add URLs at any time, then run `/career-ops pipeline` to process them all.

## Workflow

1. **Read** `data/pipeline.md` and find `- [ ]` items in the "Pending" section.
2. **For each pending URL**:
   a. Calculate the next sequential `REPORT_NUM` by reading `reports/` and taking the highest number + 1.
   b. **Extract the JD** using Playwright (`browser_navigate` + `browser_snapshot`) -> WebFetch -> WebSearch.
   c. If the URL is not accessible, mark it as `- [!]` with a note and continue.
   d. **Run the full auto-pipeline**: A-F evaluation -> report `.md` -> PDF if score >= 3.0 -> tracker.
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF yes/no`
3. **If there are 3+ pending URLs**, launch agents in parallel with `run_in_background` to maximize speed.
4. **When finished**, show a summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## pipeline.md Format

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job - Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF yes
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF no
```

## JD Extraction From URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is not available.
3. **WebSearch (last resort):** Search secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login. Mark `[!]` and ask the user to paste the text.
- **PDF**: If the URL points to a PDF, read it directly.
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` reads `jds/linkedin-pm-ai.md`.

## Automatic Numbering

1. List all files in `reports/`.
2. Extract the number from the prefix, for example `142-medispend...` -> 142.
3. New number = highest number + 1.

## Source Sync

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If sources are out of sync, warn the user before continuing.
