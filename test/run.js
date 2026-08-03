/*
 * Headless sanity tests for parsing + analytics (no browser needed).
 * Run: node test/run.js
 *
 * Loads the vendored PapaParse and the app's pure-logic modules under a
 * minimal `window` shim, runs analyze() over the sample CSV, and asserts the
 * key figures computed by hand in the plan's verification section.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// Minimal browser-ish sandbox.
const sandbox = { window: {}, console: console };
sandbox.window.PA = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

// PapaParse expects a global; load it, then bridge to window.
load('vendor/papaparse.min.js');
// PapaParse (UMD) assigns to module/exports or global Papa; ensure Papa exists.
if (!sandbox.Papa && sandbox.window.Papa) sandbox.Papa = sandbox.window.Papa;
if (!sandbox.Papa && sandbox.module && sandbox.module.exports) sandbox.Papa = sandbox.module.exports;

load('js/parse.js');
load('js/analytics.js');
load('js/compare.js');
load('js/export.js');
load('js/pdf.js');

const PA = sandbox.window.PA;
if (!sandbox.Papa) { console.error('FAIL: PapaParse did not load'); process.exit(1); }

const csv = fs.readFileSync(path.join(root, 'sample/sample_pipeline.csv'), 'utf8');
const table = PA.parse.readText(csv);

let failures = 0;
function approx(label, actual, expected, tol) {
  tol = tol || 0.5;
  const ok = Math.abs(actual - expected) <= tol;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' = ' + actual + (ok ? '' : ' (expected ' + expected + ')'));
  if (!ok) failures++;
}
function eq(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' = ' + actual + (ok ? '' : ' (expected ' + expected + ')'));
  if (!ok) failures++;
}

// Header detection
eq('headers found', table.headers.length, 13);
eq('rows parsed', table.rows.length, 30);

const mapping = PA.analytics && {
  amount: 'Amount', closeDate: 'Close Date', stage: 'Stage',
  probability: 'Probability (%)', owner: 'Opportunity Owner',
  product: 'Product Family', region: 'Region', name: 'Opportunity Name',
  lastModified: 'Last Modified Date', created: 'Created Date',
  nextStep: 'Next Step', leadSource: 'Lead Source'
};

// Two 2026 deals (Globex, Soylent) are stage "Awarded" @ 90% (were 75%):
// delta to weighted = 85500*.15 + 60000*.15 = 21825 -> 449875 + 21825 = 471700
const W2026 = 471700;

// Day-first detection on the DD/MM/YYYY sample
const dayFirst = PA.parse.detectDayFirst(table.rows.map(r => r['Close Date']));
eq('day-first detected', dayFirst, true);

// Analyze for 2026/2027, excluding closed deals
const res = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false });

approx('2026 total pipeline (open)', res.years[2026].total, 1170500);
approx('2026 weighted forecast', res.years[2026].weighted, W2026);
eq('2026 open count', res.years[2026].count, 12);

// Awarded stage is open (not closed) and carries a high stage weight
approx('awarded stage weight high', PA.analytics.stageWeight('Awarded'), 0.90);
eq('Awarded appears in 2026 by-stage', res.years[2026].byStage.some(s => s.key === 'Awarded'), true);
eq('Awarded appears in 2027 by-stage', res.years[2027].byStage.some(s => s.key === 'Awarded'), true);

// Include closed should add Wayne(310k)+Vehement(70k)+Duff(135k) = 515k to 2026 total
const resClosed = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: true });
approx('2026 total incl. closed', resClosed.years[2026].total, 1170500 + 515000);

// Year sections exclude Finlay Anderson's AWARDED deals (but keep his other
// stages and other owners' awarded deals).
const synthRow = (owner, stage, amount, close) => ({
  'Opportunity Name': owner + ' ' + stage, 'Account Name': 'A', 'Opportunity Owner': owner,
  'Stage': stage, 'Amount': amount, 'Probability (%)': '50', 'Close Date': close,
  'Created Date': '01/01/2026', 'Last Modified Date': '01/06/2026', 'Lead Source': 'Web',
  'Next Step': '', 'Product Family': 'X', 'Region': 'EMEA'
});
// Finlay is now in SUPPRESSED_OWNERS, so every stage of his is dropped, not
// just Awarded — only Jane's deal survives.
const resFin = PA.analytics.analyze([
  synthRow('Finlay Anderson', 'Awarded', '£50,000', '10/06/2026'),
  synthRow('Finlay Anderson', 'Proposal/Price Quote', '£40,000', '12/06/2026'),
  synthRow('Jane Smith', 'Awarded', '£30,000', '14/06/2026')
], mapping, { currentYear: 2026 });
approx('suppressed owner contributes nothing at any stage', resFin.years[2026].total, 30000);
eq('suppressed owner rows all removed', resFin.years[2026].count, 1);

// The awarded-only rule still exists for anyone NOT suppressed: it drops that
// one stage and keeps the rest.
const resAwardOnly = PA.analytics.analyze([
  synthRow('Dana Wright', 'Awarded', '£50,000', '10/06/2026'),
  synthRow('Dana Wright', 'Proposal/Price Quote', '£40,000', '12/06/2026'),
  synthRow('Jane Smith', 'Awarded', '£30,000', '14/06/2026')
], mapping, { currentYear: 2026, awardedExcludeOwners: ['dana'] });
approx('awarded-only exclusion drops just that stage', resAwardOnly.years[2026].total, 70000);
eq('awarded-only exclusion keeps other stages', resAwardOnly.years[2026].count, 2);

// 2025 rows (Legacy 90k won, Old 30k) must be out of range, not counted
eq('out-of-range count > 0', res.outOfRange >= 2, true);

// ---- Data quality: skip reasons, year counts, date-format override ----
const builtAll = PA.analytics.buildRecords(table.rows, mapping, {});
// Sample CSV is clean: nothing skipped, year counts sum to all parsed records.
eq('sample has no skipped rows', builtAll.skipped, 0);
eq('skippedRows detail length matches count', builtAll.skippedRows.length, builtAll.skipped);
const ycSum = Object.keys(builtAll.yearCounts).reduce((s, y) => s + builtAll.yearCounts[y], 0);
eq('yearCounts sum to parsed records', ycSum, builtAll.records.length);
eq('yearCounts surfaced on analyze result', res.yearCounts && res.yearCounts[2026] > 0, true);
eq('2026 in yearCounts matches sample 2026 deals', res.yearCounts[2026],
  table.rows.filter(r => r['Close Date'].endsWith('2026')).length);

// Skip-reason classification on synthetic bad rows.
const badRows = [
  synthRow('Bad', 'Discovery', 'N/A', '15/06/2026'),       // bad amount only
  synthRow('Bad', 'Discovery', '£50,000', 'not-a-date'),   // bad date only
  synthRow('Bad', 'Discovery', 'N/A', 'not-a-date')        // both bad
];
const builtBad = PA.analytics.buildRecords(badRows, mapping, {});
eq('three bad rows skipped', builtBad.skipped, 3);
eq('skippedRows captured all three', builtBad.skippedRows.length, 3);
eq('reason: bad amount', builtBad.skippedRows[0].reason, 'bad amount');
eq('reason: bad date', builtBad.skippedRows[1].reason, 'bad date');
eq('reason: bad amount & date', builtBad.skippedRows[2].reason, 'bad amount & date');
eq('skippedRows carry raw amount', builtBad.skippedRows[0].rawAmount, 'N/A');
eq('skippedRows carry raw date', builtBad.skippedRows[1].rawDate, 'not-a-date');
eq('skippedRows carry raw stage', builtBad.skippedRows[0].rawStage, 'Discovery');
eq('skippedRows carry 1-based row index', builtBad.skippedRows[2].row, 3);

// rawStage is '' when the row has no stage mapping.
const noStageMap = Object.assign({}, mapping, { stage: null });
const builtNoStage = PA.analytics.buildRecords(badRows, noStageMap, {});
eq('skippedRows rawStage blank without stage mapping', builtNoStage.skippedRows[0].rawStage, '');

// Closed Won / Closed Lost rows that fail to parse are hidden from the detail
// list (decided deals — not actionable) and counted separately in skippedClosed.
const closedBadRows = [
  synthRow('Bad', 'Discovery', 'N/A', '15/06/2026'),       // actionable
  synthRow('Bad', 'Closed Lost', 'N/A', '15/06/2026'),     // hidden
  synthRow('Bad', 'Closed Won', '£10,000', 'not-a-date')   // hidden
];
const builtClosed = PA.analytics.buildRecords(closedBadRows, mapping, {});
eq('closed-stage bad rows excluded from skipped count', builtClosed.skipped, 1);
eq('closed-stage bad rows excluded from skippedRows', builtClosed.skippedRows.length, 1);
eq('closed-stage bad rows counted in skippedClosed', builtClosed.skippedClosed, 2);
eq('remaining skipped row is the open Discovery one', builtClosed.skippedRows[0].rawStage, 'Discovery');

// buildSkippedCsv emits a header plus one line per actionable skipped row.
const skipCsv = PA.export.buildSkippedCsv({ skippedRows: builtBad.skippedRows });
const skipLines = skipCsv.split('\r\n');
eq('skipped CSV has header + 3 rows', skipLines.length, 4);
eq('skipped CSV header', skipLines[0],
  'Row,Opportunity name,Stage,Amount (raw),Close date (raw),Reason');
eq('skipped CSV carries the reason', skipLines[1].indexOf('bad amount') !== -1, true);
eq('skipped CSV empty when nothing skipped', PA.export.buildSkippedCsv({ skippedRows: [] }), '');

// CSV formula injection: cells starting with = @ + - are prefixed with a
// quote so Excel/Sheets won't execute them; plain negative numbers are not.
const injCsv = PA.export.buildSkippedCsv({ skippedRows: [{
  row: 1, name: '=HYPERLINK("http://evil","x")', rawStage: '@cmd',
  rawAmount: '-500', rawDate: '+1234', reason: 'bad amount'
}] });
const injLine = injCsv.split('\r\n')[1];
eq('formula name neutralised', injLine.indexOf('"\'=HYPERLINK') !== -1, true);
eq('@-prefixed stage neutralised', injLine.indexOf("'@cmd") !== -1, true);
eq('negative number not mangled', injLine.indexOf(',-500,') !== -1, true);
eq('+prefixed value neutralised', injLine.indexOf("'+1234") !== -1, true);

// Out-of-range dates are rejected, not rolled forward by Date.UTC.
eq('month 25 rejected', PA.parse.parseDate('13/25/2026', true), null);
eq('31 Feb rejected', PA.parse.parseDate('31/02/2026', true), null);
eq('valid end-of-month still parses', PA.parse.parseDate('31/01/2026', true).getUTCDate(), 31);
const rollRow = [synthRow('Roll', 'Discovery', '£10,000', '13/25/2026')];
const builtRoll = PA.analytics.buildRecords(rollRow, mapping, {});
eq('rollover date lands in skipped rows', builtRoll.skippedRows.length, 1);
eq('rollover date reason is bad date', builtRoll.skippedRows[0].reason, 'bad date');

// Date-format override forces interpretation of an ambiguous date.
// '06/05/2026' day-first -> 6 May (month index 4); month-first -> 5 Jun (index 5).
const ambRow = [synthRow('Amb', 'Discovery', '£10,000', '06/05/2026')];
const dayFirstBuilt = PA.analytics.buildRecords(ambRow, mapping, { dayFirst: true });
const monthFirstBuilt = PA.analytics.buildRecords(ambRow, mapping, { dayFirst: false });
eq('override day-first reads month as May', dayFirstBuilt.records[0].month, 4);
eq('override month-first reads month as June', monthFirstBuilt.records[0].month, 5);
eq('override day-first reported back', dayFirstBuilt.dayFirst, true);
eq('override month-first reported back', monthFirstBuilt.dayFirst, false);

// Currency cleaning: "£120,000" -> 120000
approx('cleanNumber £120,000', PA.parse.cleanNumber('£120,000'), 120000);
approx('cleanNumber (70,000) negative', PA.parse.cleanNumber('(70,000)'), -70000);

// Stage-weight fallback when no probability column
const noProb = Object.assign({}, mapping, { probability: null });
const resNoProb = PA.analytics.analyze(table.rows, noProb, { currentYear: 2026, includeClosed: false });
console.log('INFO 2026 weighted (stage-based fallback) = ' + Math.round(resNoProb.years[2026].weighted));
eq('fallback weighted is positive', resNoProb.years[2026].weighted > 0, true);

// ---- Pipeline Health ----
const today = new Date(Date.UTC(2026, 5, 14, 12, 0, 0)); // 14 Jun 2026
const health = PA.analytics.healthMetrics(table.rows, mapping, '1,000,000', today, { includeClosed: false });

eq('health current year', health.currentYear, 2026);
approx('coverage weighted forecast', health.weightedForecast, W2026);
approx('coverage ratio %', health.coverageRatio, W2026 / 1e6 * 100, 0.01);
eq('coverage status red (<50%)', health.coverageStatus, 'red');

// green/amber thresholds
eq('coverage green at 80%', PA.analytics.healthMetrics(table.rows, mapping, String(W2026 / 0.8), today, {}).coverageStatus, 'green');
eq('coverage amber at ~60%', PA.analytics.healthMetrics(table.rows, mapping, String(W2026 / 0.6), today, {}).coverageStatus, 'amber');

// Stale = OPEN deals (any year) not amended in >6 months (before 14 Dec 2025).
// Only "Stale Lead 2025" (LM 15/08/2025, Prospecting, £30k @10%) qualifies.
const staleCut = Date.UTC(2025, 11, 14, 12, 0, 0);
const recsAll = PA.analytics.buildRecords(table.rows, mapping, {}).records;
let stc = 0, stt = 0, stw = 0;
recsAll.forEach(r => {
  if (r.closed || !r.lastModified) return;
  if (r.lastModified.getTime() < staleCut) { stc++; stt += r.amount; stw += r.weighted; }
});
eq('stale count (6mo, all open)', health.stale.count, stc);
eq('stale count is 1 in sample', health.stale.count, 1);
approx('stale total value', health.stale.totalValue, stt);
approx('stale total is £30k', health.stale.totalValue, 30000);
approx('stale weighted value', health.stale.weightedValue, stw);
approx('stale weighted is £3k', health.stale.weightedValue, 3000);
eq('stale threshold months', health.stale.thresholdMonths, 6);

// Segments sum back to the current-year open pipeline
const segTotal = health.segments.reduce((s, x) => s + x.total, 0);
approx('segment totals sum to 2026 open pipeline', segTotal, 1170500);
const dataCentres = health.segments.find(s => s.key === 'Data Centres');
approx('Data Centres segment total', dataCentres.total, 200000 + 150000);
const ic = health.segments.find(s => s.key === 'I&C');
approx('I&C segment total', ic.total, 120000 + 60000 + 110000);
eq('segmentFor maps battery -> Grid-Scale', PA.analytics.segmentFor('Grid-Scale Battery Storage'), 'Grid-Scale');
eq('segmentFor unmapped -> Other', PA.analytics.segmentFor('Mystery Product'), 'Other');

// By technology: raw Opportunity Solutions values, sorted by value desc
eq('has technology flag', health.hasTechnology, true);
const techTotal = health.technologies.reduce((s, x) => s + x.total, 0);
approx('technology totals sum to 2026 open pipeline', techTotal, 1170500);
eq('technology sorted by value desc', health.technologies.every((t, i, a) => i === 0 || a[i - 1].total >= t.total), true);
// Data Centre Cooling solution = Umbrella New Logo 200k + Hooli 150k (both 2026 open)
const dcc = health.technologies.find(t => t.key === 'Data Centre Cooling');
approx('Data Centre Cooling technology total', dcc.total, 200000 + 150000);

// ---- Pipeline Insights ----
const ins = PA.analytics.insightMetrics(table.rows, mapping, today, { includeClosed: false });

// Average open-opportunity age — recomputed independently from the CSV
const openDays = table.rows
  .filter(r => String(r['Stage']).toLowerCase().indexOf('closed') === -1)
  .map(r => PA.parse.parseDate(r['Created Date'], true))
  .filter(Boolean)
  .map(d => Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000)));
const expAvg = Math.round(openDays.reduce((a, b) => a + b, 0) / openDays.length);
eq('avg open age days', ins.avgOpenAgeDays, expAvg);
eq('open age count', ins.openAgeCount, openDays.length);

// Won revenue 2026 by owner: Wayne(John 310k) + Duff(Jane 135k)
approx('won total 2026', ins.wonTotal, 445000);
eq('won count 2026', ins.wonCount, 2);
eq('won owners sorted desc', ins.wonByOwner[0].total >= ins.wonByOwner[1].total, true);

// Lead source mix percentages sum to ~100
eq('lead sources present', ins.leadSources.length > 0, true);
approx('lead source pct ~100', ins.leadSources.reduce((a, b) => a + b.pct, 0), 100, 0.5);

// Top 10 — sample has 4 Proposal-stage deals closing in 2026 (no Discovery),
// shown soonest-to-close first (Wonka 05/02 → Acme 15/03 → Stark 18/05 → Oscorp 23/10).
eq('top 10 = 4 proposals in 2026', ins.topProposed.length, 4);
eq('top 10 soonest first', ins.topProposed[0].name, 'Wonka Platform');
eq('top 10 sorted by close date asc', ins.topProposed.every((it, i, a) => i === 0 || a[i - 1].closeDate.getTime() <= it.closeDate.getTime()), true);
eq('top 10 are all proposed (no discovery in sample)', ins.topProposed.every(it => /propos/i.test(it.stage)), true);
eq('top proposed carries next step', typeof ins.topProposed[0].nextStep, 'string');
eq('allOpps available for add dropdown', ins.allOpps.length > 0, true);

// Selection — >10 proposed: keep the 10 largest by value, never reach Discovery
const manyProp = [];
for (let i = 1; i <= 12; i++) manyProp.push(synthRow('Rep', 'Proposal/Price Quote', '£' + (i * 10000), '15/06/2026'));
const insMany = PA.analytics.insightMetrics(manyProp.concat([synthRow('Rep', 'Discovery', '£999,999', '10/06/2026')]), mapping, today, {});
eq('top 10 capped at 10', insMany.topProposed.length, 10);
eq('top 10 excludes discovery when 10 proposed', insMany.topProposed.every(it => /propos/i.test(it.stage)), true);
eq('top 10 keeps largest proposals (smallest chosen = 30k)', Math.min(...insMany.topProposed.map(it => it.amount)), 30000);

// Selection — <10 proposed: fill remaining slots with the largest Discovery deals
const props6 = [], disco8 = [];
for (let i = 1; i <= 6; i++) props6.push(synthRow('Rep', 'Proposal/Price Quote', '£' + (i * 10000), '15/06/2026'));
for (let i = 1; i <= 8; i++) disco8.push(synthRow('Rep', 'Discovery', '£' + (i * 5000), '12/06/2026'));
const insFill = PA.analytics.insightMetrics(props6.concat(disco8), mapping, today, {});
eq('fills to 10', insFill.topProposed.length, 10);
eq('all 6 proposed kept', insFill.topProposed.filter(it => /propos/i.test(it.stage)).length, 6);
eq('4 discovery fillers', insFill.topProposed.filter(it => /discover/i.test(it.stage)).length, 4);
eq('discovery fillers are largest (smallest = 25k)', Math.min(...insFill.topProposed.filter(it => /discover/i.test(it.stage)).map(it => it.amount)), 25000);

// Awarded opportunities (CURRENT YEAR only): Globex 85.5k + Soylent 60k (2026)
// = 2 deals, 145.5k, sorted by value desc (Umbrella/Tyrell are 2027, excluded).
eq('awarded count (2026 only)', ins.awarded.length, 2);
approx('awarded total', ins.awardedTotal, 145500);
eq('awarded sorted by value desc', ins.awarded.every((a, i, arr) => i === 0 || arr[i - 1].amount >= a.amount), true);
eq('awarded carries owner', ins.awarded[0].owner === 'John Doe', true); // Globex 85.5k is top
eq('awarded carries name + value', ins.awarded[0].name === 'Globex Expansion' && ins.awarded[0].amount === 85500, true);
// Awarded owner exclusion (default excludes 'finlay' — none in sample, so 2 remain)
eq('awarded default keeps both', ins.awarded.length, 2);
const insExcl = PA.analytics.insightMetrics(table.rows, mapping, today, { awardedExcludeOwners: ['john'] });
eq('awarded excludes John (Globex)', insExcl.awarded.length, 1);
eq('awarded excl leaves Soylent', insExcl.awarded[0].name, 'Soylent Renewal');

// ---- Filters ----
const dv = PA.analytics.distinctFilterValues(table.rows, mapping, { currentYear: 2026 });
eq('distinct owners = 4', dv.owner.length, 4);
eq('distinct regions = 3', dv.region.length, 3);
eq('distinct lead sources = 5', dv.leadSource.length, 5);
eq('distinct segments = 5', dv.segment.length, 5);

// applyFilters: owner = Jane Smith
const janeRecs = PA.analytics.applyFilters(
  PA.analytics.buildRecords(table.rows, mapping, {}).records, { owner: ['Jane Smith'] });
eq('applyFilters keeps only Jane', janeRecs.every(r => r.owner === 'Jane Smith'), true);
// analyze with that filter: 2026 open = Acme 120k + Initech 40k + Soylent 60k = 220k
const resJane = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false, filters: { owner: ['Jane Smith'] } });
approx('filtered (Jane) 2026 open total', resJane.years[2026].total, 220000);
// no-op filter equals unfiltered
const resAll = PA.analytics.analyze(table.rows, mapping, { currentYear: 2026, includeClosed: false, filters: { owner: [] } });
approx('empty filter == unfiltered', resAll.years[2026].total, 1170500);

// ---- coverage() helper ----
eq('coverage 80% green', PA.analytics.coverage(80, 100).status, 'green');
eq('coverage 50% amber', PA.analytics.coverage(50, 100).status, 'amber');
eq('coverage 49% red', PA.analytics.coverage(49, 100).status, 'red');
eq('coverage no target = null', PA.analytics.coverage(50, '').ratio, null);

// ---- Sales performance ----
const perf = PA.analytics.performanceMetrics(table.rows, mapping, today, {});
eq('perf won count 2026', perf.wonCount, 2);
eq('perf lost count 2026', perf.lostCount, 1);
eq('perf open count 2026', perf.openCount, 12);
approx('perf win rate (count) %', perf.winRatePct, 200 / 3, 0.05);
approx('perf win rate (value) %', perf.winRateValuePct, 445000 / 515000 * 100, 0.05);
// avg cycle recomputed independently over 2026 closed-won deals with a created date
const wonCycle = table.rows.filter(r => r['Close Date'].endsWith('2026') && /won/i.test(r['Stage']) && r['Created Date'])
  .map(r => Math.floor((PA.parse.parseDate(r['Close Date'], true) - PA.parse.parseDate(r['Created Date'], true)) / 86400000));
const expCycle = Math.round(wonCycle.reduce((a, b) => a + b, 0) / wonCycle.length);
eq('perf avg sales cycle days', perf.avgCycleDays, expCycle);
// velocity is internally consistent and positive
const expVel = (perf.openCount * perf.avgDealSize * (perf.winRatePct / 100)) / perf.avgCycleDays;
approx('perf velocity £/day', perf.velocityPerDay, expVel, 0.01);
eq('perf velocity positive', perf.velocityPerDay > 0, true);

// ---- Forecast outlook (anchored to today's month: Jun 2026) ----
const fc = PA.analytics.forecastMetrics(table.rows, mapping, today, {});
eq('forecast month label', fc.monthLabel, 'Jun 2026');
eq('forecast 90 label', fc.next90Label, 'Jun 2026 – Aug 2026');
eq('forecast 365 label', fc.next365Label, 'Jun 2026 – May 2027');
// Recompute the windows independently, mirroring the forecastable rule:
// open, stage in {discovery, proposed, awarded}, not Finlay's awarded,
// and not a £10m+ discovery deal.
const curStart = Date.UTC(2026, 5, 1), nextM = Date.UTC(2026, 6, 1),
      e90 = Date.UTC(2026, 8, 1), e365 = Date.UTC(2027, 5, 1);
const fcRecs = PA.analytics.buildRecords(table.rows, mapping, {}).records;
function forecastable(r, thr = 10000000) {
  if (r.closed) return false;
  const s = String(r.stage).toLowerCase();
  if (!(s.includes('discover') || s.includes('propos') || s.includes('award'))) return false;
  if (s.includes('award') && r.owner.toLowerCase().includes('finlay')) return false;
  if (r.amount >= thr && s.includes('discover')) return false;
  return true;
}
let mC = 0, mT = 0, n90C = 0, n90T = 0, n365C = 0, n365T = 0;
fcRecs.forEach(r => {
  if (!forecastable(r)) return;
  const t = r.date.getTime();
  if (t < curStart) return;
  if (t < nextM) { mC++; mT += r.amount; }
  if (t < e90) { n90C++; n90T += r.amount; }
  if (t < e365) { n365C++; n365T += r.amount; }
});
eq('forecast month count', fc.month.count, mC);
approx('forecast month total', fc.month.total, mT);
eq('forecast 90 count', fc.next90.count, n90C);
approx('forecast 90 total', fc.next90.total, n90T);
eq('forecast 365 count', fc.next365.count, n365C);
approx('forecast 365 total', fc.next365.total, n365T);
eq('forecast windows nested (month<=90<=365)', fc.month.total <= fc.next90.total && fc.next90.total <= fc.next365.total, true);
// Stage gate makes the 365 total smaller than counting every open stage
let allOpen365 = 0;
fcRecs.forEach(r => { if (!r.closed && r.date.getTime() >= curStart && r.date.getTime() < e365) allOpen365 += r.amount; });
eq('365 stage-gated < all open', fc.next365.total < allOpen365, true);
// Excluding an awarded owner reduces the 365 total by that deal's value
// (Globex Expansion, John Doe, Awarded, £85.5k, closes 22/06/2026 → in window)
const fcExclJohn = PA.analytics.forecastMetrics(table.rows, mapping, today, { awardedExcludeOwners: ['john'] });
approx('365 drops excluded-owner awarded', fcExclJohn.next365.total, fc.next365.total - 85500);
// £10m+ discovery is removed, but £10m+ proposed is kept (synthetic check)
const big = (name, stage, close) => ({
  'Opportunity Name': name, 'Account Name': 'A', 'Opportunity Owner': 'Zoe Ray', 'Stage': stage,
  'Amount': '£12,000,000', 'Probability (%)': '20', 'Close Date': close, 'Created Date': '01/06/2026',
  'Last Modified Date': '01/06/2026', 'Lead Source': 'Web', 'Next Step': '', 'Product Family': 'X', 'Region': 'EMEA'
});
const fcBig = PA.analytics.forecastMetrics([big('Big Disco', 'Discovery', '15/07/2026'),
  big('Big Prop', 'Proposal', '20/07/2026')], mapping, today, {});
approx('365 excludes £10m+ discovery, keeps proposed', fcBig.next365.total, 12000000);
// Strategic (£10m+) is Discovery + Proposal, so both synthetic deals count
eq('strategic counts £10m+ discovery and proposal', fcBig.strategic.count, 2);
approx('strategic total = both £12m', fcBig.strategic.total, 24000000);
// Strategic All Time — no £10m+ deals in the sample
eq('strategic none at £10m', fc.strategic.count, 0);
approx('strategic total £0', fc.strategic.total, 0);
approx('strategic weighted £0', fc.strategic.weighted, 0);
// Lower the threshold to exercise detection + total/weighted
const fcLow = PA.analytics.forecastMetrics(table.rows, mapping, today, { strategicThreshold: 150000 });
const recsLow = PA.analytics.buildRecords(table.rows, mapping, {}).records;
let sC = 0, sT = 0, sW = 0;
recsLow.forEach(r => {
  if (r.closed || r.amount < 150000) return;
  const s = String(r.stage).toLowerCase();        // discovery or proposal only
  if (s.indexOf('discover') === -1 && s.indexOf('propos') === -1) return;
  sC++; sT += r.amount; sW += r.weighted;
});
eq('strategic count @150k (discovery/proposal only)', fcLow.strategic.count, sC);
approx('strategic total @150k', fcLow.strategic.total, sT);
approx('strategic weighted @150k', fcLow.strategic.weighted, sW);
// Stage gate excludes other stages (Monarch £300k Prospecting, Umbrella Awarded out)
eq('strategic excludes prospecting/awarded', fcLow.strategic.items.every(it => !/prospect|qualif|negoti|award/i.test(it.stage)), true);
eq('strategic includes only discovery/proposal', fcLow.strategic.items.every(it => /discover|propos/i.test(it.stage)), true);
// Filters flow through (Jane is a subset of everyone)
const fcJane = PA.analytics.forecastMetrics(table.rows, mapping, today, { filters: { owner: ['Jane Smith'] } });
eq('forecast respects salesperson filter', fcJane.next365.total <= fc.next365.total, true);

// ---- Summary CSV export ----
const csvOut = PA.export.buildSummaryCsv(res, health, ins, {
  generated: '2026-06-15', performance: perf, forecast: fcLow,
  filterSummary: 'Salesperson: Jane Smith', person: 'Jane Smith'
});
function has(label, needle) {
  const ok = csvOut.indexOf(needle) !== -1;
  console.log((ok ? 'PASS' : 'FAIL') + ' csv contains ' + label);
  if (!ok) failures++;
}
has('title', 'Pipeline Analysis summary');
has('generated date', '2026-06-15');
has('data quality section', 'Data quality,Count');
has('data quality skipped row', 'Skipped (bad amount/date),0');
has('data quality date format', 'Date format,Day first (DD/MM/YYYY)');
has('KPI header', 'KPIs,Total pipeline,Weighted forecast,Opportunities');
has('2026 total', '1170500');
has('by stage section', 'By stage — 2026');
has('timeline section', 'Timeline (quarter) — 2027');
has('segment section', 'By segment,Pipeline,Count');
has('technology section', 'By technology,Pipeline,Count');
has('Data Centres segment', 'Data Centres,350000,2');
has('stale section header', 'Stale deals (not amended in more than 6 months),Count,Total,Weighted');
has('cities segment label', 'Cities & Local Government');
has('insights section', 'Pipeline Insights');
has('avg age row', 'Avg open opportunity age (days)');
has('won by owner section', 'Won by owner,Amount,Count');
has('awarded section', 'Awarded opportunities,Value,Owner');
has('awarded total row', 'Total awarded,145500,2');
has('lead source section', 'Lead source,Count,%');
has('top proposed section', 'Top 10 Opportunities for this Year,Value,Close date,Rating %,Next step');
has('filters applied row', 'Filters applied,Salesperson: Jane Smith');
has('salesperson title', 'Pipeline Analysis summary — Jane Smith');
has('salesperson row', 'Salesperson,Jane Smith');
has('sales performance section', 'Sales performance — 2026');
has('velocity row', 'Pipeline velocity (£/day)');
has('forecast section', 'Forecast outlook — Jun 2026');
has('forecast month row', 'Orders this month (Jun 2026)');
has('forecast strategic all time', 'Strategic All Time (£10m+),');
// CRLF line endings for spreadsheet friendliness
eq('csv uses CRLF', /\r\n/.test(csvOut), true);

// ---- PDF report (pure doc-definition builder) ----
const doc = PA.pdf.buildDocDefinition({
  results: res, health: health, insights: ins, proposed: ins.topProposed,
  performance: perf, forecast: fcLow, images: {},
  meta: { generated: '2026-06-15', filterSummary: 'Salesperson: Jane Smith', person: 'Jane Smith' }
});
eq('pdf page size A4', doc.pageSize, 'A4');
eq('pdf footer is a function', typeof doc.footer, 'function');
eq('pdf content is array', Array.isArray(doc.content), true);
const pageBreaks = doc.content.filter(b => b && b.pageBreak === 'before').length;
eq('pdf has 3 pages (2 page-breaks)', pageBreaks, 2);
const docStr = JSON.stringify(doc.content);
function docHas(label, needle) {
  const ok = docStr.indexOf(needle) !== -1;
  console.log((ok ? 'PASS' : 'FAIL') + ' pdf doc contains ' + label);
  if (!ok) failures++;
}
docHas('title', 'Pipeline Analysis');
docHas('data quality note', 'Data quality — ');
docHas('current year heading', 'Current year — 2026');
docHas('following year heading', 'Following year — 2027');
docHas('value by stage on page 1', 'Value by stage');
docHas('by owner on page 1', 'By owner');
docHas('filter note', 'Filtered by — Salesperson: Jane Smith');
docHas('person title', 'Pipeline Analysis — Jane Smith');
docHas('person tag', 'Salesperson report');
docHas('forecast heading', 'Forecast outlook — Jun 2026');
docHas('forecast kpi', 'Orders this month');
docHas('forecast strategic all time', 'Strategic All Time (£10m+)');
docHas('sales performance row', 'Sales performance');
docHas('win rate kpi', 'Win rate (count)');
docHas('insights page', 'Pipeline Insights — 2026');
docHas('awarded section', 'Awarded opportunities — 2026');
docHas('awarded total', 'Total awarded');
docHas('stale summary line', 'Open deals not amended in more than 6 months');
docHas('avg age', 'Avg age of open opportunities');
docHas('top 10 heading', 'Top 10 Opportunities for this Year');
docHas('segments/stale page', 'Segments & Stale deals — 2026');
const foot = doc.footer(2, 3);
eq('pdf footer shows page numbers', JSON.stringify(foot).indexOf('2 / 3') !== -1, true);

// ---- Suppressed owners: ignored everywhere, in every metric ----
const SUP = ['Maciej Stefanski', 'Joshua Mauger', 'Katherine Piper', 'Finlay Anderson'];
eq('four owners are suppressed by default', PA.analytics.SUPPRESSED_OWNERS.length, 4);
SUP.forEach(n => eq('suppressed: ' + n, PA.analytics.isSuppressedOwner(n), true));
// Name-order and punctuation variants must still match.
eq('suppressed: "Piper, Katherine"', PA.analytics.isSuppressedOwner('Piper, Katherine'), true);
eq('suppressed: middle initial', PA.analytics.isSuppressedOwner('Maciej J Stefanski'), true);
eq('suppressed: lower case', PA.analytics.isSuppressedOwner('joshua mauger'), true);
// Near-misses must NOT be suppressed.
eq('not suppressed: Katherine Piperson', PA.analytics.isSuppressedOwner('Katherine Piperson'), false);
eq('not suppressed: surname only', PA.analytics.isSuppressedOwner('Piper'), false);
eq('not suppressed: different Joshua', PA.analytics.isSuppressedOwner('Joshua Smith'), false);
eq('not suppressed: blank owner', PA.analytics.isSuppressedOwner(''), false);
eq('not suppressed: ordinary rep', PA.analytics.isSuppressedOwner('Jane Smith'), false);

// A report containing their deals must produce identical figures to one without.
const supRows = [
  synthRow('Maciej Stefanski', 'Discovery', '£30,000,000', '31/12/2026'),
  synthRow('Joshua Mauger', 'Proposal/Price Quote', '£1,250,000', '31/08/2026'),
  synthRow('Katherine Piper', 'Discovery', '£5,000', '31/12/2026'),
  synthRow('Maciej Stefanski', 'Closed Won', '£16,615,467', '30/09/2026'),
  synthRow('Katherine Piper', 'Awarded', '£400,000', '15/07/2026')
];
const withSup = PA.analytics.analyze(table.rows.concat(supRows), mapping,
  { currentYear: 2026, includeClosed: false });
approx('suppressed deals add nothing to pipeline', withSup.years[2026].total, res.years[2026].total);
approx('suppressed deals add nothing to weighted', withSup.years[2026].weighted, res.years[2026].weighted);
eq('suppressed deals add nothing to the count', withSup.years[2026].count, res.years[2026].count);
eq('suppressed rows are counted for transparency', withSup.suppressed, 5);
eq('unsuppressed report reports zero suppressed', res.suppressed, 0);
// Even with closed deals included, their Closed Won must not appear.
const withSupClosed = PA.analytics.analyze(table.rows.concat(supRows), mapping,
  { currentYear: 2026, includeClosed: true });
approx('suppressed closed-won stays out', withSupClosed.years[2026].total, resClosed.years[2026].total);

// They must not appear as a filter option or in the salesperson dropdown.
const supVals = PA.analytics.distinctFilterValues(table.rows.concat(supRows), mapping,
  { currentYear: 2026 });
SUP.forEach(n => eq('not offered as a filter: ' + n, supVals.owner.indexOf(n), -1));

// Every downstream metric must be untouched by their presence.
const supAll = table.rows.concat(supRows);
const supToday = new Date(Date.UTC(2026, 5, 15));
const hA = PA.analytics.healthMetrics(table.rows, mapping, '', supToday, {});
const hB = PA.analytics.healthMetrics(supAll, mapping, '', supToday, {});
approx('health: weighted forecast unchanged', hB.weightedForecast, hA.weightedForecast);
eq('health: segment count unchanged', hB.segments.length, hA.segments.length);
eq('health: stale count unchanged', hB.stale.count, hA.stale.count);
const iA = PA.analytics.insightMetrics(table.rows, mapping, supToday, {});
const iB = PA.analytics.insightMetrics(supAll, mapping, supToday, {});
approx('insights: won total unchanged', iB.wonTotal, iA.wonTotal);
eq('insights: awarded list unchanged', iB.awarded.length, iA.awarded.length);
eq('insights: top-10 unchanged', iB.topProposed.length, iA.topProposed.length);
eq('insights: suppressed owner absent from won-by-owner',
   iB.wonByOwner.some(o => SUP.indexOf(o.key) !== -1), false);
const pA = PA.analytics.performanceMetrics(table.rows, mapping, supToday, {});
const pB = PA.analytics.performanceMetrics(supAll, mapping, supToday, {});
eq('performance: won count unchanged', pB.wonCount, pA.wonCount);
const fA = PA.analytics.forecastMetrics(table.rows, mapping, supToday, {});
const fB = PA.analytics.forecastMetrics(supAll, mapping, supToday, {});
approx('forecast: 365-day total unchanged', fB.next365.total, fA.next365.total);
approx('forecast: strategic total unchanged', fB.strategic.total, fA.strategic.total);

// The comparison must not see them either — a suppressed deal appearing or
// closing between two reports is a non-event.
const supPrev = PA.compare.buildSnapshot(table.rows, mapping,
  { currentYear: 2026, dayFirst: true, reportDate: '2026-06-12' });
const supCurr = PA.compare.buildSnapshot(supAll, mapping,
  { currentYear: 2026, dayFirst: true, reportDate: '2026-08-02' });
const supDiff = PA.compare.diffSnapshots(supPrev, supCurr, {});
eq('comparison ignores suppressed arrivals', supDiff.added.length, 0);
eq('comparison ignores suppressed closures', supDiff.closedWon.length, 0);
eq('comparison tiles unmoved by suppressed deals', supDiff.count.delta, 0);
eq('snapshot excludes suppressed owners',
   supCurr.opps.some(o => SUP.indexOf(o.owner) !== -1), false);

// A baseline stored BEFORE an owner was suppressed must not report all their
// deals as "no longer in the report" the first time the list changes.
const staleBaseline = PA.compare.buildSnapshot(table.rows.concat(supRows), mapping,
  { currentYear: 2026, dayFirst: true, reportDate: '2026-06-12', suppressOwners: [] });
eq('stale baseline really does hold their deals',
   staleBaseline.opps.filter(o => SUP.indexOf(o.owner) !== -1).length, 5);
const staleDiff = PA.compare.diffSnapshots(staleBaseline,
  PA.compare.buildSnapshot(table.rows, mapping,
    { currentYear: 2026, dayFirst: true, reportDate: '2026-08-02' }), {});
eq('suppression is applied retroactively to the baseline', staleDiff.removed.length, 0);
eq('stale baseline reports no phantom closures', staleDiff.closedWon.length, 0);
eq('stale baseline tiles ignore suppressed deals', staleDiff.count.delta, 0);
approx('stale baseline "was" value excludes suppressed deals',
   staleDiff.total.prev, res.years[2026].total + res.years[2027].total);

// Finlay is suppressed outright now, so none of his stages reach any figure.
const finRow = (name, stage, amount) => Object.assign(
  synthRow('Finlay Anderson', stage, amount, '12/06/2026'), { 'Opportunity Name': name });
const withFin = PA.analytics.analyze(table.rows.concat([
  finRow('Fin Awarded', 'Awarded', '£500,000'),
  finRow('Fin Proposal', 'Proposal/Price Quote', '£400,000'),
  finRow('Fin Discovery', 'Discovery', '£300,000')
]), mapping, { currentYear: 2026, includeClosed: false });
approx('suppressed owner adds nothing at any stage',
   withFin.years[2026].total, res.years[2026].total);
eq('all of a suppressed owner\'s rows are counted as excluded', withFin.suppressed, 3);

/*
 * The awarded-exclusion boundary, exercised with an owner who is NOT
 * suppressed. A deal moving Proposal -> Awarded is progress; crossing into the
 * excluded set must not be reported as the deal vanishing from the report.
 */
