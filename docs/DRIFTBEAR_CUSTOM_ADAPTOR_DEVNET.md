# DriftBear Custom Adaptor Devnet Verification

## Verified Setup

The following values were resolved from the current local devnet configuration and verified against live chain state.

### Core Addresses

- Wallet: `CnCAtrN1sMaTEQJfGQj5DNuBcZf4ibhYUYeAgBfBtYPL`
- Vault: `GRQrzTzz55Kd59uFSmW8mvkzUhzVTLCdjHGP4hnbxCna`
- Strategy: `FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY`
- Drift user: `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`
- Drift user stats: `B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X`
- Spot market: `6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3`
- Spot market vault: `GXWqPpjQpdz7KZw9p7f5PX2eGxHAhvpNXiviFkAB8zXg`
- Drift signer: `JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw`

## Verified Valuation

`npm run value:drift-position` resolved the current Drift spot deposit on devnet:

- User account: `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`
- Market index: `0`
- Subaccount id: `0`
- Scaled balance: `23096351975`
- Token amount: `20000000`
- UI value: `20`

This means the configured wallet currently has a live Drift spot deposit worth `20 USDC` on devnet.

## Remaining Account Order

### Initialize

1. `FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY`
2. `position PDA`
3. `5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN`
4. `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`
5. `B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X`
6. `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`

### Deposit

1. `CnCAtrN1sMaTEQJfGQj5DNuBcZf4ibhYUYeAgBfBtYPL`
2. `FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY`
3. `vault asset mint`
4. `strategy token ata`
5. `token program`
6. `position PDA`
7. `5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN`
8. `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`
9. `B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X`
10. `6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3`
11. `GXWqPpjQpdz7KZw9p7f5PX2eGxHAhvpNXiviFkAB8zXg`
12. `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`

### Withdraw

1. `CnCAtrN1sMaTEQJfGQj5DNuBcZf4ibhYUYeAgBfBtYPL`
2. `FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY`
3. `vault asset mint`
4. `strategy token ata`
5. `token program`
6. `position PDA`
7. `5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN`
8. `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`
9. `B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X`
10. `6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3`
11. `GXWqPpjQpdz7KZw9p7f5PX2eGxHAhvpNXiviFkAB8zXg`
12. `JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw`
13. `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`

## Next Step

The main remaining gap is executing the actual Ranger `initialize/deposit/withdraw` flow through the custom adaptor path, not just deriving and valuing it.

## Direct Adaptor Run (Devnet)

Executed the adaptor end-to-end against devnet Drift (subaccount `1`) using the direct workflow path:

Initial run (initialize + deposit + withdraw):

- Initialize tx: `3o8rLDXGQUyyyqLYJuMwAKaw6XE85wKk3DwcS5shDFH9BJP7s63L7HMjFGA2ajgWpq65H1AtUu1E6eDyFBaTDfTn`
- Deposit tx (1 USDC): `2FP3yhRCbP44rv5Qc3BL2ZuCGcQbfRtzW1ByvceGkJLksjoEfjn6zg7Mx663qdFuGnF655PVWzDPY9LJsWnGAf9c`
- Withdraw tx (0.5 USDC): `x4cW1c5UwgfFxQE9dyojSVmC79WQFZSQsP5dHZSgbMt4o2PQUmePkjcG68L3kZoR9cZKeMoU7s3bdaCSLukFLfY`

Re-run after wiring spot-market oracle into the remaining accounts:

- Deposit tx (1 USDC): `59zUbTtN7Cw9Zxec57px32Caw81NaQvEjinsNAiiCBzqf1sgXmsbmisbLKPS4vLM4kCgLon2QpjZ42jeWx2tSB8M`
- Withdraw tx (0.5 USDC): `5d1oGMU97cK2GHg8cVop4R1LEzNikPMZZZA1MPSDLDB8Q3tT1o9wmVq9HFpAsVM1YJvTEtUCBcH3k4KZmRsuqBor`

Re-run after adding subaccount locking + position migration (subaccount `1`):

- Position migrate (realloc + subaccount lock): `3drRLrfRD6XG81Sos8C49DveZMG9hFnFRuS5L8XUoLvRgsS16pMZ3tidudmYGUrKNwEcgcEWzTD7m3zp9dLq7HJP`
- Deposit tx (1 USDC): `5C1eN2yctzq4B2th7j3eszZ3ymy5kbGYGr8hmcUKY3CqEbpNpnKMTZDH4haCX3F7Y4dYXFVXG1M7VjemspLxYBjv`
- Withdraw tx (0.5 USDC): `vp7hBrvnCqL5QVU4YWFanaE2huRRpm9Nri9pb9FM3RRM61ECZdg68HAFbbXQLnce1yaTpeHoiei1xrzuaAbXJXc`

Note: subaccount `0` currently has perp exposure on this wallet, so the invariant checks require using a clean subaccount (e.g., `1`) for the custom adaptor flow.

This confirms the custom adaptor CPI flow against Drift works on devnet when driven directly. The remaining blocker for the full Ranger vault path is that the Voltr vault program (`vVoLTR...`) is not deployed on devnet.
