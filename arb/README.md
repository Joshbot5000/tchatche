# Arbiter — sure bet scanner

A static web app that compares bookmaker odds for the same fixture and finds arbitrage ("sure bet") opportunities, football first. It runs entirely in your browser: no server, no AI, no account.

## Use it

1. Get a free key from [The Odds API](https://the-odds-api.com/#get-access) (500 credits a month).
2. Open `arb/index.html` (or `<your GitHub Pages site>/arb/`), paste the key, press **Scan odds**.
3. Open a sure bet, check each price at the bookmaker, type in what you see, and place every leg straight away.

No key yet? Choose **explore with sample data** (made-up prices, for looking around only).

## What it checks

- **Match result (1X2), total goals, handicaps**: backs each outcome at whichever firm pays most. Totals and handicaps are only paired on the identical line.
- **Back / lay**: back at a bookmaker, lay the same result on an exchange.
- **Exchange commission** is deducted before prices are compared.
- **Stale prices** (default: older than 15 minutes), in-play fixtures, incomplete or malformed markets are dropped.
- **Whole and quarter lines** that can refund stakes are skipped unless you turn that off.
- **Rounded stakes**: every round-up/round-down combination is tested and the best worst case is kept.
- Margins above 10% are flagged as probable pricing errors.

## Credits

One scan costs `leagues × markets × regions` credits. The default (7 leagues, 2 markets, UK) is 14. Settings shows the cost and what you have left. Re-opening the app shows the last scan without spending anything.

## Limits you should know

Arbitrage is only risk-free if every bet is accepted at the price shown. Prices move, bookmakers cap stakes, restrict accounts that arb, and may void bets on obvious errors. The data feed is not instantaneous. Treat every result as a lead to verify, not a promise. 18+. [BeGambleAware.org](https://www.begambleaware.org)

## Tests

    node --test arb/tests/engine.test.cjs