const danaRow = (stage) => Object.assign(
  synthRow('Dana Wright', stage, '£400,000', '12/06/2026'), { 'Opportunity Name': 'Dana Big Deal' });
const danaOpts = { currentYear: 2026, dayFirst: true, awardedExcludeOwners: ['dana'] };
const danaPrev = PA.compare.buildSnapshot(table.rows.concat([danaRow('Proposal/Price Quote')]),
  mapping, Object.assign({ reportDate: '2026-06-12' }, danaOpts));
const danaCurr = PA.compare.buildSnapshot(table.rows.concat([danaRow('Awarded')]),
  mapping, Object.assign({ reportDate: '2026-08-02' }, danaOpts));
const danaDiff = PA.compare.diffSnapshots(danaPrev, danaCurr, { awardedExcludeOwners: ['dana'] });
eq('advancing into an excluded stage is not a loss', danaDiff.removed.length, 0);
eq('advancing into an excluded stage is not a new deal', danaDiff.added.length, 0);
// The tiles still reflect the dashboard's own rule: it counted last time, not now.
approx('tiles follow the dashboard rule', danaDiff.total.delta, -400000);
// Excluded deals are kept in the snapshot but flagged, and never counted.
eq('excluded deal is retained in the snapshot',
   danaCurr.opps.some(o => o.name === 'Dana Big Deal' && o.excluded === true), true);
