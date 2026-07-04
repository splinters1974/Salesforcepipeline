/*
 * pdf.js — build a clean, paginated PDF report with pdfmake.
 *
 * buildDocDefinition(payload) is PURE: it returns a pdfmake document-definition
 * object and does not touch pdfMake or the DOM, so it can be unit-tested. The
 * thin download() wrapper hands the definition to the vendored pdfMake.
 *
 * Page layout (as requested):
 *   Page 1 — current year (2026) and following year (2027), side by side
 *   Page 2 — avg open-opp age, two pie charts, top 10 proposed
 *   Page 3 — by segment and stale deals
 *
 * Charts are passed in as PNG data URLs (captured from the live canvases);
 * when one is missing we drop in a small placeholder instead of failing.
 */
(function (PA) {
  'use strict';

  var nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
  function money(n) {
    if (n == null || isNaN(n)) return '—';
    return '£' + nf0.format(Math.round(n));
  }
  function fmtDate(d) {
    if (!d) return '—';
    return d.getUTCDate() + ' ' + PA.analytics.MONTH_LABELS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function image(dataUrl, width) {
    return dataUrl
      ? { image: dataUrl, width: width, margin: [0, 4, 0, 10] }
      : { text: '(chart unavailable)', style: 'muted', margin: [0, 4, 0, 10] };
  }

  var TBL_LAYOUT = {
    hLineWidth: function (i, node) { return (i === 0 || i === node.table.body.length) ? 0.8 : 0.4; },
    vLineWidth: function () { return 0; },
    hLineColor: function () { return '#dddbda'; },
    paddingTop: function () { return 3; },
    paddingBottom: function () { return 3; }
  };

  function th(text, align) { return { text: text, style: 'tableHeader', alignment: align || 'left' }; }

  function kpiTable(yr) {
    return {
      margin: [0, 0, 0, 8],
      layout: 'noBorders',
      table: {
        widths: ['*', '*', 'auto'],
        body: [
          [{ text: 'Total pipeline', style: 'kpiLabel' },
           { text: 'Weighted', style: 'kpiLabel' },
           { text: 'Opps', style: 'kpiLabel' }],
          [{ text: money(yr.total), style: 'kpiVal' },
           { text: money(yr.weighted), style: 'kpiVal' },
           { text: String(yr.count), style: 'kpiVal' }]
        ]
      }
    };
  }

  function stageTable(yr) {
    var body = [[th('Stage'), th('Pipeline', 'right'), th('Weighted', 'right'), th('#', 'right')]];
    yr.byStage.forEach(function (s) {
      body.push([s.key,
        { text: money(s.total), alignment: 'right' },
        { text: money(s.weighted), alignment: 'right' },
        { text: String(s.count), alignment: 'right' }]);
    });
    body.push([
      { text: 'Total', bold: true },
      { text: money(yr.total), alignment: 'right', bold: true },
      { text: money(yr.weighted), alignment: 'right', bold: true },
      { text: String(yr.count), alignment: 'right', bold: true }
    ]);
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto'], body: body }, layout: TBL_LAYOUT };
  }

  function ownerTable(yr) {
    var rows = yr.byOwner.slice(0, 5);
    var body = [[th('Owner'), th('Pipeline', 'right'), th('Weighted', 'right'), th('#', 'right')]];
    rows.forEach(function (o) {
      body.push([o.key,
        { text: money(o.total), alignment: 'right' },
        { text: money(o.weighted), alignment: 'right' },
        { text: String(o.count), alignment: 'right' }]);
    });
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto'], body: body }, layout: TBL_LAYOUT };
  }

  // Two-up row: the same item for current and following year, side by side.
  function pair(a, b) { return { columns: [{ width: '*', stack: [a] }, { width: '*', stack: [b] }], columnGap: 18 }; }

  function kpiCell(label, val) {
    return { width: '*', stack: [{ text: label, style: 'kpiLabel' }, { text: val, style: 'kpiVal' }] };
  }

  // Sales-performance KPI row for page 2.
  function perfRow(perf) {
    if (!perf) return null;
    var pct = function (v) { return v == null ? '—' : Math.round(v) + '%'; };
    return {
      columns: [
        kpiCell('Win rate (count)', pct(perf.winRatePct)),
        kpiCell('Win rate (value)', pct(perf.winRateValuePct)),
        kpiCell('Avg sales cycle', perf.avgCycleDays == null ? '—' : perf.avgCycleDays + ' days'),
        kpiCell('Velocity', perf.velocityPerDay == null ? '—' : money(perf.velocityPerDay) + '/day')
      ],
      columnGap: 10, margin: [0, 0, 0, 10]
    };
  }

  function awardedTable(list, total) {
    var body = [[th('Opportunity'), th('Value', 'right'), th('Owner')]];
    if (!list.length) {
      body.push([{ text: 'No awarded opportunities.', colSpan: 3, style: 'muted' }, {}, {}]);
    } else {
      list.forEach(function (a) {
        body.push([a.name, { text: money(a.amount), alignment: 'right' }, a.owner]);
      });
      body.push([
        { text: 'Total awarded', bold: true },
        { text: money(total), alignment: 'right', bold: true },
        { text: list.length + (list.length === 1 ? ' deal' : ' deals'), bold: true }
      ]);
    }
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body: body }, layout: TBL_LAYOUT };
  }

  // Forecast-outlook KPI row for page 2 — each cell shows total and weighted.
  function forecastRow(f) {
    if (!f) return null;
    function fcell(label, big, sub) {
      return { width: '*', stack: [
        { text: label, style: 'kpiLabel' },
        { text: big, style: 'kpiVal' },
        { text: sub, style: 'muted', fontSize: 8 }
      ] };
    }
    return {
      columns: [
        fcell('Orders this month', f.month.count + (f.month.count === 1 ? ' order' : ' orders'),
          money(f.month.total) + ' total · ' + money(f.month.weighted) + ' wtd'),
        fcell('Next 90 days', money(f.next90.total), money(f.next90.weighted) + ' weighted'),
        fcell('365-day pipeline', money(f.next365.total), money(f.next365.weighted) + ' weighted'),
        fcell('Strategic All Time (£10m+)', money(f.strategic.total), money(f.strategic.weighted) + ' weighted')
      ],
      columnGap: 10, margin: [0, 0, 0, 10]
    };
  }

  function proposedTable(list) {
    var body = [[th('Opportunity'), th('Value', 'right'), th('Close date', 'right'), th('Rating', 'right'), th('Next step')]];
    if (!list.length) {
      body.push([{ text: 'No proposed opportunities.', colSpan: 5, style: 'muted' }, {}, {}, {}, {}]);
    } else {
      list.forEach(function (it) {
        body.push([
          it.name,
          { text: money(it.amount), alignment: 'right' },
          { text: fmtDate(it.closeDate), alignment: 'right' },
          { text: Math.round(it.probability * 100) + '%', alignment: 'right' },
          it.nextStep || '—'
        ]);
      });
    }
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', '*'], body: body }, layout: TBL_LAYOUT };
  }

  function segmentTable(segments) {
    var body = [[th('Segment'), th('Pipeline', 'right'), th('Count', 'right')]];
    segments.forEach(function (s) {
      body.push([s.key, { text: money(s.total), alignment: 'right' }, { text: String(s.count), alignment: 'right' }]);
    });
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body: body }, layout: TBL_LAYOUT };
  }

  function technologyTable(techs) {
    var body = [[th('Technology'), th('Pipeline', 'right'), th('Count', 'right')]];
    (techs || []).slice(0, 10).forEach(function (t) {
      body.push([t.key, { text: money(t.total), alignment: 'right' }, { text: String(t.count), alignment: 'right' }]);
    });
    return { style: 'tbl', table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body: body }, layout: TBL_LAYOUT };
  }

  // One-line data-quality caveat so a shared report carries the same context
  // as the on-screen Data Quality card.
  function dataQualityNote(r) {
    var yc = r.yearCounts || {};
    var parsed = Object.keys(yc).reduce(function (s, y) { return s + yc[y]; }, 0);
    var inRange = (yc[r.currentYear] || 0) + (yc[r.nextYear] || 0);
    var fmt = r.dayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
    return { text: 'Data quality — ' + parsed + ' parsed · ' + inRange + ' in ' +
      r.currentYear + '/' + r.nextYear + ' · ' + (r.skipped || 0) + ' skipped · dates ' + fmt,
      style: 'filterNote' };
  }

  function buildDocDefinition(p) {
    var r = p.results, h = p.health, ins = p.insights, imgs = p.images || {}, meta = p.meta || {};
    var cur = r.currentYear, nxt = r.nextYear;

    var curYr = r.years[cur], nxtYr = r.years[nxt];

    var content = [
      { text: meta.person ? 'Pipeline Analysis — ' + meta.person : 'Pipeline Analysis', style: 'title' },
      meta.person ? { text: 'Salesperson report', style: 'personTag' } : null,
      { text: 'Generated ' + (meta.generated || '') + '  ·  ' + cur + ' & ' + nxt, style: 'sub' },
      meta.filterSummary ? { text: 'Filtered by — ' + meta.filterSummary, style: 'filterNote' } : null,
      dataQualityNote(r),

      // Page 1 — both years side by side. Built as short two-up rows (rather
      // than two tall columns) so every chart and table renders fully and the
      // content paginates cleanly instead of clipping.
      pair({ text: 'Current year — ' + cur, style: 'h2' }, { text: 'Following year — ' + nxt, style: 'h2' }),
      pair(kpiTable(curYr), kpiTable(nxtYr)),
      { text: 'Value by stage', style: 'h3' },
      pair(image(imgs.stageCurrent, 245), image(imgs.stageNext, 245)),
      pair(stageTable(curYr), stageTable(nxtYr)),
      { text: 'Timeline (quarter)', style: 'h3' },
      pair(image(imgs.timelineCurrent, 245), image(imgs.timelineNext, 245)),
      { text: 'By owner', style: 'h3' },
      pair(image(imgs.ownerCurrent, 245), image(imgs.ownerNext, 245)),
      pair(ownerTable(curYr), ownerTable(nxtYr)),

      // Page 2 — insights
      { text: 'Pipeline Insights — ' + cur, style: 'h1', pageBreak: 'before' },
      { text: 'Sales performance', style: 'h3' },
      perfRow(p.performance),
      { text: 'Forecast outlook' + (p.forecast ? ' — ' + p.forecast.monthLabel : ''), style: 'h3' },
      forecastRow(p.forecast),
      {
        columns: [
          { width: 'auto', stack: [
            { text: 'Avg age of open opportunities', style: 'h3' },
            { text: ins.avgOpenAgeDays == null ? '—' : ins.avgOpenAgeDays + ' days', style: 'bigStat' },
            { text: 'across ' + ins.openAgeCount + ' open opportunities (created → today)', style: 'muted' }
          ] }
        ],
        margin: [0, 0, 0, 10]
      },
      {
        columns: [
          { width: '*', stack: [
            { text: 'Won revenue ' + cur + ' by owner', style: 'h3' },
            { text: 'Total won: ' + money(ins.wonTotal) + ' · ' + ins.wonCount + ' deals', style: 'muted' },
            image(imgs.won, 230)
          ] },
          { width: '*', stack: [
            { text: 'Lead source mix', style: 'h3' },
            image(imgs.lead, 230)
          ] }
        ],
        columnGap: 18
      },
      { text: 'Awarded opportunities — ' + cur, style: 'h3' },
      awardedTable(ins.awarded || [], ins.awardedTotal || 0),
      { text: 'Top 10 Opportunities for this Year', style: 'h3' },
      proposedTable(p.proposed || []),

      // Page 3 — segment + technology + stale
      { text: 'Segments & Stale deals — ' + cur, style: 'h1', pageBreak: 'before' },
      { text: 'By segment', style: 'h3' },
      {
        columns: [
          { width: '*', stack: [image(imgs.segment, 250)] },
          { width: '*', stack: [segmentTable(h.segments)] }
        ],
        columnGap: 18
      },
      h.hasTechnology ? { text: 'By technology', style: 'h3', margin: [0, 8, 0, 4] } : null,
      h.hasTechnology ? {
        columns: [
          { width: '*', stack: [image(imgs.technology, 250)] },
          { width: '*', stack: [technologyTable(h.technologies)] }
        ],
        columnGap: 18
      } : null,
      { text: 'Stale deals — ' + h.stale.count + ' deals', style: 'h3', margin: [0, 8, 0, 4] },
      { text: 'Open deals not amended in more than 6 months · ' + money(h.stale.totalValue) +
        ' total · ' + money(h.stale.weightedValue) + ' weighted', style: 'muted' }
    ].filter(Boolean);

    return {
      pageSize: 'A4',
      pageMargins: [36, 40, 36, 44],
      content: content,
      footer: function (currentPage, pageCount) {
        return {
          margin: [36, 12, 36, 0],
          columns: [
            { text: 'Pipeline Analysis', style: 'foot' },
            { text: 'Generated ' + (meta.generated || ''), style: 'foot', alignment: 'center' },
            { text: currentPage + ' / ' + pageCount, style: 'foot', alignment: 'right' }
          ]
        };
      },
      defaultStyle: { fontSize: 9, color: '#181818' },
      styles: {
        title: { fontSize: 20, bold: true, color: '#032d60', margin: [0, 0, 0, 2] },
        personTag: { fontSize: 11, bold: true, color: '#06a59a', margin: [0, 0, 0, 4] },
        sub: { fontSize: 10, color: '#706e6b', margin: [0, 0, 0, 4] },
        filterNote: { fontSize: 9, italics: true, color: '#3e3e3c', margin: [0, 0, 0, 12] },
        h1: { fontSize: 15, bold: true, color: '#032d60', margin: [0, 0, 0, 8] },
        h2: { fontSize: 13, bold: true, color: '#0176d3', margin: [0, 4, 0, 6] },
        h3: { fontSize: 11, bold: true, margin: [0, 8, 0, 4] },
        kpiLabel: { fontSize: 8, color: '#706e6b', bold: true },
        kpiVal: { fontSize: 14, bold: true },
        bigStat: { fontSize: 26, bold: true, color: '#0176d3' },
        muted: { fontSize: 8.5, color: '#706e6b' },
        tbl: { fontSize: 8.5, margin: [0, 2, 0, 8] },
        tableHeader: { bold: true, fontSize: 8, color: '#706e6b' },
        foot: { fontSize: 8, color: '#a8a8a8' }
      }
    };
  }

  function download(docDefinition, filename) {
    /* global pdfMake */
    pdfMake.createPdf(docDefinition).download(filename);
  }

  PA.pdf = { buildDocDefinition: buildDocDefinition, download: download };
})(window.PA = window.PA || {});
