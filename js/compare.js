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
   * A stable identity for one opportunity, so the same deal is recognised
   * across two exports. Prefers the Salesforce record ID when the report has
   * one; otherwise falls back to the opportunity name. Owner is deliberately
   * NOT part of the key — deals get reassigned, and that would otherwise read
   * as one deal disappearing and a different one appearing.
   */
  function assignKeys(recs) {
    var seen = {};
    return recs.map(function (r, idx) {
      if (r.oppId) return 'id:' + normText(r.oppId);
      var n = normText(r.name);
      if (!n) return 'ix:' + idx;
      seen[n] = (seen[n] || 0) + 1;
      // Duplicate names within one report get an occurrence suffix so they
      // stay distinct instead of collapsing into a single entry.
      return 'nm:' + n + (seen[n] > 1 ? '#' + seen[n] : '');
    });
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

    var keys = assignKeys(recs);
    var opps = recs.map(function (r, i) {
      return {
        key: keys[i],
        name: r.name || '(unnamed)',
        owner: r.owner,
        amount: r.amount,
        weighted: r.weighted,
        stage: r.stage,
        closed: !!r.closed,
        won: isWonStage(r.stage),
        closeDate: toIso(r.date),
        year: r.year
      };
    });

    var open = opps.filter(function (o) {
      return !o.closed && (o.year === currentYear || o.year === nextYear);
    });
    var total = 0, weighted = 0;
    open.forEach(function (o) { total += o.amount; weighted += o.weighted; });

    var reportDate = opts.reportDate instanceof Date
      ? toIso(opts.reportDate)
      : (opts.reportDate ? String(opts.reportDate).slice(0, 10) : toIso(new Date()));

    return {
      reportDate: reportDate,
      label: opts.label || '',
      currentYear: currentYear,
      nextYear: nextYear,
      count: open.length,
      total: total,
      weighted: weighted,
      opps: opps
    };
  }

  function indexByKey(opps) {
    var m = {};
    (opps || []).forEach(function (o) { m[o.key] = o; });
    return m;
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
   */
  function diffSnapshots(prev, curr) {
    if (!prev || !curr) return null;

    var prevMap = indexByKey(prev.opps);
    var currMap = indexByKey(curr.opps);

    var closedWon = [], closedLost = [], added = [], removed = [];

    (curr.opps || []).forEach(function (c) {
      var p = prevMap[c.key];
      if (!p) {
        if (!c.closed) added.push(c);
        return;
      }
      // Open before, closed now — this is the movement the report should call out.
      if (!p.closed && c.closed) {
        var entry = {
          key: c.key,
          name: c.name,
          owner: c.owner,
          amount: c.amount,
          weighted: p.weighted,      // what it was forecast at before closing
          stage: c.stage,
          closeDate: c.closeDate
        };
        (c.won ? closedWon : closedLost).push(entry);
      }
    });

    (prev.opps || []).forEach(function (p) {
      if (p.closed) return;                 // already closed last time — not news
      if (!currMap[p.key]) removed.push(p);
    });

    closedWon.sort(byValueDesc);
    closedLost.sort(byValueDesc);
    added.sort(byValueDesc);
    removed.sort(byValueDesc);

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
      count: movement(prev.count, curr.count),
      total: movement(prev.total, curr.total),
      weighted: movement(prev.weighted, curr.weighted),
      closedWon: closedWon,
      closedLost: closedLost,
      closedWonTotal: sumField(closedWon, 'amount'),
      closedLostTotal: sumField(closedLost, 'amount'),
      added: added,
      addedTotal: sumField(added, 'amount'),
      removed: removed,
      removedTotal: sumField(removed, 'amount')
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