approx('excluded deal adds nothing to snapshot totals',
   danaCurr.total, res.years[2026].total + res.years[2027].total);

// An override list keeps the rule configurable.
eq('override suppresses someone else',
   PA.analytics.buildRecords(table.rows, mapping, { suppressOwners: ['jane smith'] })
     .records.some(r => r.owner === 'Jane Smith'), false);
eq('override releases the defaults',
   PA.analytics.buildRecords(supRows, mapping, { suppressOwners: ['nobody here'] })
     .records.length, 5);

// ---- Report-to-report comparison ----
const snapOpts = (date) => ({ currentYear: 2026, dayFirst: true, reportDate: date });
const clone = (rows) => JSON.parse(JSON.stringify(rows));

const prevSnap = PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-06-12'));

// Headline totals span both years of open pipeline, matching the dashboard.
eq('snapshot open count = both years', prevSnap.count,
   res.years[2026].count + res.years[2027].count);
approx('snapshot total = both years', prevSnap.total,
   res.years[2026].total + res.years[2027].total);
eq('snapshot carries report date', prevSnap.reportDate, '2026-06-12');
eq('snapshot stores the raw name for matching', prevSnap.opps[0].name, 'Acme Renewal');
eq('snapshot stores an empty job number when unmapped', prevSnap.opps[0].oppId, '');

