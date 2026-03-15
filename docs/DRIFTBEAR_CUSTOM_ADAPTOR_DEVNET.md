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
