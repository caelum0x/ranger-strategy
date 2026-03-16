module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: {
    node: true,
    es2020: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
  rules: {
    // Allow any for SDK interop (Drift/Anchor type conflicts)
    "@typescript-eslint/no-explicit-any": "off",
    // Allow require() for dynamic imports
    "@typescript-eslint/no-var-requires": "off",
    // Allow unused vars prefixed with _
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    // Allow empty catch blocks (used for non-critical error handling)
    "no-empty": ["error", { allowEmptyCatch: true }],
    // Prefer const
    "prefer-const": "warn",
    // No console in src/ (use logger instead) — warn only
    "no-console": ["warn", { allow: ["warn", "error"] }],
  },
  ignorePatterns: [
    "node_modules/",
    "dist/",
    "*.js",
    "scripts/",
    "**/*.test.ts",
    "anchor-decoder/",
    "ccxt/",
    "drift*/",
    "keeper-bots-v2/",
    "protocol-v2/",
    "pyth-crosschain/",
    "solana-agent-kit/",
    "ranger-agent-kit/",
    "hackathon-workshop-*/",
    "driftbear-*/",
    "examples/",
    "docs/",
    "docs-v2/",
    "v2-*/",
    "gateway/",
    "dlob-server/",
    "events-publisher/",
    "jit-proxy/",
    "jupiter-swap-api-client/",
    "hyperliquid-rust-sdk/",
    "hypertree/",
    "graphql-ws-client/",
    "order_book_server/",
    "orderly-connector-rs/",
    "raydium-clmm/",
    "sor-ts-demo/",
    "swift/",
    "titan-swap-api-client/",
    "keep-rs/",
    "distributor/",
    "ranger/",
  ],
};