// A later report where Acme Renewal (£120k, Jane Smith, Proposal) has been won.
const wonRows = clone(table.rows);
const acme = wonRows.find(r => r['Opportunity Name'] === 'Acme Renewal');
acme['Stage'] = 'Closed Won';
const wonSnap = PA.compare.buildSnapshot(wonRows, mapping, snapOpts('2026-08-02'));
const wonDiff = PA.compare.diffSnapshots(prevSnap, wonSnap);

eq('diff reports both dates', wonDiff.prevDate + ' -> ' + wonDiff.currDate,
   '2026-06-12 -> 2026-08-02');
eq('diff days between reports', wonDiff.daysBetween, 51);
eq('closed-won list length', wonDiff.closedWon.length, 1);
eq('closed-won names the opportunity', wonDiff.closedWon[0].name, 'Acme Renewal');
eq('closed-won carries the owner', wonDiff.closedWon[0].owner, 'Jane Smith');
approx('closed-won carries the value', wonDiff.closedWon[0].amount, 120000);
approx('closed-won keeps prior weighted', wonDiff.closedWon[0].weighted, 60000);
approx('closed-won total', wonDiff.closedWonTotal, 120000);
eq('closed-lost empty', wonDiff.closedLost.length, 0);

// Winning a deal takes it out of open pipeline: count -1, value -£120k.
eq('count delta after a win', wonDiff.count.delta, -1);
approx('total delta after a win', wonDiff.total.delta, -120000);
approx('weighted delta after a win', wonDiff.weighted.delta, -60000);
eq('count movement keeps both sides', wonDiff.count.prev - wonDiff.count.curr, 1);

