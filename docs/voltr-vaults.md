Voltr SDK
Voltr SDK
A TypeScript SDK for interacting with the Voltr protocol on Solana.

Features
Complete TypeScript support with type definitions
Comprehensive vault management functionality
Strategy handling and execution with adaptor support
Asset deposit and withdrawal operations with direct withdraw capability
Account data fetching and PDA (Program Derived Address) utilities
Position and total value tracking
Installation
npm install @voltr/vault-sdk
Copy
Quick Start
import { Connection } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";

// Initialize client
const connection = new Connection("https://api.mainnet-beta.solana.com");
const client = new VoltrClient(connection);
Copy
Usage Examples
Initialize a New Vault
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

// Create vault initialization parameters
const vaultParams = {
  config: {
    maxCap: new BN("1000000000"),
    startAtTs: new BN(Math.floor(Date.now() / 1000)),
    lockedProfitDegradationDuration: new BN(3600), // 1 hour
    managerManagementFee: 50, // 0.5%
    managerPerformanceFee: 1000, // 10%
    adminManagementFee: 50, // 0.5%
    adminPerformanceFee: 1000, // 10%
    redemptionFee: 10, // 0.1%
    issuanceFee: 10, // 0.1%
    withdrawalWaitingPeriod: new BN(3600), // 1 hour
  },
  name: "My Vault",
  description: "Example vault",
};

// Create initialization instruction
const ix = await client.createInitializeVaultIx(vaultParams, {
  vault: vaultKeypair,
  vaultAssetMint: new PublicKey("..."),
  admin: adminPubkey,
  manager: managerPubkey,
  payer: payerPubkey,
});
Copy
Update Vault Configuration
import { VaultConfigField } from "@voltr/vault-sdk";

// Update max cap
const maxCapData = client.serializeU64(new BN(20_000_000_000_000));
const maxCapIx = await client.createUpdateVaultConfigIx(
  VaultConfigField.MaxCap,
  maxCapData,
  {
    vault: vaultPubkey,
    admin: adminPubkey,
  }
);

// Update withdrawal waiting period
const waitingPeriodData = client.serializeU64(new BN(5_000));
const waitingPeriodIx = await client.createUpdateVaultConfigIx(
  VaultConfigField.WithdrawalWaitingPeriod,
  waitingPeriodData,
  {
    vault: vaultPubkey,
    admin: adminPubkey,
  }
);

// Update manager management fee (requires LP mint)
const vaultLpMint = client.findVaultLpMint(vaultPubkey);
const feeData = client.serializeU16(1000); // 10%
const feeIx = await client.createUpdateVaultConfigIx(
  VaultConfigField.ManagerManagementFee,
  feeData,
  {
    vault: vaultPubkey,
    admin: adminPubkey,
    vaultLpMint: vaultLpMint,
  }
);

// Update issuance fee
const issuanceFeeData = client.serializeU16(75); // 0.75%
const issuanceFeeIx = await client.createUpdateVaultConfigIx(
  VaultConfigField.IssuanceFee,
  issuanceFeeData,
  {
    vault: vaultPubkey,
    admin: adminPubkey,
  }
);

// Update vault manager
const newManager = new PublicKey("...");
const managerData = client.serializePubkey(newManager);
const managerIx = await client.createUpdateVaultConfigIx(
  VaultConfigField.Manager,
  managerData,
  {
    vault: vaultPubkey,
    admin: adminPubkey,
  }
);
Copy
Available Vault Config Fields
VaultConfigField.MaxCap - Maximum vault capacity (u64)
VaultConfigField.StartAtTs - Vault start timestamp (u64)
VaultConfigField.LockedProfitDegradationDuration - Locked profit degradation duration (u64)
VaultConfigField.WithdrawalWaitingPeriod - Withdrawal waiting period (u64)
VaultConfigField.ManagerPerformanceFee - Manager performance fee in BPS (u16)
VaultConfigField.AdminPerformanceFee - Admin performance fee in BPS (u16)
VaultConfigField.ManagerManagementFee - Manager management fee in BPS (u16, requires LP mint)
VaultConfigField.AdminManagementFee - Admin management fee in BPS (u16, requires LP mint)
VaultConfigField.RedemptionFee - Redemption fee in BPS (u16)
VaultConfigField.IssuanceFee - Issuance fee in BPS (u16)
VaultConfigField.Manager - Vault manager (PublicKey)
Note: When updating ManagerManagementFee or AdminManagementFee, you must provide the vaultLpMint parameter as these operations charge management fees and require reading the LP mint supply.

