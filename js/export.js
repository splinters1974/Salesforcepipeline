/*
 * export.js — build a shareable summary of the analysis as CSV text.
 *
 * Pure function (no DOM): takes the analyze() result and the healthMetrics()
 * result and returns a CSV string, so it can be unit-tested. app.js handles
 * the actual file download. Numeric values are rounded for clean spreadsheets.
 */
(function (PA) {
  'use strict';

  function csvEscape(v) {
    var s = (v == null) ? '' : String(v);
    // Neutralise formula injection: cells starting with = @ + - would execute
    // as formulas in Excel/Sheets. Plain numbers (incl. negatives) are safe.
    if (/^[=@+\-]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function num(v) {
    return (v == null || isNaN(v)) ? '' : Math.round(v);
  }

  function fmtDate(d) {
    if (!d) return '';
    return d.getUTCDate() + ' ' + PA.analytics.MONTH_LABELS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function buildSummaryCsv(results, health, insights, meta) {
    meta = meta || {};
    var r = results;
    var rows = [];

    rows.push(['Pipeline Analysis summary' + (meta.person ? ' — ' + meta.person : '')]);
    if (meta.person) rows.push(['Salesperson', meta.person]);
    rows.push(['Generated', meta.generated || '']);
    rows.push(['Years', r.currentYear + ' & ' + r.nextYear]);
    rows.push(['Closed deals included', r.includeClosed ? 'Yes' : 'No']);
    rows.push(['Filters applied', meta.filterSummary || 'None']);
    rows.push([]);

    // Data quality — caveats that travel with the figures.
    var yc = r.yearCounts || {};
    var parsed = Object.keys(yc).reduce(function (s, y) { return s + yc[y]; }, 0);
    var inRange = (yc[r.currentYear] || 0) + (yc[r.nextYear] || 0);
    rows.push(['Data quality', 'Count']);
    rows.push(['Rows in file', parsed + (r.skipped || 0) + (r.skippedClosed || 0)]);
    rows.push(['Parsed', parsed]);
    rows.push(['In range (' + r.currentYear + '/' + r.nextYear + ')', inRange]);
    rows.push(['Other years', parsed - inRange]);
    rows.push(['Skipped (bad amount/date)', r.skipped || 0]);
    rows.push(['Skipped Closed Won/Lost (hidden)', r.skippedClosed || 0]);
    rows.push(['Date format', r.dayFirst ? 'Day first (DD/MM/YYYY)' : 'Month first (MM/DD/YYYY)']);
    rows.push([]);

    // KPIs
    rows.push(['KPIs', 'Total pipeline', 'Weighted forecast', 'Opportunities']);
    [r.currentYear, r.nextYear].forEach(function (y) {
      var yr = r.years[y];
      rows.push([y, num(yr.total), num(yr.weighted), yr.count]);
    });
    rows.push([]);

    // Breakdown helper (both years)
    function dump(title, getList) {
      [r.currentYear, r.nextYear].forEach(function (y) {
        rows.push([title + ' — ' + y, 'Pipeline', 'Weighted', 'Count']);
        getList(r.years[y]).forEach(function (o) {
          rows.push([o.key, num(o.total), num(o.weighted), o.count]);
        });
        rows.push([]);
      });
    }
    dump('By stage', function (yr) { return yr.byStage; });
    dump('Timeline (quarter)', function (yr) { return yr.timeline.quarter; });
    dump('By owner', function (yr) { return yr.byOwner; });

    // Pipeline Health (current year)
    if (health) {
      rows.push(['Pipeline Health — ' + health.currentYear]);
      if (health.coverageRatio != null) {
        rows.push(['Coverage ratio %', Math.round(health.coverageRatio)]);
        rows.push(['Target', num(health.target)]);
        rows.push(['Status', health.coverageStatus]);
      } else {
        rows.push(['Coverage', 'no target set']);
      }
      rows.push(['Weighted forecast', num(health.weightedForecast)]);
      rows.push([]);

      rows.push(['By segment', 'Pipeline', 'Count']);
      health.segments.forEach(function (s) { rows.push([s.key, num(s.total), s.count]); });
      rows.push([]);

      if (health.hasTechnology) {
        rows.push(['By technology', 'Pipeline', 'Count']);
        health.technologies.forEach(function (t) { rows.push([t.key, num(t.total), t.count]); });
        rows.push([]);
      }

      rows.push(['Stale deals (not amended in more than 6 months)', 'Count', 'Total', 'Weighted']);
      rows.push(['', health.stale.count, num(health.stale.totalValue), num(health.stale.weightedValue)]);
      rows.push([]);
    }

    // Pipeline Insights
    if (insights) {
      rows.push(['Pipeline Insights']);
      rows.push(['Avg open opportunity age (days)',
        insights.avgOpenAgeDays == null ? 'n/a' : insights.avgOpenAgeDays]);
      rows.push(['Won revenue ' + insights.currentYear, num(insights.wonTotal),
        insights.wonCount + ' deals']);
      rows.push([]);

      rows.push(['Won by owner', 'Amount', 'Count']);
      insights.wonByOwner.forEach(function (o) { rows.push([o.key, num(o.total), o.count]); });
      rows.push([]);

      rows.push(['Awarded opportunities', 'Value', 'Owner']);
      (insights.awarded || []).forEach(function (a) { rows.push([a.name, num(a.amount), a.owner]); });
      rows.push(['Total awarded', num(insights.awardedTotal || 0), (insights.awarded || []).length]);
      rows.push([]);

      rows.push(['Lead source', 'Count', '%']);
      insights.leadSources.forEach(function (o) { rows.push([o.key, o.count, Math.round(o.pct)]); });
      rows.push([]);

      rows.push(['Top 10 Opportunities for this Year', 'Value', 'Close date', 'Rating %', 'Next step']);
      insights.topProposed.forEach(function (it) {
        rows.push([it.name, num(it.amount), fmtDate(it.closeDate),
          Math.round(it.probability * 100), it.nextStep]);
      });
      rows.push([]);
    }

    // Sales performance
    var perf = meta.performance;
    if (perf) {
      rows.push(['Sales performance — ' + perf.currentYear]);
      rows.push(['Win rate (count) %', perf.winRatePct == null ? 'n/a' : Math.round(perf.winRatePct)]);
      rows.push(['Win rate (value) %', perf.winRateValuePct == null ? 'n/a' : Math.round(perf.winRateValuePct)]);
      rows.push(['Won / Lost', perf.wonCount + ' / ' + perf.lostCount]);
      rows.push(['Avg sales cycle (days)', perf.avgCycleDays == null ? 'n/a' : perf.avgCycleDays]);
      rows.push(['Pipeline velocity (£/day)', perf.velocityPerDay == null ? 'n/a' : num(perf.velocityPerDay)]);
      rows.push([]);
    }

    // Forecast outlook (anchored to the report month)
    var fc = meta.forecast;
    if (fc) {
      rows.push(['Forecast outlook — ' + fc.monthLabel, 'Count', 'Pipeline', 'Weighted']);
      rows.push(['Orders this month (' + fc.monthLabel + ')', fc.month.count, num(fc.month.total), num(fc.month.weighted)]);
      rows.push(['Next 90 days (' + fc.next90Label + ')', fc.next90.count, num(fc.next90.total), num(fc.next90.weighted)]);
      rows.push(['365-day pipeline (' + fc.next365Label + ')', fc.next365.count, num(fc.next365.total), num(fc.next365.weighted)]);
      rows.push(['Strategic All Time (£10m+)', fc.strategic.count, num(fc.strategic.total), num(fc.strategic.weighted)]);
      rows.push([]);
    }

    // Movement since the previous report.
    var cmp = meta.comparison;
    if (cmp) {
      rows.push(['Report comparison']);
      rows.push(['Previous report', cmp.prevDate, cmp.prevLabel || '']);
      rows.push(['This report', cmp.currDate, cmp.currLabel || '']);
      rows.push(['Days between reports', cmp.daysBetween == null ? 'n/a' : cmp.daysBetween]);
      var by = cmp.matchedBy || {};
      rows.push(['Deals matched by job number', by.id || 0]);
      rows.push(['Deals matched by name', by.name || 0]);
      rows.push(['Deals matched by owner + value + close date', by.fingerprint || 0]);
      rows.push(['Previous report unmatched %', Math.round((cmp.unmatchedPrevShare || 0) * 100)]);
      rows.push([]);

      rows.push(['Movement', 'Previous', 'This report', 'Change']);
      rows.push(['Open opportunities', cmp.count.prev, cmp.count.curr, cmp.count.delta]);
      rows.push(['Total pipeline', num(cmp.total.prev), num(cmp.total.curr), num(cmp.total.delta)]);
      rows.push(['Weighted forecast', num(cmp.weighted.prev), num(cmp.weighted.curr), num(cmp.weighted.delta)]);
      rows.push([]);

      // Each movement list gets the same shape so the CSV stays easy to pivot.
      [['Closed won since previous report', cmp.closedWon, cmp.closedWonTotal],
       ['Closed lost since previous report', cmp.closedLost, cmp.closedLostTotal],
       ['New since previous report', cmp.added, cmp.addedTotal],
       ['No longer in the report', cmp.removed, cmp.removedTotal]
      ].forEach(function (block) {
        rows.push([block[0], 'Owner', 'Value', 'Close date', 'Stage']);
        if (!block[1].length) {
          rows.push(['(none)']);
        } else {
          block[1].forEach(function (o) {
            rows.push([o.name, o.owner, num(o.amount), o.closeDate || '', o.stage]);
          });
          rows.push(['Total', '', num(block[2]), block[1].length + ' deals', '']);
        }
        rows.push([]);
      });

      // Renames are listed last: same deals as before, not new business.
      rows.push(['Renamed since previous report', 'Previously called', 'Owner', 'Value', 'Matched by']);
      if (!(cmp.renamed || []).length) {
        rows.push(['(none)']);
      } else {
        cmp.renamed.forEach(function (o) {
          rows.push([o.name, o.from, o.owner, num(o.amount), o.via]);
        });
      }
      rows.push([]);
    }

    return rows.map(function (row) {
      return row.map(csvEscape).join(',');
    }).join('\r\n');
  }

  // A standalone CSV of every actionable skipped row (Closed Won/Lost rows are
  // already excluded upstream). Opens directly in Excel. Returns '' when there
  // is nothing skipped.
  function buildSkippedCsv(results) {
    var skippedRows = (results && results.skippedRows) || [];
    if (!skippedRows.length) return '';
    var rows = [['Row', 'Opportunity name', 'Stage', 'Amount (raw)', 'Close date (raw)', 'Reason']];
    skippedRows.forEach(function (s) {
      rows.push([s.row, s.name || '', s.rawStage || '', s.rawAmount || '', s.rawDate || '', s.reason]);
    });
    return rows.map(function (row) {
      return row.map(csvEscape).join(',');
    }).join('\r\n');
  }

  PA.export = { buildSummaryCsv: buildSummaryCsv, buildSkippedCsv: buildSkippedCsv };
})(window.PA = window.PA || {});
