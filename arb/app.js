/* Arbiter UI: fetches odds from The Odds API in the browser, runs the engine, renders results. */
(function () {
  "use strict";
  const E = window.ArbEngine;
  const API = "https://api.the-odds-api.com/v4";
  const LS_SET = "arbiter.settings.v1", LS_DATA = "arbiter.data.v1", LS_SPORTS = "arbiter.sports.v1";

  const FOOTBALL = [
    ["soccer_epl", "Premier League"], ["soccer_efl_champ", "Championship"], ["soccer_england_league1", "League One"],
    ["soccer_england_league2", "League Two"], ["soccer_fa_cup", "FA Cup"], ["soccer_england_efl_cup", "EFL Cup"],
    ["soccer_spl", "Scottish Premiership"], ["soccer_uefa_champs_league", "Champions League"],
    ["soccer_uefa_europa_league", "Europa League"], ["soccer_uefa_europa_conference_league", "Conference League"],
    ["soccer_spain_la_liga", "La Liga"], ["soccer_italy_serie_a", "Serie A"], ["soccer_germany_bundesliga", "Bundesliga"],
    ["soccer_france_ligue_one", "Ligue 1"], ["soccer_netherlands_eredivisie", "Eredivisie"],
    ["soccer_portugal_primeira_liga", "Primeira Liga"], ["soccer_spain_segunda_division", "La Liga 2"],
    ["soccer_germany_bundesliga2", "Bundesliga 2"], ["soccer_italy_serie_b", "Serie B"], ["soccer_france_ligue_two", "Ligue 2"],
    ["soccer_belgium_first_div", "Belgian Pro League"], ["soccer_turkey_super_league", "Süper Lig"],
    ["soccer_usa_mls", "MLS"], ["soccer_brazil_campeonato", "Brasileirão"]
  ];
  const REGIONS = [["uk", "UK"], ["eu", "Europe"], ["us", "US"], ["us2", "US extra"], ["au", "Australia"]];
  const MARKETS = [["h2h", "Match result"], ["totals", "Total goals"], ["spreads", "Handicap"]];
  const DEFAULTS = {
    apiKey: "", demo: false, regions: ["uk"], markets: ["h2h", "totals"],
    sports: ["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga", "soccer_france_ligue_one"],
    excluded: [], comm: Object.assign({}, E.DEFAULT_COMMISSION), bankroll: 100, step: 1, cur: "£", minProfit: 0,
    maxAge: 15, windowDays: 7, strict: true, backLay: true, live: false, suspect: 10, auto: 0, notify: false, sound: false
  };

  const readLS = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  const S = Object.assign({}, DEFAULTS, readLS(LS_SET, {}));
  S.comm = Object.assign({}, DEFAULTS.comm, S.comm);
  const cached = readLS(LS_DATA, null);
  const state = {
    events: cached && Array.isArray(cached.events) ? cached.events : [], fetchedAt: cached ? cached.fetchedAt || 0 : 0,
    isDemo: !!(cached && cached.isDemo), quota: (cached && cached.quota) || { remaining: null, used: null, approx: false },
    result: { opps: [], stats: { events: 0, books: {}, stale: 0, malformed: 0, skippedLive: 0 } },
    scanning: false, error: null, warnings: [], tab: "arbs", open: null, calc: {}, seen: null, limit: 40,
    sports: readLS(LS_SPORTS, null), nextAuto: 0, fMarket: "", fSort: "profit", fSearch: "", noLinks: false
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = x => (x < 0 ? "−" : "") + S.cur + Math.abs(x).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const odds = x => (+x).toFixed(x >= 10 ? 1 : 2);
  const pct = (x, d) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d == null ? 2 : d) + "%";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const save = () => writeLS(LS_SET, S);
  const dtf = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function rel(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 1) return "moments";
    if (m < 60) return m + " min";
    if (m < 2880) return Math.floor(m / 60) + "h " + (m % 60 ? (m % 60) + "m" : "");
    return Math.round(m / 1440) + " days";
  }
  const ago = t => (Date.now() - t < 45000 ? "just now" : rel(Date.now() - t).trim() + " ago");

  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
  }

  /* ---------- data ---------- */
  function ApiError(message, fatal) { this.message = message; this.fatal = !!fatal; }

  function readQuota(h) {
    const rem = h.get("x-requests-remaining"), used = h.get("x-requests-used");
    if (rem != null && rem !== "" && isFinite(+rem)) { state.quota = { remaining: +rem, used: isFinite(+used) ? +used : null, approx: false }; return true; }
    return false;
  }

  async function apiGet(path, params) {
    const url = new URL(API + path);
    Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
    let last = "Network error";
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      try {
        const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        const gotQuota = readQuota(res.headers);
        if (res.ok) { const data = await res.json(); clearTimeout(timer); return { data, gotQuota }; }
        let body = {}; try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
        clearTimeout(timer);
        const msg = String(body.message || res.statusText || "HTTP " + res.status), code = String(body.error_code || "");
        if (/OUT_OF_USAGE|quota/i.test(code + " " + msg)) throw new ApiError("You are out of API credits for this month. They reset monthly, or you can upgrade your plan at the-odds-api.com.", true);
        if (res.status === 401 || res.status === 403) throw new ApiError("The API key was rejected. Check it in Settings.", true);
        if (res.status === 429 || res.status >= 500) last = res.status === 429 ? "Rate limited by the odds provider" : "Odds provider error (" + res.status + ")";
        else throw new ApiError(msg, false);
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ApiError) throw e;
        if (e && e.name === "AbortError") last = "Request timed out";
        else if (e instanceof TypeError) last = navigator.onLine === false ? "You are offline" : "Could not reach the odds provider";
      }
      if (attempt < 2) await sleep(900 * (attempt + 1) * (attempt + 1));
    }
    throw new ApiError(last, false);
  }

  const scanCost = () => S.sports.length * S.markets.length * S.regions.length;
  const sportTitle = key => {
    const f = FOOTBALL.find(x => x[0] === key); if (f) return f[1];
    const s = (state.sports || []).find(x => x.key === key); return s ? s.title : key;
  };

  async function fetchOdds(key) {
    const p = { apiKey: S.apiKey, regions: S.regions.join(","), markets: S.markets.join(","), oddsFormat: "decimal", dateFormat: "iso" };
    if (!state.noLinks) p.includeLinks = "true";
    try { return await apiGet("/sports/" + encodeURIComponent(key) + "/odds", p); }
    catch (e) {
      // If the plan rejects bookmaker deep links, carry on without them.
      if (!e.fatal && p.includeLinks && /link/i.test(e.message)) { state.noLinks = true; delete p.includeLinks; return apiGet("/sports/" + encodeURIComponent(key) + "/odds", p); }
      throw e;
    }
  }

  async function scan(auto) {
    if (state.scanning) return;
    if (S.demo || (!S.apiKey && state.isDemo)) return finishScan(window.ArbDemo(), true, [], auto);
    if (!S.apiKey) { openSheet(); toast("Add your odds API key to scan live prices"); return; }
    if (!S.sports.length || !S.markets.length || !S.regions.length) { openSheet(); toast("Pick at least one league, market and region"); return; }
    state.scanning = true; state.error = null; paintScan(0);
    const queue = S.sports.slice(), events = [], warnings = [];
    let fatal = null, done = 0, ok = 0;
    const perCall = S.markets.length * S.regions.length;
    const worker = async () => {
      while (queue.length && !fatal) {
        const key = queue.shift();
        try {
          const r = await fetchOdds(key);
          if (Array.isArray(r.data)) {
            events.push.apply(events, r.data); ok++;
            if (!r.gotQuota && r.data.length && state.quota.remaining != null) state.quota = { remaining: Math.max(0, state.quota.remaining - perCall), used: null, approx: true };
          } else warnings.push(sportTitle(key) + ": unexpected response");
        } catch (e) {
          if (e.fatal) fatal = e; else warnings.push(sportTitle(key) + ": " + e.message);
        }
        paintScan(++done / S.sports.length);
      }
    };
    await Promise.all([worker(), worker()]);
    state.scanning = false;
    if (fatal || !ok) {
      state.error = fatal ? fatal.message : "Scan failed. " + (warnings[0] || "");
      state.warnings = fatal ? [] : warnings.slice(1);
      if (fatal && S.auto) { S.auto = 0; save(); state.error += " Auto-refresh has been switched off."; }
      scheduleAuto(); compute(); render();
      return;
    }
    const byId = new Map(); events.forEach(ev => ev && ev.id && byId.set(ev.id, ev));
    finishScan(Array.from(byId.values()), false, warnings, auto);
  }

  function finishScan(events, isDemo, warnings, auto) {
    state.scanning = false; state.events = events; state.isDemo = isDemo; state.fetchedAt = Date.now();
    state.warnings = warnings; state.error = null; state.limit = 40;
    if (!writeLS(LS_DATA, { events, fetchedAt: state.fetchedAt, isDemo, quota: state.quota })) writeLS(LS_DATA, { events: [], fetchedAt: 0, quota: state.quota });
    compute();
    const arbs = visibleArbs(), fresh = state.seen ? arbs.filter(o => !state.seen.has(o.id)) : arbs;
    state.seen = new Set(arbs.map(o => o.id));
    scheduleAuto(); render();
    if (fresh.length) {
      const best = fresh[0], line = best.home + " v " + best.away + " " + pct(best.profitPct);
      toast(fresh.length + " new sure bet" + (fresh.length === 1 ? "" : "s") + " · best " + pct(best.profitPct));
      if (auto && S.sound) beep();
      if (auto && S.notify && "Notification" in window && Notification.permission === "granted" && document.hidden) {
        try { new Notification("Arbiter: " + fresh.length + " new sure bet" + (fresh.length > 1 ? "s" : ""), { body: line, icon: "icon-192.png", tag: "arbiter" }); } catch (e) { /* unsupported */ }
      }
    } else if (!auto) toast(arbs.length ? arbs.length + " sure bets live" : "Scan complete: no sure bets right now");
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.14);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.14 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.14 + 0.22);
        o.start(ctx.currentTime + i * 0.14); o.stop(ctx.currentTime + i * 0.14 + 0.25);
      });
      setTimeout(() => ctx.close(), 900);
    } catch (e) { /* audio blocked */ }
  }

  function compute() {
    state.result = E.findOpportunities(state.events, {
      now: Date.now(), maxAgeMin: S.maxAge, strictLines: S.strict, includeLive: S.live, backLay: S.backLay,
      suspectPct: S.suspect, windowDays: S.windowDays, excluded: S.excluded, commission: S.comm
    });
  }
  const visibleArbs = () => state.result.opps.filter(o => o.isArb && o.profitPct >= S.minProfit);

  function scheduleAuto() { state.nextAuto = S.auto > 0 ? Date.now() + S.auto * 60000 : 0; }

  /* ---------- rendering ---------- */
  function paintScan(frac) {
    const p = $("progress");
    p.hidden = !state.scanning; p.firstElementChild.style.width = Math.max(6, frac * 100) + "%";
    $("btnScan").classList.toggle("busy", state.scanning);
    $("scanLabel").textContent = state.scanning ? "Scanning…" : "Scan odds";
  }

  const marketTitle = o => {
    const soccer = String(o.sportKey).startsWith("soccer");
    if (o.market === "totals") return (soccer ? "Total goals " : "Total ") + o.line;
    if (o.market === "h2h") return soccer ? "Match result · 90 min" : "Match winner";
    return o.marketName;
  };
  const legName = (o, l) => (o.market === "h2h" || o.market === "backlay" ? l.outcome : l.label);
  const ageClass = m => (m < 3 ? "ok" : m < 8 ? "mid" : "old");
  const totalFor = o => (state.calc[o.id] && state.calc[o.id].total) || S.bankroll;
  const planFor = o => E.calcStakes(o, totalFor(o), S.step, state.calc[o.id] && state.calc[o.id].prices);

  function summaryHtml(o, plan) {
    const good = plan.minProfit > 0;
    const range = plan.maxProfit - plan.minProfit >= 0.1 ? " to " + money(plan.maxProfit) : "";
    return '<div><span>Outlay</span><b>' + money(plan.outlay) + '</b></div>' +
      '<div><span>' + (good ? "Guaranteed profit" : "Worst case") + '</span><b class="' + (good ? "pos" : "neg") + '">' + money(plan.minProfit) + range + '</b></div>' +
      '<div><span>ROI</span><b class="' + (good ? "pos" : "neg") + '">' + pct(plan.roiPct) + '</b></div>';
  }
  const stakeHtml = (l, p) => (l.side === "lay"
    ? '<b>' + money(p.stake) + '</b><small>liability ' + money(p.liability) + '</small>'
    : '<b>' + money(p.stake) + '</b><small>returns ' + money(p.ret) + '</small>');

  function cardHtml(o) {
    const plan = planFor(o), open = state.open === o.id, c = state.calc[o.id] || {};
    const mins = (o.commence - Date.now()) / 60000;
    const when = mins <= 0 ? "In play" : dtf.format(o.commence) + " · in " + rel(mins * 60000).trim();
    const legs = o.legs.map((l, i) =>
      '<div class="leg">' +
        '<div class="leg-out"><i class="tag ' + l.side + '">' + (l.side === "lay" ? "LAY" : "BACK") + '</i><span>' + esc(legName(o, l)) + '</span></div>' +
        '<div class="leg-book"><span>' + esc(l.title) + '</span><small class="age ' + ageClass(l.ageMin) + '" title="Price last updated">' + (l.ageMin < 1 ? "live" : Math.round(l.ageMin) + "m old") + (l.comm ? " · " + +(l.comm * 100).toFixed(1) + "% comm" : "") + '</small></div>' +
        '<div class="leg-odds">' + odds(c.prices && E.validPrice(+c.prices[i]) ? +c.prices[i] : l.price) + '</div>' +
        '<div class="leg-stake" data-stake="' + i + '">' + stakeHtml(l, plan.legs[i]) + '</div>' +
      '</div>').join("");
    const flags = o.flags.map(f => '<li class="flag ' + esc(f.id) + '">' + esc(f.text) + '</li>').join("");
    let detail = "";
    if (open) {
      const inputs = o.legs.map((l, i) =>
        '<label class="field"><span>' + (l.side === "lay" ? "Lay " : "") + esc(legName(o, l)) + ' @ ' + esc(l.title) + '</span><input type="number" inputmode="decimal" step="0.01" min="1.01" data-price="' + i + '" value="' + esc(c.prices && c.prices[i] != null ? c.prices[i] : l.price) + '"></label>').join("");
      const alts = o.legs.filter(l => l.alts && l.alts.length).map(l =>
        '<div><span>' + esc(legName(o, l)) + '</span>' + l.alts.map(a => '<em>' + esc(a.title) + ' <b>' + odds(a.price) + '</b></em>').join("") + '</div>').join("");
      const links = o.legs.map(l => (l.link ? '<a class="btn small" href="' + esc(l.link) + '" target="_blank" rel="noopener noreferrer">Open ' + esc(l.title) + ' ↗</a>' : "")).join("");
      detail =
        '<div class="detail">' +
          '<p class="hint">Check each price at the bookmaker, type in what you actually see, and the stakes update. Only bet if the profit is still positive.</p>' +
          '<div class="calc"><label class="field money"><span>Total stake</span><div><em>' + esc(S.cur) + '</em><input type="number" inputmode="decimal" min="1" step="1" data-total value="' + esc(totalFor(o)) + '"></div></label>' + inputs + '</div>' +
          (alts ? '<div class="alts"><h4>Next best prices</h4>' + alts + '</div>' : "") +
          '<div class="actions">' + links + '<button class="btn small" data-copy>Copy stake plan</button></div>' +
        '</div>';
    }
    return '<article class="card ' + (o.isArb ? "arb" : "miss") + (open ? " open" : "") + (o.flags.some(f => f.id === "suspicious") ? " sus" : "") + '" data-id="' + esc(o.id) + '">' +
      '<button class="card-head" data-toggle aria-expanded="' + open + '">' +
        '<div class="meta"><span class="league">' + esc(o.league) + '</span><span>' + esc(when) + '</span></div>' +
        '<div class="title"><h3>' + esc(o.home) + ' <i>v</i> ' + esc(o.away) + '</h3><div class="margin"><b>' + pct(o.profitPct) + '</b><small>' + (o.isArb ? "guaranteed" : "bookmaker edge") + '</small></div></div>' +
        '<div class="mk"><span>' + esc(marketTitle(o)) + '</span><span>' + o.bookCount + ' bookmaker' + (o.bookCount === 1 ? "" : "s") + ' compared</span></div>' +
      '</button>' +
      '<div class="legs">' + legs + '</div>' +
      '<div class="sum" data-sum>' + summaryHtml(o, plan) + '</div>' +
      (flags ? '<ul class="flags">' + flags + '</ul>' : "") + detail +
    '</article>';
  }

  function filtered() {
    const q = state.fSearch.trim().toLowerCase();
    let list = state.tab === "arbs" ? visibleArbs() : state.result.opps.slice();
    if (state.fMarket) list = list.filter(o => o.market === state.fMarket);
    if (q) list = list.filter(o => (o.home + " " + o.away + " " + o.league).toLowerCase().includes(q));
    if (state.fSort === "time") list.sort((a, b) => a.commence - b.commence || b.profitPct - a.profitPct);
    return list;
  }

  function onboardingHtml() {
    return '<div class="onboard">' +
      '<h2>Three minutes to live odds</h2>' +
      '<ol><li><b>Get a free key.</b> Arbiter reads prices from The Odds API, which covers 40+ bookmakers and exchanges. The free plan gives 500 credits a month. <a href="https://the-odds-api.com/#get-access" target="_blank" rel="noopener noreferrer">Get a key ↗</a></li>' +
      '<li><b>Paste it below.</b> It is stored only in this browser.</li><li><b>Scan.</b> Sure bets appear with exact stakes for each bookmaker.</li></ol>' +
      '<div class="keyrow"><input id="obKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your API key"><button id="obGo" class="btn primary">Save and scan</button></div>' +
      '<button id="obDemo" class="btn ghost">Or explore with sample data first</button></div>';
  }

  function render() {
    const r = state.result, arbs = visibleArbs(), has = state.events.length > 0;
    const best = arbs[0], stale = has && Date.now() - state.fetchedAt > S.maxAge * 60000;
    const q = state.quota, bookCount = Object.keys(r.stats.books).length;
    document.title = (arbs.length ? "(" + arbs.length + ") " : "") + "Arbiter";
    paintScan(1);

    $("mode").hidden = !has;
    $("mode").className = "pill " + (state.isDemo ? "demo" : stale ? "old" : "live");
    $("mode").textContent = state.isDemo ? "Sample data" : "Updated " + ago(state.fetchedAt);

    $("headline").textContent = !has ? "Find the gaps between bookmakers." : arbs.length
      ? arbs.length + " sure bet" + (arbs.length === 1 ? "" : "s") + " available now."
      : "No sure bets right now.";
    $("sub").textContent = !has ? "Every price, every firm, one screen. Arbiter backs each outcome where it pays best and tells you exactly what to stake."
      : arbs.length ? "Best margin " + pct(best.profitPct) + " on " + best.home + " v " + best.away + ". That is " + money(planFor(best).minProfit) + " locked in on a " + money(totalFor(best)) + " outlay."
      : "That is normal: gaps open and close within minutes. The closest markets are under All markets. Scan again shortly or switch on auto-refresh.";

    $("stats").innerHTML = [
      ["Sure bets", arbs.length, arbs.length ? "pos" : ""],
      ["Best margin", best ? pct(best.profitPct) : "–", best ? "pos" : ""],
      ["Fixtures", r.stats.events, ""],
      ["Bookmakers", bookCount, ""],
      ["Credits left", state.isDemo || q.remaining == null ? "–" : (q.approx ? "~" : "") + q.remaining.toLocaleString("en-GB"), q.remaining != null && q.remaining < scanCost() ? "neg" : ""]
    ].map(s => '<div><dt>' + s[0] + '</dt><dd class="' + s[2] + '">' + esc(s[1]) + '</dd></div>').join("");

    const b = [];
    if (state.error) b.push('<div class="note err"><b>' + esc(state.error) + '</b></div>');
    if (state.isDemo && has) b.push('<div class="note demo"><b>These are sample prices, not real ones.</b> Do not bet on them. Add your API key in Settings to scan live odds.</div>');
    else if (stale && has) b.push('<div class="note warn"><b>These odds were fetched ' + ago(state.fetchedAt) + '.</b> Prices older than ' + S.maxAge + ' minutes are hidden because they cannot be trusted. Scan again for current prices.</div>');
    if (state.warnings.length) b.push('<div class="note warn"><b>Some leagues could not be loaded:</b> ' + esc(state.warnings.join(" · ")) + '</div>');
    $("banner").innerHTML = b.join("");

    $("controls").hidden = !has;
    $("nArbs").textContent = arbs.length; $("nAll").textContent = r.opps.length;
    document.querySelectorAll(".tabs button").forEach(t => t.classList.toggle("on", t.dataset.tab === state.tab));
    $("cur").textContent = S.cur;
    if (document.activeElement !== $("bankroll")) $("bankroll").value = S.bankroll;

    const list = $("list");
    if (!has) { list.innerHTML = state.error && S.apiKey ? "" : onboardingHtml(); return; }
    const items = filtered();
    if (!items.length) {
      const near = r.opps.find(o => !o.isArb);
      list.innerHTML = '<div class="empty"><div class="ring"></div><h3>' + (state.tab === "arbs" ? "Nothing risk-free at the moment" : "No markets match") + '</h3><p>' +
        (state.tab === "arbs" ? (stale ? "The stored prices have expired. Scan again." : near ? "Closest market is " + esc(near.home + " v " + near.away) + " at " + pct(near.profitPct) + ". Sure bets usually last a few minutes, so keep scanning." : "No complete markets were returned. Try more leagues or regions in Settings.")
          : "Try clearing the search or market filter.") +
        '</p>' + (state.tab === "arbs" && r.opps.length ? '<button class="btn" data-goto="all">View all markets</button>' : "") + '</div>';
      return;
    }
    list.innerHTML = items.slice(0, state.limit).map(cardHtml).join("") +
      (items.length > state.limit ? '<button class="btn more" data-more>Show ' + Math.min(40, items.length - state.limit) + ' more of ' + items.length + '</button>' : "");
  }

  /* ---------- settings sheet ---------- */
  const chip = (group, val, label, on) => '<button type="button" class="chip' + (on ? " on" : "") + '" aria-pressed="' + !!on + '" data-chip="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
  const toggle = (key, label, help) => '<label class="switch"><input type="checkbox" data-bool="' + key + '"' + (S[key] ? " checked" : "") + '><i></i><span><b>' + label + '</b><small>' + help + '</small></span></label>';
  const num = (key, label, attrs, suffix) => '<label class="field"><span>' + label + '</span><div><input type="number" inputmode="decimal" data-num="' + key + '" value="' + esc(S[key]) + '" ' + attrs + '>' + (suffix ? '<em>' + suffix + '</em>' : "") + '</div></label>';
  const select = (key, label, opts) => '<label class="field"><span>' + label + '</span><select data-sel="' + key + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(S[key]) === String(o[0]) ? " selected" : "") + '>' + esc(o[1]) + '</option>').join("") + '</select></label>';

  function costHtml() {
    const c = scanCost(), q = state.quota;
    let s = 'Each scan uses <b>' + c + ' credit' + (c === 1 ? "" : "s") + '</b> (' + S.sports.length + ' leagues × ' + S.markets.length + ' markets × ' + S.regions.length + ' regions).';
    if (q.remaining != null) s += ' You have ' + (q.approx ? "about " : "") + '<b>' + q.remaining.toLocaleString("en-GB") + '</b> left, enough for ' + (c ? Math.floor(q.remaining / c) : 0) + ' scans.';
    if (S.auto > 0) s += ' Auto-refresh left running all day would use roughly <b>' + Math.round(c * 1440 / S.auto).toLocaleString("en-GB") + '</b> credits a day.';
    return s;
  }

  function sheetHtml() {
    const others = {};
    (state.sports || []).forEach(s => { if (s.active !== false && !s.has_outrights && !String(s.key).startsWith("soccer")) (others[s.group] = others[s.group] || []).push(s); });
    const moreSoccer = (state.sports || []).filter(s => s.active !== false && !s.has_outrights && String(s.key).startsWith("soccer") && !FOOTBALL.some(f => f[0] === s.key));
    const books = Object.keys(state.result.stats.books).sort((a, b) => state.result.stats.books[a].localeCompare(state.result.stats.books[b]));
    const exch = Object.keys(S.comm).filter(k => !books.length || books.includes(k) || E.DEFAULT_COMMISSION[k] != null);
    return '' +
      '<section><h3>Odds source</h3>' +
        '<label class="field"><span>The Odds API key</span><input id="setKey" type="password" autocomplete="off" spellcheck="false" value="' + esc(S.apiKey) + '" placeholder="Paste your key"></label>' +
        '<p class="help">Free keys (500 credits a month) at <a href="https://the-odds-api.com/#get-access" target="_blank" rel="noopener noreferrer">the-odds-api.com ↗</a>. Stored only in this browser.</p>' +
        toggle("demo", "Use sample data", "Explore the app without spending credits. Prices are made up.") +
      '</section>' +
      '<section><h3>Football leagues</h3><div class="chips">' + FOOTBALL.map(f => chip("sports", f[0], f[1], S.sports.includes(f[0]))).join("") + moreSoccer.map(s => chip("sports", s.key, s.title, S.sports.includes(s.key))).join("") + '</div>' +
        (Object.keys(others).length
          ? '<details><summary>Other sports</summary>' + Object.keys(others).sort().map(g => '<h4>' + esc(g) + '</h4><div class="chips">' + others[g].map(s => chip("sports", s.key, s.title, S.sports.includes(s.key))).join("") + '</div>').join("") + '</details>'
          : '<button class="btn small" id="loadSports">Load every league and sport in season</button>') +
      '</section>' +
      '<section><h3>Coverage</h3><h4>Bookmaker regions</h4><div class="chips">' + REGIONS.map(r => chip("regions", r[0], r[1], S.regions.includes(r[0]))).join("") + '</div>' +
        '<h4>Markets</h4><div class="chips">' + MARKETS.map(m => chip("markets", m[0], m[1], S.markets.includes(m[0]))).join("") + '</div>' +
        '<p class="help" id="cost">' + costHtml() + '</p></section>' +
      '<section><h3>Auto-refresh</h3>' +
        select("auto", "Rescan", [[0, "Off (manual only)"], [1, "Every minute"], [2, "Every 2 minutes"], [5, "Every 5 minutes"], [10, "Every 10 minutes"], [15, "Every 15 minutes"], [30, "Every 30 minutes"], [60, "Every hour"]]) +
        toggle("sound", "Sound alert", "Play a chime when auto-refresh finds a new sure bet.") +
        toggle("notify", "Notifications", "Alert me when this tab is in the background.") +
      '</section>' +
      '<section><h3>Staking</h3><div class="grid2">' +
        select("cur", "Currency", [["£", "£ Pounds"], ["€", "€ Euros"], ["$", "$ Dollars"]]) +
        select("step", "Round stakes to", [[0.01, "Exact pennies"], [0.5, "50p"], [1, "Whole pounds"], [5, "Nearest 5"], [10, "Nearest 10"]]) +
        num("minProfit", "Minimum margin", 'min="0" max="50" step="0.1"', "%") +
        num("suspect", "Flag as suspicious above", 'min="1" max="100" step="1"', "%") +
      '</div><p class="help">Rounded stakes look less like arbitrage to a bookmaker. Arbiter tests every rounding combination and keeps the one with the best worst-case result.</p></section>' +
      '<section><h3>Safety</h3><div class="grid2">' +
        num("maxAge", "Ignore prices older than", 'min="1" max="240" step="1"', "min") +
        num("windowDays", "Fixtures within", 'min="0" max="60" step="1"', "days") +
      '</div>' +
        toggle("strict", "Half-point lines only", "Skip totals and handicaps that can land exactly on the line and refund your stake.") +
        toggle("backLay", "Back / lay opportunities", "Back at a bookmaker and lay the same result on an exchange.") +
        toggle("live", "Include in-play fixtures", "Not recommended: in-play prices change faster than they can be fetched.") +
      '</section>' +
      '<section><h3>My bookmakers</h3>' + (books.length
        ? '<p class="help">Switch off any firm you do not have an account with. Sure bets are only built from the ones left on.</p><div class="chips">' + books.map(k => chip("books", k, state.result.stats.books[k], !S.excluded.includes(k))).join("") + '</div>'
        : '<p class="help">Run a scan first and the bookmakers found will be listed here.</p>') +
        '<h4>Exchange commission</h4><div class="grid2">' + exch.map(k => '<label class="field"><span>' + esc(state.result.stats.books[k] || k.replace(/_/g, " ")) + '</span><div><input type="number" inputmode="decimal" min="0" max="20" step="0.5" data-comm="' + esc(k) + '" value="' + +(S.comm[k] * 100).toFixed(2) + '"><em>%</em></div></label>').join("") + '</div>' +
        '<p class="help">Commission is taken off exchange prices before they are compared, so the profit shown is what you keep.</p></section>' +
      '<section><button class="btn small danger" id="reset">Clear stored odds and reset settings</button></section>';
  }

  function openSheet() {
    $("sheetBody").innerHTML = sheetHtml();
    $("sheet").hidden = false; $("scrim").hidden = false;
    requestAnimationFrame(() => document.body.classList.add("sheet-open"));
  }
  function closeSheet() {
    document.body.classList.remove("sheet-open");
    setTimeout(() => { $("sheet").hidden = true; $("scrim").hidden = true; }, 220);
  }
  function settingsChanged(rebuild) {
    save(); compute(); render();
    if (rebuild) { const top = $("sheetBody").scrollTop; $("sheetBody").innerHTML = sheetHtml(); $("sheetBody").scrollTop = top; }
    else if ($("cost")) $("cost").innerHTML = costHtml();
  }

  async function loadSports() {
    if (!S.apiKey) return toast("Add your API key first");
    try {
      const r = await apiGet("/sports", { apiKey: S.apiKey });
      if (Array.isArray(r.data)) { state.sports = r.data; writeLS(LS_SPORTS, r.data); settingsChanged(true); toast("Loaded " + r.data.length + " competitions"); }
    } catch (e) { toast(e.message); }
  }

  /* ---------- events ---------- */
  $("btnScan").addEventListener("click", () => scan(false));
  $("btnSettings").addEventListener("click", openSheet);
  $("btnClose").addEventListener("click", closeSheet);
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

  document.querySelector(".tabs").addEventListener("click", e => {
    const t = e.target.closest("button[data-tab]"); if (!t) return;
    state.tab = t.dataset.tab; state.limit = 40; render();
  });
  $("bankroll").addEventListener("input", e => { const v = +e.target.value; if (v > 0) { S.bankroll = v; save(); render(); } });
  $("fMarket").addEventListener("change", e => { state.fMarket = e.target.value; render(); });
  $("fSort").addEventListener("change", e => { state.fSort = e.target.value; render(); });
  $("fSearch").addEventListener("input", e => { state.fSearch = e.target.value; render(); });

  const oppById = id => state.result.opps.find(o => o.id === id);
  $("list").addEventListener("click", e => {
    if (e.target.id === "obGo") {
      const k = $("obKey").value.trim(); if (!k) return toast("Paste your API key first");
      S.apiKey = k; S.demo = false; save(); return scan(false);
    }
    if (e.target.id === "obDemo") { S.demo = true; save(); return scan(false); }
    if (e.target.closest("[data-more]")) { state.limit += 40; return render(); }
    const go = e.target.closest("[data-goto]"); if (go) { state.tab = go.dataset.goto; return render(); }
    const card = e.target.closest(".card"); if (!card) return;
    const o = oppById(card.dataset.id); if (!o) return;
    if (e.target.closest("[data-toggle]")) { state.open = state.open === o.id ? null : o.id; return render(); }
    if (e.target.closest("[data-copy]")) {
      const p = planFor(o);
      const text = o.home + " v " + o.away + " · " + marketTitle(o) + "\n" +
        o.legs.map((l, i) => (l.side === "lay" ? "LAY " : "BACK ") + legName(o, l) + ": " + money(p.legs[i].stake) + " @ " + odds(p.legs[i].price) + " · " + l.title + (l.side === "lay" ? " (liability " + money(p.legs[i].liability) + ")" : "")).join("\n") +
        "\nOutlay " + money(p.outlay) + " · guaranteed " + money(p.minProfit);
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Stake plan copied"), () => toast("Copy is not available in this browser"));
    }
  });
  $("list").addEventListener("input", e => {
    const card = e.target.closest(".card"); if (!card) return;
    const o = oppById(card.dataset.id); if (!o) return;
    const c = state.calc[o.id] = state.calc[o.id] || {};
    if (e.target.hasAttribute("data-total")) { const v = +e.target.value; if (v > 0) c.total = v; }
    if (e.target.hasAttribute("data-price")) { c.prices = c.prices || o.legs.map(l => l.price); c.prices[+e.target.dataset.price] = +e.target.value; }
    const p = planFor(o);
    card.querySelector("[data-sum]").innerHTML = summaryHtml(o, p);
    card.querySelectorAll("[data-stake]").forEach(el => { const i = +el.dataset.stake; el.innerHTML = stakeHtml(o.legs[i], p.legs[i]); });
    card.querySelectorAll(".leg-odds").forEach((el, i) => (el.textContent = odds(p.legs[i].price)));
  });

  $("sheetBody").addEventListener("click", e => {
    const c = e.target.closest("[data-chip]");
    if (c) {
      const g = c.dataset.chip, v = c.dataset.val;
      if (g === "books") S.excluded = S.excluded.includes(v) ? S.excluded.filter(x => x !== v) : S.excluded.concat(v);
      else S[g] = S[g].includes(v) ? S[g].filter(x => x !== v) : S[g].concat(v);
      const on = g === "books" ? !S.excluded.includes(v) : S[g].includes(v);
      c.classList.toggle("on", on); c.setAttribute("aria-pressed", on);
      return settingsChanged(false);
    }
    if (e.target.id === "loadSports") return loadSports();
    if (e.target.id === "reset" && confirm("Clear stored odds and reset every setting, including your API key?")) {
      [LS_SET, LS_DATA, LS_SPORTS].forEach(k => { try { localStorage.removeItem(k); } catch (err) { /* ignore */ } });
      location.reload();
    }
  });
  $("sheetBody").addEventListener("change", e => {
    const t = e.target;
    if (t.id === "setKey") { S.apiKey = t.value.trim(); if (S.apiKey) S.demo = false; return settingsChanged(true); }
    if (t.dataset.bool) {
      S[t.dataset.bool] = t.checked;
      if (t.dataset.bool === "notify" && t.checked && "Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission().then(p => { if (p !== "granted") { S.notify = false; settingsChanged(true); toast("Notifications are blocked in this browser"); } });
      } else if (t.dataset.bool === "notify" && t.checked && !("Notification" in window)) { S.notify = false; toast("Notifications are not supported here"); return settingsChanged(true); }
      if (t.dataset.bool === "demo") { settingsChanged(false); return scan(false); }
      return settingsChanged(false);
    }
    if (t.dataset.num) { const v = +t.value; if (isFinite(v) && v >= 0) S[t.dataset.num] = v; return settingsChanged(false); }
    if (t.dataset.sel) {
      S[t.dataset.sel] = t.dataset.sel === "cur" ? t.value : +t.value;
      if (t.dataset.sel === "auto") scheduleAuto();
      return settingsChanged(false);
    }
    if (t.dataset.comm) { const v = +t.value; if (isFinite(v) && v >= 0 && v <= 50) S.comm[t.dataset.comm] = v / 100; return settingsChanged(false); }
  });

  // Tick: auto-refresh countdown, and re-age the stored prices so nothing stale lingers on screen.
  let lastAge = Date.now();
  setInterval(() => {
    if (state.scanning) return;
    const now = Date.now();
    if (state.nextAuto) {
      const left = Math.max(0, Math.ceil((state.nextAuto - now) / 1000));
      $("scanLabel").textContent = left > 0 ? "Scan · " + (left >= 60 ? Math.ceil(left / 60) + "m" : left + "s") : "Scan odds";
      if (left === 0 && (!document.hidden || S.notify) && navigator.onLine !== false) return scan(true);
    } else $("scanLabel").textContent = "Scan odds";
    const typing = document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (now - lastAge > 30000 && !typing && state.events.length) { lastAge = now; compute(); render(); }
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.events.length && !state.scanning) { compute(); render(); } });

  scheduleAuto(); compute(); state.seen = new Set(visibleArbs().map(o => o.id)); render();
})();
