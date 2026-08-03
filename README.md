# Pipeline Analysis

A small, **fully local** web app that turns a Salesforce opportunity report
(CSV export) into a single dashboard view of your pipeline for the **current
calendar year and the following year**.

Everything runs in your browser — **your file is never uploaded anywhere**.
There is no server, no account, and no internet connection required.

Styled to match the **Salesforce Lightning Design System** — brand blue,
flat cards, and Lightning's data-table conventions — so it feels at home
next to the Salesforce reports it reads.

## What it shows

For both the current year and next year, side by side:

- **KPI cards** — total pipeline, weighted forecast, and number of opportunities.
- **Value by stage** — pipeline grouped by sales stage.
- **Timeline** — pipeline spread across quarters (toggle to months).
- **By owner** — top sales reps by pipeline.
- **By product / region** — breakdown by product line and region/territory.

"Weighted forecast" = `Amount × win probability`. If your report includes a
probability column it is used directly; otherwise the app estimates a
probability from each opportunity's stage (see *Weighted forecast* below).

## Data Quality

A full-width **Data Quality** card (just below the filters) makes the parse
transparent so nothing is dropped without you knowing:

- **Summary** — rows in the file, how many parsed, how many fall inside the
  analysis window (current/following year), how many sit in other years, and how
  many were skipped.
- **Deals by close-date year** — a small bar chart of every parsed year, with the
  analysis window highlighted. Rows in other years are parsed correctly but sit
  outside the window (expected for historical or long-dated deals).
- **Date format** — switch between auto-detect, day-first (DD/MM/YYYY) and
  month-first (MM/DD/YYYY). A live preview shows the first few close dates as
  *raw → parsed* so you can confirm the choice; the whole dashboard updates and
  the setting is remembered.
- **Skipped rows** — a table of every row that could not be read (the amount or
  close date would not parse) with its raw values and the reason, so you can fix
  them in the source CSV — or correct the date format — to recover them.

## Report Comparison

A full-width **Report Comparison** card (just below Data Quality) answers
"what's changed since last time?" — it shows the **date of the previous report
alongside the date of this one**, how many days apart they are, and then:

- **Open opportunities** — the count now, the change, and what it was.
- **Total pipeline** and **Weighted forecast** — same treatment, in £.
- **Closed won since the previous report** — every deal that was open last time
  and is Closed Won now, listed by **opportunity name, owner, value, close date
  and stage**, with a total.
- **Closed lost since the previous report** — the same, for Closed Lost.
- **New opportunities since the previous report** — deals that weren't in the
  last export.
- **Renamed since the previous report** — deals matched to the previous report
  under a different name, shown with their old name. Still pipeline, not new
  business.
- **No longer in the report** — deals that have vanished from the export
  entirely. These are listed separately rather than assumed won, since a deal
  can also disappear because it was deleted or filtered out at source.

### How the dates are decided

Each report is dated from the **CSV file's own timestamp** — for a Salesforce
export that is the moment you ran it. Override it with the **This report dated**
box if you need to; the comparison re-runs immediately.

### How reports are matched up

Every time you load a report, a small snapshot of it (one line per opportunity)
is saved in the browser's localStorage, and the new report is automatically
compared against **the most recent snapshot dated before it**. So the second
report you ever load starts showing movement, with nothing to configure. Use
**Compare against** to measure against any earlier stored report instead.

The very first report has nothing to compare against. To get a comparison
straight away, use **Load a previous report (CSV)** to feed in last month's
export — it is snapshotted as a baseline without disturbing the dashboard.

Deals are matched across reports in three passes, strongest first. Each deal is
consumed by at most one pass, so a weaker rule can never steal a deal a stronger
one already matched:

1. **Opportunity ID / Job Number** — the immutable Salesforce record ID is
   ideal: it is allocated automatically and never changes, so a deal matches
   through a rename, a reassignment and a stage change at once. A job or project
   number works too. Map it in the column mapping panel; it is used *only* for
   matching. If a report carries both, the Opportunity ID is preferred.
2. **Opportunity name** — for deals with no ID yet. Punctuation and case are
   folded away, so a name that arrives mangled by a character-encoding
   difference (an en-dash exported as `?`) still matches.
