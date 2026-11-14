// Run: node --test arb/tests/engine.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const fresh = "2026-11-14T11:58:00Z";
const book = (key, markets, last_update = fresh) => ({ key, title: key.toUpperCase(), last_update, markets });
const h2h = (h, d, a, key = "h2h") => ({ key, outcomes: [{ name: "Arsenal", price: h }, { name: "Draw", price: d }, { name: "Chelsea", price: a }] });
const totals = (pt, o, u) => ({ key: "totals", outcomes: [{ name: "Over", price: o, point: pt }, { name: "Under", price: u, point: pt }] });
const event = (bookmakers, extra) => Object.assign({
  id: "e1", sport_key: "soccer_epl", sport_title: "EPL", commence_time: "2026-11-15T15:00:00Z",
  home_team: "Arsenal", away_team: "Chelsea", bookmakers
}, extra);
const scan = (evs, opts) => E.findOpportunities(evs, Object.assign({ now: NOW, commission: {} }, opts));

test("finds a 3-way arb using the best price for each outcome across books", () => {
  const { opps } = scan([event([book("a", [h2h(2.9, 3.2, 2.6)]), book("b", [h2h(2.5, 3.9, 2.7)]), book("c", [h2h(2.4, 3.3, 3.3)])])]);
  const o = opps.find(x => x.market === "h2h");
  assert.deepEqual(o.legs.map(l => l.book), ["a", "b", "c"]);
  const sum = 1 / 2.9 + 1 / 3.9 + 1 / 3.3;
  assert.ok(o.isArb);
  assert.ok(Math.abs(o.profitPct - (1 / sum - 1) * 100) < 1e-9);
});

test("a normal market with bookmaker margin is not flagged as an arb", () => {
  const { opps } = scan([event([book("a", [h2h(2.4, 3.3, 2.9)]), book("b", [h2h(2.45, 3.25, 2.85)])])]);
  assert.equal(opps.filter(o => o.isArb).length, 0);
  assert.ok(opps[0].profitPct < 0);
});

test("stake plan guarantees the same profit whatever the result, and never loses after rounding", () => {
  const { opps } = scan([event([book("a", [h2h(2.9, 3.2, 2.6)]), book("b", [h2h(2.5, 3.9, 2.7)]), book("c", [h2h(2.4, 3.3, 3.3)])])]);
  const o = opps[0];
  const exact = E.calcStakes(o, 1000, 0.01);
  assert.ok(Math.abs(exact.outlay - 1000) <= 0.02);
  assert.ok(exact.maxProfit - exact.minProfit < 0.05);
  assert.ok(Math.abs(exact.minProfit - 1000 * o.profitPct / 100) < 0.05);
  for (const step of [0.5, 1, 5]) {
    const p = E.calcStakes(o, 1000, step);
    assert.ok(p.minProfit > 0, "step " + step);
    for (const l of p.legs) assert.ok(Math.abs(l.stake / step - Math.round(l.stake / step)) < 1e-6);
    assert.equal(p.minProfit, Math.round((Math.min(...p.legs.map(l => l.ret)) - p.outlay) * 100) / 100);
  }
});

test("re-checking with worse odds turns the plan negative", () => {
  const { opps } = scan([event([book("a", [h2h(2.9, 3.2, 2.6)]), book("b", [h2h(2.5, 3.9, 2.7)]), book("c", [h2h(2.4, 3.3, 3.3)])])]);
  assert.ok(E.calcStakes(opps[0], 100, 0.01, [2.5, 3.2, 2.7]).minProfit < 0);
});

test("exchange commission is deducted before comparing prices", () => {
  const evs = [event([book("betfair_ex_uk", [h2h(3.0, 3.9, 3.3)]), book("b", [h2h(2.5, 3.4, 2.7)])])];
  const none = scan(evs).opps.find(o => o.market === "h2h");
  const five = scan(evs, { commission: { betfair_ex_uk: 0.05 } }).opps.find(o => o.market === "h2h");
  assert.ok(none.isArb && none.profitPct > 0);
  assert.ok(five.profitPct < none.profitPct);
  assert.ok(Math.abs(five.legs[0].eff - 2.9) < 1e-9);
  const plan = E.calcStakes(five, 100, 0.01);
  assert.ok(Math.abs(plan.legs[0].ret - plan.legs[0].stake * 2.9) < 0.01);
});

