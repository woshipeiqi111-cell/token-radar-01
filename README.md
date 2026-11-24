# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/woshipeiqi111-cell/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/woshipeiqi111-cell/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)


A token launch radar for make.fun's "Build the best token launch radar" bounty. It reads a sealed DefiLlama snapshot of 758 protocols, fits a comps model on the 128 live-token protocols that carry a market cap, and ranks all 198 rankable pre-token protocols by implied value — the comps value times the launch odds — with a costed farm verdict for every row.

Model (radar-2), fitted at run time from the snapshot itself:

- `log(market cap) = b0 + b1·ln(TVL) + b2·(7d growth/100) + b3·ln(1 + age/365) + b4·chains`, fitted by OLS on the live-token comps. Fitted betas on this snapshot: `[7.357, 0.494, -3.982, -0.320, 0.014]`.
- Blind tests, run by the program itself: leave-one-out ×3.64, walk-forward ×2.62 (trained on older tokens, tested on newer ones). The starter's flat 0.25× model scores ×5.11 / ×5.26 on the same tests. Category dummies and growth-squared were tried and dropped — they overfit.
- Launch odds by age band, from the peers' own record (share of protocols first listed in that band that still record no token): 74% under 6 months, 60% at 6–12 months, 62% at 1–2 years, 45% at 2–3 years, 21% past 3 years.
- P10–P90 ranges from the leave-one-out residuals; they cover 80% of held-out live tokens.
- Farm verdicts: gas by chain, capital by TVL tier, opportunity cost at a 4.5% T-bill rate, assuming a 5% airdrop pool split among 20,000 farmers (sensitivity shown on the dashboard: 69 FARM at 5,000 farmers, 2 at 50,000). Verdicts on this snapshot: 6 FARM, 75 THIN, 117 SKIP.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18 or later, standard library only. `main.ts` reads the snapshot, writes `board.json` (198 rows), `data.js`, copies `dashboard/` and `screenshots/`, and writes `dossier.json`. Open `out/dashboard/index.html` in a browser to use the board: sortable, filterable, with a detail view for every protocol.

---

<sub>Entered on [make.fun](https://make.fun/?ref=75k23xv8&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
