/*
 * app.js — orchestration and DOM wiring.
 * Flow: load file -> PA.parse -> PA.mapping (auto + UI) -> PA.analytics
 *       -> render KPIs, charts (PA.charts) and tables.
 *
 * State is held in `state`; any change (new file, remapped column, toggle)
 * calls recompute() then render().
 */
(function (PA) {
  'use strict';

  // ---- formatting helpers (shared with charts.js) ----
  var nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  function currency(n) {
    if (n == null || isNaN(n)) return '—';
    return '£' + nf0.format(Math.round(n));
  }
  function compact(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return '£' + (n / 1e9).toFixed(1) + 'bn';
    if (abs >= 1e6) return '£' + (n / 1e6).toFixed(1) + 'm';
    if (abs >= 1e3) return '£' + (n / 1e3).toFixed(0) + 'k';
    return '£' + nf0.format(n);
  }
  PA.format = { currency: currency, compact: compact };

  var STORAGE_KEY = 'pipelineAnalysis.v1';
  // Snapshot history lives under its own key so a dataset too large to persist
  // never costs you the baselines you compare against.
  var SNAPSHOT_KEY = 'pipelineAnalysis.snapshots.v1';

  var state = {
    table: null,        // { headers, rows }
    mapping: null,
    results: null,
    snapshot: null,      // this report's snapshot, rebuilt on every recompute
    snapshots: [],       // stored history of earlier reports, oldest first
    reportDate: '',      // ISO date this report was run (defaults to the file's date)
    reportLabel: '',     // source filename, shown alongside the dates
    baselineDate: '',    // chosen baseline; '' = most recent earlier report
    timelineGranularity: 'quarter',
    includeClosed: false,
    target: '',          // current-year coverage target (raw text)
    nextTarget: '',      // next-year coverage target (raw text)
    filters: { owner: [], region: [], segment: [], stage: [], leadSource: [] },
    proposedRemoved: {}, // {name: true} manually removed from the top-10 list
    proposedAdded: [],   // [name] manually added to the top-10 list
    proposedOrder: [],   // [name] manual running order; empty = by close date
    dayFirst: null,      // date format override: null=auto, true=D/M/Y, false=M/D/Y
    currentYear: 2026   // overridable; defaults to system year below
  };
  state.currentYear = new Date().getFullYear();

  var el = {};

  function $(id) { return document.getElementById(id); }

  function init() {
    el.fileInput = $('fileInput');
    el.dropZone = $('dropZone');
    el.sampleBtn = $('loadSampleBtn');
    el.mappingPanel = $('mappingPanel');
    el.mappingSection = $('mappingSection');
    el.dashboard = $('dashboard');
    el.dataQuality = $('dataQualityCard');
    el.status = $('statusBar');
    el.granularity = $('granularitySelect');
    el.salespersonSelect = $('salespersonSelect');
    el.includeClosed = $('includeClosedToggle');
    el.targetInput = $('targetInput');
    el.nextTargetInput = $('nextTargetInput');
    el.filtersRow = $('filtersRow');
    el.filtersSummary = $('filtersSummary');
    el.clearFiltersBtn = $('clearFiltersBtn');
    el.exportCsvBtn = $('exportCsvBtn');
    el.pdfReportBtn = $('pdfReportBtn');
    el.resetBtn = $('resetBtn');
    el.topProposedTable = $('topProposedTable');
    el.addProposedSelect = $('addProposedSelect');
    el.addProposedBtn = $('addProposedBtn');
    el.resetOrderBtn = $('resetOrderBtn');
    el.yearLabels = { current: $('yearLabelCurrent'), next: $('yearLabelNext') };
    el.compareCard = $('compareCard');
    el.compareBody = $('compareBody');
    el.reportDateInput = $('reportDateInput');
    el.baselineSelect = $('baselineSelect');
    el.baselineFileInput = $('baselineFileInput');

    el.fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    });

    // Drag & drop
    ['dragover', 'dragenter'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) { e.preventDefault(); el.dropZone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) { e.preventDefault(); el.dropZone.classList.remove('drag'); });
    });
    el.dropZone.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    el.sampleBtn.addEventListener('click', loadSample);

    el.granularity.addEventListener('change', function () {
      state.timelineGranularity = el.granularity.value;
      render(); saveState();
    });
    el.includeClosed.addEventListener('change', function () {
      state.includeClosed = el.includeClosed.checked;
      recompute(); render(); saveState();
    });
    el.salespersonSelect.addEventListener('change', onSalespersonChange);
    // Coverage targets: re-render just the health card, no CSV re-parse.
    el.targetInput.addEventListener('input', function () {
      state.target = el.targetInput.value;
      renderHealth(); saveState();
    });
    el.nextTargetInput.addEventListener('input', function () {
      state.nextTarget = el.nextTargetInput.value;
      renderHealth(); saveState();
    });
    el.clearFiltersBtn.addEventListener('click', clearFilters);
    // Close any open filter popover when clicking elsewhere.
    document.addEventListener('click', closeAllPopovers);

    el.exportCsvBtn.addEventListener('click', exportSummaryCsv);
    el.pdfReportBtn.addEventListener('click', generatePdfReport);
    el.resetBtn.addEventListener('click', resetAll);

    // Manual edits to the top-10 proposed list (event delegation: rows redraw).
    el.topProposedTable.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var mv = e.target.closest('.move-proposed');
      if (mv) {
        moveProposed(mv.getAttribute('data-name'), mv.getAttribute('data-dir') === 'up' ? -1 : 1);
        return;
      }
      var btn = e.target.closest('.remove-proposed');
      if (!btn) return;
      var name = btn.getAttribute('data-name');
      state.proposedRemoved[name] = true;
      state.proposedAdded = state.proposedAdded.filter(function (n) { return n !== name; });
      state.proposedOrder = state.proposedOrder.filter(function (n) { return n !== name; });
      renderInsights(); saveState();
    });
    el.resetOrderBtn.addEventListener('click', function () {
      state.proposedOrder = [];
      renderInsights(); saveState();
    });
    el.addProposedBtn.addEventListener('click', function () {
      var name = el.addProposedSelect.value;
      if (!name) return;
      delete state.proposedRemoved[name];
      if (state.proposedAdded.indexOf(name) === -1) state.proposedAdded.push(name);
      renderInsights(); saveState();
    });

    // Date-format override lives inside the Data Quality card, which is
    // re-rendered on every recompute — use delegation on the stable card root.
    el.dataQuality.addEventListener('change', function (e) {
      var radio = e.target.closest && e.target.closest('input[name="dqDateFormat"]');
      if (!radio) return;
      state.dayFirst = radio.value === 'dayfirst' ? true
                     : radio.value === 'monthfirst' ? false : null;
      recompute(); render(); saveState();
    });

    // ---- Report comparison controls ----
    // Re-dating the report changes which stored snapshot counts as "previous",
    // so rebuild the snapshot and redraw.
    el.reportDateInput.addEventListener('change', function () {
      if (!el.reportDateInput.value) return;
      state.reportDate = el.reportDateInput.value;
      recompute(); render(); saveState();
    });
    el.baselineSelect.addEventListener('change', function () {
      state.baselineDate = el.baselineSelect.value;
      renderComparison(); saveState();
    });
    el.baselineFileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadBaselineFile(e.target.files[0]);
    });

    // Charts don't reflow for print on their own — resize them first.
    window.addEventListener('beforeprint', function () { PA.charts.resizeAll(); });

    restoreSnapshots();
    restoreState();
  }

  function currentHealth() {
    return PA.analytics.healthMetrics(state.table.rows, state.mapping, state.target,
      new Date(), { includeClosed: state.includeClosed, filters: state.filters });
  }

  function currentPerformance() {
    return PA.analytics.performanceMetrics(state.table.rows, state.mapping,
      new Date(), { includeClosed: state.includeClosed, filters: state.filters });
  }

  function currentForecast() {
    return PA.analytics.forecastMetrics(state.table.rows, state.mapping,
      new Date(), { filters: state.filters });
  }

  // Movement since the previous report, for the exports. Null when there is no
  // earlier report to measure against.
  function currentComparison() {
    if (!state.snapshot) return null;
    return PA.compare.diffSnapshots(baselineSnapshot(state.snapshot), state.snapshot,
      { filters: state.filters });
  }

  // Slug for filenames, e.g. "Jane Smith" -> "-jane-smith" (empty for everyone).
  function personSlug() {
    var p = selectedPerson();
    return p ? '-' + p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  }

  function exportSummaryCsv() {
    if (!state.results) return;
    var ins = currentInsights();
    var csv = PA.export.buildSummaryCsv(state.results, currentHealth(), ins, {
      generated: new Date().toISOString().slice(0, 10),
      // Same curated list the screen and the PDF use, so all three agree.
      proposed: computeShownProposed(ins).shown,
      performance: currentPerformance(),
      forecast: currentForecast(),
      filterSummary: filterSummaryText(),
      person: selectedPerson(),
      comparison: currentComparison()
    });
    downloadFile('pipeline-analysis' + personSlug() + '-' + new Date().toISOString().slice(0, 10) + '.csv',
      csv, 'text/csv;charset=utf-8');
  }

  function exportSkippedCsv() {
    if (!state.results) return;
    var csv = PA.export.buildSkippedCsv(state.results);
    if (!csv) {
      setStatus('No skipped rows to download — every open row parsed cleanly.', 'info');
      return;
    }
    // No personSlug(): skipped rows are whole-file, unaffected by filters.
    // Prefix a UTF-8 BOM so Excel opens the file with the right encoding.
    downloadFile('pipeline-analysis-skipped-rows-' +
      new Date().toISOString().slice(0, 10) + '.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
  }

  // The curated top-proposed list shown in the UI = auto top-10 minus removed,
  // plus any manually added opportunities. Shared by the table and the PDF.
  function computeShownProposed(ins) {
    var shown = ins.topProposed.filter(function (it) { return !state.proposedRemoved[it.name]; });
    var names = {};
    shown.forEach(function (it) { names[it.name] = true; });
    state.proposedAdded.forEach(function (name) {
      if (names[name]) return;
      var opp = ins.allOpps.filter(function (o) { return o.name === name; })[0];
      if (opp) { shown.push(opp); names[name] = true; }
    });
    /*
     * Order: close date first (soonest to close), unless the user has dragged
     * the list into their own running order. A manual move stores the whole
     * order, so anything appearing later — a newly added opportunity, or a
     * deal that shows up in the next report — has no place in it and falls to
     * the end by close date rather than landing somewhere arbitrary.
     */
    var rank = {};
    state.proposedOrder.forEach(function (n, i) { rank[n] = i; });
    shown.sort(function (a, b) {
      var ai = rank[a.name], bi = rank[b.name];
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return a.closeDate.getTime() - b.closeDate.getTime();
    });
    return { shown: shown, names: names };
  }

  // Move one opportunity up or down the list. The resulting order is stored in
  // full, so it stays stable no matter what changes around it.
  function moveProposed(name, dir) {
    if (!state.results) return;
    var order = computeShownProposed(currentInsights()).shown.map(function (it) { return it.name; });
    var i = order.indexOf(name);
    var j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    order[i] = order[j];
    order[j] = name;
    state.proposedOrder = order;
    renderInsights(); saveState();
  }

  function generatePdfReport() {
    if (!state.results) return;
    var ins = currentInsights();
    var docDef = PA.pdf.buildDocDefinition({
      results: state.results,
      health: currentHealth(),
      insights: ins,
      proposed: computeShownProposed(ins).shown,
      performance: currentPerformance(),
      forecast: currentForecast(),
      comparison: currentComparison(),
      images: {
        stageCurrent: PA.charts.getImage('stageChart_current'),
        stageNext: PA.charts.getImage('stageChart_next'),
        timelineCurrent: PA.charts.getImage('timelineChart_current'),
        timelineNext: PA.charts.getImage('timelineChart_next'),
        ownerCurrent: PA.charts.getImage('ownerChart_current'),
        ownerNext: PA.charts.getImage('ownerChart_next'),
        won: PA.charts.getImage('wonChart'),
        lead: PA.charts.getImage('leadChart')
      },
      meta: {
        generated: new Date().toISOString().slice(0, 10),
        filterSummary: filterSummaryText(),
        person: selectedPerson()
      }
    });
    PA.pdf.download(docDef, 'pipeline-analysis' + personSlug() + '-' + new Date().toISOString().slice(0, 10) + '.pdf');
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function setStatus(msg, kind) {
    el.status.textContent = msg || '';
    el.status.className = 'status-bar' + (kind ? ' ' + kind : '');
    el.status.style.display = msg ? 'block' : 'none';
  }

  /*
   * The date a report was taken. A Salesforce export's file timestamp is the
   * moment it was run, which is exactly what we want; fall back to today for
   * pasted or generated data. Local Y/M/D is carried over verbatim so the date
   * shown matches the one on the user's own file listing.
   */
  function fileDateIso(file) {
    var d = (file && file.lastModified) ? new Date(file.lastModified) : new Date();
    return PA.compare.toIso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
  }

  function loadFile(file) {
    setStatus('Reading ' + file.name + ' …', 'info');
    PA.parse.readFile(file).then(function (table) {
      onTableLoaded(table, false, { name: file.name, date: fileDateIso(file) });
    }).catch(function (err) {
      setStatus('Could not read file: ' + err.message, 'error');
    });
  }

  /*
   * Load an earlier export purely as a comparison baseline — it is mapped and
   * snapshotted on its own, then stored in the history, but never becomes the
   * dashboard's dataset.
   */
  function loadBaselineFile(file) {
    setStatus('Reading previous report ' + file.name + ' …', 'info');
    PA.parse.readFile(file).then(function (t) {
      if (!t.headers.length || !t.rows.length) {
        setStatus('No data rows found in that previous report.', 'error');
        return;
      }
      var m = PA.mapping.autoDetect(t.headers);
      var missing = PA.mapping.requiredMissing(m);
      if (missing.length) {
        setStatus('That previous report is missing required column(s): ' + missing.join(', '), 'error');
        return;
      }
      var snap = PA.compare.buildSnapshot(t.rows, m, {
        currentYear: state.currentYear,
        reportDate: fileDateIso(file),
        label: file.name
      });
      if (state.snapshot && snap.reportDate >= state.snapshot.reportDate) {
        setStatus('That report is dated ' + fmtIso(snap.reportDate) + ', which is not before this one (' +
          fmtIso(state.snapshot.reportDate) + '). Adjust the report dates to compare them.', 'warn');
        return;
      }
      state.snapshots = PA.compare.addSnapshot(state.snapshots, snap);
      state.baselineDate = snap.reportDate;
      saveSnapshots(); saveState();
      renderComparison();
      setStatus('Comparing against ' + file.name + ' (' + fmtIso(snap.reportDate) + ').', 'info');
    }).catch(function (err) {
      setStatus('Could not read that previous report: ' + err.message, 'error');
    });
  }

  function loadSample() {
    setStatus('Loading sample data …', 'info');
    // Try fetch (works over http://). Fall back to a clear message over file://.
    fetch('sample/sample_pipeline.csv').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      onTableLoaded(PA.parse.readText(text), false,
        { name: 'sample_pipeline.csv', date: PA.compare.toIso(new Date()) });
    }).catch(function () {
      setStatus('Sample auto-load is blocked when opening via file://. ' +
        'Use the upload button and pick sample/sample_pipeline.csv, or run a local server.', 'error');
    });
  }

  function onTableLoaded(table, restored, meta) {
    if (!table.headers.length || !table.rows.length) {
      setStatus('No data rows found in that file.', 'error');
      return;
    }
    state.table = table;
    // A freshly loaded file starts with auto-mapping and no manual list edits;
    // a restored session keeps whatever was saved.
    if (!restored) {
      state.mapping = PA.mapping.autoDetect(table.headers);
      state.proposedRemoved = {};
      state.proposedAdded = [];
      state.proposedOrder = [];
      // A new report dates itself from the file and compares against whatever
      // stored report came immediately before it.
      state.reportDate = (meta && meta.date) || PA.compare.toIso(new Date());
      state.reportLabel = (meta && meta.name) || '';
      state.baselineDate = '';
    }
    PA.mapping.renderPanel(el.mappingPanel, table.headers, state.mapping, function (m) {
      state.mapping = m;
      populateFilters(); recompute(); render(); saveState();
    });
    el.mappingSection.style.display = 'block';
    populateFilters();
    recompute(); render();
    if (!restored) saveState();
  }

  // ---- Persistence: keep the loaded data + settings across browser sessions ----
  function saveState() {
    if (!state.table) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        table: state.table,
        mapping: state.mapping,
        timelineGranularity: state.timelineGranularity,
        includeClosed: state.includeClosed,
        target: state.target,
        nextTarget: state.nextTarget,
        filters: state.filters,
        proposedRemoved: state.proposedRemoved,
        proposedAdded: state.proposedAdded,
        proposedOrder: state.proposedOrder,
        dayFirst: state.dayFirst,
        reportDate: state.reportDate,
        reportLabel: state.reportLabel,
        baselineDate: state.baselineDate
      }));
    } catch (e) {
      // Most likely the dataset is too large for localStorage; carry on without
      // persistence rather than breaking the app.
      setStatus('Note: data is loaded but too large to save for next time.', 'warn');
    }
  }

  function restoreState() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved || !saved.table) return;

    state.mapping = saved.mapping || null;
    state.timelineGranularity = saved.timelineGranularity || 'quarter';
    state.includeClosed = !!saved.includeClosed;
    state.target = saved.target || '';
    state.nextTarget = saved.nextTarget || '';
    state.filters = Object.assign({ owner: [], region: [], segment: [], stage: [], leadSource: [] }, saved.filters || {});
    state.proposedRemoved = saved.proposedRemoved || {};
    state.proposedAdded = saved.proposedAdded || [];
    state.proposedOrder = saved.proposedOrder || [];
    state.dayFirst = saved.dayFirst == null ? null : saved.dayFirst;
    state.reportDate = saved.reportDate || PA.compare.toIso(new Date());
    state.reportLabel = saved.reportLabel || '';
    state.baselineDate = saved.baselineDate || '';

    // Reflect restored settings in the controls.
    el.granularity.value = state.timelineGranularity;
    el.includeClosed.checked = state.includeClosed;
    el.targetInput.value = state.target;
    el.nextTargetInput.value = state.nextTarget;

    onTableLoaded(saved.table, true);
  }

  // ---- Snapshot history: the baselines this report is compared against ----
  function saveSnapshots() {
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state.snapshots)); }
    catch (e) { /* history is a nice-to-have — never break the app over it */ }
  }

  function restoreSnapshots() {
    var raw;
    try { raw = localStorage.getItem(SNAPSHOT_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var list = JSON.parse(raw);
      if (Array.isArray(list)) state.snapshots = list;
    } catch (e) { /* ignore corrupt history */ }
  }

  // Record this report so the next one has something to compare against.
  // addSnapshot replaces any entry with the same date, so re-loading or
  // re-mapping the same report refreshes its snapshot instead of duplicating it.
  function rememberCurrentReport() {
    if (!state.snapshot) return;
    state.snapshots = PA.compare.addSnapshot(state.snapshots, state.snapshot);
    saveSnapshots();
  }

  // The snapshot this report is measured against: an explicitly chosen one
  // when set, otherwise the most recent report dated before this one.
  function baselineSnapshot(curr) {
    if (state.baselineDate) {
      var picked = state.snapshots.filter(function (s) {
        return s.reportDate === state.baselineDate && s.reportDate < curr.reportDate;
      })[0];
      if (picked) return picked;
    }
    return PA.compare.previousSnapshot(state.snapshots, curr);
  }

  function fmtIso(iso) {
    var d = PA.compare.fromIso(iso);
    return d ? fmtDate(d) : (iso || '—');
  }

  function resetAll() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state.table = null;
    state.mapping = null;
    state.results = null;
    // The stored snapshot history deliberately survives a reset — it is the
    // whole point of the comparison, and you reset precisely to load the next
    // report that should be measured against it.
    state.snapshot = null;
    state.reportDate = '';
    state.reportLabel = '';
    state.baselineDate = '';
    state.target = '';
    state.nextTarget = '';
    state.includeClosed = false;
    state.timelineGranularity = 'quarter';
    state.filters = { owner: [], region: [], segment: [], stage: [], leadSource: [] };
    state.proposedRemoved = {};
    state.proposedAdded = [];
    state.proposedOrder = [];
    state.dayFirst = null;
    el.targetInput.value = '';
    el.nextTargetInput.value = '';
    el.includeClosed.checked = false;
    el.granularity.value = 'quarter';
    el.fileInput.value = '';
    el.filtersRow.innerHTML = '';
    el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>';
    el.mappingPanel.innerHTML = '';
    el.mappingSection.style.display = 'none';
    el.dashboard.style.display = 'none';
    setStatus('Data cleared. Upload a Salesforce CSV to start again.', 'info');
  }

  // ---- Filters ----
  // All filterable dimensions (used for summaries/clear). Owner is driven by the
  // dedicated single-select "Salesperson" control; the rest render as the
  // multi-select pills in the filters row.
  var FILTER_DIMS = [
    ['owner', 'Salesperson'], ['region', 'Region'], ['segment', 'Segment'],
    ['stage', 'Stage'], ['leadSource', 'Lead source']
  ];
  var MULTI_DIMS = FILTER_DIMS.filter(function (d) { return d[0] !== 'owner'; });

  function populateFilters() {
    if (!state.table || !state.mapping) return;
    if (PA.mapping.requiredMissing(state.mapping).length) {
      el.filtersRow.innerHTML = '';
      el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>';
      return;
    }
    var vals = PA.analytics.distinctFilterValues(state.table.rows, state.mapping, { currentYear: state.currentYear });

    // Salesperson dropdown (single person) — drives state.filters.owner.
    state.filters.owner = (state.filters.owner || []).filter(function (v) { return vals.owner.indexOf(v) !== -1; });
    var selectedPerson = state.filters.owner.length === 1 ? state.filters.owner[0] : '';
    el.salespersonSelect.innerHTML = '<option value="">All salespeople</option>' +
      vals.owner.map(function (o) {
        return '<option value="' + escapeHtml(o) + '"' + (o === selectedPerson ? ' selected' : '') + '>' +
          escapeHtml(o) + '</option>';
      }).join('');

    // The remaining dimensions as multi-select pills.
    el.filtersRow.innerHTML = '';
    MULTI_DIMS.forEach(function (d) {
      var key = d[0];
      state.filters[key] = (state.filters[key] || []).filter(function (v) { return vals[key].indexOf(v) !== -1; });
      createMultiSelect(el.filtersRow, d[1], vals[key], state.filters[key], function (selected) {
        state.filters[key] = selected;
        recompute(); render(); saveState();
      });
    });
    updateFiltersSummary();
  }

  function onSalespersonChange() {
    var val = el.salespersonSelect.value;
    state.filters.owner = val ? [val] : [];
    recompute(); render(); saveState();
  }

  // The currently selected single salesperson, or null when viewing everyone.
  function selectedPerson() {
    return state.filters.owner && state.filters.owner.length === 1 ? state.filters.owner[0] : null;
  }

  function createMultiSelect(container, label, values, selected, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'ms';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-btn';
    var pop = document.createElement('div');
    pop.className = 'ms-pop';
    pop.style.display = 'none';
    var chosen = selected.slice();

    function refreshLabel() { btn.textContent = label + ': ' + (chosen.length ? chosen.length + ' selected' : 'All'); }
    refreshLabel();

    values.forEach(function (v) {
      var row = document.createElement('label');
      row.className = 'ms-opt';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.indexOf(v) !== -1;
      cb.addEventListener('change', function () {
        if (cb.checked) { if (chosen.indexOf(v) === -1) chosen.push(v); }
        else { chosen = chosen.filter(function (x) { return x !== v; }); }
        refreshLabel();
        onChange(chosen.slice());
      });
      var span = document.createElement('span');
      span.textContent = v || '(blank)';
      row.appendChild(cb); row.appendChild(span);
      pop.appendChild(row);
    });
    if (!values.length) {
      var empty = document.createElement('div');
      empty.className = 'muted'; empty.style.padding = '6px 8px';
      empty.textContent = 'No values'; pop.appendChild(empty);
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = pop.style.display !== 'none';
      closeAllPopovers();
      pop.style.display = isOpen ? 'none' : 'block';
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });

    wrap.appendChild(btn); wrap.appendChild(pop);
    container.appendChild(wrap);
  }

  function closeAllPopovers() {
    var pops = document.querySelectorAll('.ms-pop');
    for (var i = 0; i < pops.length; i++) pops[i].style.display = 'none';
  }

  function activeFilterKeys() {
    return FILTER_DIMS.map(function (d) { return d[0]; })
      .filter(function (k) { return state.filters[k] && state.filters[k].length; });
  }

  function updateFiltersSummary() {
    var active = activeFilterKeys();
    var labels = {}; FILTER_DIMS.forEach(function (d) { labels[d[0]] = d[1]; });
    el.filtersSummary.textContent = active.length
      ? 'Filtering: ' + active.map(function (k) { return labels[k] + ' (' + state.filters[k].length + ')'; }).join(', ')
      : 'No filters applied — showing all opportunities.';
  }

  function filterSummaryText() {
    var active = activeFilterKeys();
    if (!active.length) return '';
    var labels = {}; FILTER_DIMS.forEach(function (d) { labels[d[0]] = d[1]; });
    return active.map(function (k) { return labels[k] + ': ' + state.filters[k].join(', '); }).join('  ·  ');
  }

  function clearFilters() {
    FILTER_DIMS.forEach(function (d) { state.filters[d[0]] = []; });
    el.salespersonSelect.value = '';
    populateFilters(); recompute(); render(); saveState();
  }

  function recompute() {
    if (!state.table || !state.mapping) { state.results = null; state.snapshot = null; return; }
    var missing = PA.mapping.requiredMissing(state.mapping);
    if (missing.length) {
      state.results = null;
      state.snapshot = null;
      setStatus('Map the required column(s): ' + missing.join(', '), 'warn');
      el.dashboard.style.display = 'none';
      return;
    }
    // Snapshot the whole report — deliberately unfiltered, so a comparison
    // against an earlier report is never skewed by the filters in force today.
    state.snapshot = PA.compare.buildSnapshot(state.table.rows, state.mapping, {
      currentYear: state.currentYear,
      dayFirst: state.dayFirst == null ? undefined : state.dayFirst,
      reportDate: state.reportDate || PA.compare.toIso(new Date()),
      label: state.reportLabel
    });
    rememberCurrentReport();

    state.results = PA.analytics.analyze(state.table.rows, state.mapping, {
      currentYear: state.currentYear,
      includeClosed: state.includeClosed,
      filters: state.filters,
      // Only pass an override when the user has chosen one; null means auto-detect.
      dayFirst: state.dayFirst == null ? undefined : state.dayFirst
    });

    var r = state.results;
    var bits = [
      r.totalRecords + ' opportunities in view',
      r.outOfRange + ' outside ' + r.currentYear + '/' + r.nextYear,
      r.skipped + ' skipped (bad amount/date)'
    ];
    if (!state.mapping.probability) bits.push('no probability column — weighted forecast uses stage-based estimates');
    bits.push('dates read as ' + (r.dayFirst ? 'day/month/year' : 'month/day/year'));
    setStatus(bits.join('  •  '), 'info');
  }

  function render() {
    var r = state.results;
    if (!r) return;
    el.dashboard.style.display = 'block';
    el.yearLabels.current.textContent = r.currentYear;
    el.yearLabels.next.textContent = r.nextYear;

    renderDataQuality();
    renderComparison();
    renderColumn('current', r.years[r.currentYear], r.currentYear);
    renderColumn('next', r.years[r.nextYear], r.nextYear);
    renderHealth();
    renderPerformance();
    renderForecast();
    renderInsights();
    updateFiltersSummary();
  }

  // Forecast Outlook card — anchored to the report month.
  function renderForecast() {
    if (!state.results) return;
    var f = currentForecast();
    $('fcMonthLabel').textContent = f.monthLabel;

    $('fcOrdersMonth').textContent = f.month.count + (f.month.count === 1 ? ' order' : ' orders');
    $('fcOrdersMonthSub').textContent = f.monthLabel + ' · ' + currency(f.month.total) + ' total · ' +
      currency(f.month.weighted) + ' weighted';

    $('fc90').textContent = currency(f.next90.total);
    $('fc90Sub').textContent = f.next90Label + ' · ' + currency(f.next90.weighted) + ' weighted · ' +
      f.next90.count + (f.next90.count === 1 ? ' deal' : ' deals');

    $('fc365').textContent = currency(f.next365.total);
    $('fc365Sub').textContent = f.next365Label + ' · ' + currency(f.next365.weighted) + ' weighted · ' +
      f.next365.count + (f.next365.count === 1 ? ' deal' : ' deals');

    $('fcStrategic').textContent = currency(f.strategic.total);
    $('fcStrategicSub').textContent = currency(f.strategic.weighted) + ' weighted · ' +
      (f.strategic.count
        ? f.strategic.count + (f.strategic.count === 1 ? ' opportunity' : ' opportunities')
        : 'none £10m+');
  }

  // Sales Performance card (current year).
  function renderPerformance() {
    if (!state.results) return;
    var p = currentPerformance();
    $('perfYearLabel').textContent = p.currentYear;
    $('perfWinRate').textContent = p.winRatePct == null ? '—' : Math.round(p.winRatePct) + '%';
    $('perfWinSub').textContent = (p.wonCount + p.lostCount)
      ? (p.wonCount + ' won / ' + p.lostCount + ' lost') : 'no closed deals yet';
    $('perfWinRateValue').textContent = p.winRateValuePct == null ? '—' : Math.round(p.winRateValuePct) + '%';
    $('perfCycle').textContent = p.avgCycleDays == null ? '—' : p.avgCycleDays + ' days';
    $('perfCycleSub').textContent = p.avgCycleDays == null
      ? (p.hasCreated ? 'no closed-won deals' : 'map a Created Date column')
      : ('over ' + p.cycleCount + ' won ' + (p.cycleCount === 1 ? 'deal' : 'deals'));
    $('perfVelocity').textContent = p.velocityPerDay == null ? '—' : currency(p.velocityPerDay) + '/day';
    $('perfVelocitySub').textContent = p.velocityPerDay == null
      ? 'needs win rate + sales cycle' : (currency(p.velocityPerMonth) + '/month');
  }

  function currentInsights() {
    return PA.analytics.insightMetrics(state.table.rows, state.mapping, new Date(),
      { includeClosed: state.includeClosed, filters: state.filters });
  }

  // Pipeline Insights card: avg open age, won-by-owner, lead source, top 10 proposed.
  function renderInsights() {
    if (!state.results || !state.table || !state.mapping) return;
    var ins = currentInsights();

    // Avg age of open opportunities
    if (ins.avgOpenAgeDays == null) {
      $('avgAgeStat').textContent = '—';
      $('avgAgeSub').textContent = ins.hasCreated
        ? 'No open opportunities with a created date.'
        : 'Map a Created Date column to see this.';
    } else {
      $('avgAgeStat').textContent = ins.avgOpenAgeDays + ' days';
      $('avgAgeSub').textContent = 'across ' + ins.openAgeCount +
        ' open opportunities (created → today)';
    }

    // Won revenue by owner (current year, closed won)
    $('wonYearLabel').textContent = ins.currentYear;
    $('wonTotalLabel').textContent = ins.wonCount
      ? 'Total won: ' + currency(ins.wonTotal) + ' · ' + ins.wonCount +
        (ins.wonCount === 1 ? ' deal' : ' deals')
      : 'No closed-won deals in ' + ins.currentYear + '.';
    PA.charts.pieChart('wonChart',
      ins.wonByOwner.map(function (o) { return o.key; }),
      ins.wonByOwner.map(function (o) { return o.total; }),
      { kind: 'currency', counts: ins.wonByOwner.map(function (o) { return o.count; }) });

    // Lead source mix
    if (!ins.hasLeadSource) {
      PA.charts.destroy('leadChart');
      $('leadNote').textContent = 'Map a Lead Source column to see this.';
    } else {
      $('leadNote').textContent = '';
      PA.charts.pieChart('leadChart',
        ins.leadSources.map(function (o) { return o.key; }),
        ins.leadSources.map(function (o) { return o.count; }),
        { kind: 'count' });
    }

    // Awarded opportunities (current+next year) — name, value, owner + total.
    $('awardedYearLabel').textContent = ins.currentYear;
    var awHead = '<thead><tr><th>Opportunity</th><th>Value</th><th>Owner</th></tr></thead>';
    var awBody = ins.awarded.map(function (a) {
      return '<tr>' +
        '<td>' + escapeHtml(a.name) + '</td>' +
        '<td class="num">' + currency(a.amount) + '</td>' +
        '<td>' + escapeHtml(a.owner) + '</td>' +
      '</tr>';
    }).join('');
    var awFoot = ins.awarded.length
      ? '<tfoot><tr class="total-row">' +
          '<td>Total awarded</td>' +
          '<td class="num">' + currency(ins.awardedTotal) + '</td>' +
          '<td>' + ins.awarded.length + (ins.awarded.length === 1 ? ' deal' : ' deals') + '</td>' +
        '</tr></tfoot>'
      : '';
    $('awardedTable').innerHTML = awHead + '<tbody>' +
      (awBody || '<tr><td colspan="3" class="muted">No awarded opportunities.</td></tr>') +
      '</tbody>' + awFoot;

    // Top 10 proposed (auto-ranked) with manual add/remove.
    var curated = computeShownProposed(ins);
    var shown = curated.shown, shownNames = curated.names;

    var headers = ['#', 'Opportunity', 'Value', 'Close date', 'Rating', 'Next step', ''];
    var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = shown.map(function (it, idx) {
      var nm = escapeHtml(it.name);
      var first = idx === 0, last = idx === shown.length - 1;
      return '<tr>' +
        '<td class="rank">' + (idx + 1) + '</td>' +
        '<td>' + nm + '</td>' +
        '<td class="num">' + currency(it.amount) + '</td>' +
        '<td class="num">' + fmtDate(it.closeDate) + '</td>' +
        '<td class="num">' + Math.round(it.probability * 100) + '%</td>' +
        '<td class="next-step">' + escapeHtml(it.nextStep || '—') + '</td>' +
        '<td class="num row-actions">' +
          '<button type="button" class="move-proposed" data-dir="up" title="Move up"' +
            (first ? ' disabled' : '') + ' aria-label="Move ' + nm + ' up"' +
            ' data-name="' + nm + '">&#9650;</button>' +
          '<button type="button" class="move-proposed" data-dir="down" title="Move down"' +
            (last ? ' disabled' : '') + ' aria-label="Move ' + nm + ' down"' +
            ' data-name="' + nm + '">&#9660;</button>' +
          '<button type="button" class="remove-proposed" title="Remove"' +
            ' aria-label="Remove ' + nm + '" data-name="' + nm + '">✕</button>' +
        '</td>' +
      '</tr>';
    }).join('');
    el.topProposedTable.innerHTML = thead + '<tbody>' +
      (body || '<tr><td colspan="7" class="muted">No proposed opportunities.</td></tr>') + '</tbody>';

    // The "reset order" control only makes sense once the list has been moved.
    el.resetOrderBtn.style.display = state.proposedOrder.length ? '' : 'none';

    // Populate the "add" dropdown with opportunities not already shown.
    var options = ['<option value="">Select an opportunity…</option>'];
    ins.allOpps.forEach(function (o) {
      if (shownNames[o.name]) return;
      options.push('<option value="' + escapeHtml(o.name) + '">' +
        escapeHtml(o.name) + ' — ' + currency(o.amount) + ' (' + escapeHtml(o.stage) + ')</option>');
    });
    el.addProposedSelect.innerHTML = options.join('');
  }

  function renderCoverage(elm, ratio, status, weighted, target, year) {
    if (ratio == null) {
      elm.className = 'coverage-result';
      elm.innerHTML = '<p class="muted">Enter a ' + year + ' target to see coverage.<br>Weighted forecast: <strong>' +
        currency(weighted) + '</strong></p>';
    } else {
      elm.className = 'coverage-result ' + status;
      elm.innerHTML =
        '<div class="coverage-ratio">' + Math.round(ratio) + '%</div>' +
        '<div class="coverage-sub">' + compact(weighted) + ' weighted against ' + compact(target) + ' target</div>';
    }
  }

  // Data Quality card — what was parsed, what was dropped and why, the spread
  // of deals by year, and a manual date-format override with a live preview.
  // Filter-independent: it describes the file as loaded, not the current view.
  function renderDataQuality() {
    if (!state.results || !el.dataQuality) return;
    var r = state.results;
    var yc = r.yearCounts || {};
    var years = Object.keys(yc).map(Number).sort(function (a, b) { return a - b; });
    var parsed = years.reduce(function (s, y) { return s + yc[y]; }, 0);
    var inRange = (yc[r.currentYear] || 0) + (yc[r.nextYear] || 0);
    var outside = parsed - inRange;
    var skipped = r.skipped || 0;
    var skippedClosed = r.skippedClosed || 0;
    var skippedRows = r.skippedRows || [];
    var suppressed = r.suppressed || 0;

    // ---- Summary chips ----
    var summary =
      '<div class="dq-summary">' +
        dqChip(parsed + skipped + skippedClosed + suppressed, 'rows in file') +
        dqChip(parsed, 'parsed') +
        dqChip(inRange, 'in ' + r.currentYear + '/' + r.nextYear, 'good') +
        dqChip(outside, 'other years', outside ? 'warn' : '') +
        dqChip(skipped, 'skipped', skipped ? 'bad' : '') +
        (suppressed ? dqChip(suppressed, 'excluded owners') : '') +
      '</div>' +
      // Never let people vanish from a report without saying so.
      (suppressed ? '<p class="muted">' + suppressed + ' row' + (suppressed === 1 ? '' : 's') +
        ' excluded from every figure on this page: opportunities owned by ' +
        escapeHtml(PA.analytics.SUPPRESSED_OWNERS.map(titleCaseName).join(', ')) +
        '. Edit <code>SUPPRESSED_OWNERS</code> in <code>js/analytics.js</code> to change this.</p>' : '');

    // ---- By-year distribution ----
    // Distant future years are collapsed into a single "N onwards" bucket so
    // the chart isn't stretched out by sparse long-dated deals. The bucket
    // never absorbs the analysis-window years, so the highlighted bars keep
    // working as the calendar advances past 2030.
    var futureFrom = Math.max(2030, r.nextYear + 1);
    var buckets = [];
    var futureCount = 0;
    years.forEach(function (y) {
      if (y >= futureFrom) { futureCount += yc[y]; return; }
      buckets.push({ label: String(y), count: yc[y],
        inWindow: (y === r.currentYear || y === r.nextYear) });
    });
    if (futureCount) buckets.push({ label: futureFrom + ' onwards', count: futureCount, inWindow: false });

    var maxCount = buckets.reduce(function (m, b) { return Math.max(m, b.count); }, 0) || 1;
    var bars = buckets.map(function (b) {
      var pct = Math.round(b.count / maxCount * 100);
      return '<div class="dq-bar-row' + (b.inWindow ? ' in-range' : '') + '">' +
        '<span class="dq-bar-label">' + b.label + '</span>' +
        '<span class="dq-bar-track"><span class="dq-bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="dq-bar-count">' + b.count + '</span>' +
      '</div>';
    }).join('');
    var yearBlock =
      '<div class="dq-block">' +
        '<h3>Deals by close-date year</h3>' +
        (years.length
          ? '<div class="dq-bars">' + bars + '</div>' +
            '<p class="muted dq-note">Highlighted rows fall inside the ' +
              r.currentYear + '/' + r.nextYear + ' analysis window. Other years are ' +
              'parsed correctly but sit outside it — expected for historical or ' +
              'long-dated deals.</p>'
          : '<p class="muted">No dated rows parsed.</p>') +
      '</div>';

    // ---- Date format override + preview ----
    var current = state.dayFirst === true ? 'dayfirst'
                : state.dayFirst === false ? 'monthfirst' : 'auto';
    var activeLabel = r.dayFirst ? 'day / month / year (DD/MM/YYYY)'
                                 : 'month / day / year (MM/DD/YYYY)';
    var detectNote = state.dayFirst == null
      ? 'Auto-detected as ' + activeLabel + '.'
      : 'Forced to ' + activeLabel + '.';
    var preview = dqDatePreview(r.dayFirst);
    var formatBlock =
      '<div class="dq-block">' +
        '<h3>Date format</h3>' +
        '<div class="dq-format-controls">' +
          dqRadio('auto', 'Auto-detect', current) +
          dqRadio('dayfirst', 'Day first · DD/MM/YYYY', current) +
          dqRadio('monthfirst', 'Month first · MM/DD/YYYY', current) +
        '</div>' +
        '<p class="muted dq-note">' + escapeHtml(detectNote) +
          ' If dates look wrong below, switch the format and the whole dashboard updates.</p>' +
        preview +
      '</div>';

    // ---- Skipped rows table ----
    var closedNote = skippedClosed
      ? '<p class="muted dq-note">' + skippedClosed + ' Closed Won/Lost row' +
        (skippedClosed === 1 ? '' : 's') + ' with unreadable data ' +
        (skippedClosed === 1 ? 'was' : 'were') + ' hidden — those deals are ' +
        'already decided, so nothing needs fixing.</p>'
      : '';
    var skippedBlock;
    if (!skippedRows.length) {
      skippedBlock =
        '<div class="dq-block">' +
          '<h3>Skipped rows</h3>' +
          '<p class="dq-ok">✓ No rows skipped — every open row parsed cleanly.</p>' +
          closedNote +
        '</div>';
    } else {
      var DISPLAY_CAP = 200;
      var shownRows = skippedRows.slice(0, DISPLAY_CAP);
      var rowsHtml = shownRows.map(function (s) {
        return '<tr>' +
          '<td class="num">' + s.row + '</td>' +
          '<td>' + escapeHtml(s.name || '—') + '</td>' +
          '<td>' + escapeHtml(s.rawStage || '—') + '</td>' +
          '<td>' + escapeHtml(s.rawAmount || '—') + '</td>' +
          '<td>' + escapeHtml(s.rawDate || '—') + '</td>' +
          '<td><span class="dq-reason dq-reason-' + s.reason.replace(/[^a-z]/g, '') + '">' +
            escapeHtml(s.reason) + '</span></td>' +
        '</tr>';
      }).join('');
      var capped = skippedRows.length > shownRows.length
        ? '<p class="muted dq-note">Showing the first ' + shownRows.length +
          ' of ' + skippedRows.length + ' skipped rows — download for the full list.</p>'
        : '';
      skippedBlock =
        '<div class="dq-block">' +
          '<h3>Skipped rows <span class="dq-count-pill">' + skipped + '</span>' +
            '<button type="button" id="dqExportSkippedBtn" class="btn btn-ghost dq-export-btn">' +
              'Download skipped rows (Excel/CSV)</button></h3>' +
          '<p class="muted dq-note">These open rows could not be read (the amount or ' +
            'close date would not parse) and are excluded from every figure. ' +
            'Fix them in the source CSV — or correct the date format above — to recover them.</p>' +
          closedNote +
          '<div class="dq-table-wrap"><table class="data-table dq-skipped-table">' +
            '<thead><tr><th>Row</th><th>Name</th><th>Stage</th><th>Amount (raw)</th>' +
              '<th>Close date (raw)</th><th>Reason</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody>' +
          '</table></div>' + capped +
        '</div>';
    }

    el.dataQuality.innerHTML =
      '<h2>Data Quality</h2>' +
      summary +
      '<div class="dq-grid">' + yearBlock + formatBlock + '</div>' +
      skippedBlock;

    var skippedBtn = document.getElementById('dqExportSkippedBtn');
    if (skippedBtn) skippedBtn.addEventListener('click', exportSkippedCsv);
  }

  // "katherine piper" -> "Katherine Piper", for displaying the config list.
  function titleCaseName(s) {
    return String(s).replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  function dqChip(value, label, kind) {
    return '<div class="dq-chip' + (kind ? ' dq-chip-' + kind : '') + '">' +
      '<span class="dq-chip-value">' + value + '</span>' +
      '<span class="dq-chip-label">' + escapeHtml(label) + '</span>' +
    '</div>';
  }

  function dqRadio(value, label, current) {
    return '<label class="dq-radio">' +
      '<input type="radio" name="dqDateFormat" value="' + value + '"' +
        (value === current ? ' checked' : '') + ' /> ' +
      escapeHtml(label) +
    '</label>';
  }

  // Show the first few close dates as "raw → parsed" so the user can eyeball
  // whether the active date format reads them the way they intend.
  function dqDatePreview(dayFirst) {
    if (!state.table || !state.mapping || !state.mapping.closeDate) return '';
    var key = state.mapping.closeDate;
    var samples = [];
    var rows = state.table.rows;
    for (var i = 0; i < rows.length && samples.length < 5; i++) {
      var raw = rows[i][key];
      if (raw == null || String(raw).trim() === '') continue;
      var d = PA.parse.parseDate(raw, dayFirst);
      samples.push({ raw: String(raw), parsed: d ? fmtDate(d) : '(unparseable)' });
    }
    if (!samples.length) return '';
    return '<div class="dq-preview"><span class="dq-preview-title">Preview</span>' +
      samples.map(function (s) {
        return '<div class="dq-preview-row"><code>' + escapeHtml(s.raw) + '</code>' +
          '<span class="dq-preview-arrow">→</span><strong>' + escapeHtml(s.parsed) + '</strong></div>';
      }).join('') +
    '</div>';
  }

  // Pipeline Health card — current year only. Safe to call on its own
  // (e.g. when the target input changes) without re-parsing the CSV.
  // ---- Report Comparison card ----
  function renderComparison() {
    var curr = state.snapshot;
    if (!curr) { el.compareCard.style.display = 'none'; return; }
    el.compareCard.style.display = 'block';
    el.reportDateInput.value = curr.reportDate;
    populateBaselineOptions(curr);

    var diff = PA.compare.diffSnapshots(baselineSnapshot(curr), curr, { filters: state.filters });
    if (!diff) {
      el.compareBody.innerHTML = '<div class="compare-none">' +
        'No earlier report stored yet — this one has been saved as the baseline (dated <strong>' +
        escapeHtml(fmtIso(curr.reportDate)) + '</strong>). Load your next export and the movement ' +
        'since this report will appear here. To compare straight away, use ' +
        '<strong>Load a previous report (CSV)</strong> above.</div>';
      return;
    }
    el.compareBody.innerHTML = compareDatesHtml(diff) + compareTilesHtml(diff) +
      compareNoteHtml(diff) + compareListsHtml(diff);
  }

  /*
   * How the two reports were matched up, plus a warning when a large share of
   * the previous report couldn't be matched at all — which nearly always means
   * the two exports don't cover the same ground, rather than a mass of deals
   * genuinely vanishing.
   */
  function compareNoteHtml(d) {
    var by = d.matchedBy || { id: 0, name: 0, fingerprint: 0 };
    var bits = [];
    if (by.id) bits.push(by.id + ' by job number');
    if (by.name) bits.push(by.name + ' by name');
    if (by.fingerprint) bits.push(by.fingerprint + ' by owner + value + close date');
    var note = bits.length
      ? '<p class="compare-matchnote">Deals matched across the two reports: ' +
        escapeHtml(bits.join(', ')) + '.</p>'
      : '';

    // Say plainly which slice these figures describe — without this, a filtered
    // dashboard beside an unfiltered comparison reads as a contradiction.
    if ((d.filteredBy || []).length) {
      note = '<p class="compare-matchnote">Showing <strong>' +
        escapeHtml(filterSummaryText()) + '</strong> — both reports sliced the same way, ' +
        'so these figures line up with the rest of the dashboard.</p>' + note;
    }
    if (d.notShown) {
      note += '<p class="compare-matchnote">' + d.notShown + ' movement' +
        (d.notShown === 1 ? '' : 's') + ' on deals this dashboard does not count — ' +
        'closing outside ' + escapeHtml(String(d.windowYears[0])) + '/' +
        escapeHtml(String(d.windowYears[1])) + ', or on an excluded stage — ' +
        (d.notShown === 1 ? 'is' : 'are') + ' not shown, for the same reason ' +
        'they are absent from the figures above.</p>';
    }
    if ((d.unsupportedFilters || []).length) {
      var labels = d.unsupportedFilters.map(function (k) {
        var dim = FILTER_DIMS.filter(function (f) { return f[0] === k; })[0];
        return dim ? dim[1] : k;
      });
      note += '<div class="compare-warning"><strong>The stored baseline predates ' +
        'filtering by ' + escapeHtml(labels.join(', ')) + '.</strong> Those filters are ' +
        'not applied to this comparison, so it covers a wider slice than the rest of the ' +
        'dashboard. Load both reports again to store them with full filter support.</div>';
    }

    var pct = Math.round((d.unmatchedPrevShare || 0) * 100);
    if (d.removed.length >= 3 && pct >= 20) {
      note += '<div class="compare-warning"><strong>' + pct + '% of the previous report ' +
        '(' + d.removed.length + ' open ' + (d.removed.length === 1 ? 'deal' : 'deals') +
        ') could not be matched to anything in this one.</strong> That is usually a sign the ' +
        'two exports do not cover the same ground — check both were run with the same report ' +
        'filters, owners and columns, and that the same Opportunity ID / job number column is ' +
        'mapped in each — rather than that this many deals genuinely disappeared.</div>';
    }
    return note;
  }

  function compareRenamedHtml(list) {
    var head = '<div class="compare-list"><h3>Renamed since the previous report' +
      '<span class="compare-pill compare-pill-renamed">' + list.length + ' renamed</span></h3>';
    if (!list.length) return '';
    var rows = list.map(function (o) {
      return '<tr><td>' + escapeHtml(o.name) + '</td>' +
        '<td>' + escapeHtml(o.from) + '</td>' +
        '<td>' + escapeHtml(o.owner) + '</td>' +
        '<td class="num">' + currency(o.amount) + '</td></tr>';
    }).join('');
    return head +
      '<p class="compare-empty">These are the same deals as last time, still counted as ' +
      'pipeline — not new business.</p>' +
      '<table class="data-table compare-renamed">' +
      '<thead><tr><th>Opportunity (now)</th><th>Previously called</th><th>Owner</th><th>Value</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function populateBaselineOptions(curr) {
    var older = state.snapshots.filter(function (s) { return s.reportDate < curr.reportDate; });
    var html = '<option value="">Most recent earlier report</option>';
    // Newest first — the likeliest pick sits at the top of the list.
    older.slice().reverse().forEach(function (s) {
      html += '<option value="' + escapeHtml(s.reportDate) + '"' +
        (state.baselineDate === s.reportDate ? ' selected' : '') + '>' +
        escapeHtml(fmtIso(s.reportDate)) + (s.label ? ' — ' + escapeHtml(s.label) : '') +
        '</option>';
    });
    el.baselineSelect.innerHTML = html;
    el.baselineSelect.disabled = older.length === 0;
  }

  function compareDatesHtml(d) {
    var gap = d.daysBetween == null ? ''
      : '<span class="compare-gap">' + d.daysBetween +
        (d.daysBetween === 1 ? ' day' : ' days') + ' between reports</span>';
    function block(label, iso, file) {
      return '<span class="compare-date-block">' +
        '<span class="compare-date-label">' + label + '</span>' +
        '<span class="compare-date-value">' + escapeHtml(fmtIso(iso)) + '</span>' +
        (file ? '<span class="compare-date-file">' + escapeHtml(file) + '</span>' : '') +
        '</span>';
    }
    return '<div class="compare-dates">' +
      block('Previous report', d.prevDate, d.prevLabel) +
      '<span class="compare-arrow">→</span>' +
      block('This report', d.currDate, d.currLabel) +
      gap + '</div>';
  }

  function compareTilesHtml(d) {
    function tile(label, m, fmt) {
      var dir = d.daysBetween === null ? 'flat'
              : m.delta > 0 ? 'up' : (m.delta < 0 ? 'down' : 'flat');
      var body = m.delta === 0
        ? '■ No change'
        : (m.delta > 0 ? '▲ +' : '▼ −') + fmt(Math.abs(m.delta));
      return '<div class="compare-tile">' +
        '<span class="compare-tile-label">' + escapeHtml(label) + '</span>' +
        '<span class="compare-tile-value">' + fmt(m.curr) + '</span>' +
        '<span class="compare-delta ' + (m.delta === 0 ? 'flat' : dir) + '">' + body + '</span>' +
        '<span class="compare-tile-from">was ' + fmt(m.prev) + '</span>' +
        '</div>';
    }
    var n = function (v) { return String(v); };
    return '<div class="compare-tiles">' +
      tile('Open opportunities', d.count, n) +
      tile('Total pipeline', d.total, currency) +
      tile('Weighted forecast', d.weighted, currency) +
      '</div>';
  }

  // One movement table: opportunity, owner, value, close date, stage/outcome.
  function compareMovementHtml(title, pillClass, pillText, list, total, emptyText, outcome) {
    var head = '<div class="compare-list"><h3>' + escapeHtml(title) +
      '<span class="compare-pill compare-pill-' + pillClass + '">' + escapeHtml(pillText) + '</span></h3>';
    if (!list.length) return head + '<p class="compare-empty">' + escapeHtml(emptyText) + '</p></div>';

    var rows = list.map(function (o) {
      var last = outcome
        ? '<span class="compare-badge compare-badge-' + outcome + '">' + escapeHtml(o.stage) + '</span>'
        : escapeHtml(o.stage);
      return '<tr><td>' + escapeHtml(o.name) + '</td>' +
        '<td>' + escapeHtml(o.owner) + '</td>' +
        '<td class="num">' + currency(o.amount) + '</td>' +
        '<td class="num">' + escapeHtml(fmtIso(o.closeDate)) + '</td>' +
        '<td>' + last + '</td></tr>';
    }).join('');

    return head +
      '<table class="data-table compare-table">' +
      '<thead><tr><th>Opportunity</th><th>Owner</th><th>Value</th><th>Close date</th><th>Stage</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr class="total-row"><td>Total</td><td></td><td class="num">' + currency(total) +
      '</td><td class="num">' + list.length + (list.length === 1 ? ' deal' : ' deals') +
      '</td><td></td></tr></tfoot></table></div>';
  }

  function compareListsHtml(d) {
    return compareMovementHtml(
        'Closed won since the previous report', 'won',
        d.closedWon.length + ' won', d.closedWon, d.closedWonTotal,
        'No opportunities were won between these two reports.', 'won') +
      compareMovementHtml(
        'Closed lost since the previous report', 'lost',
        d.closedLost.length + ' lost', d.closedLost, d.closedLostTotal,
        'No opportunities were lost between these two reports.', 'lost') +
      compareMovementHtml(
        'New opportunities since the previous report', 'new',
        d.added.length + ' new', d.added, d.addedTotal,
        'No new opportunities appeared between these two reports.', null) +
      compareRenamedHtml(d.renamed || []) +
      compareMovementHtml(
        'No longer in the report', 'gone',
        d.removed.length + ' gone', d.removed, d.removedTotal,
        'Every opportunity from the previous report is still present.', null);
  }

  function renderHealth() {
    if (!state.results || !state.table || !state.mapping) return;
    var h = currentHealth();

    $('healthYearLabel').textContent = h.currentYear;
    var nextYear = state.results.nextYear;
    $('targetLabelCurrent').textContent = h.currentYear;
    $('targetLabelNext').textContent = nextYear;

    // Panel 1 — Coverage (current year)
    renderCoverage($('coverageResult'), h.coverageRatio, h.coverageStatus, h.weightedForecast, h.target, h.currentYear);

    // Next-year coverage (weighted forecast already excludes closed unless toggled)
    var nextWeighted = state.results.years[nextYear].weighted;
    var covNext = PA.analytics.coverage(nextWeighted, state.nextTarget);
    renderCoverage($('coverageResultNext'), covNext.ratio, covNext.status, nextWeighted, covNext.target, nextYear);

    // Panel 2 — Stale deals (open deals not amended in 6+ months)
    if (!h.hasLastModified) {
      $('staleSummary').innerHTML = '<span class="muted">Map a Last Modified Date column to see stale deals.</span>';
    } else {
      $('staleSummary').innerHTML =
        '<strong>' + h.stale.count + '</strong> stale ' + (h.stale.count === 1 ? 'deal' : 'deals') +
        '<div class="stale-values">' + currency(h.stale.totalValue) + ' total · ' +
        currency(h.stale.weightedValue) + ' weighted</div>';
    }

    // Panel 3 — By segment
    PA.charts.horizontalBar('segmentChart',
      h.segments.map(function (s) { return s.key; }),
      h.segments.map(function (s) { return s.total; }),
      h.segments.map(function (s) { return s.count; }),
      PA.charts.COLORS.current, PA.charts.COLORS.currentSoft);

    // Panel 4 — By technology (raw Opportunity Solutions values, top 10)
    if (!h.hasTechnology) {
      PA.charts.destroy('techChart');
      $('techNote').textContent = 'Map an Opportunity Solutions column to see this.';
    } else {
      var techs = h.technologies.slice(0, 10);
      $('techNote').textContent = h.technologies.length > 10
        ? 'Showing top 10 of ' + h.technologies.length + ' solutions.' : '';
      PA.charts.horizontalBar('techChart',
        techs.map(function (t) { return t.key; }),
        techs.map(function (t) { return t.total; }),
        techs.map(function (t) { return t.count; }),
        PA.charts.COLORS.next, PA.charts.COLORS.nextSoft);
    }
  }

  function fmtDate(d) {
    if (!d) return '—';
    return d.getUTCDate() + ' ' + PA.analytics.MONTH_LABELS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function renderColumn(which, year, yearNum) {
    var c = PA.charts.colorsForYear(which);

    // KPI cards
    $('kpiTotal_' + which).textContent = currency(year.total);
    $('kpiWeighted_' + which).textContent = currency(year.weighted);
    $('kpiCount_' + which).textContent = year.count;

    if (year.count === 0) {
      $('emptyNote_' + which).style.display = 'block';
    } else {
      $('emptyNote_' + which).style.display = 'none';
    }

    // Stage chart + table, with a Pipeline/Weighted total row at the bottom
    PA.charts.categoryBar('stageChart_' + which,
      year.byStage.map(kKey), year.byStage.map(kTotal), year.byStage.map(kWeighted),
      c.solid, c.soft);
    renderTable('stageTable_' + which, ['Stage', 'Pipeline', 'Weighted', '#'], year.byStage,
      { key: 'Total', total: year.total, weighted: year.weighted, count: year.count });

    // Timeline
    var tl = year.timeline[state.timelineGranularity];
    PA.charts.timelineChart('timelineChart_' + which,
      tl.map(kKey), tl.map(kTotal), tl.map(kWeighted), c.solid);

    // Owners (top 8)
    var owners = year.byOwner.slice(0, 8);
    PA.charts.categoryBar('ownerChart_' + which,
      owners.map(kKey), owners.map(kTotal), owners.map(kWeighted), c.solid, c.soft);
    renderTable('ownerTable_' + which, ['Owner', 'Pipeline', 'Weighted', '#'], owners);
  }

  function kKey(o) { return o.key; }
  function kTotal(o) { return o.total; }
  function kWeighted(o) { return o.weighted; }

  function renderTable(id, headers, rows, totals) {
    var tbl = $(id);
    if (!tbl) return;
    var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = rows.map(function (o) {
      return '<tr>' +
        '<td>' + escapeHtml(o.key) + '</td>' +
        '<td class="num">' + currency(o.total) + '</td>' +
        '<td class="num">' + currency(o.weighted) + '</td>' +
        '<td class="num">' + o.count + '</td>' +
      '</tr>';
    }).join('');
    var tfoot = '';
    if (totals) {
      tfoot = '<tfoot><tr class="total-row">' +
        '<td>' + escapeHtml(totals.key) + '</td>' +
        '<td class="num">' + currency(totals.total) + '</td>' +
        '<td class="num">' + currency(totals.weighted) + '</td>' +
        '<td class="num">' + totals.count + '</td>' +
      '</tr></tfoot>';
    }
    tbl.innerHTML = thead + '<tbody>' + (body || '<tr><td colspan="4" class="muted">No data</td></tr>') + '</tbody>' + tfoot;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.PA = window.PA || {});
