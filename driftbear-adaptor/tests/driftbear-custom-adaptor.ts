import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

describe("driftbear_custom_adaptor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const adaptorProgram = anchor.workspace
    .DriftbearCustomAdaptor as Program;

  it("scaffold reminder", async () => {
    // This is intentionally a scaffold test.
    // The critical implementation detail from Workshop 2 is that the vault's
    // fixed accounts come first and the protocol-specific accounts are passed
    // as remaining accounts in the exact order expected by the adaptor.
    //
    // Fill this test with:
    // 1. mock market + receipt mint PDA setup
    // 2. initialize call with remaining accounts
    // 3. deposit call with the same ordered protocol accounts
    // 4. withdraw call with the same ordered protocol accounts
    //
    // Keep the account order in sync with the Rust contexts.
    void adaptorProgram;
  });
});