// A lost deal is reported separately from a won one.
const lostRows = clone(table.rows);
lostRows.find(r => r['Opportunity Name'] === 'Acme Renewal')['Stage'] = 'Closed Lost';
const lostDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(lostRows, mapping, snapOpts('2026-08-02')));
eq('closed-lost list length', lostDiff.closedLost.length, 1);
eq('closed-lost not counted as won', lostDiff.closedWon.length, 0);
approx('closed-lost total', lostDiff.closedLostTotal, 120000);

// Awarded is open pipeline in this app, so it must not read as a closure.
const awardedRows = clone(table.rows);
awardedRows.find(r => r['Opportunity Name'] === 'Acme Renewal')['Stage'] = 'Awarded';
const awardedDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(awardedRows, mapping, snapOpts('2026-08-02')));
eq('awarded is not a closure', awardedDiff.closedWon.length + awardedDiff.closedLost.length, 0);

// New opportunity appearing in the later report.
const addedRows = clone(table.rows);
addedRows.push(synthRow('Nia Patel', 'Discovery', '£90,000', '10/10/2026'));
const addedDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(addedRows, mapping, snapOpts('2026-08-02')));
eq('new opportunity detected', addedDiff.added.length, 1);
eq('new opportunity named', addedDiff.added[0].name, 'Nia Patel Discovery');
approx('added total', addedDiff.addedTotal, 90000);
eq('count delta after an addition', addedDiff.count.delta, 1);

