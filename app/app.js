'use strict';

// ---------- helpers ----------
const TZ = 'America/New_York';
const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('en-US');
const pct = new Intl.NumberFormat('en-US', {style: 'percent', maximumFractionDigits: 0});
const fDate = new Intl.DateTimeFormat('en-US', {timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric'});
const fDT = new Intl.DateTimeFormat('en-US', {timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const fDayUTC = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'});
const fMonth = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', year: 'numeric', month: 'long'});
const fMonthShort = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', year: '2-digit', month: 'short'});
const partsF = new Intl.DateTimeFormat('en-US', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23'});
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (i) => `var(--s${i})`;

const localCache = new Map();
function local(iso) {
  let o = localCache.get(iso);
  if (o) return o;
  const p = {};
  for (const x of partsF.formatToParts(new Date(iso))) p[x.type] = x.value;
  o = {y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, wd: WD.indexOf(p.weekday)};
  localCache.set(iso, o);
  return o;
}
const monthKey = (iso) => { const l = local(iso); return `${l.y}-${pad(l.m)}`; };
const yearOf = (iso) => local(iso).y;
function monthRange(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  while (y < by || (y === by && m <= bm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const monthDate = (k) => new Date(`${k}-01T00:00:00Z`);
const countBy = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); m.set(k, (m.get(k) || 0) + 1); } return m; };
const minYear = (isos) => { const ys = isos.filter(Boolean).map(yearOf); return ys.length ? Math.min(...ys) : '—'; };
const since = (isos) => isos.length ? `since ${minYear(isos)}` : 'not in this export';
const COMPLETE = 'LinkedIn only includes this in the Complete export.';
const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : null;

function lede(node, parts) {
  // parts: strings, or [value] to bold
  node.replaceChildren(...parts.map((p) => Array.isArray(p) ? el('b', null, p[0]) : document.createTextNode(p)));
}

function highlight(node, text, q) {
  node.replaceChildren();
  if (!q) { node.textContent = text; return; }
  const lower = text.toLowerCase();
  let i = 0, j;
  while ((j = lower.indexOf(q, i)) !== -1) {
    if (j > i) node.append(text.slice(i, j));
    node.append(el('mark', null, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  node.append(text.slice(i));
}

function legend(node, series) {
  node.replaceChildren(...series.map((s) => {
    const it = el('span');
    const sw = el('span', 'sw'); sw.style.background = s.color;
    it.append(sw, s.name);
    return it;
  }));
}

// ---------- tooltip ----------
const tip = $('#tip');
function showTip(ev, head, lines) {
  tip.replaceChildren(el('div', 'h', head));
  for (const [c, n, v] of lines) {
    const r = el('div', 'r');
    if (c) { const s = el('span', 'sw'); s.style.background = c; r.append(s); }
    r.append(n ? `${n}: ${v}` : v);
    tip.append(r);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY - h - 10;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y < 8) y = ev.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------- charts ----------
const NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}
function niceStep(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Vertical bars. labels: tick text per bar ('' for none); tips: tooltip heading per bar. */
function bars(container, {labels, tips, series, stacked = true}) {
  container.replaceChildren();
  const W = Math.max(260, container.clientWidth);
  const H = container.classList.contains('short') ? 180 : 240;
  const svg = sv('svg', {viewBox: `0 0 ${W} ${H}`, height: H}, container);
  const n = labels.length;
  const totals = labels.map((_, i) => stacked
    ? series.reduce((s, se) => s + se.values[i], 0)
    : Math.max(...series.map((se) => se.values[i])));
  const max = Math.max(1, ...totals);
  const step = Math.max(1, niceStep(max / 4));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);

  const probe = sv('text', {class: 'tk'}, svg);
  const width = (s) => { probe.textContent = s; return probe.getComputedTextLength(); };
  const lw = Math.max(...ticks.map((t) => width(nf.format(t))));
  const xw = Math.max(0, ...labels.filter(Boolean).map(width));
  probe.remove();

  const m = {l: lw + 8, r: 4, t: 8, b: 20};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const y = (v) => m.t + ih - (v / top) * ih;
  for (const t of ticks) {
    sv('line', {class: 'grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t)}, svg);
    sv('text', {class: 'tk', x: m.l - 6, y: y(t), 'text-anchor': 'end', 'dominant-baseline': 'middle'}, svg).textContent = nf.format(t);
  }
  const band = iw / n;
  const bw = Math.max(1, Math.min(32, band * 0.72));
  const off = (band - bw) / 2;

  // Thin labels so they never collide; keep the last one.
  const labelled = labels.map((l, i) => l ? i : -1).filter((i) => i >= 0);
  const minGap = xw + 10;
  const shown = new Set();
  let lastX = Infinity;
  for (let k = labelled.length - 1; k >= 0; k--) {
    const cx = m.l + labelled[k] * band + band / 2;
    if (lastX - cx >= minGap) { shown.add(labelled[k]); lastX = cx; }
  }

  for (let i = 0; i < n; i++) {
    const x0 = m.l + i * band;
    if (stacked) {
      let acc = 0;
      for (const se of series) {
        const v = se.values[i];
        if (!v) continue;
        sv('rect', {x: x0 + off, width: bw, y: y(acc + v), height: y(acc) - y(acc + v), rx: series.length > 1 ? 1 : Math.min(3, bw / 2), fill: se.color}, svg);
        acc += v;
      }
    } else {
      const sw = bw / series.length;
      series.forEach((se, k) => {
        const v = se.values[i];
        if (v) sv('rect', {x: x0 + off + k * sw, width: Math.max(1, sw - 1), y: y(v), height: y(0) - y(v), rx: Math.min(2, sw / 2), fill: se.color}, svg);
      });
    }
    if (shown.has(i)) sv('text', {class: 'tk', x: x0 + band / 2, y: H - 4, 'text-anchor': 'middle'}, svg).textContent = labels[i];
    const hit = sv('rect', {class: 'hit', x: x0, width: band, y: m.t, height: ih}, svg);
    hit.addEventListener('pointermove', (ev) => showTip(ev, tips[i],
      series.map((se) => [series.length > 1 ? se.color : null, series.length > 1 ? se.name : null, nf.format(se.values[i])])));
    hit.addEventListener('pointerleave', hideTip);
  }
}

/** HTML horizontal bars. items: {label, value, color?, onClick?, active?} */
function hbars(container, items, {fmt = nf.format} = {}) {
  container.replaceChildren();
  const wrap = el('div', 'hb');
  const max = Math.max(1, ...items.map((d) => d.value));
  for (const d of items) {
    const lab = d.onClick ? el('button', 'l' + (d.active ? ' on' : ''), d.label) : el('span', 'l', d.label);
    lab.title = d.label;
    if (d.onClick) { lab.type = 'button'; lab.addEventListener('click', d.onClick); }
    const b = el('div', 'b');
    const bar = el('span', 'bar');
    bar.style.width = `calc((100% - 4.5em) * ${d.value / max})`;
    if (d.color) bar.style.background = d.color;
    b.append(bar, el('span', 'v', fmt(d.value)));
    wrap.append(lab, b);
  }
  container.append(wrap);
}

function heatmap(container, events) {
  const grid = Array.from({length: 7}, () => new Array(24).fill(0));
  for (const iso of events) { const l = local(iso); grid[l.wd][l.h]++; }
  const max = Math.max(1, ...grid.flat());
  const h = el('div', 'heat');
  h.append(el('span'));
  for (let i = 0; i < 24; i++) h.append(el('span', 'hl', i % 6 === 0 ? (i === 0 ? '12a' : i === 12 ? '12p' : i < 12 ? `${i}a` : `${i - 12}p`) : ''));
  grid.forEach((row, d) => {
    h.append(el('span', 'dl', WD[d]));
    row.forEach((v, hr) => {
      const c = el('span', 'c');
      if (v) c.style.background = `color-mix(in srgb, var(--s1) ${Math.round(10 + 90 * (v / max))}%, var(--heat0))`;
      const hl = (x) => `${x % 12 || 12}${x < 12 ? 'am' : 'pm'}`;
      c.addEventListener('pointermove', (ev) => showTip(ev, `${WD[d]} ${hl(hr)}–${hl((hr + 1) % 24)}`, [[null, null, `${nf.format(v)} actions`]]));
      c.addEventListener('pointerleave', hideTip);
      h.append(c);
    });
  });
  container.replaceChildren(h);
}

function tableRows(tbody, rows) {
  tbody.replaceChildren(...rows.map((cells) => {
    const tr = el('tr');
    for (const c of cells) { const td = el('td', c.cls, c.text ?? c); tr.append(td); }
    return tr;
  }));
}

function monthSeries(range, sets) {
  return sets.map((s) => {
    const c = countBy(s.items, (iso) => monthKey(iso));
    return {name: s.name, color: s.color, values: range.map((k) => c.get(k) || 0)};
  });
}

// ---------- views ----------
let D;
const views = {};

views.overview = (() => {
  let range = '2y';
  const sets = () => [
    {name: 'Reactions', color: color(1), items: D.reactions.map((r) => r[0])},
    {name: 'Comments', color: color(2), items: D.comments.map((c) => c.d)},
    {name: 'Reposts', color: color(3), items: D.reposts.map((r) => r[0])},
    {name: 'Posts', color: color(4), items: D.posts.map((p) => p.d)},
  ];
  function init() {
    const msgs = D.conversations.reduce((s, c) => s + c.msgs.length, 0);
    const people = D.follows_members.filter((f) => f[2] === 'Active').length;
    const tiles = [
      ['Reactions', D.reactions.length, since(D.reactions.map((r) => r[0]))],
      ['Comments', D.comments.length, since(D.comments.map((c) => c.d))],
      ['Posts', D.posts.length, since(D.posts.map((p) => p.d))],
      ['Reposts', D.reposts.length, since(D.reposts.map((r) => r[0]))],
      ['Searches', D.searches.length, D.searches.length ? 'last 13 months' : 'not in this export'],
      ['People followed', people, `${nf.format(D.follows_companies.length)} companies`],
      ['Connections', D.connections.length, since(D.connections.map((c) => c[0]).filter(Boolean))],
      ['Messages', msgs, `${nf.format(D.conversations.length)} conversations`],
      ['Ad clicks', D.ads_clicked.length, since(D.ads_clicked.map((a) => a[0]))],
    ];
    $('#ov-tiles').replaceChildren(...tiles.map(([l, v, s]) => {
      const t = el('div', 'tile');
      t.append(el('span', 'lbl', l), el('span', 'num', nf.format(v)), el('span', 'sub', s));
      return t;
    }));
    const all = sets().flatMap((s) => s.items);
    if (!all.length) {
      lede($('#ov-lede'), ['This export has no reactions, comments, posts or reposts. ', COMPLETE]);
      $('#ov-monthly').closest('.card').hidden = true;
      $('#ov-heat').closest('.grid2').hidden = true;
      return;
    }
    const byMonth = countBy(all, monthKey);
    const [bm, bn] = [...byMonth].reduce((a, b) => b[1] > a[1] ? b : a);
    lede($('#ov-lede'), ['You have reacted to ', [nf.format(D.reactions.length)], ' posts, written ', [nf.format(D.comments.length)],
      ' comments and ', [nf.format(D.posts.length)], ' posts. Your busiest month was ', [fMonth.format(monthDate(bm))],
      ', with ', [nf.format(bn)], ' actions.']);
    legend($('#ov-legend'), sets());
    $('#ov-range').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      range = b.dataset.range;
      $('#ov-range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      drawMonthly();
    });
    const names = {LIKE: 'Like', PRAISE: 'Celebrate', APPRECIATION: 'Support', EMPATHY: 'Love', INTEREST: 'Insightful', ENTERTAINMENT: 'Funny'};
    const rc = [...countBy(D.reactions, (r) => r[1])].sort((a, b) => b[1] - a[1]);
    hbars($('#ov-react'), rc.map(([k, v], i) => ({label: names[k] || k, value: v, color: color((i % 6) + 1)})));
  }
  function drawMonthly() {
    const s = sets();
    const keys = s.flatMap((x) => x.items).map(monthKey).sort();
    const last = monthKey(D.built);
    let first = keys[0] || last;
    if (range === '2y') { const d = monthDate(last); d.setUTCMonth(d.getUTCMonth() - 23); first = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }
    const r = monthRange(first, last);
    const long = r.length > 36;
    bars($('#ov-monthly'), {
      labels: r.map((k) => long ? (k.endsWith('-01') ? k.slice(0, 4) : '') : fMonthShort.format(monthDate(k))),
      tips: r.map((k) => fMonth.format(monthDate(k))),
      series: monthSeries(r, s),
    });
  }
  function draw() {
    if ($('#ov-monthly').closest('.card').hidden) return;
    drawMonthly();
    heatmap($('#ov-heat'), [...D.reactions.map((r) => r[0]), ...D.comments.map((c) => c.d), ...D.posts.map((p) => p.d),
      ...D.reposts.map((r) => r[0]), ...D.searches.map((s) => s[0])]);
  }
  return {init, draw};
})();

views.writing = (() => {
  let kind = 'all', items;
  const LIMIT = 200;
  function init() {
    items = [...D.posts.map((p) => ({...p, kind: 'post'})), ...D.comments.map((c) => ({...c, kind: 'comment'}))]
      .filter((x) => x.d).sort((a, b) => b.d.localeCompare(a.d));
    for (const it of items) it.lower = it.text.toLowerCase();
    lede($('#wr-lede'), [[nf.format(D.posts.length)], ' posts since ', [String(minYear(D.posts.map((p) => p.d)))], ' and ',
      [nf.format(D.comments.length)], ' comments since ', [String(minYear(D.comments.map((c) => c.d)))], '. Search the text, or open any item on LinkedIn.']);
    $('#wr-q').addEventListener('input', list);
    $('#wr-kind').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      kind = b.dataset.kind;
      $('#wr-kind').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      list();
    });
    list();
  }
  function list() {
    const q = $('#wr-q').value.trim().toLowerCase();
    const hits = items.filter((x) => (kind === 'all' || x.kind === kind) && (!q || x.lower.includes(q)));
    $('#wr-count').textContent = `${nf.format(hits.length)} ${hits.length === 1 ? 'item' : 'items'}${hits.length > LIMIT ? `, showing ${LIMIT}` : ''}`;
    $('#wr-list').replaceChildren(...hits.slice(0, LIMIT).map((x) => {
      const li = el('li', 'item');
      const meta = el('div', 'meta');
      meta.append(el('span', `pill ${x.kind}`, x.kind === 'post' ? 'Post' : 'Comment'), el('span', null, fDT.format(new Date(x.d))));
      const u = safeUrl(x.url);
      if (u) { const a = el('a', null, 'Open on LinkedIn'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; meta.append(a); }
      const shared = safeUrl(x.shared);
      if (shared) { const a = el('a', null, `Shared: ${new URL(shared).hostname}`); a.href = shared; a.target = '_blank'; a.rel = 'noopener noreferrer'; meta.append(a); }
      const t = el('div', 'text');
      highlight(t, x.text || '(no text)', q);
      li.append(meta, t);
      if (x.text.length > 420 && !q) {
        t.classList.add('clamp');
        const more = el('button', 'more', 'Show more'); more.type = 'button';
        more.addEventListener('click', () => { const c = t.classList.toggle('clamp'); more.textContent = c ? 'Show more' : 'Show less'; });
        li.append(more);
      }
      return li;
    }));
    draw(hits);
  }
  const empty = () => !D.posts.length && !D.comments.length && `No posts or comments in this export. ${COMPLETE}`;
  function draw(hits) {
    hits = hits || items.filter((x) => kind === 'all' || x.kind === kind);
    const yrs = items.map((x) => yearOf(x.d));
    const r = []; for (let y = Math.min(...yrs); y <= Math.max(...yrs); y++) r.push(y);
    const series = [{name: 'Posts', color: color(1), k: 'post'}, {name: 'Comments', color: color(2), k: 'comment'}].map((s) => {
      const c = countBy(hits.filter((x) => x.kind === s.k), (x) => yearOf(x.d));
      return {...s, values: r.map((y) => c.get(y) || 0)};
    });
    legend($('#wr-legend'), series);
    bars($('#wr-chart'), {labels: r.map(String), tips: r.map(String), series});
  }
  return {init, draw: () => list(), empty};
})();

views.searches = (() => {
  const LIMIT = 500;
  let rows, weeks, weekIdx;
  function weekKey(iso) {
    const l = local(iso);
    const d = new Date(Date.UTC(l.y, l.m - 1, l.d - l.wd));
    return d.toISOString().slice(0, 10);
  }
  function init() {
    rows = D.searches.map(([d, q]) => ({d, q, lower: q.toLowerCase(), w: weekKey(d)})).reverse();
    const first = new Date(`${rows.at(-1).w}T00:00:00Z`), last = new Date(`${rows[0].w}T00:00:00Z`);
    weeks = [];
    for (const d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 7)) weeks.push(d.toISOString().slice(0, 10));
    weekIdx = new Map(weeks.map((w, i) => [w, i]));
    const top = [...countBy(rows, (r) => r.lower)].sort((a, b) => b[1] - a[1]);
    lede($('#se-lede'), [[nf.format(rows.length)], ' searches from ', [fDate.format(new Date(rows.at(-1).d))], ' to ',
      [fDate.format(new Date(rows[0].d))], `. LinkedIn logged ${nf.format(D.searches_raw)} entries; repeats of the same query within 10 seconds are counted once. Your top search was `,
      [`“${top[0][0]}”`], ', run ', [nf.format(top[0][1])], ' times.']);
    $('#se-q').addEventListener('input', update);
    update();
  }
  function update() {
    const q = $('#se-q').value.trim().toLowerCase();
    const hits = q ? rows.filter((r) => r.lower.includes(q)) : rows;
    $('#se-count').textContent = `${nf.format(hits.length)} ${hits.length === 1 ? 'search' : 'searches'}${hits.length > LIMIT ? `, newest ${LIMIT} shown` : ''}`;
    tableRows($('#se-log tbody'), hits.slice(0, LIMIT).map((r) => [fDT.format(new Date(r.d)), r.q]));
    const top = [...countBy(rows, (r) => r.lower)].sort((a, b) => b[1] - a[1]).slice(0, 25);
    hbars($('#se-top'), top.map(([k, v]) => ({label: k, value: v, active: k === q,
      onClick: () => { $('#se-q').value = k === q ? '' : k; update(); }})));
    $('#se-chart-note').textContent = q ? `Weeks starting Monday. Searches matching “${q}” are highlighted.` : 'Weeks starting Monday. Click a query below to see when you ran it.';
    drawChart(q);
  }
  function drawChart(q) {
    q = q ?? $('#se-q').value.trim().toLowerCase();
    const match = new Array(weeks.length).fill(0), other = new Array(weeks.length).fill(0);
    for (const r of rows) (q && r.lower.includes(q) ? match : other)[weekIdx.get(r.w)]++;
    const lab = (w) => new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric'}).format(new Date(`${w}T00:00:00Z`));
    bars($('#se-chart'), {
      labels: weeks.map((w, i) => (i % 4 === 0 ? lab(w) : '')),
      tips: weeks.map((w) => `Week of ${fDate.format(new Date(`${w}T12:00:00Z`))}`),
      series: q ? [{name: 'Matching', color: color(3), values: match}, {name: 'Other', color: color(6), values: other}]
        : [{name: 'Searches', color: color(1), values: other}],
    });
  }
  return {init, draw: () => drawChart(), empty: () => !D.searches.length && `No search history in this export. ${COMPLETE}`};
})();

views.following = (() => {
  function init() {
    const active = D.follows_members.filter((f) => f[2] === 'Active').length;
    lede($('#fo-lede'), ['You follow ', [nf.format(active)], ' people, ', [nf.format(D.follows_companies.length)], ' companies and ',
      [nf.format(D.follows_hashtags.length)], ' hashtags.']);
    $('#fo-q').addEventListener('input', lists);
    lists();
  }
  function fill(ul, countEl, rows, q) {
    const hits = rows.filter((r) => !q || r.name.toLowerCase().includes(q)).sort((a, b) => (b.d || '').localeCompare(a.d || ''));
    countEl.textContent = nf.format(hits.length);
    ul.replaceChildren(...hits.map((r) => {
      const li = el('li', r.off ? 'off' : null);
      li.append(el('span', null, r.name), el('span', null, r.d ? fDate.format(new Date(r.d)) : ''));
      if (r.off) li.title = r.off;
      return li;
    }));
  }
  function lists() {
    const q = $('#fo-q').value.trim().toLowerCase();
    fill($('#fo-members'), $('#fo-n-m'), D.follows_members.map(([d, name, st]) => ({d, name, off: st !== 'Active' ? st : null})), q);
    fill($('#fo-companies'), $('#fo-n-c'), D.follows_companies.map(([d, name]) => ({d, name})), q);
    fill($('#fo-hashtags'), $('#fo-n-h'), D.follows_hashtags.map(([d, name]) => ({d, name: `#${name}`})), q);
  }
  function draw() {
    const sets = [
      {name: 'People', color: color(1), items: D.follows_members.map((f) => f[0])},
      {name: 'Companies', color: color(2), items: D.follows_companies.map((f) => f[0])},
      {name: 'Hashtags', color: color(3), items: D.follows_hashtags.map((f) => f[0])},
    ];
    const yrs = sets.flatMap((s) => s.items).filter(Boolean).map(yearOf);
    const r = []; for (let y = Math.min(...yrs); y <= Math.max(...yrs); y++) r.push(y);
    const series = sets.map((s) => { const c = countBy(s.items.filter(Boolean), yearOf); return {...s, values: r.map((y) => c.get(y) || 0)}; });
    legend($('#fo-legend'), series);
    bars($('#fo-chart'), {labels: r.map(String), tips: r.map(String), series});
  }
  const empty = () => !D.follows_members.length && !D.follows_companies.length && !D.follows_hashtags.length && 'No follows in this export.';
  return {init, draw, empty};
})();

views.connections = (() => {
  const LIMIT = 500;
  // Words that say nothing about the job on their own.
  const STOP = new Set('a an and at for in of on the to with & - – — | / @ , + i ii iii'.split(' '));
  let rows;
  // "Connected On" is a calendar date (stored as midnight UTC), so read it in UTC, not Eastern.
  const year = (iso) => +iso.slice(0, 4);
  const words = (title) => [...new Set(title.toLowerCase().split(/[\s,/|&()·:;–—-]+/).filter((w) => w.length > 1 && !STOP.has(w)))];
  function init() {
    rows = D.connections.map(([d, name, company, title, url]) => ({d, name, company, title, url,
      lower: `${name}\n${company}\n${title}`.toLowerCase()}))
      .sort((a, b) => (b.d || '').localeCompare(a.d || ''));
    const dated = rows.filter((r) => r.d);
    const companies = [...countBy(rows.filter((r) => r.company), (r) => r.company)].sort((a, b) => b[1] - a[1]);
    const parts = rows.length
      ? [['You have ', [nf.format(rows.length)], ' connections']]
      : [['This export has no connections list']];
    if (dated.length) parts.push([', the first made in ', [String(year(dated.at(-1).d))]]);
    if (companies.length) parts.push(['. They work at ', [nf.format(companies.length)], ' different companies; the most at ',
      [companies[0][0]], ' (', [nf.format(companies[0][1])], ')']);
    lede($('#cn-lede'), [...parts.flat(), '.']);
    $('#cn-q').addEventListener('input', update);
    invitations();
    update();
  }
  function setQ(v) { const q = $('#cn-q').value.trim().toLowerCase(); $('#cn-q').value = v === q ? '' : v; update(); }
  function update() {
    const q = $('#cn-q').value.trim().toLowerCase();
    const hits = q ? rows.filter((r) => r.lower.includes(q)) : rows;
    $('#cn-count').textContent = `${nf.format(hits.length)} ${hits.length === 1 ? 'person' : 'people'}${hits.length > LIMIT ? `, newest ${LIMIT} shown` : ''}`;
    $('#cn-list tbody').replaceChildren(...hits.slice(0, LIMIT).map((r) => {
      const tr = el('tr');
      tr.append(el('td', null, r.d ? fDayUTC.format(new Date(r.d)) : ''));
      const name = el('td');
      const u = safeUrl(r.url);
      const target = u ? el('a') : name;
      if (u) { target.href = u; target.target = '_blank'; target.rel = 'noopener noreferrer'; name.append(target); }
      highlight(target, r.name || '(no name)', q);
      const co = el('td'); highlight(co, r.company, q);
      const ti = el('td'); highlight(ti, r.title, q);
      tr.append(name, co, ti);
      return tr;
    }));
    const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15);
    hbars($('#cn-companies'), top(countBy(rows.filter((r) => r.company), (r) => r.company))
      .map(([k, v]) => ({label: k, value: v, color: color(2), active: k.toLowerCase() === q, onClick: () => setQ(k.toLowerCase())})));
    const w = new Map();
    for (const r of rows) for (const x of words(r.title)) w.set(x, (w.get(x) || 0) + 1);
    hbars($('#cn-titles'), top(w).map(([k, v]) => ({label: k, value: v, color: color(4), active: k === q, onClick: () => setQ(k)})));
    drawChart(q);
  }
  function drawChart(q) {
    q = q ?? $('#cn-q').value.trim().toLowerCase();
    const dated = rows.filter((r) => r.d);
    const note = $('#cn-chart-note');
    if (!dated.length) { $('#cn-chart').closest('.card').hidden = true; return; }
    const ys = dated.map((r) => year(r.d));
    const r = []; for (let y = Math.min(...ys); y <= Math.max(...ys, year(D.built)); y++) r.push(y);
    const match = countBy(dated.filter((x) => q && x.lower.includes(q)), (x) => year(x.d));
    const other = countBy(dated.filter((x) => !(q && x.lower.includes(q))), (x) => year(x.d));
    const series = q
      ? [{name: 'Matching', color: color(3), values: r.map((y) => match.get(y) || 0)}, {name: 'Other', color: color(6), values: r.map((y) => other.get(y) || 0)}]
      : [{name: 'Connections', color: color(1), values: r.map((y) => other.get(y) || 0)}];
    note.textContent = q ? `Connections matching “${q}” are highlighted.` : 'When each connection was made. Filter the list below to see when you met a group.';
    legend($('#cn-legend'), q ? series : []);
    bars($('#cn-chart'), {labels: r.map(String), tips: r.map(String), series});
  }
  function invitations() {
    const inv = [...D.invitations].sort((a, b) => (b[0] || '').localeCompare(a[0] || ''));
    if (!inv.length) { $('#cn-inv-card').hidden = true; return; }
    const got = inv.filter((x) => x[1] === 'in').length;
    $('#cn-n-inv').textContent = `${nf.format(inv.length)} in export`;
    $('#cn-inv-note').textContent = `${nf.format(got)} received and ${nf.format(inv.length - got)} sent.`;
    $('#cn-inv tbody').replaceChildren(...inv.map(([d, dir, who, msg, url]) => {
      const tr = el('tr');
      tr.append(el('td', null, d ? fDT.format(new Date(d)) : ''), el('td', null, dir === 'in' ? 'Received' : 'Sent'));
      const td = el('td');
      const u = safeUrl(url);
      if (u) { const a = el('a', null, who || '(unknown)'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; td.append(a); } else td.textContent = who;
      tr.append(td, el('td', null, msg));
      return tr;
    }));
  }
  const empty = () => !D.connections.length && !D.invitations.length && 'No connections or invitations in this export.';
  return {init, draw: () => drawChart(), empty};
})();

views.messages = (() => {
  const LIMIT = 150;
  let shown = LIMIT, current = null, me;
  const label = (c) => c.people.join(', ') || c.title || '(no participants)';
  function init() {
    me = D.profile.name;
    for (const c of D.conversations) c.hay = [c.title, ...c.people, ...c.msgs.map((m) => `${m[2]} ${m[3]}`)].join('\n').toLowerCase();
    const total = D.conversations.reduce((s, c) => s + c.msgs.length, 0);
    const replied = D.conversations.filter((c) => c.msgs.some((m) => m[1] === me)).length;
    const firstYear = Math.min(...D.conversations.map((c) => yearOf(c.msgs[0][0])));
    lede($('#ms-lede'), [[nf.format(total)], ' messages in ', [nf.format(D.conversations.length)], ' conversations since ',
      [String(firstYear)], '. You wrote in ', [pct.format(replied / D.conversations.length)], ' of them.']);
    $('#ms-q').addEventListener('input', () => { shown = LIMIT; list(); if (current) open(current); });
    list();
  }
  function list() {
    const q = $('#ms-q').value.trim().toLowerCase();
    const hits = q ? D.conversations.filter((c) => c.hay.includes(q)) : D.conversations;
    $('#ms-count').textContent = `${nf.format(hits.length)} conversations`;
    const items = hits.slice(0, shown).map((c) => {
      const li = el('li');
      const b = el('button', c === current ? 'on' : null); b.type = 'button';
      const last = c.msgs.at(-1);
      b.append(el('span', 'who', label(c)), el('span', 'sub', `${fDate.format(new Date(last[0]))} · ${c.msgs.length} msg · ${(last[3] || last[2] || '').replace(/\s+/g, ' ').slice(0, 90)}`));
      b.addEventListener('click', () => { current = c; open(c); $('#ms-list').querySelectorAll('button.on').forEach((x) => x.classList.remove('on')); b.classList.add('on'); });
      li.append(b);
      return li;
    });
    if (hits.length > shown) {
      const li = el('li'); const b = el('button', 'more-btn', `Show ${nf.format(Math.min(LIMIT, hits.length - shown))} more`); b.type = 'button';
      b.addEventListener('click', () => { shown += LIMIT; list(); });
      li.append(b); items.push(li);
    }
    $('#ms-list').replaceChildren(...items);
  }
  function open(c) {
    const q = $('#ms-q').value.trim().toLowerCase();
    const t = $('#ms-thread');
    t.replaceChildren(el('h2', null, c.title && c.title !== label(c) ? `${c.title}` : label(c)));
    if (c.title && c.title !== label(c)) t.append(el('p', 'note', label(c)));
    for (const [d, from, subj, body] of c.msgs) {
      const m = el('div', 'msg' + (from === me ? ' me' : ''));
      m.append(el('div', 'mh', `${from || 'Unknown'} · ${d ? fDT.format(new Date(d)) : ''}${subj ? ` · ${subj}` : ''}`));
      const mb = el('div', 'mb');
      highlight(mb, body || '(empty)', q);
      m.append(mb);
      t.append(m);
    }
    t.scrollTop = 0;
  }
  return {init, draw() {}, empty: () => !D.conversations.length && 'No messages in this export.'};
})();

views.ads = (() => {
  function init() {
    $('#ad-infer').replaceChildren(...D.inferences.map((x) => {
      const c = el('div', 'inf');
      const v = String(x.value).toLowerCase();
      const yes = v === 'true' || v === 'yes', no = v === 'false' || v === 'no';
      c.append(el('span', 'cat', x.category), el('span', 'ty', x.type),
        el('span', 'val' + (no ? ' no' : ''), yes ? 'Yes' : no ? 'No' : x.value), el('span', 'ds', x.description));
      return c;
    }));
    $('#ad-target').replaceChildren(...Object.entries(D.ad_targeting).map(([k, vals]) => {
      const d = el('details', 'tg');
      const s = el('summary');
      s.append(el('span', null, k), el('span', null, `${nf.format(vals.length)} ${vals.length === 1 ? 'value' : 'values'}`));
      const chips = el('div', 'chips');
      chips.append(...vals.map((v) => el('span', 'chip', v)));
      d.append(s, chips);
      return d;
    }));
    const distinct = new Set(D.ads_clicked.map((a) => a[1])).size;
    $('#ad-click-note').textContent = !D.ads_clicked.length ? `No ad clicks in this export. ${COMPLETE}` : `${nf.format(D.ads_clicked.length)} clicks on ${nf.format(distinct)} different ads. The export lists ad IDs only, not ad titles.`;
    const off = D.ads_offsite;
    const imp = off.filter((a) => a[1] === 'Impression').length;
    const dates = off.map((a) => a[0]).filter(Boolean).sort();
    $('#ad-off-note').textContent = !dates.length ? `No Audience Network activity in this export. ${COMPLETE}` : `LinkedIn Audience Network: ${nf.format(imp)} impressions and ${nf.format(off.length - imp)} clicks on partner sites and apps, ${fDayUTC.format(new Date(dates[0]))} to ${fDayUTC.format(new Date(dates.at(-1)))}. Top 12 shown.`;
    const sites = [...countBy(off, (a) => a[2])].sort((a, b) => b[1] - a[1]).slice(0, 12);
    hbars($('#ad-off'), sites.map(([k, v]) => ({label: k, value: v, color: color(3)})));
    const logins = [...D.logins].sort((a, b) => b[0].localeCompare(a[0]));
    $('#ad-n-login').textContent = `${nf.format(logins.length)} in export`;
    tableRows($('#ad-logins tbody'), logins.map(([d, ip, dev]) => [fDT.format(new Date(d)), dev, {text: ip, cls: 'mono'}]));
    const ch = [...D.challenges].sort((a, b) => b[0].localeCompare(a[0]));
    const kinds = {CAPTCHA_CHALLENGE: 'CAPTCHA', EMAIL_PIN_CHALLENGE: 'Email PIN'};
    $('#ad-n-chal').textContent = `${nf.format(ch.length)} in export`;
    tableRows($('#ad-chal tbody'), ch.map(([d, ip, country, type, dev]) => [fDT.format(new Date(d)), kinds[type] || type, dev, {text: `${ip} (${country})`, cls: 'mono'}]));
  }
  function draw() {
    const keys = D.ads_clicked.map((a) => monthKey(a[0])).sort();
    if (!keys.length) { $('#ad-clicks').replaceChildren(); return; }
    const r = monthRange(keys[0], keys.at(-1));
    bars($('#ad-clicks'), {
      labels: r.map((k) => fMonthShort.format(monthDate(k))),
      tips: r.map((k) => fMonth.format(monthDate(k))),
      series: monthSeries(r, [{name: 'Clicks', color: color(5), items: D.ads_clicked.map((a) => a[0])}]),
    });
  }
  return {init, draw};
})();

// ---------- routing ----------
let currentView = null;
const inited = new Set();
function route() {
  const name = views[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  currentView = name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
  hideTip();
  if (!inited.has(name)) { views[name].init(); inited.add(name); }
  views[name].draw();
}

let rz;
let lastW = innerWidth;
addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { if (innerWidth !== lastW && currentView) { lastW = innerWidth; views[currentView].draw(); } }, 150);
});

function start(data) {
  D = data;
  // A data.json built before connections were parsed has no such keys.
  D.connections ??= [];
  D.invitations ??= [];
  $('#loading').remove();
  $('#picker').hidden = true;
  $('#open-other').hidden = false;
  $('#who').textContent = D.profile.name || '';
  $('#built').textContent = `Built ${fDate.format(new Date(D.built))}`;
  for (const [name, v] of Object.entries(views)) {
    const msg = v.empty && v.empty();
    if (!msg) continue;
    const sec = $(`#view-${name}`);
    sec.replaceChildren(sec.querySelector('.view-head'), el('div', 'card empty', msg));
    views[name] = {init() {}, draw() {}};
  }
  addEventListener('hashchange', route);
  route();
}

// ---------- reading an export zip with WebAssembly (see ../wasm) ----------
async function buildFromZips(files) {
  const {instance} = await WebAssembly.instantiate(await (await fetch('linkedin_export.wasm')).arrayBuffer());
  const w = instance.exports;
  const out = () => new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.out_ptr(), w.out_len()));
  w.reset();
  // Oldest first, so a newer export's files replace an older one's.
  for (const f of [...files].sort((a, b) => a.lastModified - b.lastModified)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const ptr = w.alloc(bytes.length);
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    if (w.add_zip(ptr, bytes.length) < 0) throw new Error(`${f.name}: ${out()}`);
  }
  w.build(Date.now() / 1000);
  return JSON.parse(out());
}

function showPicker() {
  $('#loading').hidden = true;
  $('#picker').hidden = false;
  const drop = $('#drop'), status = $('#pick-status');
  const take = async (files) => {
    files = [...files].filter((f) => /\.zip$/i.test(f.name));
    if (!files.length) return;
    drop.classList.remove('err');
    status.textContent = `Reading ${files.map((f) => f.name).join(', ')}…`;
    try {
      start(await buildFromZips(files));
    } catch (e) {
      drop.classList.add('err');
      status.textContent = `Could not read that export (${e.message}).`;
    }
  };
  $('#zip-in').addEventListener('change', (ev) => take(ev.target.files));
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); take(ev.dataTransfer.files); });
}

if (new URLSearchParams(location.search).has('zip')) showPicker();
else {
  fetch('data.json')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(start, showPicker);
}
