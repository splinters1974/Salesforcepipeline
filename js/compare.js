/*
 * compare.js — compare this report against a previously loaded one.
 *
 * Two pure functions (no DOM, so they unit-test cleanly):
 *   buildSnapshot(rows, mapping, opts) -> a compact, JSON-safe picture of a
 *     report: its date plus one small entry per opportunity.
 *   diffSnapshots(prev, curr)          -> the movement between two snapshots.
 *
 * Snapshots are deliberately unfiltered — they describe the whole report, so
 * two reports stay comparable even if the dashboard filters differ between
 * the sessions that produced them. Headline totals still mirror the dashboard
 * KPIs: open pipeline inside the current/following-year window, with the
 * excluded-owner awarded deals dropped, so the numbers agree on screen.
 */
(function (PA) {
  'use strict';

  // Only keep this many snapshots — enough history to pick a baseline from,
  // small enough to stay well inside the localStorage quota.
  var MAX_SNAPSHOTS = 12;

  // 2 = each opportunity also carries region / segment / lead source, so a
  // stored snapshot can be re-sliced by the dashboard filters after the fact.
  // Version 1 snapshots only support the owner and stage dimensions.
  var SNAPSHOT_VERSION = 2;

  // Dimensions a version 1 snapshot cannot answer.
  var V2_ONLY_DIMS = ['region', 'segment', 'leadSource'];

  function normText(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function isWonStage(stage) {
    return String(stage || '').toLowerCase().indexOf('closed won') !== -1;
  }

  // YYYY-MM-DD, so snapshots survive JSON round-tripping intact.
  function toIso(d) {
    if (!d) return null;
    var m = String(d.getUTCMonth() + 1);
    var day = String(d.getUTCDate());
    return d.getUTCFullYear() + '-' + (m.length < 2 ? '0' + m : m) +
           '-' + (day.length < 2 ? '0' + day : day);
  }

  function fromIso(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  /*
   * Normalise an opportunity name for matching. Punctuation is folded away to
   * single spaces, which matters more than it looks: the same deal exported
   * twice can differ purely by character encoding (an en-dash arriving as "?"
   * or "â€“"), and a raw string compare would then read as two different deals.
   */
  function normName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /*
   * Normalise a record identifier. A Salesforce Opportunity ID is allocated
   * automatically and never changes, which makes it the ideal key — but the
   * same record exports as EITHER a 15-character case-sensitive ID or an
   * 18-character case-safe one (the same 15 plus a 3-character checksum),
   * depending on how the report was run. Fold 18 down to 15 so a deal still
   * matches when the export format differs between two reports, and preserve
   * case there, because 15-character IDs are genuinely case-sensitive and
   * lowercasing them could collide two distinct records. Anything else — a job
   * or project number — is matched case-insensitively.
   */
  function normId(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^[A-Za-z0-9]{18}$/.test(s)) return s.slice(0, 15);
    if (/^[A-Za-z0-9]{15}$/.test(s)) return s;
    return s.toLowerCase();
  }

  /*
   * Match keys for one report's opportunities, computed at diff time rather
   * than stored — so snapshots written by an older version still compare
   * correctly, and the matching rules can improve without invalidating history.
   *
   * Each opportunity gets BOTH an id key and a name key where available,
   * because a deal does not keep the same identifiers for life: a job number
   * is typically only assigned once a deal reaches a certain stage. Keyed on
   * "id, or else name", such a deal would look like one deal vanishing and a
   * different one appearing the moment its number came through.
   */
  function matchKeys(opps) {
    var seen = {};
    return opps.map(function (o, idx) {
      var n = normName(o.name);
      if (n) {
        // Duplicate names within one report get an occurrence suffix so they
        // stay distinct instead of collapsing into a single entry.
        seen[n] = (seen[n] || 0) + 1;
        if (seen[n] > 1) n += '#' + seen[n];
      }
      return {
        id: normId(o.oppId),
        name: n || null,
        // Last-resort fingerprint for a deal that has been renamed and has no
        // job number in at least one of the reports. Deliberately strict —
        // owner, value and close date must all agree — because a report can
        // easily hold several deals sharing any two of the three.
        print: (o.owner && o.amount && o.closeDate)
          ? normText(o.owner) + '|' + o.amount + '|' + o.closeDate
          : null,
        idx: idx
      };
    });
  }

  /*
   * Pair up two reports' opportunities in decreasing order of confidence:
   * job number, then name, then the strict fingerprint. Each opportunity is
   * consumed by at most one pairing, so a later, weaker pass can never steal
   * a deal that an earlier, stronger one already matched.
   */
  function matchOpps(prevOpps, currOpps) {
    var pk = matchKeys(prevOpps), ck = matchKeys(currOpps);
    var prevUsed = {}, currUsed = {}, pairs = [];

    function pass(field, via) {
      var buckets = {};
      pk.forEach(function (k, i) {
        if (prevUsed[i] || !k[field]) return;
        var b = k[field];
        (buckets[b] = buckets[b] || []).push(i);
      });
      ck.forEach(function (k, j) {
        if (currUsed[j] || !k[field]) return;
        var bucket = buckets[k[field]];
        if (!bucket || !bucket.length) return;
        var i = bucket.shift();
        prevUsed[i] = true; currUsed[j] = true;
        pairs.push({ prev: prevOpps[i], curr: currOpps[j], via: via });
      });
    }

    pass('id', 'id');
    pass('name', 'name');
    pass('print', 'fingerprint');

    var unmatchedPrev = [], unmatchedCurr = [];
    prevOpps.forEach(function (o, i) { if (!prevUsed[i]) unmatchedPrev.push(o); });
    currOpps.forEach(function (o, j) { if (!currUsed[j]) unmatchedCurr.push(o); });
    return { pairs: pairs, unmatchedPrev: unmatchedPrev, unmatchedCurr: unmatchedCurr };
  }

  /*
   * Build a snapshot from raw rows + mapping.
   * opts: { currentYear, dayFirst, stageWeights, reportDate (Date|ISO), label }
   */
  function buildSnapshot(rows, mapping, opts) {
    opts = opts || {};
    var built = PA.analytics.buildRecords(rows, mapping, opts);
    var currentYear = opts.currentYear || new Date().getFullYear();
    var nextYear = currentYear + 1;

    // Mirror analyze(): drop awarded deals owned by an excluded owner so the
    // snapshot's headline totals match what the dashboard shows.
    var recs = built.records.filter(function (r) {
      return !PA.analytics.isExcludedAwarded(r, opts.awardedExcludeOwners);
    });

    var opps = recs.map(function (r) {
      return {
        // The raw job number / record ID is stored, not a derived key, so the
        // matching rules can change later without invalidating stored history.
        oppId: r.oppId || '',
        name: r.name || '(unnamed)',
        owner: r.owner,
        amount: r.amount,
        weighted: r.weighted,
        stage: r.stage,
        closed: !!r.closed,
        won: isWonStage(r.stage),
        closeDate: toIso(r.date),
        year: r.year,
        // Carried so a stored snapshot can be re-sliced by the dashboard
        // filters later, without needing the original CSV back.
        region: r.region,
        segment: PA.analytics.segmentFor(r.product),
        leadSource: r.leadSource
      };
    });

    var headline = totalsFor(opps, currentYear, nextYear);

    var reportDate = opts.reportDate instanceof Date
      ? toIso(opts.reportDate)
      : (opts.reportDate ? String(opts.reportDate).slice(0, 10) : toIso(new Date()));

    return {
      v: SNAPSHOT_VERSION,
      reportDate: reportDate,
      label: opts.label || '',
      currentYear: currentYear,
      nextYear: nextYear,
      count: headline.count,
      total: headline.total,
      weighted: headline.weighted,
      opps: opps
    };
  }

  /*
   * Headline figures for a set of opportunities: open pipeline inside the
   * analysis window. Computed rather than read back from the snapshot so that
   * a filtered view recomputes correctly.
   */
  function totalsFor(opps, currentYear, nextYear) {
    var open = (opps || []).filter(function (o) {
      return !o.closed && (o.year === currentYear || o.year === nextYear);
    });
    var total = 0, weighted = 0;
    open.forEach(function (o) { total += o.amount; weighted += o.weighted; });
    return { count: open.length, total: total, weighted: weighted };
  }

  // Same semantics as the dashboard's filters: OR within a dimension, AND
  // across dimensions. Reads the fields stored on a snapshot opportunity.
  var SNAP_DIMS = {
    owner: function (o) { return o.owner; },
    region: function (o) { return o.region; },
    segment: function (o) { return o.segment; },
    stage: function (o) { return o.stage; },
    leadSource: function (o) { return o.leadSource; }
  };

  function activeDims(filters) {
    if (!filters) return [];
    return Object.keys(SNAP_DIMS).filter(function (d) {
      return Array.isArray(filters[d]) && filters[d].length;
    });
  }

  function filterOpps(opps, filters, dims) {
    if (!dims.length) return opps;
    return (opps || []).filter(function (o) {
      return dims.every(function (d) {
        return filters[d].indexOf(SNAP_DIMS[d](o)) !== -1;
      });
    });
  }

  function sumField(list, field) {
    return list.reduce(function (s, o) { return s + (o[field] || 0); }, 0);
  }

  function byValueDesc(a, b) { return b.amount - a.amount; }

  function movement(prev, curr) {
    return { prev: prev, curr: curr, delta: curr - prev };
  }

  /*
   * Compare two snapshots. Returns:
   *   { prevDate, currDate, daysBetween,
   *     count/total/weighted: { prev, curr, delta },
   *     closedWon[], closedLost[], closedWonTotal, closedLostTotal,
   *     added[], removed[], addedTotal, removedTotal }
   *
   * A deal counts as "closed since" when it was open in the previous report
   * and carries a Closed stage in this one. Deals that simply vanished from
   * the export are reported separately under `removed` — they may have been
   * closed, deleted or filtered out at source, so they are not assumed won.
   *
   * Also returns `renamed` (deals matched across the two reports whose name
   * changed) and `matchedBy` counts, so a run can be sanity-checked rather
   * than silently mis-reporting renamed deals as churn.
   */
  function diffSnapshots(prev, curr, opts) {
    if (!prev || !curr) return null;
    opts = opts || {};

    /*
     * Apply the dashboard's filters to both sides, so the comparison describes
     * the same slice of the pipeline the rest of the screen is showing. The
     * stored snapshot itself stays unfiltered, so changing a filter re-slices
     * the comparison instantly and history is never lost to a filter that
     * happened to be set on the day a report was loaded.
     */
    var dims = activeDims(opts.filters);
    var oldBaseline = (prev.v || 1) < SNAPSHOT_VERSION || (curr.v || 1) < SNAPSHOT_VERSION;
    // A snapshot stored before those fields existed cannot answer these, so
    // drop them rather than silently filtering every deal out.
    var unsupported = oldBaseline
      ? dims.filter(function (d) { return V2_ONLY_DIMS.indexOf(d) !== -1; })
      : [];
    var usable = dims.filter(function (d) { return unsupported.indexOf(d) === -1; });

    var prevOpps = filterOpps(prev.opps || [], opts.filters, usable);
    var currOpps = filterOpps(curr.opps || [], opts.filters, usable);

    var prevTotals = totalsFor(prevOpps, prev.currentYear, prev.nextYear);
    var currTotals = totalsFor(currOpps, curr.currentYear, curr.nextYear);

    var m = matchOpps(prevOpps, currOpps);
    var closedWon = [], closedLost = [], renamed = [];
    var matchedBy = { id: 0, name: 0, fingerprint: 0 };
    var outOfWindow = 0;

    /*
     * The headline tiles only count open pipeline inside the analysis window,
     * so the movement lists honour the same window — otherwise a deal closing
     * in a year the dashboard never counted would appear as a win while the
     * tiles above it reported no change. A deal counts as in scope if it sat
     * in the window in EITHER report, which keeps deals that slipped out of
     * the window visible rather than silently dropping them.
     */
    function inWindow(o, snap) {
      return o && (o.year === snap.currentYear || o.year === snap.nextYear);
    }

    m.pairs.forEach(function (pair) {
      var p = pair.prev, c = pair.curr;
      matchedBy[pair.via]++;
      if (!inWindow(p, prev) && !inWindow(c, curr)) {
        // Only count it as skipped if it would otherwise have been reported.
        if ((!p.closed && c.closed) || (!c.closed && p.name !== c.name)) outOfWindow++;
        return;
      }
      // Open before, closed now — the movement the report should call out.
      if (!p.closed && c.closed) {
        (c.won ? closedWon : closedLost).push({
          name: c.name,
          owner: c.owner,
          amount: c.amount,
          weighted: p.weighted,      // what it was forecast at before closing
          stage: c.stage,
          closeDate: c.closeDate
        });
      }
      // Surfaced so a rename is visible as a rename rather than looking like
      // one deal disappearing and an unrelated one arriving.
      if (!c.closed && p.name !== c.name) {
        renamed.push({
          name: c.name, from: p.name, owner: c.owner,
          amount: c.amount, stage: c.stage, closeDate: c.closeDate, via: pair.via
        });
      }
    });

    // Only genuinely unmatched rows count as new or gone, and only inside the
    // window the tiles describe.
    var added = m.unmatchedCurr.filter(function (c) {
      if (c.closed) return false;
      if (!inWindow(c, curr)) { outOfWindow++; return false; }
      return true;
    });
    var removed = m.unmatchedPrev.filter(function (p) {
      if (p.closed) return false;
      if (!inWindow(p, prev)) { outOfWindow++; return false; }
      return true;
    });

    closedWon.sort(byValueDesc);
    closedLost.sort(byValueDesc);
    added.sort(byValueDesc);
    removed.sort(byValueDesc);
    renamed.sort(byValueDesc);

    var pd = fromIso(prev.reportDate), cd = fromIso(curr.reportDate);
    var daysBetween = (pd && cd)
      ? Math.round((cd.getTime() - pd.getTime()) / 86400000)
      : null;

    return {
      prevDate: prev.reportDate,
      currDate: curr.reportDate,
      prevLabel: prev.label || '',
      currLabel: curr.label || '',
      daysBetween: daysBetween,
      count: movement(prevTotals.count, currTotals.count),
      total: movement(prevTotals.total, currTotals.total),
      weighted: movement(prevTotals.weighted, currTotals.weighted),
      // Which filters this comparison honours, so the card can say so rather
      // than quietly showing a different slice from the rest of the dashboard.
      filteredBy: usable,
      unsupportedFilters: unsupported,
      // Movements on deals that sat outside the analysis window in both
      // reports, and so are not shown — reported rather than silently dropped.
      outOfWindow: outOfWindow,
      windowYears: [curr.currentYear, curr.nextYear],
      closedWon: closedWon,
      closedLost: closedLost,
      closedWonTotal: sumField(closedWon, 'amount'),
      closedLostTotal: sumField(closedLost, 'amount'),
      added: added,
      addedTotal: sumField(added, 'amount'),
      removed: removed,
      removedTotal: sumField(removed, 'amount'),
      renamed: renamed,
      matchedBy: matchedBy,
      // Share of the previous report that could not be matched at all. A high
      // value almost always means the two exports don't cover the same ground
      // (different filters, owners or columns) rather than a mass of lost deals.
      unmatchedPrevShare: prevOpps.length
        ? m.unmatchedPrev.length / prevOpps.length : 0
    };
  }

  // Newest last. Snapshots taken on a date that is already stored replace that
  // entry, so re-loading the same report doesn't pile up duplicate baselines.
  function addSnapshot(list, snap) {
    var out = (list || []).filter(function (s) { return s.reportDate !== snap.reportDate; });
    out.push(snap);
    out.sort(function (a, b) { return a.reportDate < b.reportDate ? -1 : 1; });
    return out.slice(-MAX_SNAPSHOTS);
  }

  // The most recent stored snapshot strictly older than `snap`, or null.
  function previousSnapshot(list, snap) {
    var older = (list || []).filter(function (s) { return s.reportDate < snap.reportDate; });
    return older.length ? older[older.length - 1] : null;
  }

  PA.compare = {
    MAX_SNAPSHOTS: MAX_SNAPSHOTS,
    buildSnapshot: buildSnapshot,
    diffSnapshots: diffSnapshots,
    addSnapshot: addSnapshot,
    previousSnapshot: previousSnapshot,
    toIso: toIso,
    fromIso: fromIso
  };
})(window.PA = window.PA || {});