test("totals only pair Over and Under on the same line", () => {
  const { opps } = scan([event([book("a", [totals(2.5, 2.2, 1.7)]), book("b", [totals(3.5, 1.5, 2.2)])])]);
  assert.equal(opps.filter(o => o.isArb).length, 0); // Over 2.5 @2.2 + Under 3.5 @2.2 must NOT be combined
  const { opps: same } = scan([event([book("a", [totals(2.5, 2.2, 1.7)]), book("b", [totals(2.5, 1.7, 2.1)])])]);
  assert.equal(same.filter(o => o.isArb).length, 1);
  assert.equal(same[0].line, 2.5);
});

test("strict mode drops whole and quarter lines that can push", () => {
  const evs = [event([book("a", [totals(3, 2.2, 1.7)]), book("b", [totals(3, 1.7, 2.2)])])];
  assert.equal(scan(evs).opps.length, 0);
  const loose = scan(evs, { strictLines: false }).opps;
  assert.equal(loose.length, 1);
  assert.ok(loose[0].flags.some(f => f.id === "push"));
});

test("handicaps pair only exactly opposite lines", () => {
  const sp = (hp, ho, ap, ao) => ({ key: "spreads", outcomes: [{ name: "Arsenal", price: ho, point: hp }, { name: "Chelsea", price: ao, point: ap }] });
  const { opps } = scan([event([book("a", [sp(-0.5, 2.2, 0.5, 1.7)]), book("b", [sp(-1.5, 3.4, 1.5, 1.3)])])]);
  assert.equal(opps.filter(o => o.isArb).length, 0);
  assert.equal(opps.length, 2);
  assert.equal(scan([event([book("a", [sp(-0.5, 2.2, 1.5, 2.2)])])]).opps.length, 0); // inconsistent book
});

test("stale, malformed, excluded and in-play data are ignored", () => {
  const good = book("b", [h2h(2.5, 3.9, 2.7)]), also = book("c", [h2h(2.4, 3.3, 2.8)]);
  const arbBook = h => book("a", [h2h(2.9, 3.2, 2.6)], h);
  assert.ok(scan([event([arbBook(fresh), good, also])]).opps[0].isArb);
  assert.ok(!scan([event([arbBook("2026-11-14T10:00:00Z"), good, also])]).opps[0].isArb, "stale");
  assert.ok(!scan([event([arbBook(fresh), good, also])], { excluded: ["a"] }).opps[0].isArb, "excluded");
  assert.equal(scan([event([arbBook(fresh), good, also], { commence_time: "2026-11-14T11:00:00Z" })]).opps.length, 0, "live");
  const twoWay = book("x", [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 9 }, { name: "Chelsea", price: 9 }] }]);
  const junk = book("y", [{ key: "h2h", outcomes: [{ name: "Arsenal", price: "9" }, { name: "Draw", price: 9 }, { name: "Chelsea", price: 1 }] }]);
  const r = scan([event([twoWay, junk, good])]);
  assert.ok(!r.opps.some(o => o.isArb));
  assert.equal(r.stats.malformed, 2);
  assert.doesNotThrow(() => scan([null, {}, { id: "z", home_team: "a", away_team: "b", commence_time: "nope" }]));
});

test("back/lay: equal profit on both results, net of lay commission", () => {
  const evs = [event([book("a", [h2h(3.2, 3.3, 2.4)]), book("betfair_ex_uk", [h2h(2.9, 3.3, 2.4), h2h(3.0, 3.5, 2.6, "h2h_lay")])])];
  const { opps } = scan(evs, { commission: { betfair_ex_uk: 0.05 } });
  const o = opps.find(x => x.type === "backlay" && x.isArb);
  assert.equal(o.legs[0].book, "a"); assert.equal(o.legs[1].side, "lay");
  const p = E.calcStakes(o, 500, 0.01);
  const [bk, ly] = p.legs;
  assert.ok(Math.abs(p.outlay - 500) < 0.05);
  const win = bk.stake * 2.2 - ly.stake * 2.0, lose = ly.stake * 0.95 - bk.stake;
  assert.ok(Math.abs(win - lose) < 0.05);
  assert.ok(Math.abs(p.minProfit - Math.min(win, lose)) < 0.02);
  assert.ok(p.minProfit > 0);
  assert.ok(Math.abs(p.roiPct - o.profitPct) < 0.05);
});

test("suspiciously large arbs are flagged", () => {
  const { opps } = scan([event([book("a", [h2h(4.5, 3.2, 2.6)]), book("b", [h2h(2.5, 4.9, 2.7)]), book("c", [h2h(2.4, 3.3, 4.3)])])]);
  assert.ok(opps[0].flags.some(f => f.id === "suspicious"));
});
