# DriftBear Neutral Farmer

Starter scaffold for the Ranger Build-A-Bear hackathon submission.

## Layout

- `setup/`: vault creation and strategy initialization notes plus starter config.
- `bot/`: rebalance bot starter files for the 50/50 DriftBear neutral strategy.

## Intended Flow

1. Configure admin and manager keys in `setup/src/variables.ts`.
2. Create the Ranger vault and initialize Drift/Jupiter strategies.
3. Configure the bot in `bot/.env.example`, `bot/strategies.json`, and `bot/src/rebalance_loop.ts`.
4. Run the integrated repo agent or adapt this scaffold into a standalone deployment.

This scaffold is local-only. It does not clone external repos automatically.
