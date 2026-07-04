/*
 * charts.js — thin wrappers around Chart.js for the dashboard.
 * Keeps a registry of live charts so we can destroy/recreate on re-compute.
 */
(function (PA) {
  'use strict';

  var registry = {};

  // Salesforce Lightning Design System palette; current year vs next year get distinct hues.
  var COLORS = {
    current: '#0176d3',
    currentSoft: 'rgba(1, 118, 211, 0.55)',
    next: '#06a59a',
    nextSoft: 'rgba(6, 165, 154, 0.55)',
    weighted: 'rgba(4, 132, 75, 0.85)'
  };

  // Shared look-and-feel for every chart (fonts, axis colour, grid lines).
  if (window.Chart) {
    Chart.defaults.font.family = '"Salesforce Sans", "Segoe UI", Arial, Helvetica, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#706e6b';
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
    if (Chart.defaults.plugins.tooltip) {
      Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(3, 45, 96, 0.94)';
      Chart.defaults.plugins.tooltip.padding = 10;
      Chart.defaults.plugins.tooltip.cornerRadius = 4;
      Chart.defaults.plugins.tooltip.boxPadding = 4;
    }
  }

  // Translucent fill from a hex colour (for area charts).
  function hexToRgba(hex, alpha) {
    var h = hex.replace('#', '');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // Soft grid styling reused across cartesian charts.
  var GRID = { color: 'rgba(112, 110, 107, 0.15)', drawBorder: false };

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  // Resize every live chart to fit its (possibly changed) container — used
  // before printing so canvases reflow into the print layout instead of
  // overflowing their boxes.
  function resizeAll() {
    Object.keys(registry).forEach(function (id) { registry[id].resize(); });
  }

  // PNG data URL of a rendered chart (for embedding in the PDF report).
  function getImage(id) {
    return registry[id] ? registry[id].toBase64Image('image/png', 1.0) : null;
  }

  function currency(n) { return PA.format.currency(n); }

  function baseOptions(extra) {
    var o = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.dataset.label + ': ' + currency(ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed);
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: GRID,
          ticks: { callback: function (v) { return PA.format.compact(v); } }
        },
        x: { grid: { display: false } }
      }
    };
    return Object.assign(o, extra || {});
  }

  // Grouped bar: total vs weighted, for one year's category breakdown.
  function categoryBar(canvasId, labels, totals, weighted, yearColor, softColor) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Pipeline', data: totals, backgroundColor: softColor, borderColor: yearColor, borderWidth: 1, borderRadius: 2, maxBarThickness: 38 },
          { label: 'Weighted', data: weighted, backgroundColor: COLORS.weighted, borderColor: COLORS.weighted, borderWidth: 1, borderRadius: 2, maxBarThickness: 38 }
        ]
      },
      options: baseOptions()
    });
  }

  // Timeline: line for pipeline + line for weighted across periods.
  function timelineChart(canvasId, labels, totals, weighted, yearColor) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Pipeline', data: totals, borderColor: yearColor, borderWidth: 2,
            backgroundColor: hexToRgba(yearColor, 0.10), fill: true, tension: 0.35,
            pointRadius: 3, pointBackgroundColor: yearColor, pointBorderColor: '#fff', pointBorderWidth: 1.5 },
          { label: 'Weighted', data: weighted, borderColor: '#04844b', borderWidth: 2,
            backgroundColor: 'rgba(4,132,75,0.08)', fill: true, tension: 0.35,
            pointRadius: 3, pointBackgroundColor: '#04844b', pointBorderColor: '#fff', pointBorderWidth: 1.5 }
        ]
      },
      options: baseOptions()
    });
  }

  // Horizontal bar of pipeline value per category; deal count shown in tooltip.
  function horizontalBar(canvasId, labels, totals, counts, color, soft) {
    destroy(canvasId);
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Pipeline', data: totals,
          backgroundColor: soft, borderColor: color, borderWidth: 1, borderRadius: 2, maxBarThickness: 26
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var n = counts[ctx.dataIndex];
                return currency(ctx.parsed.x) + ' · ' + n + (n === 1 ? ' deal' : ' deals');
              }
            }
          }
        },
        scales: {
          x: { beginAtZero: true, grid: GRID, ticks: { callback: function (v) { return PA.format.compact(v); } } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // Distinct palette for categorical pie/doughnut slices.
  var PIE_PALETTE = ['#0176d3', '#06a59a', '#04844b', '#dd7a01', '#ba0517',
                     '#5867e8', '#a094ed', '#8a3b8f', '#4b9edd', '#e18402'];

  /*
   * Doughnut chart. opts.kind = 'currency' (default) or 'count' controls value
   * formatting; opts.counts (optional) adds a deal count to currency tooltips.
   * Tooltip always shows the slice's share of the total as a percentage.
   */
  function pieChart(canvasId, labels, values, opts) {
    destroy(canvasId);
    opts = opts || {};
    var counts = opts.counts || null;
    var fmtVal = opts.kind === 'count'
      ? function (v) { return v + (v === 1 ? ' deal' : ' deals'); }
      : function (v) { return currency(v); };
    var bg = labels.map(function (_, i) { return PIE_PALETTE[i % PIE_PALETTE.length]; });
    var sum = values.reduce(function (a, b) { return a + b; }, 0) || 1;
    var ctx = document.getElementById(canvasId).getContext('2d');
    registry[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: bg, borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 8, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed;
                var pct = Math.round((v / sum) * 100);
                var extra = (counts && opts.kind !== 'count') ? ' · ' + counts[c.dataIndex] + ' deals' : '';
                return c.label + ': ' + fmtVal(v) + ' (' + pct + '%)' + extra;
              }
            }
          }
        }
      }
    });
  }

  function colorsForYear(which) {
    return which === 'next'
      ? { solid: COLORS.next, soft: COLORS.nextSoft }
      : { solid: COLORS.current, soft: COLORS.currentSoft };
  }

  PA.charts = {
    destroy: destroy,
    resizeAll: resizeAll,
    getImage: getImage,
    categoryBar: categoryBar,
    timelineChart: timelineChart,
    horizontalBar: horizontalBar,
    pieChart: pieChart,
    colorsForYear: colorsForYear,
    COLORS: COLORS
  };
})(window.PA = window.PA || {});
