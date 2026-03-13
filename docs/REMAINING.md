 ---
  A. Hard Blockers (require external action, not code)

  1. No on-chain trade history
  Judges will "verify trade activity and performance directly on-chain via Solscan." Without deploying and trading during Mar 9 – Apr 6,
  there's nothing to verify. Backtest is accepted but explicitly "less preferred."

  2. No CEX trade history
  Need actual Binance trades + CSV export + read-only API key for judges. The export-trades script exists but there's nothing to export
  without live trading.

  3. Demo video is mandatory
  Submission says "Submit all of the following." It's not optional — it's a gate to be considered at all.

  4. No deployed Ranger Earn vault
  The whole point is strategies deployed "on Ranger Earn." Without a live vault on their platform, production viability scores zero.

  ---
  B. Strategic Weaknesses Judges Will Flag

  5. Binance custody risk kills scalability
  If you win 1st place, they seed $500K. That capital needs to be on-chain in a Ranger vault. But your strategy requires half of it to sit on
   Binance (a CEX). Judges will ask: "How do we seed a vault where half the funds are custodied off-chain on Binance?" This is the single
  biggest structural problem — the strategy's cross-venue nature conflicts with the on-chain vault seeding model.

  6. Delta-neutral basis trade is commoditized
  Every quant team at this hackathon knows this strategy. It's textbook. The "AI" layer (regime detection, confidence scoring) adds marginal
  differentiation but isn't a genuine novel primitive. Judges score "Novelty & Innovation" as a criterion.

  7. No CPI / Custom Adaptor
  Workshop 2 is literally about "Compose with Ranger Vaults via CPI / Custom Adaptors." Teams that build custom on-chain adaptors will score
  higher on "Technical Implementation" and "vault architecture." Our approach is purely off-chain agent-based.

  8. 10% APY guarantee is fragile
  Funding rates can stay negative for weeks in bear markets. The minimum 10% APY requirement is a hard eligibility gate. If the backtest
  doesn't show 10%+ consistently across different market regimes, the submission is disqualified.

  ---
  C. Operational Gaps

  9. No multisig / key management story
  Judges evaluating "Production Viability" will note single-key operation. The Cobo MPC wallet workshop (Workshop 4) was specifically about
  this — teams using Cobo MPC will score higher on security.

  10. Capital efficiency
  Split capital across Drift + Binance means neither leg is fully collateralized. With $20 USDC total, you're splitting $10/$10. Slippage and
   minimum order sizes may make small-capital execution impractical.

  11. Settlement timing mismatch
  Drift settles funding hourly, Binance every 8h. The delta-neutral position accrues basis risk between settlement windows. No code handles
  this timing gap explicitly.

  ---
  D. What You Can Still Do (code + some effort)

  ┌───────────────────────┬───────────────────────────────────────────────────────────────────────────┬──────────────────────────────┐
  │          Gap          │                                    Fix                                    │            Effort            │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ On-chain verification │ Deploy with $20, run agent for a few days                                 │ Medium (need SOL + USDC)     │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ CEX verification      │ Make a few real trades on Binance                                         │ Medium (need funded account) │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ Demo video            │ 3-min screen recording + voiceover                                        │ Low                          │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ Scalability concern   │ Add documentation about how vault-seeded capital would work               │ Low                          │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ Novelty               │ Emphasize the AI funding prediction + on-chain analysis as differentiator │ Low                          │
  ├───────────────────────┼───────────────────────────────────────────────────────────────────────────┼──────────────────────────────┤
  │ Backtest APY proof    │ Run backtest, save JSON, include in submission                            │ Low (code is ready)          │
  └───────────────────────┴───────────────────────────────────────────────────────────────────────────┴──────────────────────────────┘

  ---
  ┌─────┬───────────────────────────────────┬────────────────────────────────────────────────────────────────┐
  │  #  │               Issue               │                            Code Fix                            │
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ 5   │ Binance custody kills seedability │ Add Drift-only mode — both legs on Drift, fully on-chain       │
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ 6   │ Basis trade is commoditized       │ Enhance AI layer — funding momentum, trend scoring             │
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ 8   │ 10% APY fragile                   │ Bi-directional funding — reverse when negative, always collect │                               
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤
  │ 9   │ No key management story           │ Add Cobo MPC wallet abstraction                                │                               
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤                             
  │ 10  │ Capital split inefficiency        │ Fixed by Drift-only mode                                       │                               
  ├─────┼───────────────────────────────────┼────────────────────────────────────────────────────────────────┤                               
  │ 11  │ Settlement timing mismatch        │ Add settlement-aware rebalancing                               │                               
  └─────┴───────────────────────────────────┴────────────────────────────────────────────────────────────────┘                               
                                                                                         