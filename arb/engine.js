/* Arbiter engine — pure arbitrage maths. No DOM, no network: runs in the browser and under Node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ArbEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Exchanges charge commission on net winnings; a 2.00 back price at 5% really pays 1.95.
  const DEFAULT_COMMISSION = {
    betfair_ex_uk: 0.05, betfair_ex_eu: 0.05, betfair_ex_au: 0.05,
    smarkets: 0.02, matchbook: 0.02
  };
  const EPS = 1e-9;

  const validPrice = p => typeof p === "number" && isFinite(p) && p > 1 && p <= 1001;
  const effPrice = (price, comm) => 1 + (price - 1) * (1 - (comm || 0));
  const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
  const safeLink = u => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);

  function lineKind(line) {
    const f = Math.abs(line) % 1;
    if (Math.abs(f - 0.5) < EPS) return "half";
    if (f < EPS || 1 - f < EPS) return "whole";
    return "quarter";
  }
  const fmtLine = n => (n > 0 ? "+" : "") + String(+(+n).toFixed(2));

  /** Collect every usable quote for one event, grouped into mutually-exclusive, exhaustive outcome sets. */
  function buildGroups(ev, o, stats) {
    const groups = new Map();
    const home = ev.home_team, away = ev.away_team;
    const books = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
    const isSoccer = String(ev.sport_key || "").startsWith("soccer");
    const threeWay = isSoccer || books.some(b => (b.markets || []).some(m =>
      m.key === "h2h" && (m.outcomes || []).some(x => x && x.name === "Draw")));

    const group = (key, init) => {
      let g = groups.get(key);
      if (!g) { g = Object.assign({ key, quotes: {}, lays: {} }, init); g.names.forEach(n => (g.quotes[n] = [])); groups.set(key, g); }
      return g;
    };

    for (const b of books) {
      if (!b || !b.key || o.excluded.has(b.key)) continue;
      const comm = o.commission[b.key] != null ? o.commission[b.key] : 0;
      for (const m of b.markets || []) {
        const outs = Array.isArray(m.outcomes) ? m.outcomes : [];
        const updated = Date.parse(m.last_update || b.last_update || "");
        const ageMin = isFinite(updated) ? (o.now - updated) / 60000 : Infinity;
        if (!(ageMin <= o.maxAgeMin)) { stats.stale++; continue; }
        if (!outs.length || !outs.every(x => x && validPrice(x.price))) { stats.malformed++; continue; }
        const quote = x => ({
          book: b.key, title: b.title || b.key, price: x.price, comm,
          eff: effPrice(x.price, comm), updated, ageMin,
          link: safeLink(x.link) || safeLink(m.link) || safeLink(b.link)
        });

        if (m.key === "h2h" || m.key === "h2h_lay") {
          const names = threeWay ? [home, "Draw", away] : [home, away];
          // A book must price exactly the full outcome set, otherwise it is a different market (e.g. 2-way on a 3-way game).
          if (outs.length !== names.length || !names.every(n => outs.filter(x => x.name === n).length === 1)) { stats.malformed++; continue; }
          const g = group("h2h", { market: "h2h", line: null, names, labels: threeWay ? ["Home", "Draw", "Away"] : ["Home", "Away"] });
          for (const x of outs) {
            if (m.key === "h2h") g.quotes[x.name].push(quote(x));
            else (g.lays[x.name] = g.lays[x.name] || []).push(quote(x));
          }
          stats.quotes += outs.length;
        } else if (m.key === "totals") {
          const pts = new Map();
          for (const x of outs) {
            if (typeof x.point !== "number" || !isFinite(x.point)) continue;
            const p = pts.get(x.point) || {}; (p[x.name] = p[x.name] || []).push(x); pts.set(x.point, p);
          }
          for (const [pt, p] of pts) {
            if (!p.Over || !p.Under || p.Over.length !== 1 || p.Under.length !== 1) { stats.malformed++; continue; }
            const kind = lineKind(pt);
            if (o.strictLines && kind !== "half") continue;
            const g = group("totals|" + pt, { market: "totals", line: pt, kind, names: ["Over", "Under"], labels: ["Over " + pt, "Under " + pt] });
            g.quotes.Over.push(quote(p.Over[0])); g.quotes.Under.push(quote(p.Under[0]));
            stats.quotes += 2;
          }
        } else if (m.key === "spreads") {
          const hs = outs.filter(x => x.name === home && typeof x.point === "number");
          const as = outs.filter(x => x.name === away && typeof x.point === "number");
          for (const h of hs) {
            // Opposite sides of the SAME handicap only: home -1.5 pairs with away +1.5, never with +1.0.
            const a = as.filter(x => Math.abs(x.point + h.point) < EPS);
            if (a.length !== 1 || hs.filter(x => x.point === h.point).length !== 1) { stats.malformed++; continue; }
            const kind = lineKind(h.point);
            if (o.strictLines && kind !== "half") continue;
            const g = group("spreads|" + h.point, {
              market: "spreads", line: h.point, kind, names: [home, away],
              labels: [home + " " + fmtLine(h.point), away + " " + fmtLine(-h.point)]
            });
            g.quotes[home].push(quote(h)); g.quotes[away].push(quote(a[0]));
            stats.quotes += 2;
          }
        }
      }
    }
    return groups;
  }

  const MARKET_NAME = { h2h: "Match result", totals: "Total goals", spreads: "Handicap", backlay: "Back / Lay" };

  function baseOpp(ev, extra) {
    return Object.assign({
      eventId: ev.id, sportKey: ev.sport_key, league: ev.sport_title || ev.sport_key,
      home: ev.home_team, away: ev.away_team, commence: Date.parse(ev.commence_time)
    }, extra);
  }

  function flagsFor(opp, o) {
    const f = [];
    const mins = (opp.commence - o.now) / 60000;
    if (mins <= 0) f.push({ id: "live", text: "In-play: prices move in seconds" });
    else if (mins < 15) f.push({ id: "soon", text: "Kicks off in under 15 min" });
    if (opp.isArb && opp.profitPct >= o.suspectPct) f.push({ id: "suspicious", text: "Unusually large: likely a pricing error the bookmaker can void" });
    if (opp.kind === "whole") f.push({ id: "push", text: "Whole line: stakes are refunded (profit 0) if it lands exactly" });
    if (opp.kind === "quarter") f.push({ id: "push", text: "Quarter line: profit is halved in one result" });
    if (new Set(opp.legs.map(l => l.book)).size === 1) f.push({ id: "samebook", text: "All legs at one bookmaker: expect it to be corrected" });
    if (opp.legs.some(l => l.comm > 0 || l.side === "lay")) f.push({ id: "exchange", text: "Exchange leg: check there is enough money available at this price" });
    return f;
  }

  /**
   * Scan raw The Odds API events. Returns every complete market, best price per outcome, sorted by margin.
   * `isArb` marks the ones where backing every outcome at the best prices returns more than is staked.
   */
  function findOpportunities(events, options) {
    const o = Object.assign({
      now: Date.now(), maxAgeMin: 15, strictLines: true, includeLive: false, backLay: true,
      suspectPct: 10, windowDays: 0, excluded: new Set(), commission: DEFAULT_COMMISSION
    }, options || {});
    if (!(o.excluded instanceof Set)) o.excluded = new Set(o.excluded || []);
    const stats = { events: 0, skippedLive: 0, quotes: 0, stale: 0, malformed: 0, books: {} };
    const opps = [];

    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !ev.id || !ev.home_team || !ev.away_team) continue;
      const commence = Date.parse(ev.commence_time);
      if (!isFinite(commence)) continue;
      if (commence <= o.now && !o.includeLive) { stats.skippedLive++; continue; }
      if (o.windowDays > 0 && commence - o.now > o.windowDays * 864e5) continue;
      stats.events++;
      for (const b of ev.bookmakers || []) if (b && b.key) stats.books[b.key] = b.title || b.key;

      for (const g of buildGroups(ev, o, stats).values()) {
        const ladders = g.names.map(n => g.quotes[n].slice().sort((a, b) => b.eff - a.eff || a.ageMin - b.ageMin));
        if (ladders.every(l => l.length)) {
          const legs = ladders.map((l, i) => Object.assign({ side: "back", outcome: g.names[i], label: g.labels[i], alts: l.slice(1, 4) }, l[0]));
          const sumInv = legs.reduce((s, l) => s + 1 / l.eff, 0);
          const opp = baseOpp(ev, {
            id: ev.id + "|" + g.key, type: "multi", market: g.market, marketName: MARKET_NAME[g.market],
            line: g.line, kind: g.kind || "half", legs, sumInv,
            profitPct: (1 / sumInv - 1) * 100, isArb: sumInv < 1 - EPS,
            bookCount: new Set([].concat(...ladders).map(q => q.book)).size
          });
          opp.flags = flagsFor(opp, o);
          opps.push(opp);
        }

        // Back at one firm, lay the same outcome on an exchange.
        if (o.backLay && g.market === "h2h") {
          g.names.forEach((n, i) => {
            let best = null;
            for (const lay of g.lays[n] || []) {
              const back = g.quotes[n].filter(q => q.book !== lay.book).sort((a, b) => b.eff - a.eff)[0];
              if (!back || lay.price - lay.comm <= 0) continue;
              const layPerBack = back.eff / (lay.price - lay.comm);
              const profit = layPerBack * (1 - lay.comm) - 1;
              const pct = profit / (1 + layPerBack * (lay.price - 1)) * 100;
              if (!best || pct > best.pct) best = { pct, back, lay };
            }
            if (!best || best.pct < -1.5) return;
            const opp = baseOpp(ev, {
              id: ev.id + "|lay|" + n, type: "backlay", market: "backlay", marketName: MARKET_NAME.backlay,
              line: null, kind: "half", profitPct: best.pct, isArb: best.pct > EPS, bookCount: 2,
              legs: [
                Object.assign({ side: "back", outcome: n, label: "Back " + n, alts: [] }, best.back),
                Object.assign({ side: "lay", outcome: n, label: "Lay " + n, alts: [] }, best.lay, { eff: best.lay.price })
              ]
            });
            opp.flags = flagsFor(opp, o);
            opps.push(opp);
          });
        }
      }
    }
    opps.sort((a, b) => b.profitPct - a.profitPct);
    return { opps, stats };
  }

  /**
   * Stake plan for a total outlay. `prices` optionally overrides the raw odds per leg (for re-checking at the bookmaker).
   * With a rounding step, searches every round-up/round-down combination and keeps the one with the best worst case.
   */
  function calcStakes(opp, total, step, prices) {
    total = Math.max(0, +total || 0); step = +step > 0 ? +step : 0.01;
    const raw = opp.legs.map((l, i) => (prices && validPrice(+prices[i]) ? +prices[i] : l.price));
    const snap = x => Math.max(step, r2(Math.round(x / step) * step));

    if (opp.type === "backlay") {
      const b = effPrice(raw[0], opp.legs[0].comm), l = raw[1], c = opp.legs[1].comm;
      const backStake = total > 0 ? snap(total / (1 + b * (l - 1) / (l - c))) : 0;
      const layStake = r2(backStake * b / (l - c));
      const liability = r2(layStake * (l - 1));
      const win = r2(backStake * (b - 1) - liability), lose = r2(layStake * (1 - c) - backStake);
      const outlay = r2(backStake + liability);
      return {
        legs: [{ stake: backStake, price: raw[0], ret: r2(backStake * b) }, { stake: layStake, price: l, liability, ret: r2(layStake * (1 - c) + liability) }],
        outlay, minProfit: Math.min(win, lose), maxProfit: Math.max(win, lose),
        roiPct: outlay ? Math.min(win, lose) / outlay * 100 : 0
      };
    }

    const eff = raw.map((p, i) => effPrice(p, opp.legs[i].comm));
    const sumInv = eff.reduce((s, e) => s + 1 / e, 0);
    const ideal = eff.map(e => total / e / sumInv);
    let best = null;
    const n = eff.length, combos = total > 0 ? 1 << n : 1;
    for (let mask = 0; mask < combos; mask++) {
      const stakes = ideal.map((s, i) => total > 0 ? Math.max(step, r2((mask >> i & 1 ? Math.ceil(s / step - EPS) : Math.floor(s / step + EPS)) * step)) : 0);
      const outlay = r2(stakes.reduce((a, b) => a + b, 0));
      const rets = stakes.map((s, i) => r2(s * eff[i]));
      const minProfit = r2(Math.min(...rets) - outlay);
      const cand = { stakes, outlay, rets, minProfit, maxProfit: r2(Math.max(...rets) - outlay), drift: Math.abs(outlay - total) };
      if (!best || cand.minProfit > best.minProfit + EPS || (Math.abs(cand.minProfit - best.minProfit) <= EPS && cand.drift < best.drift)) best = cand;
    }
    return {
      legs: best.stakes.map((s, i) => ({ stake: s, price: raw[i], ret: best.rets[i] })),
      outlay: best.outlay, minProfit: best.minProfit, maxProfit: best.maxProfit,
      roiPct: best.outlay ? best.minProfit / best.outlay * 100 : 0
    };
  }

  return { findOpportunities, calcStakes, effPrice, validPrice, lineKind, DEFAULT_COMMISSION, MARKET_NAME };
});