// An opportunity that vanished from the export entirely.
const droppedRows = clone(table.rows).filter(r => r['Opportunity Name'] !== 'Acme Renewal');
const droppedDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(droppedRows, mapping, snapOpts('2026-08-02')));
eq('removed opportunity detected', droppedDiff.removed.length, 1);
eq('removed opportunity named', droppedDiff.removed[0].name, 'Acme Renewal');
eq('removed is not reported as closed', droppedDiff.closedWon.length, 0);

// Reassigning an owner must not read as one deal leaving and another arriving.
const reassignedRows = clone(table.rows);
reassignedRows.find(r => r['Opportunity Name'] === 'Acme Renewal')['Opportunity Owner'] = 'Mike Brown';
const reassignedDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(reassignedRows, mapping, snapOpts('2026-08-02')));
eq('owner change keeps the deal matched',
   reassignedDiff.added.length + reassignedDiff.removed.length, 0);

// Identical reports show no movement at all.
const sameDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02')));
eq('identical reports: no closures', sameDiff.closedWon.length + sameDiff.closedLost.length, 0);
eq('identical reports: no additions', sameDiff.added.length, 0);
eq('identical reports: no removals', sameDiff.removed.length, 0);
eq('identical reports: zero count delta', sameDiff.count.delta, 0);
approx('identical reports: zero value delta', sameDiff.total.delta, 0);

// A job number that only appears once a deal reaches a later stage must not
// read as the old deal vanishing and a new one arriving. This is the exact
// shape of the "15 gone" report: deals progressing past the stage where a job
// number is assigned.
const jobMapping = Object.assign({}, mapping, { oppId: 'Job Number' });
const noJobNumbers = clone(table.rows).map(r => Object.assign(r, { 'Job Number': '' }));
const gainedJobNumbers = clone(table.rows).map((r, i) =>
  Object.assign(r, { 'Job Number': i < 5 ? 'JOB' + (1000 + i) : '' }));
const jobPrev = PA.compare.buildSnapshot(noJobNumbers, jobMapping, snapOpts('2026-06-12'));
const jobDiff = PA.compare.diffSnapshots(
  jobPrev, PA.compare.buildSnapshot(gainedJobNumbers, jobMapping, snapOpts('2026-08-02')));
eq('job number appearing does not orphan deals', jobDiff.removed.length, 0);
eq('job number appearing does not duplicate deals', jobDiff.added.length, 0);
eq('deals without a job number still match by name', jobDiff.matchedBy.name, 30);

// A deal that both gains a job number AND is renamed at the same time is still
// caught, by the owner+value+close-date fingerprint.
const renamedAndNumbered = clone(gainedJobNumbers);
renamedAndNumbered[0]['Opportunity Name'] = 'Acme Renewal - Phase 1 (rev B)';
const bothDiff = PA.compare.diffSnapshots(
  jobPrev, PA.compare.buildSnapshot(renamedAndNumbered, jobMapping, snapOpts('2026-08-02')));