Strategy Management
// Add an adaptor to a vault
const addAdaptorIx = await client.createAddAdaptorIx({
  vault: vaultPubkey,
  payer: payerPubkey,
  admin: adminPubkey,
  adaptorProgram: adaptorProgramPubkey,
});

// Initialize a strategy
const initStrategyIx = await client.createInitializeStrategyIx(
  {
    instructionDiscriminator: null,
    additionalArgs: null,
  },
  {
    payer: payerPubkey,
    vault: vaultPubkey,
    manager: managerPubkey,
    strategy: strategyPubkey,
    adaptorProgram: adaptorProgramPubkey,
    remainingAccounts: [],
  }
);

// Initialize direct withdraw strategy
const initDirectWithdrawIx =
  await client.createInitializeDirectWithdrawStrategyIx(
    {
      instructionDiscriminator: null,
      additionalArgs: null,
      allowUserArgs: true,
    },
    {
      payer: payerPubkey,
      admin: adminPubkey,
      vault: vaultPubkey,
      strategy: strategyPubkey,
      adaptorProgram: adaptorProgramPubkey,
    }
  );
Copy
Asset Operations
// Deposit assets
const depositIx = await client.createDepositVaultIx(new BN("1000000000"), {
  userTransferAuthority: userPubkey,
  vault: vaultPubkey,
  vaultAssetMint: mintPubkey,
  assetTokenProgram: tokenProgramPubkey,
});

// Request withdraw assets
const requestWithdrawIx = await client.createRequestWithdrawVaultIx(
  {
    amount: new BN("1000000000"),
    isAmountInLp: false,
    isWithdrawAll: false,
  },
  {
    payer: payerPubkey,
    userTransferAuthority: userPubkey,
    vault: vaultPubkey,
  }
);

// Cancel withdraw request
const cancelRequestWithdrawIx = await client.createCancelRequestWithdrawVaultIx(
  {
    userTransferAuthority: userPubkey,
    vault: vaultPubkey,
  }
);

// Withdraw from vault
const withdrawIx = await client.createWithdrawVaultIx({
  userTransferAuthority: userPubkey,
  vault: vaultPubkey,
  vaultAssetMint: mintPubkey,
  assetTokenProgram: tokenProgramPubkey,
});

// Direct withdraw from strategy
const directWithdrawIx = await client.createDirectWithdrawStrategyIx(
  {
    userArgs: null,
  },
  {
    user: userPubkey,
    vault: vaultPubkey,
    strategy: strategyPubkey,
    vaultAssetMint: mintPubkey,
    assetTokenProgram: tokenProgramPubkey,
    adaptorProgram: adaptorProgramPubkey,
    remainingAccounts: [],
  }
);
Copy
Position and Value Tracking
// Get position and total values for a vault
const values = await client.getPositionAndTotalValuesForVault(vaultPubkey);
console.log(`Total Value: ${values.totalValue}`);
console.log("Strategy Positions:", values.strategies);
Copy
Asset Calculation Utilities
// Calculate the amount of assets that would be received for a given LP token amount
const assetsToReceive = await client.calculateAssetsForWithdraw(
  vaultPubkey,
  new BN("1000000000")
);
console.log(`Assets to receive: ${assetsToReceive.toString()}`);

// Calculate the amount of LP tokens needed to withdraw a specific asset amount
const lpTokensRequired = await client.calculateLpForWithdraw(
  vaultPubkey,
  new BN("1000000000")
);
console.log(`LP tokens required: ${lpTokensRequired.toString()}`);

// Calculate the amount of LP tokens that would be received for a deposit
const lpTokensToReceive = await client.calculateLpForDeposit(
  vaultPubkey,
  new BN("1000000000")
);
console.log(`LP tokens to receive: ${lpTokensToReceive.toString()}`);
Copy
Querying Pending Withdrawals
// Get all pending withdrawals for a vault
const pendingWithdrawals = await client.getAllPendingWithdrawalsForVault(
  vaultPubkey
);

// Process the pending withdrawals
pendingWithdrawals.forEach((withdrawal, index) => {
  console.log(`Withdrawal ${index + 1}:`);
  console.log(`  Asset amount: ${withdrawal.amountAssetToWithdraw}`);

  // Check if withdrawal is available yet
  const withdrawableTimestamp = withdrawal.withdrawableFromTs.toNumber();
  const currentTime = Math.floor(Date.now() / 1000);
  const isWithdrawable = currentTime >= withdrawableTimestamp;

  console.log(
    `  Withdrawable from: ${new Date(
      withdrawableTimestamp * 1000
    ).toLocaleString()}`
  );
  console.log(`  Status: ${isWithdrawable ? "Available now" : "Pending"}`);
  if (!isWithdrawable) {
    const timeRemaining = Math.max(0, withdrawableTimestamp - currentTime);
    console.log(
      `  Time remaining: ${Math.floor(timeRemaining / 3600)}h ${Math.floor(
        (timeRemaining % 3600) / 60
      )}m`
    );
  }
});

