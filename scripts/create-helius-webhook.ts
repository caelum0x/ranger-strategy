import dotenv from "dotenv";
import { config } from "../src/config";

dotenv.config();

async function main(): Promise<void> {
  if (!config.heliusApiKey) {
    throw new Error("HELIUS_API_KEY is required");
  }
  if (!config.webhookUrl) {
    throw new Error("WEBHOOK_URL is required");
  }
  if (!config.vaultPubkey) {
    throw new Error("VAULT_PUBKEY is required");
  }

  const response = await fetch(
    `https://api.helius.xyz/v0/webhooks?api-key=${config.heliusApiKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        webhookURL: config.webhookUrl,
        accountAddresses: [config.vaultPubkey],
        transactionTypes: ["Any"],
        webhookType: "enhanced",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Helius webhook creation failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
