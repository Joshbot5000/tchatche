/* Sample data in The Odds API's response shape, so the app can be explored without spending credits. Not real prices. */
(function () {
  "use strict";
  const BOOKS = [
    ["bet365", "Bet365"], ["skybet", "Sky Bet"], ["williamhill", "William Hill"], ["paddypower", "Paddy Power"],
    ["ladbrokes_uk", "Ladbrokes"], ["coral", "Coral"], ["betfred_uk", "Betfred"], ["unibet_uk", "Unibet"],
    ["betvictor", "Bet Victor"], ["boylesports", "BoyleSports"], ["betway", "Betway"], ["betfair_ex_uk", "Betfair Exchange"], ["smarkets", "Smarkets"]
  ];
  const FIXTURES = [
    ["soccer_epl", "Premier League", "Arsenal", "Newcastle United", 0.55, 0.24],
    ["soccer_epl", "Premier League", "Brighton and Hove Albion", "Aston Villa", 0.40, 0.27],
    ["soccer_epl", "Premier League", "Liverpool", "Tottenham Hotspur", 0.58, 0.22],
    ["soccer_epl", "Premier League", "Everton", "Fulham", 0.36, 0.30],
    ["soccer_epl", "Premier League", "Manchester City", "Chelsea", 0.52, 0.24],
    ["soccer_efl_champ", "Championship", "Leeds United", "Sunderland", 0.50, 0.27],
    ["soccer_efl_champ", "Championship", "Norwich City", "Coventry City", 0.38, 0.29],
    ["soccer_efl_champ", "Championship", "Sheffield United", "Middlesbrough", 0.44, 0.28],
    ["soccer_uefa_champs_league", "UEFA Champions League", "Real Madrid", "Bayern Munich", 0.44, 0.25],
    ["soccer_uefa_champs_league", "UEFA Champions League", "Inter Milan", "Paris Saint Germain", 0.39, 0.27],
    ["soccer_spain_la_liga", "La Liga", "Barcelona", "Atletico Madrid", 0.54, 0.24],
    ["soccer_italy_serie_a", "Serie A", "Juventus", "Napoli", 0.37, 0.31],
    ["soccer_germany_bundesliga", "Bundesliga", "Borussia Dortmund", "RB Leipzig", 0.43, 0.25],
    ["soccer_france_ligue_one", "Ligue 1", "Marseille", "Lyon", 0.45, 0.26]
  ];
  // Events where one firm is deliberately out of line, to show what a sure bet looks like.
  const BOOSTS = { 1: ["h2h", 2, "betvictor", 1.13], 4: ["totals", 0, "unibet_uk", 1.1], 6: ["h2h", 1, "boylesports", 1.12], 9: ["h2h", 0, "betfair_ex_uk", 1.19], 12: ["totals", 1, "coral", 1.085] };

  function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const px = x => Math.max(1.02, Math.round(x * 100) / 100);

  window.ArbDemo = function () {
    const rand = rng(Math.floor(Date.now() / 60000));
    const now = Date.now();
    const iso = t => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
    return FIXTURES.map((f, i) => {
      const [sport_key, sport_title, home, away, pH, pD] = f;
      const probs = [pH, pD, 1 - pH - pD];
      const pOver = 0.42 + rand() * 0.2;
      const boost = BOOSTS[i];
      const bookmakers = BOOKS.filter(() => rand() > 0.12).map(([key, title]) => {
        const ex = key === "betfair_ex_uk" || key === "smarkets";
        const margin = ex ? 1.005 : 1.035 + rand() * 0.035;
        const jig = () => 1 + (rand() - 0.5) * 0.03;
        const b = (mk, idx) => (boost && boost[0] === mk && boost[1] === idx && boost[2] === key ? boost[3] : 1);
        const names = [home, "Draw", away];
        const order = [0, 2, 1];
        const hh = order.map(k => ({ name: names[k], price: px(1 / (probs[k] * margin) * jig() * b("h2h", k)) }));
        const markets = [{ key: "h2h", last_update: iso(now - rand() * 240000), outcomes: hh }];
        if (ex) markets.push({ key: "h2h_lay", last_update: markets[0].last_update, outcomes: hh.map(o => ({ name: o.name, price: px(o.price * (1.012 + rand() * 0.02)) })) });
        if (rand() > 0.15) markets.push({
          key: "totals", last_update: iso(now - rand() * 300000), outcomes: [
            { name: "Over", price: px(1 / (pOver * margin) * jig() * b("totals", 0)), point: 2.5 },
            { name: "Under", price: px(1 / ((1 - pOver) * margin) * jig() * b("totals", 1)), point: 2.5 }]
        });
        return { key, title, last_update: markets[0].last_update, markets };
      });
      const hour = 36e5, start = now + (2 + i * 5.5 + rand() * 3) * hour;
      return { id: "demo" + i, sport_key, sport_title, commence_time: iso(Math.round(start / 9e5) * 9e5), home_team: home, away_team: away, bookmakers };
    });
  };
})();