// Get pending withdrawal for a specific user
const userWithdrawal = await client.getPendingWithdrawalForUser(
  vaultPubkey,
  userPubkey
);
console.log(`User withdrawal amount: ${userWithdrawal.amountAssetToWithdrawEffective}`);
Copy
Fee Management
// Calibrate high water mark (admin only)
const calibrateIx = await client.createCalibrateHighWaterMarkIx({
  vault: vaultPubkey,
  admin: adminPubkey,
});

// Get current high water mark
const highWaterMark = await client.getHighWaterMarkForVault(vaultPubkey);
console.log(`Highest asset per LP: ${highWaterMark.highestAssetPerLp}`);
console.log(
  `Last updated: ${new Date(highWaterMark.lastUpdatedTs * 1000).toLocaleString()}`
);

// Get current asset per LP
const currentAssetPerLp =
  await client.getCurrentAssetPerLpForVault(vaultPubkey);
console.log(`Current asset per LP: ${currentAssetPerLp}`);

// Harvest accumulated fees
const harvestIx = await client.createHarvestFeeIx({
  harvester: harvesterPubkey,
  vaultManager: managerPubkey,
  vaultAdmin: adminPubkey,
  protocolAdmin: protocolAdminPubkey,
  vault: vaultPubkey,
});

// Get accumulated fees
const adminFees = await client.getAccumulatedAdminFeesForVault(vaultPubkey);
const managerFees = await client.getAccumulatedManagerFeesForVault(vaultPubkey);
console.log(`Admin fees: ${adminFees.toString()}`);
console.log(`Manager fees: ${managerFees.toString()}`);
Copy
Helper Methods
Serialization Helpers
The SDK provides helper methods to serialize values for vault configuration updates:

// Serialize u64 values (for amounts, timestamps, etc.)
const u64Data = client.serializeU64(new BN(20_000_000_000_000));

// Serialize u16 values (for fee percentages in basis points)
const u16Data = client.serializeU16(1000); // 10%

