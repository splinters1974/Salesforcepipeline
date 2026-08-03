/*
 * analytics.js — turn mapped rows into the pipeline analysis dataset.
 *
 * Pure functions: input rows + mapping + options -> a plain results object.
 * No DOM access here so the calculations stay testable.
 */
(function (PA) {
  'use strict';

  // Default stage -> win probability, used when the report has no
  // probability column. Matching is case-insensitive substring, so
  // "Proposal/Price Quote" matches "proposal". Editable here and surfaced
  // in the UI.
  var DEFAULT_STAGE_WEIGHTS = [
    { match: 'closed won', weight: 1.00 },
    { match: 'closed lost', weight: 0.00 },
    { match: 'awarded', weight: 0.90 },
    { match: 'negotiat', weight: 0.75 },
    { match: 'proposal', weight: 0.50 },
    { match: 'quote', weight: 0.50 },
    { match: 'qualif', weight: 0.25 },
    { match: 'discovery', weight: 0.20 },
    { match: 'prospect', weight: 0.10 },
    { match: 'lead', weight: 0.10 }
  ];
  var FALLBACK_WEIGHT = 0.20; // unknown stage

  // --- Pipeline Health config (easy to tweak) ---

  // A deal is "stale" if its Last Modified Date is older than this many days
  // (or its close date is already in the past). Change this single value to
  // re-tune staleness everywhere.
  var STALE_THRESHOLD_MONTHS = 6; // a deal is stale if untouched this long

  // Map Salesforce Product / Product Family values to Ameresco's five
  // segments. Matching is case-insensitive substring, first match wins, so
  // order from most specific to least. Anything unmatched falls into "Other".
  // Update these rules as product naming in Salesforce evolves.
  var SEGMENT_MAP = [
    { match: 'i&c', segment: 'I&C' },
    { match: 'c&i', segment: 'I&C' },
    { match: 'commercial', segment: 'I&C' },
    { match: 'industrial', segment: 'I&C' },
    { match: 'street lighting', segment: 'Cities & Local Government' },
    { match: 'local auth', segment: 'Cities & Local Government' },
    { match: 'local gov', segment: 'Cities & Local Government' },
    { match: 'council', segment: 'Cities & Local Government' },
    { match: 'cities', segment: 'Cities & Local Government' },
    { match: 'city', segment: 'Cities & Local Government' },
    { match: 'nhs', segment: 'Public Sector' },
    { match: 'school', segment: 'Public Sector' },
    { match: 'university', segment: 'Public Sector' },
    { match: 'public', segment: 'Public Sector' },
    { match: 'grid', segment: 'Grid-Scale' },
    { match: 'battery', segment: 'Grid-Scale' },
    { match: 'storage', segment: 'Grid-Scale' },
    { match: 'data centre', segment: 'Data Centres' },
    { match: 'data center', segment: 'Data Centres' },
    { match: 'datacent', segment: 'Data Centres' }
  ];
  // Canonical display order; "Other" is appended only when it has deals.
  var SEGMENT_ORDER = ['I&C', 'Cities & Local Government', 'Public Sector',
                       'Grid-Scale', 'Data Centres'];
  var OTHER_SEGMENT = 'Other';

  var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Opportunities at or above this value are "strategic / early-stage".
  var STRATEGIC_THRESHOLD = 10000000; // £10m
  // Strategic deals (£10m+) only count when at a Discovery or Proposal stage
  // (lower-case match) — excludes awarded/qualification/prospecting/etc.
  var STRATEGIC_STAGES = ['discover', 'propos'];
  // Forecast-pipeline windows (month / 90-day / 365-day) only count deals at
  // these stages (lower-case match): discovery, proposed, awarded.
  var FORECAST_STAGES = ['discover', 'propos', 'award'];
  /*
   * Owners (lower-case substring) whose AWARDED pipeline is excluded.
   * Note: anyone also listed in SUPPRESSED_OWNERS never reaches this check,
   * because suppression drops their rows first. The entry is kept so the rule
   * still applies if that person is later removed from the suppression list.
   */
  var AWARDED_EXCLUDE_OWNERS = ['finlay'];

  /*
   * Owners whose opportunities are ignored completely. Unlike
   * AWARDED_EXCLUDE_OWNERS — which only drops a single stage — these people are
   * suppressed from every calculation, count and list: KPIs, health, insights,
   * performance, forecast, the report comparison and the filter dropdowns.
   * Their rows are counted once in the Data Quality card so the suppression is
   * visible rather than silent.
   *
   * Each entry is a set of name tokens; a row matches when the owner contains
   * ALL of them, so "Katherine Piper", "Piper, Katherine" and "Katherine J
   * Piper" all match while "Katherine Piperson" does not.
   */
  var SUPPRESSED_OWNERS = [
    'maciej stefanski',
    'joshua mauger',
    'katherine piper',
    // Finlay's Awarded pipeline was already excluded via AWARDED_EXCLUDE_OWNERS
    // below; this removes his remaining stages too, so he is absent entirely.
    // A single token, matching the AWARDED_EXCLUDE_OWNERS entry, so it still
    // applies however the surname is exported.
    'finlay'
  ];

  // Split a name into comparable lower-case tokens, ignoring punctuation.
  function nameTokens(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  }

  function isSuppressedOwner(owner, list) {
    var have = nameTokens(owner);
    if (!have.length) return false;
    return (list || SUPPRESSED_OWNERS).some(function (name) {
      var want = nameTokens(name);
      return want.length && want.every(function (t) { return have.indexOf(t) !== -1; });
    });
  }

  // True when a record is an Awarded deal owned by an excluded owner (Finlay).
  function isExcludedAwarded(rec, excludeOwners) {
    excludeOwners = excludeOwners || AWARDED_EXCLUDE_OWNERS;
    if (String(rec.stage).toLowerCase().indexOf('award') === -1) return false;
    var o = String(rec.owner).toLowerCase();
    return excludeOwners.some(function (x) { return o.indexOf(x) !== -1; });
  }

  function stageWeight(stage, table) {
    var s = String(stage || '').toLowerCase();
    var rules = table || DEFAULT_STAGE_WEIGHTS;
    for (var i = 0; i < rules.length; i++) {
      if (s.indexOf(rules[i].match) !== -1) return rules[i].weight;
    }
    return FALLBACK_WEIGHT;
  }

  function isClosedStage(stage) {
    return String(stage || '').toLowerCase().indexOf('closed') !== -1;
  }

  // Normalise a probability cell to a 0..1 fraction. Accepts "75", "75%", "0.75".
  function normProbability(raw) {
    var n = PA.parse.cleanNumber(raw);
    if (isNaN(n)) return null;
    if (n > 1) return n / 100;       // "75" or "75%"
    if (n < 0) return 0;
    return n;                        // already a fraction
  }

  /*
   * Build normalised records from raw rows + mapping.
   * Returns { records, skipped, skippedClosed, dayFirst, skippedRows, yearCounts }.
   *   skippedRows: every actionable row that failed to parse, each
   *     { row, name, rawStage, rawAmount, rawDate, reason } — reason is one of
   *     'bad amount' | 'bad date' | 'bad amount & date'. Closed Won/Lost rows
   *     that fail to parse are excluded here and counted in skippedClosed.
   *   skipped: count of actionable (non-closed) skipped rows = skippedRows.length.
   *   skippedClosed: count of Closed Won/Lost rows hidden from the detail list.
   *   yearCounts: { <year>: count } over every successfully parsed record,
   *     across all years (before the 2026/2027 window is applied).
   * Each record: { amount, date, year, month, quarter, stage, owner,
   *                product, region, name, probability, weighted }.
   */
  function buildRecords(rows, mapping, opts) {
    opts = opts || {};
    var stageTable = opts.stageWeights || DEFAULT_STAGE_WEIGHTS;

    // Decide date format once across the whole column.
    var dateValues = rows.map(function (r) { return r[mapping.closeDate]; });
    var dayFirst = opts.dayFirst != null ? opts.dayFirst
                                         : PA.parse.detectDayFirst(dateValues);

    var records = [];
    var skipped = 0;
    var skippedClosed = 0;
    var skippedRows = [];
    var yearCounts = {};
    var suppressed = 0;

    rows.forEach(function (r, idx) {
      // Suppressed owners drop out before anything else is looked at, so their
      // deals reach no calculation, count or list anywhere in the app — not
      // even the skipped-rows table or the year histogram.
      if (mapping.owner && isSuppressedOwner(r[mapping.owner], opts.suppressOwners)) {
        suppressed++;
        return;
      }
      var amount = PA.parse.cleanNumber(r[mapping.amount]);
      var date = PA.parse.parseDate(r[mapping.closeDate], dayFirst);
      var badAmount = isNaN(amount);
      var badDate = !date;
      if (badAmount || badDate) {
        // Closed Won / Closed Lost rows are decided deals — a bad amount or
        // date on them is not actionable, so hide them from the skipped list
        // (counted separately for transparency) rather than ask the user to fix.
        var rawStage = mapping.stage ? (r[mapping.stage] || '') : '';
        if (isClosedStage(rawStage)) {
          skippedClosed++;
          return;
        }
        skipped++;
        var reason = badAmount && badDate ? 'bad amount & date'
                   : badAmount ? 'bad amount' : 'bad date';
        skippedRows.push({
          row: idx + 1,
          name: mapping.name ? (r[mapping.name] || '') : '',
          rawStage: rawStage,
          rawAmount: r[mapping.amount] == null ? '' : String(r[mapping.amount]),
          rawDate: r[mapping.closeDate] == null ? '' : String(r[mapping.closeDate]),
          reason: reason
        });
        return;
      }

      var stage = mapping.stage ? (r[mapping.stage] || '') : '';
      var owner = mapping.owner ? (r[mapping.owner] || '—') : '—';
      var product = mapping.product ? (r[mapping.product] || '—') : '—';
      var region = mapping.region ? (r[mapping.region] || '—') : '—';
      var name = mapping.name ? (r[mapping.name] || '') : '';
      var oppId = mapping.oppId ? (r[mapping.oppId] || '') : '';
      var lastModified = mapping.lastModified
        ? PA.parse.parseDate(r[mapping.lastModified], dayFirst) : null;
      var created = mapping.created
        ? PA.parse.parseDate(r[mapping.created], dayFirst) : null;
      var nextStep = mapping.nextStep ? (r[mapping.nextStep] || '') : '';
      var leadSource = mapping.leadSource ? (r[mapping.leadSource] || '—') : '—';

      var prob = null;
      if (mapping.probability) prob = normProbability(r[mapping.probability]);
      if (prob == null) prob = stageWeight(stage, stageTable);

      records.push({
        amount: amount,
        date: date,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        quarter: Math.floor(date.getUTCMonth() / 3) + 1,
        stage: stage || '(blank)',
        owner: owner,
        product: product,
        region: region,
        name: name,
        oppId: oppId,
        lastModified: lastModified,
        created: created,
        nextStep: nextStep,
        leadSource: leadSource,
        probability: prob,
        weighted: amount * prob,
        closed: isClosedStage(stage)
      });
      var yr = date.getUTCFullYear();
      yearCounts[yr] = (yearCounts[yr] || 0) + 1;
    });

    return {
      records: records,
      skipped: skipped,
      skippedClosed: skippedClosed,
      dayFirst: dayFirst,
      skippedRows: skippedRows,
      yearCounts: yearCounts,
      suppressed: suppressed
    };
  }

  // Sum a numeric field of records grouped by a key function.
  function groupSum(records, keyFn, valFn) {
    var map = {};
    records.forEach(function (rec) {
      var k = keyFn(rec);
      if (!map[k]) map[k] = { key: k, total: 0, weighted: 0, count: 0 };
      map[k].total += valFn ? valFn(rec) : rec.amount;
      map[k].weighted += rec.weighted;
      map[k].count += 1;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function byDesc(arr) {
    return arr.slice().sort(function (a, b) { return b.total - a.total; });
  }

  // Compute every view for a single year's records.
  function computeYear(records) {
    var total = 0, weighted = 0;
    records.forEach(function (r) { total += r.amount; weighted += r.weighted; });

    var byStage = byDesc(groupSum(records, function (r) { return r.stage; }));
    var byOwner = byDesc(groupSum(records, function (r) { return r.owner; }));
    var byProduct = byDesc(groupSum(records, function (r) { return r.product; }));
    var byRegion = byDesc(groupSum(records, function (r) { return r.region; }));

    // Timeline buckets: quarters Q1-Q4 and months Jan-Dec, in calendar order.
    var quarters = [1, 2, 3, 4].map(function (q) {
      var recs = records.filter(function (r) { return r.quarter === q; });
      return reduceBucket('Q' + q, recs);
    });
    var months = MONTH_LABELS.map(function (lbl, idx) {
      var recs = records.filter(function (r) { return r.month === idx; });
      return reduceBucket(lbl, recs);
    });

    return {
      total: total,
      weighted: weighted,
      count: records.length,
      byStage: byStage,
      byOwner: byOwner,
      byProduct: byProduct,
      byRegion: byRegion,
      timeline: { quarter: quarters, month: months }
    };
  }

  function reduceBucket(label, recs) {
    var total = 0, weighted = 0;
    recs.forEach(function (r) { total += r.amount; weighted += r.weighted; });
    return { key: label, total: total, weighted: weighted, count: recs.length };
  }

  /*
   * Top-level analysis.
   * opts: { currentYear, includeClosed, dayFirst, stageWeights }
   * Returns:
   *   { years: {2026:{...}, 2027:{...}}, currentYear, nextYear,
   *     skipped, dayFirst, outOfRange, includeClosed }
   */
  function analyze(rows, mapping, opts) {
    opts = opts || {};
    var currentYear = opts.currentYear || new Date().getFullYear();
    var nextYear = currentYear + 1;
    var includeClosed = !!opts.includeClosed;

    var built = buildRecords(rows, mapping, opts);
    var records = applyFilters(built.records, opts.filters)
      .filter(function (r) { return !isExcludedAwarded(r, opts.awardedExcludeOwners); });
    var inYears = [];
    var outOfRange = 0;

    records.forEach(function (rec) {
      if (rec.year !== currentYear && rec.year !== nextYear) { outOfRange++; return; }
      if (!includeClosed && rec.closed) return;
      inYears.push(rec);
    });

    var result = { years: {}, currentYear: currentYear, nextYear: nextYear };
    [currentYear, nextYear].forEach(function (y) {
      var recs = inYears.filter(function (r) { return r.year === y; });
      result.years[y] = computeYear(recs);
    });

    result.skipped = built.skipped;
    result.skippedClosed = built.skippedClosed;
    result.dayFirst = built.dayFirst;
    result.skippedRows = built.skippedRows;
    result.yearCounts = built.yearCounts;
    result.suppressed = built.suppressed;
    result.outOfRange = outOfRange;
    result.includeClosed = includeClosed;
    result.totalRecords = records.length;
    return result;
  }

  // Map a product/product-family value to one of the Ameresco segments.
  function segmentFor(product) {
    var p = String(product || '').toLowerCase();
    for (var i = 0; i < SEGMENT_MAP.length; i++) {
      if (p.indexOf(SEGMENT_MAP[i].match) !== -1) return SEGMENT_MAP[i].segment;
    }
    return OTHER_SEGMENT;
  }

  // The dimensions the dashboard can be filtered by. Each maps to a function
  // returning the record's value for that dimension.
  var FILTER_DIMS = {
    owner: function (r) { return r.owner; },
    region: function (r) { return r.region; },
    segment: function (r) { return segmentFor(r.product); },
    stage: function (r) { return r.stage; },
    leadSource: function (r) { return r.leadSource; }
  };

  /*
   * Keep a record when, for every dimension that has a non-empty selection, the
   * record's value is in that selection. (OR within a dimension, AND across
   * dimensions.) `filters` is e.g. { owner:['Jane'], region:[], ... }.
   */
  function applyFilters(records, filters) {
    if (!filters) return records;
    var active = Object.keys(FILTER_DIMS).filter(function (d) {
      return Array.isArray(filters[d]) && filters[d].length;
    });
    if (!active.length) return records;
    return records.filter(function (r) {
      return active.every(function (d) {
        return filters[d].indexOf(FILTER_DIMS[d](r)) !== -1;
      });
    });
  }

  // Distinct, sorted values per dimension across the current+next-year records,
  // used to populate the filter controls.
  function distinctFilterValues(rows, mapping, opts) {
    opts = opts || {};
    var currentYear = opts.currentYear || new Date().getFullYear();
    var nextYear = currentYear + 1;
    var recs = buildRecords(rows, mapping, opts).records.filter(function (r) {
      return r.year === currentYear || r.year === nextYear;
    });
    var out = {};
    Object.keys(FILTER_DIMS).forEach(function (d) {
      var seen = {};
      recs.forEach(function (r) { seen[FILTER_DIMS[d](r)] = true; });
      out[d] = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
    });
    return out;
  }

  // Coverage ratio + RAG status from a weighted forecast against a £ target.
  function coverage(weighted, target) {
    var t = PA.parse.cleanNumber(target);
    if (isNaN(t) || t <= 0) return { ratio: null, status: null, target: null };
    var ratio = (weighted / t) * 100;
    var status = ratio >= 80 ? 'green' : (ratio >= 50 ? 'amber' : 'red');
    return { ratio: ratio, status: status, target: t };
  }

  /*
   * Pipeline-health view for the CURRENT year (derived from `today`).
   *
   *   healthMetrics(rows, mapping, targetValue, today[, options])
   *
   * targetValue : user-entered £ target (string or number); blank -> no coverage.
   * today       : Date used for "current year", stale-by-close and stale-by-modified.
   * options     : { includeClosed, dayFirst, stageWeights } — includeClosed
   *               mirrors the dashboard toggle (closed Won/Lost are excluded
   *               from all three panels unless it is true).
   *
   * Returns { currentYear, target, weightedForecast, coverageRatio,
   *           coverageStatus, stale:{count,totalValue,items[]}, segments[],
   *           hasLastModified }.
   */
  function healthMetrics(rows, mapping, targetValue, today, options) {
    options = options || {};
    today = today || new Date();
    var currentYear = today.getFullYear();
    var includeClosed = !!options.includeClosed;

    var built = buildRecords(rows, mapping, options);
    var records = applyFilters(built.records, options.filters);
    var current = records.filter(function (r) { return r.year === currentYear; });
    var active = current.filter(function (r) { return includeClosed || !r.closed; });

    // --- Panel 1: Coverage ---
    var weightedForecast = 0;
    active.forEach(function (r) { weightedForecast += r.weighted; });
    var cov = coverage(weightedForecast, targetValue);
    var target = cov.target;
    var coverageRatio = cov.ratio, coverageStatus = cov.status;

    // --- Panel 2: Stale deals — OPEN opportunities (any year, filters applied)
    //     not amended in more than STALE_THRESHOLD_MONTHS. Reported as a count
    //     plus total and weighted value (no per-deal list). ---
    var staleCutoff = Date.UTC(today.getUTCFullYear(),
      today.getUTCMonth() - STALE_THRESHOLD_MONTHS, today.getUTCDate(), 12, 0, 0);
    var staleCount = 0, staleTotal = 0, staleWeighted = 0;
    records.forEach(function (r) {
      if (r.closed || !r.lastModified) return;
      if (r.lastModified.getTime() < staleCutoff) {
        staleCount++; staleTotal += r.amount; staleWeighted += r.weighted;
      }
    });

    // --- Panel 3: By segment ---
    var segMap = {};
    active.forEach(function (r) {
      var seg = segmentFor(r.product);
      if (!segMap[seg]) segMap[seg] = { key: seg, total: 0, count: 0 };
      segMap[seg].total += r.amount;
      segMap[seg].count += 1;
    });
    var segments = SEGMENT_ORDER.map(function (seg) {
      return segMap[seg] || { key: seg, total: 0, count: 0 };
    });
    if (segMap[OTHER_SEGMENT]) segments.push(segMap[OTHER_SEGMENT]);

    // --- Panel 4: By technology (the raw Opportunity Solutions value) ---
    var techMap = {};
    active.forEach(function (r) {
      var tech = (mapping.product ? r.product : '—') || '—';
      if (!techMap[tech]) techMap[tech] = { key: tech, total: 0, count: 0 };
      techMap[tech].total += r.amount;
      techMap[tech].count += 1;
    });
    var technologies = Object.keys(techMap).map(function (k) { return techMap[k]; })
      .sort(function (a, b) { return b.total - a.total; });

    return {
      currentYear: currentYear,
      target: target,
      weightedForecast: weightedForecast,
      coverageRatio: coverageRatio,
      coverageStatus: coverageStatus,
      stale: {
        count: staleCount, totalValue: staleTotal, weightedValue: staleWeighted,
        thresholdMonths: STALE_THRESHOLD_MONTHS
      },
      segments: segments,
      technologies: technologies,
      hasTechnology: !!mapping.product,
      hasLastModified: !!mapping.lastModified
    };
  }

  /*
   * Cross-cutting "insights" for the dashboard:
   *   insightMetrics(rows, mapping, today[, options])
   *
   * - avgOpenAgeDays : mean days from Created Date to today across OPEN
   *   opportunities (any non-closed stage — Discovery/Proposed/Awarded/etc.).
   * - wonByOwner     : current-year Closed Won revenue split by owner (+totals).
   * - leadSources    : lead-source mix across the current+next-year open
   *   pipeline, with a percentage per source.
   * - topProposed    : top 5 Proposed-stage opportunities ranked by a blend of
   *   rating (win %), value and nearest close date; carries the Next Step.
   */
  function insightMetrics(rows, mapping, today, options) {
    options = options || {};
    today = today || new Date();
    var currentYear = today.getFullYear();
    var nextYear = currentYear + 1;
    var includeClosed = !!options.includeClosed;
    var MS_PER_DAY = 86400000;

    var recs = applyFilters(buildRecords(rows, mapping, options).records, options.filters);

    // --- Average age of open opportunities (created -> today) ---
    var ageSum = 0, ageCount = 0;
    recs.forEach(function (r) {
      if (r.closed || !r.created) return;
      ageSum += Math.max(0, Math.floor((today.getTime() - r.created.getTime()) / MS_PER_DAY));
      ageCount++;
    });
    var avgOpenAgeDays = ageCount ? Math.round(ageSum / ageCount) : null;

    // --- Current-year Closed Won revenue by owner ---
    var wonMap = {}, wonTotal = 0, wonCount = 0;
    recs.forEach(function (r) {
      if (r.year !== currentYear) return;
      if (String(r.stage).toLowerCase().indexOf('won') === -1) return;
      if (!wonMap[r.owner]) wonMap[r.owner] = { key: r.owner, total: 0, count: 0 };
      wonMap[r.owner].total += r.amount; wonMap[r.owner].count++;
      wonTotal += r.amount; wonCount++;
    });
    var wonByOwner = Object.keys(wonMap).map(function (k) { return wonMap[k]; })
      .sort(function (a, b) { return b.total - a.total; });

    // --- Awarded opportunities (current year, open) — bid won, not yet booked.
    //     Owners listed in AWARDED_EXCLUDE_OWNERS (e.g. Finlay) are excluded.
    //     Listed line by line with a running total. ---
    var excludeOwners = options.awardedExcludeOwners || AWARDED_EXCLUDE_OWNERS;
    function ownerExcluded(owner) {
      var o = String(owner).toLowerCase();
      return excludeOwners.some(function (x) { return o.indexOf(x) !== -1; });
    }
    var awarded = recs.filter(function (r) {
      return r.year === currentYear &&
        String(r.stage).toLowerCase().indexOf('award') !== -1 &&
        !ownerExcluded(r.owner);
    }).map(function (r) {
      return { name: r.name || '(unnamed)', amount: r.amount, owner: r.owner, year: r.year };
    }).sort(function (a, b) { return b.amount - a.amount; });
    var awardedTotal = awarded.reduce(function (s, r) { return s + r.amount; }, 0);

    // --- Lead source mix across current+next-year open pipeline ---
    var active = recs.filter(function (r) {
      return (r.year === currentYear || r.year === nextYear) && (includeClosed || !r.closed);
    });
    var lsMap = {}, lsTotal = 0;
    active.forEach(function (r) {
      var src = (mapping.leadSource ? r.leadSource : '—') || '—';
      if (!lsMap[src]) lsMap[src] = { key: src, count: 0, total: 0 };
      lsMap[src].count++; lsMap[src].total += r.amount; lsTotal++;
    });
    var leadSources = Object.keys(lsMap).map(function (k) {
      var o = lsMap[k];
      o.pct = lsTotal ? (o.count / lsTotal) * 100 : 0;
      return o;
    }).sort(function (a, b) { return b.count - a.count; });

    // --- Top 10 opportunities closing in the CURRENT YEAR: take all Proposed
    //     deals first (largest value wins when there are more than 10), then
    //     fill any remaining slots with Discovery deals (largest value first).
    //     Displayed soonest-to-close first. ---
    var byValueDesc = function (a, b) { return b.amount - a.amount; };
    function stageIs(r, key) { return String(r.stage).toLowerCase().indexOf(key) !== -1; }
    var curOpen = recs.filter(function (r) { return r.year === currentYear && !r.closed; });
    var proposedDeals = curOpen.filter(function (r) { return stageIs(r, 'propos'); }).sort(byValueDesc);
    var discoveryDeals = curOpen.filter(function (r) { return stageIs(r, 'discover'); }).sort(byValueDesc);
    var chosen = proposedDeals.slice(0, 10);
    if (chosen.length < 10) chosen = chosen.concat(discoveryDeals.slice(0, 10 - chosen.length));
    var topProposed = chosen.sort(function (a, b) { return a.date.getTime() - b.date.getTime(); })
      .map(function (r) {
        return {
          name: r.name || '(unnamed)', amount: r.amount, closeDate: r.date,
          probability: r.probability, nextStep: r.nextStep || '', stage: r.stage
        };
      });

    // All current+next-year opportunities, for the "add to the list" dropdown.
    var allOpps = recs.filter(function (r) {
      return r.year === currentYear || r.year === nextYear;
    }).map(function (r) {
      return {
        name: r.name || '(unnamed)', amount: r.amount, closeDate: r.date,
        probability: r.probability, nextStep: r.nextStep || '', stage: r.stage
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });

    return {
      currentYear: currentYear,
      avgOpenAgeDays: avgOpenAgeDays, openAgeCount: ageCount, hasCreated: !!mapping.created,
      wonByOwner: wonByOwner, wonTotal: wonTotal, wonCount: wonCount,
      awarded: awarded, awardedTotal: awardedTotal,
      leadSources: leadSources, hasLeadSource: !!mapping.leadSource,
      topProposed: topProposed, allOpps: allOpps
    };
  }

  /*
   * Sales-performance KPIs for the CURRENT year (filters applied).
   *   performanceMetrics(rows, mapping, today[, options])
   *
   * - winRate     : Closed Won ÷ (Won + Lost), by count and by value.
   * - avgCycleDays: mean (close − created) over Closed Won deals (needs a
   *                 Created Date; null + flag otherwise).
   * - velocity    : (open count × avg open deal × win-rate) ÷ avg cycle days,
   *                 in £/day (and £/month); null when the cycle is unknown/0.
   */
  function performanceMetrics(rows, mapping, today, options) {
    options = options || {};
    today = today || new Date();
    var currentYear = today.getFullYear();
    var MS_PER_DAY = 86400000;

    var recs = applyFilters(buildRecords(rows, mapping, options).records, options.filters)
      .filter(function (r) { return r.year === currentYear; });

    function isWon(r) { return String(r.stage).toLowerCase().indexOf('won') !== -1; }
    function isLost(r) { return String(r.stage).toLowerCase().indexOf('lost') !== -1; }

    var wonCount = 0, lostCount = 0, wonValue = 0, lostValue = 0;
    var cycleSum = 0, cycleCount = 0;
    var openCount = 0, openValue = 0;
    recs.forEach(function (r) {
      if (isWon(r)) {
        wonCount++; wonValue += r.amount;
        if (r.created) { cycleSum += Math.max(0, Math.floor((r.date.getTime() - r.created.getTime()) / MS_PER_DAY)); cycleCount++; }
      } else if (isLost(r)) {
        lostCount++; lostValue += r.amount;
      }
      if (!r.closed) { openCount++; openValue += r.amount; }
    });

    var decided = wonCount + lostCount;
    var winRatePct = decided ? (wonCount / decided) * 100 : null;
    var decidedValue = wonValue + lostValue;
    var winRateValuePct = decidedValue ? (wonValue / decidedValue) * 100 : null;
    var avgCycleDays = cycleCount ? Math.round(cycleSum / cycleCount) : null;
    var avgDealSize = openCount ? openValue / openCount : 0;

    var velocityPerDay = null;
    if (avgCycleDays && winRatePct != null && openCount) {
      velocityPerDay = (openCount * avgDealSize * (winRatePct / 100)) / avgCycleDays;
    }

    return {
      currentYear: currentYear,
      wonCount: wonCount, lostCount: lostCount,
      winRatePct: winRatePct, winRateValuePct: winRateValuePct,
      avgCycleDays: avgCycleDays, hasCreated: !!mapping.created, cycleCount: cycleCount,
      openCount: openCount, avgDealSize: avgDealSize,
      velocityPerDay: velocityPerDay,
      velocityPerMonth: velocityPerDay == null ? null : velocityPerDay * 30
    };
  }

  /*
   * Forward-looking forecast outlook, anchored to the calendar month that
   * `today` falls in (so it's stable whether the report runs on the 1st or the
   * 30th). Open opportunities only — closed deals are already decided.
   * Filters (e.g. the selected salesperson) are applied.
   *
   *   - month   : open opps closing within the current calendar month
   *   - next90  : current month + next 2 months ("next 90 days")
   *   - next365 : current month + next 11 months ("365-day pipeline")
   *   - strategic: open opps at or above the strategic threshold (default £10m)
   */
  function forecastMetrics(rows, mapping, today, options) {
    options = options || {};
    today = today || new Date();
    var threshold = options.strategicThreshold != null ? options.strategicThreshold : STRATEGIC_THRESHOLD;
    var recs = applyFilters(buildRecords(rows, mapping, options).records, options.filters);

    var ty = today.getFullYear(), tm = today.getMonth();
    var curStart = Date.UTC(ty, tm, 1);          // start of this month
    var nextMonthStart = Date.UTC(ty, tm + 1, 1); // start of next month
    var end90 = Date.UTC(ty, tm + 3, 1);          // start of month+3 (covers 3 months)
    var end365 = Date.UTC(ty, tm + 12, 1);        // start of month+12 (covers 12 months)

    function bucket() { return { count: 0, total: 0, weighted: 0 }; }
    function add(b, r) { b.count++; b.total += r.amount; b.weighted += r.weighted; }
    var month = bucket(), next90 = bucket(), next365 = bucket();

    var excludeAwardedOwners = options.awardedExcludeOwners || AWARDED_EXCLUDE_OWNERS;
    function stageHas(r, list) {
      var s = String(r.stage).toLowerCase();
      return list.some(function (x) { return s.indexOf(x) !== -1; });
    }
    function ownerExcluded(owner) {
      var o = String(owner).toLowerCase();
      return excludeAwardedOwners.some(function (x) { return o.indexOf(x) !== -1; });
    }
    // A deal counts toward the forecast windows when it is open, at a
    // discovery/proposed/awarded stage, is not an awarded deal owned by an
    // excluded owner (e.g. Finlay), and is not a £10m+ deal still at discovery.
    function forecastable(r) {
      if (r.closed) return false;
      if (!stageHas(r, FORECAST_STAGES)) return false;
      var s = String(r.stage).toLowerCase();
      if (s.indexOf('award') !== -1 && ownerExcluded(r.owner)) return false;
      if (r.amount >= threshold && s.indexOf('discover') !== -1) return false;
      return true;
    }

    recs.forEach(function (r) {
      if (!forecastable(r)) return;
      var t = r.date.getTime();
      if (t < curStart) return;
      if (t < nextMonthStart) add(month, r);
      if (t < end90) add(next90, r);
      if (t < end365) add(next365, r);
    });

    // Strategic = open, £10m+, and only at a Proposal or Awarded stage
    // (excludes discovery and any earlier stage).
    function isStrategic(r) {
      if (r.closed || r.amount < threshold) return false;
      var s = String(r.stage).toLowerCase();
      return STRATEGIC_STAGES.some(function (x) { return s.indexOf(x) !== -1; });
    }
    var items = recs.filter(isStrategic)
      .map(function (r) {
        return { name: r.name || '(unnamed)', amount: r.amount, owner: r.owner, stage: r.stage, closeDate: r.date };
      })
      .sort(function (a, b) { return b.amount - a.amount; });
    var strategicTotal = items.reduce(function (s, r) { return s + r.amount; }, 0);
    var strategicWeighted = recs.reduce(function (s, r) {
      return isStrategic(r) ? s + r.weighted : s;
    }, 0);

    function monthLabel(y, m) {
      var yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
      return MONTH_LABELS[mm] + ' ' + yy;
    }

    return {
      month: month, monthLabel: monthLabel(ty, tm),
      next90: next90, next90Label: monthLabel(ty, tm) + ' – ' + monthLabel(ty, tm + 2),
      next365: next365, next365Label: monthLabel(ty, tm) + ' – ' + monthLabel(ty, tm + 11),
      strategic: {
        threshold: threshold, count: items.length,
        total: strategicTotal, weighted: strategicWeighted, items: items
      }
    };
  }

  PA.analytics = {
    analyze: analyze,
    buildRecords: buildRecords,
    healthMetrics: healthMetrics,
    insightMetrics: insightMetrics,
    performanceMetrics: performanceMetrics,
    forecastMetrics: forecastMetrics,
    applyFilters: applyFilters,
    isExcludedAwarded: isExcludedAwarded,
    isSuppressedOwner: isSuppressedOwner,
    SUPPRESSED_OWNERS: SUPPRESSED_OWNERS,
    distinctFilterValues: distinctFilterValues,
    coverage: coverage,
    segmentFor: segmentFor,
    stageWeight: stageWeight,
    STRATEGIC_THRESHOLD: STRATEGIC_THRESHOLD,
    DEFAULT_STAGE_WEIGHTS: DEFAULT_STAGE_WEIGHTS,
    SEGMENT_MAP: SEGMENT_MAP,
    STALE_THRESHOLD_MONTHS: STALE_THRESHOLD_MONTHS,
    MONTH_LABELS: MONTH_LABELS
  };
})(window.PA = window.PA || {});
