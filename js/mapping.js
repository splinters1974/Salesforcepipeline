/*
 * mapping.js — auto-detect which CSV columns map to the fields the
 * analysis needs, and render a panel of dropdowns so the user can correct
 * any mismatch.
 *
 * Field model:
 *   amount      (required)  numeric opportunity value
 *   closeDate   (required)  used to bucket into current/next year
 *   stage       (required)  sales stage
 *   probability (optional)  win % (0-100 or 0-1); falls back to stage weight
 *   owner       (optional)  sales rep
 *   product     (optional)  product / line of business
 *   region      (optional)  region / territory / segment
 *   name        (optional)  opportunity name, for tables/tooltips
 */
(function (PA) {
  'use strict';

  var FIELDS = [
    { key: 'amount', label: 'Amount', required: true,
      hints: ['amount', 'opportunity amount', 'acv', 'arr', 'value', 'deal size', 'tcv'] },
    { key: 'closeDate', label: 'Close Date', required: true,
      hints: ['close date', 'closedate', 'close', 'expected close'] },
    { key: 'lastModified', label: 'Last Modified Date', required: false,
      hints: ['last modified date', 'last modified', 'modified date', 'last activity date', 'last activity'] },
    { key: 'created', label: 'Created Date', required: false,
      hints: ['created date', 'create date', 'opportunity created date', 'date created', 'created'] },
    { key: 'nextStep', label: 'Next Step', required: false,
      hints: ['next step', 'next steps', 'next action'] },
    { key: 'leadSource', label: 'Lead Source', required: false,
      hints: ['lead source', 'lead origin', 'source', 'opportunity source'] },
    { key: 'stage', label: 'Stage', required: true,
      hints: ['stage', 'stage name', 'sales stage', 'opportunity stage'] },
    { key: 'probability', label: 'Probability', required: false,
      hints: ['probability', 'win %', 'win probability', 'prob', '%'] },
    { key: 'owner', label: 'Owner', required: false,
      hints: ['owner', 'opportunity owner', 'account owner', 'sales rep', 'rep', 'salesperson'] },
    { key: 'product', label: 'Opportunity Solutions', required: false,
      hints: ['opportunity solutions', 'opportunity solution', 'solutions', 'solution',
              'technology', 'product', 'product family', 'product line', 'line of business', 'lob'] },
    { key: 'region', label: 'Region', required: false,
      hints: ['region', 'territory', 'segment', 'area', 'geo', 'market'] },
    { key: 'name', label: 'Opportunity Name', required: false,
      hints: ['opportunity name', 'opportunity', 'name', 'deal name'] }
  ];

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Score how well a header matches a field's hints. Higher is better.
  function scoreHeader(header, hints) {
    var h = norm(header);
    if (!h) return 0;
    var best = 0;
    hints.forEach(function (hint) {
      var hh = norm(hint);
      if (h === hh) best = Math.max(best, 100);
      else if (h.indexOf(hh) !== -1) best = Math.max(best, 70 + hh.length); // longer hint = stronger
      else if (hh.indexOf(h) !== -1) best = Math.max(best, 40);
    });
    return best;
  }

  /*
   * Given headers, return a best-guess mapping { fieldKey: headerName|null }.
   * Each header is assigned to at most one field (greedy by best score).
   */
  function autoDetect(headers) {
    var mapping = {};
    var used = {};
    // Build candidate scores for every (field, header) pair.
    var candidates = [];
    FIELDS.forEach(function (f) {
      headers.forEach(function (hdr) {
        var s = scoreHeader(hdr, f.hints);
        if (s > 0) candidates.push({ field: f.key, header: hdr, score: s });
      });
    });
    candidates.sort(function (a, b) { return b.score - a.score; });
    candidates.forEach(function (c) {
      if (mapping[c.field] || used[c.header]) return;
      mapping[c.field] = c.header;
      used[c.header] = true;
    });
    FIELDS.forEach(function (f) { if (!mapping[f.key]) mapping[f.key] = null; });
    return mapping;
  }

  /*
   * Render dropdowns into `container`. Calls onChange(mapping) whenever the
   * user changes a selection. Returns the initial mapping.
   */
  function renderPanel(container, headers, initialMapping, onChange) {
    container.innerHTML = '';
    var mapping = Object.assign({}, initialMapping);

    FIELDS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'map-field';

      var label = document.createElement('label');
      label.textContent = f.label + (f.required ? ' *' : '');
      label.className = 'map-label' + (f.required ? ' required' : '');

      var select = document.createElement('select');
      select.className = 'map-select';

      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = f.required ? '— select column —' : '(none)';
      select.appendChild(noneOpt);

      headers.forEach(function (hdr) {
        var opt = document.createElement('option');
        opt.value = hdr;
        opt.textContent = hdr;
        if (mapping[f.key] === hdr) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener('change', function () {
        mapping[f.key] = select.value || null;
        validateRequired(container, mapping);
        onChange(Object.assign({}, mapping));
      });

      wrap.appendChild(label);
      wrap.appendChild(select);
      container.appendChild(wrap);
    });

    validateRequired(container, mapping);
    return mapping;
  }

  function validateRequired(container, mapping) {
    var missing = FIELDS.filter(function (f) {
      return f.required && !mapping[f.key];
    }).map(function (f) { return f.label; });
    container.classList.toggle('has-missing', missing.length > 0);
    return missing;
  }

  function requiredMissing(mapping) {
    return FIELDS.filter(function (f) {
      return f.required && !mapping[f.key];
    }).map(function (f) { return f.label; });
  }

  PA.mapping = {
    FIELDS: FIELDS,
    autoDetect: autoDetect,
    renderPanel: renderPanel,
    requiredMissing: requiredMissing
  };
})(window.PA = window.PA || {});
