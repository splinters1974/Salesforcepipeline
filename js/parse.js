/*
 * parse.js — CSV reading and Salesforce-export cleanup.
 *
 * Salesforce report CSV exports are not always clean tables:
 *  - "Formatted" exports can prepend a report-title row and append
 *    grand-total / "Confidential Information" footer rows.
 *  - Amounts come through as currency strings ("£120,000", "(70,000)").
 *  - Close dates appear in several formats depending on org locale.
 *
 * This module turns a raw File into { headers, rows } of plain strings,
 * plus reusable value cleaners (cleanNumber, parseDate) used downstream.
 *
 * Exposes a global `PA.parse` namespace (no ES modules, so the app works
 * by double-clicking index.html over file://).
 */
(function (PA) {
  'use strict';

  // Header tokens we expect somewhere in a real Salesforce opportunity report.
  // Used to locate the true header row when junk rows sit above it.
  var KNOWN_HEADER_TOKENS = [
    'amount', 'close date', 'closedate', 'stage', 'owner', 'opportunity',
    'account', 'probability', 'product', 'region', 'territory', 'forecast',
    'value', 'acv', 'arr', 'segment'
  ];

  // Footer/junk row markers that Salesforce appends.
  var FOOTER_MARKERS = [
    'grand total', 'subtotal', 'confidential', 'copyright',
    'generated', 'record count'
  ];

  function lower(s) { return (s == null ? '' : String(s)).trim().toLowerCase(); }

  // Score a row by how many cells look like known header tokens.
  function headerScore(cells) {
    var score = 0;
    cells.forEach(function (c) {
      var v = lower(c);
      if (!v) return;
      KNOWN_HEADER_TOKENS.forEach(function (tok) {
        if (v.indexOf(tok) !== -1) score++;
      });
    });
    return score;
  }

  // Given PapaParse's array-of-arrays, find the most likely header row index.
  function findHeaderRow(matrix) {
    var bestIdx = 0, bestScore = -1;
    // Only look in the first 8 rows — header is never deep in the file.
    var limit = Math.min(matrix.length, 8);
    for (var i = 0; i < limit; i++) {
      var s = headerScore(matrix[i]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    return bestScore > 0 ? bestIdx : 0;
  }

  function looksLikeFooter(cells) {
    // Footer rows usually have the marker text in the first non-empty cell
    // and most other cells empty.
    var firstText = '';
    var nonEmpty = 0;
    cells.forEach(function (c) {
      var v = lower(c);
      if (v) { nonEmpty++; if (!firstText) firstText = v; }
    });
    if (nonEmpty === 0) return true; // blank row
    return FOOTER_MARKERS.some(function (m) { return firstText.indexOf(m) !== -1; });
  }

  // Strip currency symbols/commas; handle (1,234) negatives. Returns Number or NaN.
  function cleanNumber(raw) {
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;
    var s = String(raw).trim();
    if (!s) return NaN;
    var negative = /^\(.*\)$/.test(s);
    s = s.replace(/[()]/g, '');
    // Remove anything that isn't a digit, separator, sign or decimal point.
    s = s.replace(/[^0-9.,\-]/g, '');
    // Drop thousands separators. Assume '.' is the decimal separator.
    s = s.replace(/,/g, '');
    if (s === '' || s === '-' || s === '.') return NaN;
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return negative ? -n : n;
  }

  // Month name lookup for textual dates ("12 Mar 2026", "Mar 12, 2026").
  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  /*
   * Parse a date string tolerant of common Salesforce formats.
   * `dayFirst` disambiguates numeric formats like 03/04/2026:
   *   true  -> D/M/Y (UK/EU), false -> M/D/Y (US).
   * Returns a Date (UTC, midday to avoid TZ edge slips) or null.
   */
  function parseDate(raw, dayFirst) {
    if (raw == null) return null;
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
    var s = String(raw).trim();
    if (!s) return null;

    // ISO yyyy-mm-dd (or yyyy/mm/dd)
    var iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) {
      return makeDate(+iso[1], +iso[2] - 1, +iso[3]);
    }

    // Textual month: "12 Mar 2026", "Mar 12, 2026", "March 12 2026"
    var txt = s.match(/([a-zA-Z]{3,})/);
    if (txt && MONTHS[txt[1].slice(0, 3).toLowerCase()] !== undefined) {
      var mo = MONTHS[txt[1].slice(0, 3).toLowerCase()];
      var nums = s.match(/\d{1,4}/g) || [];
      var day = 1, year = null;
      nums.forEach(function (numStr) {
        var n = +numStr;
        if (n > 31) year = n;
        else if (day === 1 && n <= 31) day = n;
      });
      if (year != null) return makeDate(year, mo, day);
    }

    // Numeric d/m/y or m/d/y
    var parts = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
    if (parts) {
      var a = +parts[1], b = +parts[2], c = +parts[3];
      var year2 = c < 100 ? 2000 + c : c;
      var dd, mm;
      if (a > 12) { dd = a; mm = b; }       // first field must be day
      else if (b > 12) { mm = a; dd = b; }  // second field must be day
      else { if (dayFirst) { dd = a; mm = b; } else { mm = a; dd = b; } }
      return makeDate(year2, mm - 1, dd);
    }

    // Last resort: native parser
    var native = new Date(s);
    return isNaN(native.getTime()) ? null : native;
  }

  function makeDate(y, mIndex, d) {
    // Reject out-of-range components instead of letting Date.UTC roll them
    // forward (e.g. month 25 -> next year) — bad dates must surface as
    // unparseable so they land in the skipped-rows table, not the analysis.
    if (mIndex < 0 || mIndex > 11 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mIndex, d, 12, 0, 0));
    if (isNaN(dt.getTime())) return null;
    // Catch day overflow within a valid month (31 Feb -> 2/3 Mar).
    if (dt.getUTCMonth() !== mIndex || dt.getUTCDate() !== d) return null;
    return dt;
  }

  /*
   * Heuristic: scan a sample of values for a column and decide whether the
   * numeric dates are day-first. If any value has its first field > 12, it
   * must be day-first; if any second field > 12, it must be month-first.
   * Defaults to day-first=false (US M/D/Y), matching Salesforce default export.
   */
  function detectDayFirst(values) {
    var dayFirstVotes = 0, monthFirstVotes = 0;
    values.forEach(function (v) {
      if (v == null) return;
      var m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{1,4}/);
      if (!m) return;
      var a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) dayFirstVotes++;
      else if (b > 12 && a <= 12) monthFirstVotes++;
    });
    if (dayFirstVotes > monthFirstVotes) return true;
    if (monthFirstVotes > dayFirstVotes) return false;
    return false;
  }

  /*
   * Read a File and return a Promise resolving to { headers, rows, raw }.
   * rows is an array of plain objects keyed by header.
   */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      Papa.parse(file, {
        header: false,          // parse as matrix so we can find the header row
        skipEmptyLines: 'greedy',
        dynamicTyping: false,
        complete: function (res) {
          try {
            resolve(matrixToTable(res.data));
          } catch (e) {
            reject(e);
          }
        },
        error: function (err) { reject(err); }
      });
    });
  }

  // Parse already-loaded CSV text (used for tests / programmatic input).
  function readText(text) {
    var res = Papa.parse(text, {
      header: false, skipEmptyLines: 'greedy', dynamicTyping: false
    });
    return matrixToTable(res.data);
  }

  function matrixToTable(matrix) {
    if (!matrix || !matrix.length) {
      return { headers: [], rows: [], raw: [] };
    }
    var headerIdx = findHeaderRow(matrix);
    var headers = (matrix[headerIdx] || []).map(function (h) {
      return String(h == null ? '' : h).trim();
    });

    var rows = [];
    for (var i = headerIdx + 1; i < matrix.length; i++) {
      var cells = matrix[i];
      if (!cells || looksLikeFooter(cells)) continue;
      var obj = {};
      var hasValue = false;
      for (var c = 0; c < headers.length; c++) {
        var key = headers[c] || ('Column ' + (c + 1));
        var val = cells[c] == null ? '' : String(cells[c]).trim();
        obj[key] = val;
        if (val) hasValue = true;
      }
      if (hasValue) rows.push(obj);
    }
    return { headers: headers, rows: rows, raw: matrix };
  }

  PA.parse = {
    readFile: readFile,
    readText: readText,
    cleanNumber: cleanNumber,
    parseDate: parseDate,
    detectDayFirst: detectDayFirst
  };
})(window.PA = window.PA || {});
