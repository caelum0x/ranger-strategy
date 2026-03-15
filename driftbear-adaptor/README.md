# DriftBear Custom Adaptor

Drift-targeted Anchor adaptor for Ranger-style vault composition, using the
Workshop 2 contract shape but pointing at Drift's real `deposit` and `withdraw`
instruction layout instead of the mock cToken market.

## What Changed

- `programs/driftbear_custom_adaptor/` now builds manual CPI instructions for
  Drift `deposit` and `withdraw`
- adaptor state is stored in a PDA `AdaptorPosition`, keyed by the vault
  strategy address
- the mock cToken program remains in the workspace only as workshop reference

## Current Scope

The adaptor now targets the real Drift program ID and real Drift account graph
for spot deposit / withdraw:

1. `initialize(market_index)` creates the adaptor PDA for a strategy
2. `deposit(amount)` CPIs into Drift `deposit`
3. `withdraw(amount)` CPIs into Drift `withdraw`

The PDA still tracks a nominal balance for bookkeeping, but the adaptor now
returns the **interest-adjusted underlying token amount** on `deposit` and
`withdraw` by decoding the Drift user spot position plus the spot market's
cumulative interest state on-chain.

For exact current valuation off-chain, use:

```bash
npm run value:drift-position
```

That script reads the live Drift user + spot market state and converts the
interest-adjusted spot balance into underlying token amount and quote value.

## Required Accounts

The caller must supply the real Drift accounts:

- `drift_state`
- `drift_user`
- `drift_user_stats`
- `spot_market`
- `spot_market_vault`
- `drift_signer` for withdraw
- `drift_program`

The vault strategy authority must arrive as a signer so signer privilege can
flow through the adaptor CPI into Drift.

## Client Wiring

There is now a helper script to derive the real Drift accounts and the exact
ordered account list expected by the adaptor:

```bash
npm run derive:drift-accounts
```

Required env:

- `HELIUS_RPC_URL` or `SOLANA_RPC_URL`
- `ANCHOR_WALLET` or `KEYPAIR_PATH`
- `STRATEGY_PUBKEY`
- optional `DRIFT_MARKET_INDEX`
- optional `DRIFT_SUBACCOUNT_ID`

The same env is used by `npm run value:drift-position`.

## Status

This is no longer the mock workshop path, but it is still not a finished
production adaptor. The major remaining gap is full client wiring for Ranger's
remaining-account ordering in the live vault flow.
