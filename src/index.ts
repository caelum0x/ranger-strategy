import { logger } from "./utils/logger";

logger.info("Ranger Delta-Neutral Vault Strategy");
logger.info("====================================");
logger.info("");
logger.info("Available commands:");
logger.info("  npm run agent          — Start the AI strategy agent");
logger.info("  npm run backtest       — Run historical backtest");
logger.info("  npm run vault:init     — Initialize Ranger Earn vault");
logger.info("  npm run vault:deposit  — Deposit USDC into vault");
logger.info("  npm run vault:withdraw — Withdraw from vault");
logger.info("  npm run vault:status   — Check vault status");
logger.info("  npm run drift:status   — Check Drift account & vault status");
logger.info("  npm run drift:init-vault — Create Drift vault for delegate trading");
logger.info("  npm run export-trades  — Export trade history for submission");
logger.info("");
logger.info("See README.md and docs/ for documentation.");