3. **Owner + value + close date** — a strict last resort that catches a deal
   renamed while it had no ID. All three must agree, because a report easily
   holds several deals sharing any two of them.

Matching deliberately ignores the owner in passes 1–2, so reassigning a deal
doesn't read as one deal disappearing and another appearing.

**Why the layering matters:** a job number is typically only assigned once a
deal reaches a certain stage. Keyed on "ID, *or else* name", every deal crossing
that stage would look like one deal vanishing and a different one appearing —
inflating both the *gone* and *new* lists. Holding both keys per deal is what
prevents that.

Deals matched under a changed name are listed under **Renamed since the previous
report** (with their previous name), so a rename reads as a rename rather than
churn. The card also states how many deals matched by each pass, and warns when
a large share of the previous report couldn't be matched at all — which nearly
always means the two exports don't cover the same ground (different report
filters, owners or columns) rather than a mass of genuinely lost deals.

### Scope — the comparison shows the same slice as the rest of the dashboard

Two rules keep the card consistent with the figures above it:

- **Filters apply.** Filter to a salesperson (or region, segment, stage, lead
  source) and the comparison re-slices to match — tiles *and* deal lists. Both
  reports are sliced the same way, so the movement is like-for-like. The card
  states which filter it is showing.
- **The year window applies.** Only deals closing in the current or following
  year are counted, exactly as in the KPI tiles. A deal that closed in a year
  the dashboard never counted is not listed as a win — otherwise the lists would
  contradict the tiles. Anything skipped this way is reported as a count, not
  silently dropped, and a deal that *slipped out* of the window stays visible
  because it was in the window in the previous report.

Snapshots themselves are stored **unfiltered and whole**, and the filters are
applied when the comparison is drawn. So changing a filter re-slices instantly,
and no history is lost to whichever filter happened to be set on the day a
report was loaded. The history keeps the last 12 reports and **survives Reset /
new file** — that is the point, since you reset precisely to load the next
report that should be measured against it.

Deals excluded from the dashboard's headline numbers (Awarded deals owned by an
excluded owner — see `AWARDED_EXCLUDE_OWNERS` in `js/analytics.js`) are excluded
from the comparison too.

Both exports carry the comparison: a **Report Comparison page** in the PDF and a
**Report comparison** section in the summary CSV.

## Pipeline Insights

A full-width **Pipeline Insights** card (above the year columns) adds:

- **Avg age of open opportunities** — mean days from Created Date to today
  across all open (non-closed) deals.
- **Won revenue (current year) by owner** — a doughnut of Closed Won value split
  by salesperson, with the total and deal count.
- **Lead source mix** — a doughnut showing the % of the open pipeline coming
  from each lead source.
- **Top 10 proposed opportunities** — the strongest Proposed-stage deals, ranked
  by a blend of win probability (rating), value and nearest close date, with the
  Next Step shown. You can **remove** any row (✕), **add** any other opportunity
  from the dropdown, and **set the running order** with the ▲ ▼ buttons, so the
  list is yours to curate.

  The order is numbered, saved with the rest of your session, and used by the
  **PDF and CSV exports** as well as the screen. Moving a row stores the whole
  order, so it stays stable as things change around it — anything that appears
  later (a newly added opportunity, or a deal arriving in the next report) has
  no place in your order and joins the end in close-date order. **Reset to
  close-date order** appears once you have moved anything.

Each year's **Value by stage** table also shows a **Total** row (pipeline and
weighted) at the bottom.

The **Awarded** stage is treated as open pipeline (not closed) but carries a high
win weighting (90% by default), so it shows in each year's value *and* weighted
charts.

## Excluded owners

Opportunities owned by certain people are **ignored completely**. Their rows are
dropped the moment the file is read, so they reach no calculation, count or list
anywhere: KPIs, Pipeline Health, Sales Performance, Forecast Outlook, Pipeline
Insights, the Report Comparison, the exports, and the filter dropdowns (they are
not offered as a salesperson to filter by).

By default that list is **Maciej Stefanski, Joshua Mauger, Katherine Piper and
Finlay**. Edit `SUPPRESSED_OWNERS` at the top of `js/analytics.js` to change it.

Matching is on name tokens, so `Katherine Piper`, `Piper, Katherine` and
`Katherine J Piper` all match, while `Katherine Piperson` does not.