// Serialize PublicKey values (for manager updates)
const pubkeyData = client.serializePubkey(new PublicKey("..."));
Copy
API Reference
VoltrClient Methods
Vault Management
createInitializeVaultIx(vaultParams, params) - Initialize a new vault
createUpdateVaultIx(vaultConfig, params) - Deprecated: Update vault (use createUpdateVaultConfigIx instead)
createUpdateVaultConfigIx(field, data, params) - Update a specific vault configuration field
createDepositVaultIx(amount, params) - Deposit assets into vault
createRequestWithdrawVaultIx(requestWithdrawArgs, params) - Request withdrawal from vault
createCancelRequestWithdrawVaultIx(params) - Cancel a pending withdrawal request
createWithdrawVaultIx(params) - Execute a withdrawal from vault
createHarvestFeeIx(params) - Harvest accumulated fees
createCalibrateHighWaterMarkIx(params) - Calibrate the high water mark
createCreateLpMetadataIx(createLpMetadataArgs, params) - Create LP token metadata
Strategy Management
createAddAdaptorIx(params) - Add an adaptor to a vault
createInitializeStrategyIx(initArgs, params) - Initialize a new strategy
createDepositStrategyIx(depositArgs, params) - Deposit assets into a strategy
createWithdrawStrategyIx(withdrawArgs, params) - Withdraw assets from a strategy
createInitializeDirectWithdrawStrategyIx(initArgs, params) - Initialize direct withdraw for a strategy
createDirectWithdrawStrategyIx(withdrawArgs, params) - Execute direct withdrawal from a strategy
createCloseStrategyIx(params) - Close a strategy
createRemoveAdaptorIx(params) - Remove an adaptor from a vault
Account Data
fetchVaultAccount(vault) - Fetch vault account data
fetchStrategyInitReceiptAccount(strategyInitReceipt) - Fetch strategy initialization receipt
fetchAdaptorAddReceiptAccount(adaptorAddReceipt) - Fetch adaptor add receipt
fetchRequestWithdrawVaultReceiptAccount(requestWithdrawVaultReceipt) - Fetch withdrawal request receipt
fetchAllStrategyInitReceiptAccounts() - Fetch all strategy receipts
fetchAllStrategyInitReceiptAccountsOfVault(vault) - Fetch all strategy receipts for a vault
fetchAllAdaptorAddReceiptAccountsOfVault(vault) - Fetch all adaptor receipts for a vault
fetchAllRequestWithdrawVaultReceiptsOfVault(vault) - Fetch all withdrawal requests for a vault
getPositionAndTotalValuesForVault(vault) - Get position values and total vault value
getAccumulatedAdminFeesForVault(vault) - Get accumulated admin fees
getAccumulatedManagerFeesForVault(vault) - Get accumulated manager fees
getPendingWithdrawalForUser(vault, user) - Get pending withdrawal for a specific user
getAllPendingWithdrawalsForVault(vault) - Get all pending withdrawals for a vault
getCurrentAssetPerLpForVault(vault) - Get current asset per LP ratio
getHighWaterMarkForVault(vault) - Get high water mark information
PDA Finding
findVaultLpMint(vault) - Find vault LP mint address
findVaultAssetIdleAuth(vault) - Find vault asset idle authority
findVaultAddresses(vault) - Find all vault-related addresses
findVaultStrategyAuth(vault, strategy) - Find vault strategy authority
findStrategyInitReceipt(vault, strategy) - Find strategy initialization receipt
findDirectWithdrawInitReceipt(vault, strategy) - Find direct withdraw receipt
findVaultStrategyAddresses(vault, strategy) - Find all strategy-related addresses
findRequestWithdrawVaultReceipt(vault, user) - Find withdrawal request receipt
findLpMetadataAccount(vault) - Find LP metadata account
Calculations
calculateAssetsForWithdraw(vaultPk, lpAmount) - Calculate asset amount for LP tokens
calculateLpForWithdraw(vaultPk, assetAmount) - Calculate LP tokens needed for asset amount
calculateLpForDeposit(vaultPk, assetAmount) - Calculate LP tokens received for deposit
Helper Methods
serializeU64(value) - Serialize a u64 value to Buffer
serializeU16(value) - Serialize a u16 value to Buffer
serializePubkey(pubkey) - Serialize a PublicKey to Buffer
getBalance(publicKey) - Get account balance in lamports
License
Overview
This documentation covers Cross-Program Invocation (CPI) integration for Voltr Vault, a yield-bearing vault protocol. Users can deposit assets into a vault to receive LP tokens, which represent their share of the vault's total assets. Withdrawing assets is a two-step process designed to ensure vault stability and manage liquidity.

Deployed Addresses
Network	Program Address	Link
Mainnet	vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8	voltr-vault
Core CPI Functions
1. Deposit Flow
deposit_vault - Deposit assets into the vault and receive LP tokens.
2. Withdrawal Flow (Two-Step)
request_withdraw_vault - Initiate a withdrawal request, locking LP tokens into a receipt.
withdraw_vault - Finalize the withdrawal after the waiting period has passed, burning the locked LP tokens to receive the underlying assets.
3. Cancel Withdrawal
cancel_request_withdraw_vault - Cancel a pending withdrawal request, refunding LP tokens to the user.
4. Instant Withdrawal
instant_withdraw_vault - Withdraw assets instantly without a waiting period (only available for vaults with zero withdrawal waiting period).
1. Deposit Vault CPI Integration
This function allows a user to deposit an underlying asset into the vault and mint a corresponding amount of LP tokens.

Function Discriminator
fn get_deposit_vault_discriminator() -> [u8; 8] {
    // discriminator = sha256("global:deposit_vault")[0..8]
    [41, 158, 82, 88, 95, 140, 106, 154]
}
deposit_vault CPI Struct
use anchor_lang::prelude::*;
use anchor_spl::{token, token_interface};

pub struct DepositVaultParams<'info> {
    pub user_transfer_authority: AccountInfo<'info>,
    pub protocol: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub vault_asset_mint: AccountInfo<'info>,
    pub vault_lp_mint: AccountInfo<'info>,
    pub user_asset_ata: AccountInfo<'info>,
    pub vault_asset_idle_ata: AccountInfo<'info>,
    pub vault_asset_idle_auth: AccountInfo<'info>,
    pub user_lp_ata: AccountInfo<'info>,
    pub vault_lp_mint_auth: AccountInfo<'info>,
    pub asset_token_program: AccountInfo<'info>,
    pub lp_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    // Target Voltr Vault program
    pub voltr_vault_program: AccountInfo<'info>,
}
Implementation
The CPI call requires passing all accounts specified in the instruction. The user_transfer_authority must sign the transaction. The vault's internal PDAs (vault_asset_idle_auth, vault_lp_mint_auth) will be signed for by the Voltr Vault program itself during the CPI.