eq('renamed + newly numbered deal still matches', bothDiff.removed.length, 0);
eq('rename is reported as a rename', bothDiff.renamed.length, 1);
eq('rename records the old name', bothDiff.renamed[0].from, 'Acme Renewal');
eq('rename records the new name', bothDiff.renamed[0].name, 'Acme Renewal - Phase 1 (rev B)');
eq('rename matched via fingerprint', bothDiff.renamed[0].via, 'fingerprint');

// Character-encoding drift between two exports (an en-dash arriving as "?")
// must not split one deal into a removal plus an addition.
const dashRows = clone(table.rows);
dashRows[0]['Opportunity Name'] = 'Haycombe – Bath Crematoria';
const qmarkRows = clone(table.rows);
qmarkRows[0]['Opportunity Name'] = 'Haycombe ? Bath Crematoria';
const encDiff = PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(dashRows, mapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(qmarkRows, mapping, snapOpts('2026-08-02')));
eq('encoding drift does not orphan a deal', encDiff.removed.length, 0);
eq('encoding drift does not duplicate a deal', encDiff.added.length, 0);
eq('encoding drift matched on the folded name', encDiff.matchedBy.name, 30);

// The fingerprint pass must stay strict: same owner and value but a different
// close date are two different deals, not one renamed one.
const fpA = clone(table.rows).slice(0, 1);
const fpB = clone(table.rows).slice(0, 1);
fpB[0]['Opportunity Name'] = 'Totally Different Deal';
fpB[0]['Close Date'] = '20/09/2026';
const fpDiff = PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(fpA, mapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(fpB, mapping, snapOpts('2026-08-02')));
eq('fingerprint will not match on a different close date', fpDiff.removed.length, 1);
eq('fingerprint mismatch surfaces as an addition', fpDiff.added.length, 1);

// A wholly unrelated report should read as such, not as a clean comparison.
const unrelated = clone(table.rows).map((r, i) =>
  Object.assign(r, { 'Opportunity Name': 'Unrelated Deal ' + i, 'Amount': '£1,234' }));
const unrelatedDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(unrelated, mapping, snapOpts('2026-08-02')));
eq('unrelated reports flag a high unmatched share',
   unrelatedDiff.unmatchedPrevShare > 0.9, true);
eq('matched reports show a zero unmatched share', sameDiff.unmatchedPrevShare, 0);

// Snapshots written before match keys were stored still compare (no oppId field).
const legacy = JSON.parse(JSON.stringify(prevSnap));
legacy.opps.forEach(o => { delete o.oppId; });
eq('legacy snapshots still match by name',
   PA.compare.diffSnapshots(legacy, PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02'))).removed.length, 0);

// The comparison must describe the same slice of pipeline as the rest of the
// dashboard: with a filter active, its headline figures have to agree with
// analyze() run under the same filter, not with the whole report.
const janeFilter = { owner: ['Jane Smith'], region: [], segment: [], stage: [], leadSource: [] };
const resJaneCmp = PA.analytics.analyze(table.rows, mapping,
  { currentYear: 2026, includeClosed: false, filters: janeFilter });
const janeExpected = {
  count: resJaneCmp.years[2026].count + resJaneCmp.years[2027].count,
  total: resJaneCmp.years[2026].total + resJaneCmp.years[2027].total
};
const janeDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02')),
  { filters: janeFilter });
eq('filtered comparison count matches the dashboard', janeDiff.count.curr, janeExpected.count);
approx('filtered comparison value matches the dashboard', janeDiff.total.curr, janeExpected.total);
eq('filtered comparison is not the whole report', janeDiff.count.curr < prevSnap.count, true);
eq('filter is reported on the diff', janeDiff.filteredBy.join(), 'owner');

// Unfiltered, the comparison still equals the unfiltered dashboard.
const noFilterDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02')), {});
eq('unfiltered comparison count matches the dashboard',
   noFilterDiff.count.curr, res.years[2026].count + res.years[2027].count);
approx('unfiltered comparison value matches the dashboard',
   noFilterDiff.total.curr, res.years[2026].total + res.years[2027].total);

// A filter must slice the movement lists too, not just the tiles.
const wonRowsJane = clone(table.rows);
wonRowsJane.find(r => r['Opportunity Name'] === 'Acme Renewal')['Stage'] = 'Closed Won';   // Jane
wonRowsJane.find(r => r['Opportunity Name'] === 'Wonka Platform')['Stage'] = 'Closed Won'; // Mike
const janeWonDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(wonRowsJane, mapping, snapOpts('2026-08-02')),
  { filters: janeFilter });
eq('filtered closed-won list excludes other owners', janeWonDiff.closedWon.length, 1);
eq('filtered closed-won keeps the right deal', janeWonDiff.closedWon[0].name, 'Acme Renewal');

// Snapshots carry the fields the filters need.
eq('snapshot carries region', typeof prevSnap.opps[0].region, 'string');
eq('snapshot carries segment', typeof prevSnap.opps[0].segment, 'string');
eq('snapshot carries lead source', typeof prevSnap.opps[0].leadSource, 'string');
eq('snapshot records its version', prevSnap.v, 2);

// A pre-filter snapshot must not silently drop every deal: unsupported
// dimensions are skipped and reported instead.
const legacySnap = JSON.parse(JSON.stringify(prevSnap));
delete legacySnap.v;
legacySnap.opps.forEach(o => { delete o.region; delete o.segment; delete o.leadSource; });
const legacyDiff = PA.compare.diffSnapshots(
  legacySnap, PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02')),
  { filters: { owner: [], region: ['EMEA'], segment: [], stage: [], leadSource: [] } });
eq('legacy baseline does not zero out under a region filter', legacyDiff.count.curr > 0, true);
eq('unsupported filter is reported', legacyDiff.unsupportedFilters.join(), 'region');
// Owner and stage still work against a legacy snapshot.
const legacyOwnerDiff = PA.compare.diffSnapshots(legacySnap,
  PA.compare.buildSnapshot(table.rows, mapping, snapOpts('2026-08-02')), { filters: janeFilter });
eq('legacy baseline still filters by owner', legacyOwnerDiff.count.curr, janeExpected.count);
eq('legacy owner filter is supported', legacyOwnerDiff.unsupportedFilters.length, 0);

// The movement lists must honour the same year window as the headline tiles,
// or a deal closing in a year the dashboard never counted would show as a win
// while the tiles above it reported no change.
const oow = clone(table.rows);
oow.find(r => r['Opportunity Name'] === 'Stale Lead 2025')['Stage'] = 'Closed Won';
const oowDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(oow, mapping, snapOpts('2026-08-02')), {});
eq('out-of-window win is not listed', oowDiff.closedWon.length, 0);
eq('out-of-window movement is reported, not hidden', oowDiff.notShown, 1);
eq('out-of-window win leaves the tiles unchanged', oowDiff.count.delta, 0);
eq('window years surfaced', oowDiff.windowYears.join('/'), '2026/2027');

// An in-window win is still reported, and moves the tiles.
eq('in-window win is still listed', wonDiff.closedWon.length, 1);
eq('in-window win has no out-of-window noise', wonDiff.notShown, 0);

// A deal that slipped out of the window stays visible, because it was in the
// window in the previous report.
const slipped = clone(table.rows);
slipped.find(r => r['Opportunity Name'] === 'Acme Renewal')['Close Date'] = '15/03/2029';
slipped.find(r => r['Opportunity Name'] === 'Acme Renewal')['Stage'] = 'Closed Lost';
const slipDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(slipped, mapping, snapOpts('2026-08-02')), {});
eq('deal slipping out of the window is still reported', slipDiff.closedLost.length, 1);

// A brand-new deal closing outside the window is not counted as new pipeline.
const farOut = clone(table.rows);
farOut.push(synthRow('Nia Patel', 'Discovery', '£90,000', '10/10/2029'));
const farDiff = PA.compare.diffSnapshots(
  prevSnap, PA.compare.buildSnapshot(farOut, mapping, snapOpts('2026-08-02')), {});
eq('out-of-window new deal is not listed as new', farDiff.added.length, 0);
eq('out-of-window new deal is reported as skipped', farDiff.notShown, 1);

