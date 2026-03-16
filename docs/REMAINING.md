# Remaining Work

## Current Direction

The repo now has a local self-indexing path for Ranger/Voltr vault telemetry:

- `src/indexer/server.ts` listens for Helius webhook events.
- `src/indexer/voltr-parser.ts` refreshes vault state from `@voltr/vault-sdk`.
- `src/indexer/db.ts` persists snapshots and decisions to `.ranger-state/indexer-state.json`.
- `src/indexer/ai-decision.ts` records an LLM-backed or heuristic rebalance recommendation.
- `scripts/create-helius-webhook.ts` registers the webhook against the configured vault.

## Remaining Code Gaps

1. Execute the full Ranger vault `initialize/deposit/withdraw` flow through the Voltr vault program (direct adaptor CPI on devnet is done; see `docs/DRIFTBEAR_CUSTOM_ADAPTOR_DEVNET.md`). **Blocked**: Voltr vault program not deployed on devnet.

### Completed (2026-03-16)

2. ~~Feed the latest indexed snapshot and decision into the live agent before each rebalance cycle.~~
   **Done**: `engine.evaluateVaultSnapshot()` now reacts to AUM drops (>5%/10%), share price below HWM, and high-confidence "reduce-risk" decisions. Vault risk multiplier scales position sizes from 0.3x–1.0x.
3. ~~Extend the decision engine with funding, volatility, and health-factor inputs from the existing Drift strategy modules.~~
   **Done**: `onChainAnalyses` (premium, imbalance, momentum) already passed to LLM advisor in `runCycle()` lines 164-172. Vault snapshot data now also included in LLM prompt context.
4. ~~Add a dashboard view for the indexed vault snapshots and rebalance recommendations.~~
   **Done**: HTML dashboard served at `/dashboard` with health grade, positions, yield, predictions, indexer status, AUM history, and LLM reasoning.

## Remaining Operational Gaps

1. Run the live vault on-chain during the judging window so Solscan shows recent activity.
2. Record and submit the mandatory demo video.
3. Verify the seeded-capital story stays fully on-chain in `drift-only` mode.
4. Register the production webhook with a public URL and confirm events are arriving.
5. Keep the verified devnet custom adaptor addresses and valuation in `docs/DRIFTBEAR_CUSTOM_ADAPTOR_DEVNET.md`.