So the exclusion is never silent, the **Data Quality** card counts the dropped
rows in an *excluded owners* chip and names who was excluded — the row totals
still add up (`rows in file` = parsed + skipped + excluded).

This is distinct from `AWARDED_EXCLUDE_OWNERS`, which only drops one *stage*
(Awarded) for the owners it lists, rather than the person entirely. Finlay
appears in both: his Awarded pipeline was already excluded by that rule, and
he is now suppressed outright, so every stage of his is gone. Anyone listed in
`SUPPRESSED_OWNERS` never reaches the Awarded check, since suppression drops
their rows first — the `AWARDED_EXCLUDE_OWNERS` entry is kept so the narrower
rule still applies if they are ever taken off the suppression list.

## Column mapping (optional fields)

Beyond the required Amount / Close Date / Stage, you can map: Probability, Owner,
Product, Region, **Last Modified Date** (stale detection), **Created Date** (open
age), **Next Step** (top-5 list), **Lead Source** (source mix) and **Opportunity
ID** (matching deals across reports — see *Report Comparison*). Each is
auto-detected and adjustable in the mapping panel; features that need a column
they can't find show a short "map this column" hint.

## Saved sessions

Your uploaded data, column mapping, target, toggles and manual top-10 edits are
saved in the browser's **localStorage**, so closing the tab or browser and
reopening `index.html` brings everything straight back — no re-upload needed.
The data stays on your machine. Use the **Reset / new file** button to clear it
and return to the upload screen. (If your browser blocks storage on `file://`,
run the local-server option instead and persistence will work.)

## Exporting the view

Two buttons sit in the dashboard controls:

- **Download PDF report** — generates a clean, paginated PDF with
  [pdfmake](https://pdfmake.github.io/) (vendored, offline). Vector tables print
  crisply; charts are embedded at a controlled size; every page has a footer with
  the date and page numbers. Layout:
  1. **Page 1** — current year (2026) and following year (2027) side by side:
     KPIs, value-by-stage chart + table (with totals), quarterly timeline, and
     by-owner chart + table.
  2. **Page 2** — average age of open opportunities, the two pie charts
     (won-by-owner, lead source), the awarded list and the top-10 table (in
     your chosen running order).
  3. **Report Comparison** — the two report dates, the movement in
     opportunities / pipeline / weighted forecast, the old-vs-new pipeline
     bridge, and the deal-level movement lists. Only when an earlier report is
     stored to compare against.

  The **by segment / by technology / stale deals** breakdowns are on screen
  only (Pipeline Health card) — they are deliberately not in the PDF.

  The document is assembled by the pure, testable `PA.pdf.buildDocDefinition`
  in `js/pdf.js`; `js/app.js` captures the chart images and triggers the
  download. (Browser `Ctrl/Cmd+P` still works too, via a print stylesheet.)
- **Download summary (CSV)** — exports all the computed figures (KPIs,
  by-stage with totals, by-owner, quarterly timeline, coverage, segments,
  stale-deal list and the insights) as a spreadsheet-friendly CSV. Built by the
  pure `PA.export.buildSummaryCsv` function in `js/export.js`.

## Filters

A **Filters** bar at the top of the dashboard lets you slice the *entire* view —
year dashboard, Pipeline Health, Sales Performance and Pipeline Insights all
update together — by **owner, region, segment, stage and lead source**. Each is a
multi-select dropdown (OR within a dimension, AND across dimensions). Active
filters show in the summary line, persist across sessions, and are noted in the
PDF and CSV exports. Use **Clear filters** to reset.

## Sales Performance

A **Sales Performance** card (current year) shows:

- **Win rate** — Closed Won ÷ (Won + Lost), by deal count and by value
- **Average sales cycle** — mean days from Created Date to close on Closed Won
  deals (needs a Created Date column)
- **Pipeline velocity** — `open count × avg open deal × win rate ÷ avg cycle
  days`, in £/day (and £/month)

Coverage in the Health card now covers **both years** — enter a target for the
current and the following year to see each one's RAG-rated coverage ratio.

## Pipeline Health

A full-width **Pipeline Health** card sits above the year columns and focuses on
the **current year**. It has three panels:

1. **Coverage** — type a £ target; shows weighted-forecast ÷ target as a
   colour-coded percentage (green ≥ 80%, amber 50–79%, red < 50%).
2. **Stale deals** — flags open deals whose **Close Date is in the past** or
   whose **Last Modified Date** is more than `STALE_THRESHOLD_DAYS` (default 30)
   days old. Shows a count, total value and a scrollable list (most stale first).
3. **By segment** — maps the Product / Product Family column to Ameresco's five
   segments (I&C, Cities & Local Government, Public Sector, Grid-Scale, Data
   Centres) and charts pipeline value per segment; unmapped products go to
   *Other*.

Both the stale threshold (`STALE_THRESHOLD_DAYS`) and the product→segment rules
(`SEGMENT_MAP`) live at the top of `js/analytics.js` for easy editing. To map
"days since last modified", include a **Last Modified Date** column in your
report (optional — staleness still works off close dates without it).

## How to run

### Option A — just open it (simplest)

Double-click **`index.html`** to open it in your browser. Then click **Choose
file** and pick your Salesforce CSV export.

> Note: when opened this way (via `file://`), the **Load sample data** button
> can't auto-read the bundled sample because browsers block local file reads.
> Use **Choose file** and select `sample/sample_pipeline.csv` instead — that
> always works.

### Option B — run a tiny local server (enables the sample button)

From this folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> and use **Load sample data** or upload your own.

## How to export the report from Salesforce

1. Go to **Reports** and open (or build) an **Opportunities** report.
2. Make sure the report includes at least: **Amount**, **Close Date**, and
   **Stage**. Helpful extras: **Probability**, **Opportunity Owner**,
   **Product / Product Family**, **Region / Territory**, **Last Modified Date**.
3. Click the dropdown (▾) → **Export**.
4. Choose **Details Only** and format **Comma Delimited (.csv)**, then export.
5. Upload that file here.

The app tolerates the "Formatted" export too — it skips report-title and
grand-total/footer rows automatically — but **Details Only** is cleanest.

## Column mapping

After you upload, the app guesses which columns to use and shows a mapping
panel. Required fields are **Amount**, **Close Date**, and **Stage** (marked
with `*`). Correct any wrong guess with the dropdowns; the dashboard recomputes
instantly. Owner, Product and Region are optional and their charts simply show
"—" if absent.

## Weighted forecast (stage estimates)

When no probability column is mapped, these default stage → win-probability
estimates are used (editable in `js/analytics.js`, `DEFAULT_STAGE_WEIGHTS`):

| Stage contains | Probability |
| --- | --- |
| closed won | 100% |
| negotiation | 75% |
| proposal / quote | 50% |
| qualification | 25% |
| discovery | 20% |
| prospecting / lead | 10% |
| closed lost | 0% |
| (anything else) | 20% |

## Notes & assumptions

- **Years** are calendar years based on **Close Date**. "Current year" is taken
  from your computer's clock; "following year" is the year after.
- **Closed deals** (Won/Lost) are excluded from the pipeline by default; tick
  *Include closed deals* to add them.
- **Dates**: the app auto-detects day-first (DD/MM/YYYY) vs month-first
  (MM/DD/YYYY) from your data and shows which it chose in the status bar. If the
  guess is wrong (or your dates are mixed), override it in the **Data Quality**
  card — see below.
- **Amounts**: currency symbols, thousands separators and `(parentheses)`
  negatives are cleaned automatically.

## Project layout

```
index.html              App shell + dashboard layout
css/styles.css          Styling
js/parse.js             CSV reading + Salesforce-export cleanup
js/mapping.js           Column auto-detection + mapping UI
js/analytics.js         Pipeline calculations (pure, testable)
js/compare.js           Report snapshots + report-to-report diff (pure, testable)
js/charts.js            Chart.js render helpers
js/export.js            Summary CSV builder (pure, testable)
js/pdf.js               PDF report builder via pdfmake (pure doc-definition)
js/app.js               Orchestration + DOM wiring
vendor/                 PapaParse + Chart.js (vendored, offline)
sample/sample_pipeline.csv   Synthetic Salesforce-style report
test/run.js             Headless logic tests (node test/run.js)
```

## Tests

```bash
node test/run.js
```

Runs the parsing and analytics logic against the sample data and checks the
totals, weighted forecast, year filtering and currency cleaning.