// Matching by Opportunity ID survives a rename that name-matching would miss.
const idMapping = Object.assign({}, mapping, { oppId: 'Opportunity ID' });
const withIds = clone(table.rows).map((r, i) => Object.assign(r, { 'Opportunity ID': 'OPP' + i }));
const renamed = clone(withIds);
renamed[0]['Opportunity Name'] = 'Acme Renewal (renegotiated)';
const idPrev = PA.compare.buildSnapshot(withIds, idMapping, snapOpts('2026-06-12'));
const idDiff = PA.compare.diffSnapshots(
  idPrev, PA.compare.buildSnapshot(renamed, idMapping, snapOpts('2026-08-02')));
eq('snapshot stores the job number', idPrev.opps[0].oppId, 'OPP0');

// The Salesforce Opportunity ID is the strongest key: immutable, so a deal
// matches through a rename, an owner change and a stage change at once.
const sfPrev = clone(table.rows).map((r, i) =>
  Object.assign(r, { 'Opportunity ID': '0065g00000ABC' + String(i).padStart(2, '0') }));
const sfCurr = clone(sfPrev);
sfCurr[0]['Opportunity Name'] = 'Completely Different Name';
sfCurr[0]['Opportunity Owner'] = 'Someone Else';
sfCurr[0]['Amount'] = '£999,000';
sfCurr[0]['Close Date'] = '01/12/2027';
const sfDiff = PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(sfPrev, idMapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(sfCurr, idMapping, snapOpts('2026-08-02')));
eq('salesforce id survives a total rewrite', sfDiff.removed.length + sfDiff.added.length, 0);
eq('salesforce id matches every deal', sfDiff.matchedBy.id, 30);

// The same record exported as a 15-char and an 18-char ID is one deal.
const id15 = clone(table.rows).map((r, i) =>
  Object.assign(r, { 'Opportunity ID': '0065g00000ABC' + String(i).padStart(2, '0') }));
const id18 = clone(table.rows).map((r, i) =>
  Object.assign(r, { 'Opportunity ID': '0065g00000ABC' + String(i).padStart(2, '0') + 'AA1' }));
const idFmtDiff = PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(id15, idMapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(id18, idMapping, snapOpts('2026-08-02')));
eq('15-char and 18-char ids match the same record', idFmtDiff.matchedBy.id, 30);
eq('id format change orphans nothing', idFmtDiff.removed.length + idFmtDiff.added.length, 0);

// Case must be preserved for 15-char ids, which are genuinely case-sensitive.
const caseA = [Object.assign(clone(table.rows)[0], { 'Opportunity ID': '0065g00000ABCDe' })];
const caseB = [Object.assign(clone(table.rows)[0], { 'Opportunity ID': '0065g00000ABCDE' })];
caseB[0]['Opportunity Name'] = 'A Different Deal Entirely';
caseB[0]['Close Date'] = '03/04/2027';
const caseDiff = PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(caseA, idMapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(caseB, idMapping, snapOpts('2026-08-02')));
eq('15-char ids are not folded together by case', caseDiff.matchedBy.id, 0);

// Job numbers stay case-insensitive, since they are free text.
const jobLower = [Object.assign(clone(table.rows)[0], { 'Opportunity ID': 'job-2001' })];
const jobUpper = [Object.assign(clone(table.rows)[0], { 'Opportunity ID': 'JOB-2001' })];
eq('job numbers match case-insensitively', PA.compare.diffSnapshots(
  PA.compare.buildSnapshot(jobLower, idMapping, snapOpts('2026-06-12')),
  PA.compare.buildSnapshot(jobUpper, idMapping, snapOpts('2026-08-02'))).matchedBy.id, 1);
eq('renamed deal stays matched by id', idDiff.added.length + idDiff.removed.length, 0);
eq('rename with a stable id matches on the id', idDiff.renamed[0].via, 'id');

// Snapshot history: newest last, same-date reloads replace, capped.
let hist = [];
hist = PA.compare.addSnapshot(hist, { reportDate: '2026-06-12', count: 1 });
hist = PA.compare.addSnapshot(hist, { reportDate: '2026-08-02', count: 2 });
eq('history keeps both snapshots', hist.length, 2);
eq('history is oldest-first', hist[0].reportDate, '2026-06-12');
hist = PA.compare.addSnapshot(hist, { reportDate: '2026-08-02', count: 99 });
eq('same-date reload replaces', hist.length, 2);
eq('same-date reload keeps newest values', hist[1].count, 99);
hist = PA.compare.addSnapshot(hist, { reportDate: '2026-07-01', count: 3 });
eq('out-of-order snapshot sorts in', hist[1].reportDate, '2026-07-01');
eq('previous snapshot is the one before',
   PA.compare.previousSnapshot(hist, { reportDate: '2026-08-02' }).reportDate, '2026-07-01');
eq('no previous before the earliest',
   PA.compare.previousSnapshot(hist, { reportDate: '2026-01-01' }), null);
let capped = [];
for (let i = 0; i < PA.compare.MAX_SNAPSHOTS + 5; i++) {
  capped = PA.compare.addSnapshot(capped, { reportDate: '2026-01-' + String(i + 1).padStart(2, '0') });
}
eq('history capped', capped.length, PA.compare.MAX_SNAPSHOTS);

eq('diff needs both snapshots', PA.compare.diffSnapshots(null, prevSnap), null);

// Comparison reaches both exports.
const cmpCsv = PA.export.buildSummaryCsv(res, health, ins, {
  generated: '2026-08-02', comparison: wonDiff
});
const csvHasCmp = (label, needle) =>
  eq('comparison csv contains ' + label, cmpCsv.indexOf(needle) !== -1, true);
csvHasCmp('section header', 'Report comparison');
csvHasCmp('previous report date', 'Previous report,2026-06-12');
csvHasCmp('this report date', 'This report,2026-08-02');
csvHasCmp('days between', 'Days between reports,51');
csvHasCmp('movement header', 'Movement,Previous,This report,Change');
csvHasCmp('opportunity movement', 'Open opportunities,24,23,-1');
csvHasCmp('closed won block', 'Closed won since previous report');
csvHasCmp('closed won deal', 'Acme Renewal,Jane Smith,120000');
csvHasCmp('closed lost block', 'Closed lost since previous report');
csvHasCmp('empty list marked', '(none)');
csvHasCmp('match diagnostics', 'Deals matched by name,30');
csvHasCmp('unmatched share', 'Previous report unmatched %,0');
csvHasCmp('renamed block', 'Renamed since previous report');

// Renames reach both exports.
const renCsv = PA.export.buildSummaryCsv(res, health, ins, {
  generated: '2026-08-02', comparison: bothDiff
});
eq('comparison csv lists the rename',
   renCsv.indexOf('Acme Renewal - Phase 1 (rev B),Acme Renewal') !== -1, true);
const renDoc = JSON.stringify(PA.pdf.buildDocDefinition({
  results: res, health: health, insights: ins, proposed: [],
  comparison: bothDiff, images: {}, meta: {}
}).content);
eq('comparison pdf lists the rename',
   renDoc.indexOf('Renamed since the previous report') !== -1, true);
eq('comparison pdf carries the match note',
   renDoc.indexOf('Deals matched across the two reports') !== -1, true);
eq('summary csv omits comparison when absent',
   PA.export.buildSummaryCsv(res, health, ins, { generated: 'x' }).indexOf('Report comparison'), -1);

const cmpDoc = PA.pdf.buildDocDefinition({
  results: res, health: health, insights: ins, proposed: ins.topProposed,
  performance: perf, forecast: fcLow, comparison: wonDiff, images: {},
  meta: { generated: '2026-08-02' }
});
const cmpJson = JSON.stringify(cmpDoc.content);
const docHasCmp = (label, needle) =>
  eq('comparison pdf contains ' + label, cmpJson.indexOf(needle) !== -1, true);
docHasCmp('comparison page', 'Report Comparison');
docHasCmp('both report dates', '12 Jun 2026');
docHasCmp('days apart', '51 days apart');
docHasCmp('closed won heading', 'Closed won since the previous report');
docHasCmp('closed lost heading', 'Closed lost since the previous report');
docHasCmp('closed won deal', 'Acme Renewal');
docHasCmp('signed movement', '-1 vs 24');
eq('comparison adds a 4th page',
   cmpDoc.content.filter(b => b && b.pageBreak === 'before').length, 3);
eq('pdf omits comparison page when absent',
   JSON.stringify(PA.pdf.buildDocDefinition({
     results: res, health: health, insights: ins, proposed: [], images: {}, meta: {}
   }).content).indexOf('Report Comparison'), -1);

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
