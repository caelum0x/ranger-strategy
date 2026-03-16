import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx } from "../utils/helper";
import { VoltrClient, VaultConfigField } from "@voltr/vault-sdk";
import {
  vaultAddress,
  vaultConfigUpdateField,
  vaultConfigUpdateValue,
} from "../../config/base";
import { BN } from "@coral-xyz/anchor";

const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const adminKpData = JSON.parse(adminKpFile);
const adminSecret = Uint8Array.from(adminKpData);
const adminKp = Keypair.fromSecretKey(adminSecret);
const admin = adminKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

/**
 * Serializes the vault config value based on the field type
 */
const serializeVaultConfigValue = (
  field: VaultConfigField,
  value: any
): Buffer => {
  switch (field) {
    // u64 fields (8 bytes, little-endian)
    case VaultConfigField.MaxCap:
    case VaultConfigField.StartAtTs:
    case VaultConfigField.LockedProfitDegradationDuration:
    case VaultConfigField.WithdrawalWaitingPeriod:
      if (!(value instanceof BN)) {
        throw new Error(`Expected BN for field ${field}, got ${typeof value}`);
      }
      return value.toArrayLike(Buffer, "le", 8);

    // u16 fields (2 bytes, little-endian)
    case VaultConfigField.ManagerPerformanceFee:
    case VaultConfigField.AdminPerformanceFee:
    case VaultConfigField.ManagerManagementFee:
    case VaultConfigField.AdminManagementFee:
    case VaultConfigField.RedemptionFee:
    case VaultConfigField.IssuanceFee:
    case VaultConfigField.DisabledOperations:
      if (typeof value !== "number") {
        throw new Error(
          `Expected number for field ${field}, got ${typeof value}`
        );
      }
      const buffer = Buffer.alloc(2);
      buffer.writeUInt16LE(value, 0);
      return buffer;

    // PublicKey fields (32 bytes)
    case VaultConfigField.Manager:
    case VaultConfigField.PendingAdmin:
      if (!(value instanceof PublicKey)) {
        throw new Error(
          `Expected PublicKey for field ${field}, got ${typeof value}`
        );
      }
      return value.toBuffer();

    default:
      throw new Error(`Unknown vault config field: ${field}`);
  }
};

const updateVaultConfigHandler = async () => {
  // Serialize the value based on field type
  const data = serializeVaultConfigValue(
    vaultConfigUpdateField,
    vaultConfigUpdateValue
  );

  // const vaultLpMint = vc.findVaultLpMint(vault); // needed for management fees update

  const updateVaultConfigIx = await vc.createUpdateVaultConfigIx(
    vaultConfigUpdateField,
    data,
    {
      vault,
      admin,
      // vaultLpMint, // needed for management fees update
    }
  );

  const txSig = await sendAndConfirmOptimisedTx(
    [updateVaultConfigIx],
    process.env.HELIUS_RPC_URL!,
    adminKp
  );

  console.log(
    `Vault config field '${vaultConfigUpdateField}' updated with signature: ${txSig}`
  );
};

const main = async () => {
  await updateVaultConfigHandler();
};

main();