impl<'info> DepositVaultParams<'info> {
    pub fn deposit_vault(&self, amount: u64) -> Result<()> {
        let mut instruction_data = get_deposit_vault_discriminator().to_vec();
        instruction_data.extend_from_slice(&amount.to_le_bytes());

        let account_metas = vec![
            AccountMeta::new_readonly(*self.user_transfer_authority.key, true),
            AccountMeta::new_readonly(*self.protocol.key, false),
            AccountMeta::new(*self.vault.key, false),
            AccountMeta::new_readonly(*self.vault_asset_mint.key, false),
            AccountMeta::new(*self.vault_lp_mint.key, false),
            AccountMeta::new(*self.user_asset_ata.key, false),
            AccountMeta::new(*self.vault_asset_idle_ata.key, false),
            AccountMeta::new_readonly(*self.vault_asset_idle_auth.key, false),
            AccountMeta::new(*self.user_lp_ata.key, false),
            AccountMeta::new_readonly(*self.vault_lp_mint_auth.key, false),
            AccountMeta::new_readonly(*self.asset_token_program.key, false),
            AccountMeta::new_readonly(*self.lp_token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
        ];

        let instruction = Instruction {
            program_id: *self.voltr_vault_program.key,
            accounts: account_metas,
            data: instruction_data,
        };

        invoke(
            &instruction,
            &[
                self.user_transfer_authority.clone(),
                self.protocol.clone(),
                self.vault.clone(),
                self.vault_asset_mint.clone(),
                self.vault_lp_mint.clone(),
                self.user_asset_ata.clone(),
                self.vault_asset_idle_ata.clone(),
                self.vault_asset_idle_auth.clone(),
                self.user_lp_ata.clone(),
                self.vault_lp_mint_auth.clone(),
                self.asset_token_program.clone(),
                self.lp_token_program.clone(),
                self.system_program.clone(),
            ],
        )?;
        Ok(())
    }
}
Full snippet available here

deposit_vault Account Explanations
Account	Mutability	Signer	Purpose
user_transfer_authority	Immutable	Yes	The user depositing assets.
protocol	Immutable	No	The global Voltr protocol state account.
vault	Mutable	No	The target vault state account.
vault_asset_mint	Immutable	No	The mint of the asset being deposited.
vault_lp_mint	Mutable	No	The LP mint for the vault, representing shares.
user_asset_ata	Mutable	No	The user's ATA for the asset (source).
vault_asset_idle_ata	Mutable	No	The vault's idle ATA for the asset (destination).
vault_asset_idle_auth	Immutable	No	The PDA authority over the vault_asset_idle_ata.
user_lp_ata	Mutable	No	The user's ATA for the LP token (destination).
vault_lp_mint_auth	Immutable	No	The PDA authority for minting LP tokens.
asset_token_program	Immutable	No	The Token Program or Token-2022 Program for assets.
lp_token_program	Immutable	No	The Token Program for LP tokens.
system_program	Immutable	No	The Solana System Program.
2. Withdrawal Flow CPI Integration
Step 1: request_withdraw_vault
This function initiates a withdrawal. The user specifies an amount, and their LP tokens are transferred to an escrow receipt account.

Function Discriminator
fn get_request_withdraw_vault_discriminator() -> [u8; 8] {
    // discriminator = sha256("global:request_withdraw_vault")[0..8]
    [147, 67, 155, 26, 32, 163, 32, 193]
}
request_withdraw_vault CPI Struct
pub struct RequestWithdrawVaultParams<'info> {
    pub payer: AccountInfo<'info>,
    pub user_transfer_authority: AccountInfo<'info>,
    pub protocol: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub vault_lp_mint: AccountInfo<'info>,
    pub user_lp_ata: AccountInfo<'info>,
    pub request_withdraw_lp_ata: AccountInfo<'info>,
    pub request_withdraw_vault_receipt: AccountInfo<'info>,
    pub lp_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    // Target Voltr Vault program
    pub voltr_vault_program: AccountInfo<'info>,
}
Implementation
impl<'info> RequestWithdrawVaultParams<'info> {
    pub fn request_withdraw_vault(
        &self,
        amount: u64,
        is_amount_in_lp: bool,
        is_withdraw_all: bool
    ) -> Result<()> {
        let mut instruction_data = get_request_withdraw_vault_discriminator().to_vec();
        instruction_data.extend_from_slice(&amount.to_le_bytes());
        instruction_data.push(is_amount_in_lp as u8);
        instruction_data.push(is_withdraw_all as u8);

        let account_metas = vec![
            AccountMeta::new(*self.payer.key, true),
            AccountMeta::new_readonly(*self.user_transfer_authority.key, true),
            AccountMeta::new_readonly(*self.protocol.key, false),
            AccountMeta::new_readonly(*self.vault.key, false),
            AccountMeta::new_readonly(*self.vault_lp_mint.key, false),
            AccountMeta::new(*self.user_lp_ata.key, false),
            AccountMeta::new(*self.request_withdraw_lp_ata.key, false),
            AccountMeta::new(*self.request_withdraw_vault_receipt.key, false),
            AccountMeta::new_readonly(*self.lp_token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
        ];

        let instruction = Instruction {
            program_id: *self.voltr_vault_program.key,
            accounts: account_metas,
            data: instruction_data,
        };

        invoke(&instruction, &self.to_account_infos())?;
        Ok(())
    }
}
Full snippet available here

request_withdraw_vault Account Explanations
Account	Mutability	Signer	Purpose
payer	Mutable	Yes	The account paying for the receipt's rent.
user_transfer_authority	Immutable	Yes	The user requesting the withdrawal.
protocol	Immutable	No	The global Voltr protocol state account.
vault	Immutable	No	The vault from which to withdraw.
vault_lp_mint	Immutable	No	The LP mint of the vault.
user_lp_ata	Mutable	No	The user's LP token account (source).
request_withdraw_lp_ata	Mutable	No	The receipt's ATA to hold escrowed LP tokens.
request_withdraw_vault_receipt	Mutable	No	The PDA receipt account to be created, storing request details.
lp_token_program	Immutable	No	The Token Program for LP tokens.
system_program	Immutable	No	The Solana System Program.
Step 2: withdraw_vault
After the withdrawal_waiting_period defined in the vault has passed, this function can be called to complete the withdrawal.

Function Discriminator
fn get_withdraw_vault_discriminator() -> [u8; 8] {
    // discriminator = sha256("global:withdraw_vault")[0..8]
    [81, 229, 229, 94, 86, 233, 198, 15]
}
withdraw_vault CPI Struct
pub struct WithdrawVaultParams<'info> {
    pub user_transfer_authority: AccountInfo<'info>,
    pub protocol: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub vault_asset_mint: AccountInfo<'info>,
    pub vault_lp_mint: AccountInfo<'info>,
    pub request_withdraw_lp_ata: AccountInfo<'info>,
    pub vault_asset_idle_ata: AccountInfo<'info>,
    pub vault_asset_idle_auth: AccountInfo<'info>,
    pub user_asset_ata: AccountInfo<'info>,
    pub request_withdraw_vault_receipt: AccountInfo<'info>,
    pub asset_token_program: AccountInfo<'info>,
    pub lp_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    // Target Voltr Vault program
    pub voltr_vault_program: AccountInfo<'info>,
}
Implementation
impl<'info> WithdrawVaultParams<'info> {
    pub fn withdraw_vault(&self) -> Result<()> {
        let instruction_data = get_withdraw_vault_discriminator().to_vec();

        let account_metas = vec![
            AccountMeta::new(*self.user_transfer_authority.key, true),
            AccountMeta::new_readonly(*self.protocol.key, false),
            AccountMeta::new(*self.vault.key, false),
            AccountMeta::new_readonly(*self.vault_asset_mint.key, false),
            AccountMeta::new(*self.vault_lp_mint.key, false),
            AccountMeta::new(*self.request_withdraw_lp_ata.key, false),
            AccountMeta::new(*self.vault_asset_idle_ata.key, false),
            AccountMeta::new(*self.vault_asset_idle_auth.key, false),
            AccountMeta::new(*self.user_asset_ata.key, false),
            AccountMeta::new(*self.request_withdraw_vault_receipt.key, false),
            AccountMeta::new_readonly(*self.asset_token_program.key, false),
            AccountMeta::new_readonly(*self.lp_token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
        ];

        let instruction = Instruction {
            program_id: *self.voltr_vault_program.key,
            accounts: account_metas,
            data: instruction_data,
        };

        invoke(&instruction, &self.to_account_infos())?;
        Ok(())
    }
}
Full snippet available here

withdraw_vault Account Explanations
Account	Mutability	Signer	Purpose
user_transfer_authority	Mutable	Yes	The user finalizing the withdrawal.
protocol	Immutable	No	The global Voltr protocol state account.
vault	Mutable	No	The vault state account.
vault_asset_mint	Immutable	No	The mint of the asset being withdrawn.
vault_lp_mint	Mutable	No	The vault's LP mint.
request_withdraw_lp_ata	Mutable	No	The receipt's ATA holding the escrowed LP tokens (source for burn).
vault_asset_idle_ata	Mutable	No	The vault's idle ATA for the asset (source for transfer).
vault_asset_idle_auth	Mutable	No	The PDA authority over the vault_asset_idle_ata.
user_asset_ata	Mutable	No	The user's ATA for the asset (destination).
request_withdraw_vault_receipt	Mutable	No	The PDA receipt account, which will be closed after the withdrawal.
asset_token_program	Immutable	No	The Token Program or Token-2022 Program for assets.
lp_token_program	Immutable	No	The Token Program for LP tokens.
system_program	Immutable	No	The Solana System Program.
3. Cancel Request Withdraw Vault CPI Integration
This function cancels a pending withdrawal request. The escrowed LP tokens are refunded to the user (minus any redemption fee), and the receipt account is closed.

Function Discriminator
fn get_cancel_request_withdraw_vault_discriminator() -> [u8; 8] {
    // discriminator = sha256("global:cancel_request_withdraw_vault")[0..8]
    [231, 54, 14, 6, 223, 124, 127, 238]
}
cancel_request_withdraw_vault CPI Struct
pub struct CancelRequestWithdrawVaultParams<'info> {
    pub user_transfer_authority: AccountInfo<'info>,
    pub protocol: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub vault_lp_mint: AccountInfo<'info>,
    pub user_lp_ata: AccountInfo<'info>,
    pub request_withdraw_lp_ata: AccountInfo<'info>,
    pub request_withdraw_vault_receipt: AccountInfo<'info>,
    pub lp_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    // Target Voltr Vault program
    pub voltr_vault_program: AccountInfo<'info>,
}
Implementation
impl<'info> CancelRequestWithdrawVaultParams<'info> {
    pub fn cancel_request_withdraw_vault(&self) -> Result<()> {
        let instruction_data = get_cancel_request_withdraw_vault_discriminator().to_vec();

        let account_metas = vec![
            AccountMeta::new(*self.user_transfer_authority.key, true),
            AccountMeta::new_readonly(*self.protocol.key, false),
            AccountMeta::new(*self.vault.key, false),
            AccountMeta::new(*self.vault_lp_mint.key, false),
            AccountMeta::new(*self.user_lp_ata.key, false),
            AccountMeta::new(*self.request_withdraw_lp_ata.key, false),
            AccountMeta::new(*self.request_withdraw_vault_receipt.key, false),
            AccountMeta::new_readonly(*self.lp_token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
        ];

        let instruction = Instruction {
            program_id: *self.voltr_vault_program.key,
            accounts: account_metas,
            data: instruction_data,
        };

        invoke(&instruction, &self.to_account_infos())?;
        Ok(())
    }
}
Full snippet available here

cancel_request_withdraw_vault Account Explanations
Account	Mutability	Signer	Purpose
user_transfer_authority	Mutable	Yes	The user cancelling the withdrawal; receives closed receipt's rent.
protocol	Immutable	No	The global Voltr protocol state account.
vault	Mutable	No	The vault state account.
vault_lp_mint	Mutable	No	The vault's LP mint.
user_lp_ata	Mutable	No	The user's LP token account (destination for refunded LP tokens).
request_withdraw_lp_ata	Mutable	No	The receipt's ATA holding escrowed LP tokens (source for refund).
request_withdraw_vault_receipt	Mutable	No	The PDA receipt account, which will be closed after cancellation.
lp_token_program	Immutable	No	The Token Program for LP tokens.
system_program	Immutable	No	The Solana System Program.
4. Instant Withdraw Vault CPI Integration
This function allows a user to withdraw assets from the vault instantly, without going through the two-step request/withdraw flow. This is only available for vaults that have a withdrawal_waiting_period of zero.

Function Discriminator
fn get_instant_withdraw_vault_discriminator() -> [u8; 8] {
    // discriminator = sha256("global:instant_withdraw_vault")[0..8]
    [221, 56, 115, 168, 128, 220, 235, 245]
}
instant_withdraw_vault CPI Struct
pub struct InstantWithdrawVaultParams<'info> {
    pub user_transfer_authority: AccountInfo<'info>,
    pub protocol: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub vault_asset_mint: AccountInfo<'info>,
    pub vault_lp_mint: AccountInfo<'info>,
    pub user_lp_ata: AccountInfo<'info>,
    pub vault_asset_idle_ata: AccountInfo<'info>,
    pub vault_asset_idle_auth: AccountInfo<'info>,
    pub user_asset_ata: AccountInfo<'info>,
    pub asset_token_program: AccountInfo<'info>,
    pub lp_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    // Target Voltr Vault program
    pub voltr_vault_program: AccountInfo<'info>,
}
Implementation
impl<'info> InstantWithdrawVaultParams<'info> {
    pub fn instant_withdraw_vault(
        &self,
        amount: u64,
        is_amount_in_lp: bool,
        is_withdraw_all: bool
    ) -> Result<()> {
        let mut instruction_data = get_instant_withdraw_vault_discriminator().to_vec();
        instruction_data.extend_from_slice(&amount.to_le_bytes());
        instruction_data.push(is_amount_in_lp as u8);
        instruction_data.push(is_withdraw_all as u8);

        let account_metas = vec![
            AccountMeta::new_readonly(*self.user_transfer_authority.key, true),
            AccountMeta::new_readonly(*self.protocol.key, false),
            AccountMeta::new(*self.vault.key, false),
            AccountMeta::new_readonly(*self.vault_asset_mint.key, false),
            AccountMeta::new(*self.vault_lp_mint.key, false),
            AccountMeta::new(*self.user_lp_ata.key, false),
            AccountMeta::new(*self.vault_asset_idle_ata.key, false),
            AccountMeta::new(*self.vault_asset_idle_auth.key, false),
            AccountMeta::new(*self.user_asset_ata.key, false),
            AccountMeta::new_readonly(*self.asset_token_program.key, false),
            AccountMeta::new_readonly(*self.lp_token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
        ];

        let instruction = Instruction {
            program_id: *self.voltr_vault_program.key,
            accounts: account_metas,
            data: instruction_data,
        };

        invoke(&instruction, &self.to_account_infos())?;
        Ok(())
    }
}
Full snippet available here

instant_withdraw_vault Account Explanations
Account	Mutability	Signer	Purpose
user_transfer_authority	Immutable	Yes	The user withdrawing assets.
protocol	Immutable	No	The global Voltr protocol state account.
vault	Mutable	No	The vault state account.
vault_asset_mint	Immutable	No	The mint of the asset being withdrawn.
vault_lp_mint	Mutable	No	The vault's LP mint.
user_lp_ata	Mutable	No	The user's LP token account (source for burn).
vault_asset_idle_ata	Mutable	No	The vault's idle ATA for the asset (source).
vault_asset_idle_auth	Mutable	No	The PDA authority over the vault_asset_idle_ata.
user_asset_ata	Mutable	No	The user's ATA for the asset (destination).
asset_token_program	Immutable	No	The Token Program or Token-2022 Program for assets.
lp_token_program	Immutable	No	The Token Program for LP tokens.
system_program	Immutable	No	The Solana System Program.
Key Implementation Notes
1. Account Derivation
Most accounts are standard PDAs derived from seeds defined in the Voltr program. For CPI, you will need to derive these PDAs on your client or in your program to pass them into the instructions. Key PDAs include:

protocol: ["protocol"]
vault_asset_idle_auth: ["vault_asset_idle_auth", vault_key]
vault_lp_mint_auth: ["vault_lp_mint_auth", vault_key]
request_withdraw_vault_receipt: ["request_withdraw_vault_receipt", vault_key, user_key]
2. Signers
User-initiated actions require the user_transfer_authority to be a signer.
The CPI-calling program does not need to provide seeds for the Voltr Vault's internal PDAs. The Voltr program will use invoke_signed internally for its own CPIs (e.g., token transfers and burns). Your program simply passes the PDA addresses in the AccountInfo slice.
3. Error Handling
Your program should be prepared to handle errors from the Voltr Vault program, such as:

InvalidAmount: Input amount is zero or invalid.
MaxCapExceeded: Deposit would exceed the vault's maximum capacity.
WithdrawalNotYetAvailable: Attempting to withdraw_vault before the waiting period has passed.
InstantWithdrawNotAllowed: Attempting to instant_withdraw_vault on a vault with a non-zero withdrawal waiting period.
OperationNotAllowed: The protocol has globally disabled the attempted operation.