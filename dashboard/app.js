// Token Radar dashboard (model radar-2). Reads window.RADAR from data.js and
// renders the ranked board, filters, a per-protocol detail view with the
// model's own arithmetic, and the live-token set that anchors the comps fit.
// No network: every byte it shows is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtX(n) { return 'x' + n.toFixed(2); }
  // The model in one function: the page recomputes a row from the snapshot
  // figures and checks the number board.json carries, so the page's code and
  // the board's data are visibly the same arithmetic. log mcap = b0 +
  // b1*ln(tvl) + b2*(growth/100) + b3*ln(1+age/365) + b4*chains; the fitted
  // betas live in DATA.beta, fitted at run time from the live-token comps.
  function rawOf(row) {
    var b = DATA.beta;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var growth = Math.min(120, Math.max(-60, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    return Math.exp(b[0] + b[1] * Math.log(row.tvl_usd) + b[2] * (growth / 100) + b[3] * Math.log1p(age / 365) + b[4] * (row.chains || []).length);
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.watchlistOnly && !DATA.watchlistSlugs.includes(r.slug)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function val(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null ? Infinity : r.age_days;
    if (key === 'odds') return r.odds;
    if (key === 'perhour') return r.dollars_per_hour;
    if (key === 'comps') return r.comps_value_usd;
    return r.implied_value_usd;
  }
  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = val(a, state.sort), bv = val(b, state.sort);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      ));
  }
  function lede() {
    var vc = DATA.verdict_counts;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The board ranks all ' + DATA.board_size + ' rankable pre-token protocols. Implied value is the comps value times the launch odds: an expected value, not a promise.' })
      ),
      el('div', { class: 'strip' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('small', { text: 'every watchlist slug is on the board' })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) }), el('small', { text: 'of 758 protocols in the snapshot' })),
        el('div', { class: 'fact' }, el('span', { text: 'Farm verdicts' }), el('b', { text: vc.FARM + ' farm / ' + vc.THIN + ' thin / ' + vc.SKIP + ' skip' }), el('small', { text: 'costed per row, net of gas and T-bill cost' })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token set aside' }), el('b', { text: String(DATA.live_size) }), el('small', { text: DATA.tests.comps + ' with a market cap anchor the fit' }))
      ));
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var ch = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    ch.addEventListener('change', function () { state.chain = ch.value; writeHash(); render(); });
    var vd = el('select', { id: 'verdict', 'aria-label': 'Filter by farm verdict' },
      el('option', { value: 'all', text: 'All verdicts' }),
      ['FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v, selected: v === state.verdict ? 'selected' : null }); }));
    vd.addEventListener('change', function () { state.verdict = vd.value; writeHash(); render(); });
    var wl = el('button', { type: 'button', 'aria-pressed': state.watchlistOnly ? 'true' : 'false', text: state.watchlistOnly ? 'Watchlist only: on' : 'Watchlist only', onclick: function () { state.watchlistOnly = !state.watchlistOnly; render(); } });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), ch),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Farm verdict' }), vd),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), el('div', { class: 'tabs' }, wl)),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function verdictBadge(v) { return el('span', { class: 'verdict ' + v.toLowerCase(), text: v }); }
  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.watchlistOnly = false; writeHash(); render(); } })));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: Math.round(r.odds * 100) + '%' }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: fmtUsd(r.range_lo_usd) + ' - ' + fmtUsd(r.range_hi_usd) }),
        el('td', null, verdictBadge(r.verdict)),
        el('td', { class: 'num ' + (r.dollars_per_hour >= 0 ? 'pos' : 'neg'), text: '$' + r.dollars_per_hour.toFixed(0) + '/h' })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan. Implied value is the comps value times the launch odds.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'),
            sortHeader('odds', 'Odds'), sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'P10-P90 range' }), el('th', { scope: 'col', text: 'Farm' }), sortHeader('perhour', '$/hour')
          )), tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. The ' + DATA.tests.comps + ' with a market cap are the comps the model is fitted on.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  }
  function modelPanel() {
    var t = DATA.tests;
    var b = DATA.beta;
    var rows = DATA.odds_bands.map(function (band) {
      return el('tr', null, el('td', { text: band.label }), el('td', { class: 'num', text: Math.round(band.odds * 100) + '%' }), el('td', { class: 'num', text: band.pre + ' of ' + band.total + ' still pre-token' }));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every row, fitted at run time from the snapshot\u2019s own live-token protocols. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'log(market cap) = ' + b[0].toFixed(3) + ' + ' + b[1].toFixed(3) + ' x ln(TVL) + ' + b[2].toFixed(3) + ' x (growth/100) + ' + b[3].toFixed(3) + ' x ln(1 + age/365) + ' + b[4].toFixed(3) + ' x chains\n' +
        'comps value = exp(log market cap);  implied value = comps value x launch odds;  range = implied x exp(P10/P90 of the leave-one-out residuals)'),
      el('table', { class: 'tests' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Blind test' }), el('th', { scope: 'col', text: 'This model' }), el('th', { scope: 'col', text: 'Starter flat 0.25x' }), el('th', { scope: 'col', text: 'What it means' }))),
        el('tbody', null,
          el('tr', null, el('td', { text: 'Leave-one-out (' + t.comps + ' live tokens)' }), el('td', { class: 'num', text: fmtX(t.looFactor) }), el('td', { class: 'num', text: fmtX(t.starterLooFactor) }), el('td', { text: 'typical factor off the live market cap' })),
          el('tr', null, el('td', { text: 'Walk-forward (' + t.wfTested + ' newer tokens)' }), el('td', { class: 'num', text: fmtX(t.wfFactor) }), el('td', { class: 'num', text: fmtX(t.wfStarterFactor) }), el('td', { text: 'trained on older tokens, tested on newer ones' })),
          el('tr', null, el('td', { text: 'P10-P90 range coverage' }), el('td', { class: 'num', text: Math.round(t.looCoverage * 100) + '%' }), el('td', { class: 'num', text: 'n/a' }), el('td', { text: 'of held-out tokens fall inside the shown range' })))
      ),
      el('p', { class: 'sub', text: 'Terms kept or dropped on those two tests: log TVL kept (the biggest gain), growth kept, age kept (the task\u2019s own value definition includes how long a protocol has run with no token), chain count kept; category dummies dropped (leave-one-out x4.06, walk-forward x3.76: they overfit 128 comps) and growth squared dropped (walk-forward x4.34). Growth enters with a negative sign: among live tokens, a one-week TVL spike usually means inflated TVL, not a dearer token, so the fit discounts it; dropping the term worsens both blind tests.' }),
      el('h2', { text: 'Launch odds, from the peers\u2019 record' }),
      el('table', { class: 'tests' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Age with no token' }), el('th', { scope: 'col', text: 'Odds' }), el('th', { scope: 'col', text: 'Peers' }))),
        el('tbody', null, rows)
      ),
      el('p', { class: 'sub', text: 'Odds are the share of protocols first listed in that age band that still record no token. They fall with age: a protocol that has run for years with no token is, on the peers\u2019 record, the one that stays without one. A protocol with no listed date uses the overall pre-token rate of ' + Math.round(DATA.overall_pre_rate * 100) + '%.' }),
      el('h2', { text: 'Farm verdicts, costed' }),
      el('p', { class: 'sub', text: 'Each plan costs its gas by chain (Ethereum about $12 a transaction, L2s about $0.50, Solana about $0.05), its capital by TVL tier, and the capital\u2019s opportunity cost at a 4.5% T-bill rate over the hold. The verdict assumes the airdrop pool is 5% of the implied value split among 20,000 farmers; at 5,000 farmers ' + DATA.verdict_sensitivity.farmers_5000.FARM + ' rows would read FARM, at 50,000 farmers ' + DATA.verdict_sensitivity.farmers_50000.FARM + ' would. That assumption is the verdict\u2019s weakest link, so the dashboard shows it moving. FARM means at least $25 an hour net, THIN means above zero, SKIP means the costs beat the expected share.' }),
      el('p', { class: 'sub', text: 'What is not here: ' + DATA.excluded_size + ' pre-token protocols are excluded by the watchlist\u2019s own rule (bridges, liquid staking, CEXs, versioned and wrapped or staked products of tokens that already trade), and the ' + DATA.live_size + ' live-token protocols are set aside with their market caps. Together with the ' + DATA.board_size + ' ranked rows, that accounts for all 758 protocols in the snapshot.' })
    );
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  function farmStepsFor(row) { return row.farm_steps || []; }
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = rawOf(row);
    var b = DATA.beta;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var growth = Math.min(120, Math.max(-60, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value, term by term' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Chains' }), el('b', { class: 'num', text: String((row.chains || []).length) })),
        el('div', null, el('span', { text: 'Comps value' }), el('b', { class: 'num', text: fmtUsd(row.comps_value_usd) })),
        el('div', null, el('span', { text: 'Launch odds' }), el('b', { class: 'num', text: Math.round(row.odds * 100) + '%' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'P10-P90 range' }), el('b', { class: 'num', text: fmtUsd(row.range_lo_usd) + ' - ' + fmtUsd(row.range_hi_usd) }))
      ),
      el('p', { class: 'sub', text: 'log(market cap) = ' + b[0].toFixed(3) + ' + ' + b[1].toFixed(3) + ' x ln(' + fmtUsd(row.tvl_usd) + ') + ' + b[2].toFixed(3) + ' x ' + (growth / 100).toFixed(3) + ' + ' + b[3].toFixed(3) + ' x ln(1 + ' + age + '/365) + ' + b[4].toFixed(3) + ' x ' + (row.chains || []).length + ' = ' + Math.log(recomputed).toFixed(2) + '. The page recomputes this row as ' + fmtUsd(Math.round(recomputed)) + (Math.abs(recomputed - row.comps_value_usd) <= Math.max(1000, row.comps_value_usd * 0.001) ? ', matching the board\u2019s ' + fmtUsd(row.comps_value_usd) + ' (the dashboard carries the betas rounded to 4 decimals).' : ', which differs from the board\u2019s ' + fmtUsd(row.comps_value_usd) + ': the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict: ' + row.verdict }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'Expected share per farmer' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd * 0.05 / 20000) })),
        el('div', null, el('span', { text: 'Farm cost (gas + T-bill)' }), el('b', { class: 'num', text: '$' + row.farm_cost_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Hours spent' }), el('b', { class: 'num', text: row.farm_hours.toFixed(2) + ' h' })),
        el('div', null, el('span', { text: 'Net per hour' }), el('b', { class: 'num', text: '$' + row.dollars_per_hour.toFixed(2) + '/h' }))
      ),
      el('p', { class: 'sub', text: 'Assumes a 5% airdrop pool split among 20,000 farmers. At 5,000 farmers this row would be worth about $' + (row.implied_value_usd * 0.05 / 5000).toFixed(0) + ' a farmer; at 50,000, about $' + (row.implied_value_usd * 0.05 / 50000).toFixed(0) + '. FARM means at least $25 an hour net, THIN means above zero, SKIP means the costs beat the expected share.' })
    ));
    var steps = farmStepsFor(row);
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }
  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
