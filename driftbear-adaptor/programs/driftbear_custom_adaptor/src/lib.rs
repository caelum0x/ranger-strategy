use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{Token, TokenAccount};
use anchor_spl::token_interface::Mint;

declare_id!("4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ");

const POSITION_SEED: &[u8] = b"driftbear-position";
const DRIFT_PROGRAM_ID: Pubkey = pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const ACCOUNT_DISCRIMINATOR_LEN: usize = 8;
const DRIFT_USER_STATUS_BEING_LIQUIDATED: u8 = 0b0000_0001;
const DRIFT_USER_STATUS_BANKRUPT: u8 = 0b0000_0010;

#[program]
pub mod driftbear_custom_adaptor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, market_index: u16) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.drift_program.key(),
            DRIFT_PROGRAM_ID,
            DriftAdaptorError::InvalidDriftProgram
        );
        let sub_account_id = validate_user_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.drift_user,
            &ctx.accounts.drift_user_stats,
            market_index,
        )?;

        let position = &mut ctx.accounts.position;
        position.strategy = ctx.accounts.strategy.key();
        position.market_index = market_index;
        position.sub_account_id = sub_account_id;
        position.tracked_balance = 0;
        position.bump = ctx.bumps.position;
        Ok(())
    }

    pub fn migrate_position(ctx: Context<MigratePosition>) -> Result<()> {
        let position_info = &ctx.accounts.position;
        require_keys_eq!(
            *position_info.owner,
            *ctx.program_id,
            DriftAdaptorError::InvalidPositionOwner
        );
        let (expected_pda, expected_bump) = Pubkey::find_program_address(
            &[POSITION_SEED, ctx.accounts.strategy.key().as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(
            position_info.key(),
            expected_pda,
            DriftAdaptorError::InvalidPositionPda
        );

        let data = position_info.try_borrow_data()?;
        let (market_index, tracked_balance, stored_strategy, needs_realloc) =
            if data.len() >= ACCOUNT_DISCRIMINATOR_LEN + AdaptorPosition::SIZE {
                let mut cursor: &[u8] = &data[..];
                let current = AdaptorPosition::try_deserialize(&mut cursor)
                    .map_err(|_| error!(DriftAdaptorError::InvalidPositionLayout))?;
                (
                    current.market_index,
                    current.tracked_balance,
                    current.strategy,
                    false,
                )
            } else if data.len() >= ACCOUNT_DISCRIMINATOR_LEN + AdaptorPositionV0::SIZE {
                let mut cursor: &[u8] = &data[ACCOUNT_DISCRIMINATOR_LEN..];
                let legacy = AdaptorPositionV0::deserialize(&mut cursor)
                    .map_err(|_| error!(DriftAdaptorError::InvalidPositionLayout))?;
                (
                    legacy.market_index,
                    legacy.tracked_balance,
                    Pubkey::new_from_array(legacy.strategy),
                    true,
                )
            } else {
                return err!(DriftAdaptorError::InvalidPositionLayout);
            };
        require_keys_eq!(
            stored_strategy,
            ctx.accounts.strategy.key(),
            DriftAdaptorError::InvalidPositionStrategy
        );
        drop(data);

        let sub_account_id = validate_user_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.drift_user,
            &ctx.accounts.drift_user_stats,
            market_index,
        )?;

        if needs_realloc {
            let new_size = ACCOUNT_DISCRIMINATOR_LEN + AdaptorPosition::SIZE;
            let rent = Rent::get()?;
            let required_lamports = rent.minimum_balance(new_size);
            let current_lamports = position_info.lamports();
            if current_lamports < required_lamports {
                let diff = required_lamports.saturating_sub(current_lamports);
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: position_info.clone(),
                        },
                    ),
                    diff,
                )?;
            }
            position_info
                .realloc(new_size, false)
                .map_err(|_| error!(DriftAdaptorError::InvalidPositionLayout))?;
        }

        let mut data = position_info.try_borrow_mut_data()?;
        let updated = AdaptorPosition {
            strategy: ctx.accounts.strategy.key(),
            market_index,
            sub_account_id,
            bump: expected_bump,
            tracked_balance,
        };
        updated
            .try_serialize(&mut &mut data[..])
            .map_err(|_| error!(DriftAdaptorError::InvalidPositionLayout))?;

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<u64> {
        require_keys_eq!(
            ctx.accounts.drift_program.key(),
            DRIFT_PROGRAM_ID,
            DriftAdaptorError::InvalidDriftProgram
        );
        validate_passive_spot_strategy_accounts(
            &ctx.accounts.strategy_authority.key(),
            &ctx.accounts.vault_asset_mint.key(),
            &ctx.accounts.strategy_token_ata,
            &ctx.accounts.drift_user,
            &ctx.accounts.drift_user_stats,
            &ctx.accounts.spot_market,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.spot_market_oracle,
            Some(ctx.accounts.position.sub_account_id),
            ctx.accounts.position.market_index,
        )?;

        if amount > 0 {
            let mut account_infos: Vec<AccountInfo> = Vec::with_capacity(9);
            account_infos.push(ctx.accounts.drift_state.clone());
            account_infos.push(ctx.accounts.drift_user.clone());
            account_infos.push(ctx.accounts.drift_user_stats.clone());
            account_infos.push(ctx.accounts.strategy_authority.to_account_info());
            account_infos.push(ctx.accounts.spot_market_vault.clone());
            account_infos.push(ctx.accounts.strategy_token_ata.to_account_info());
            account_infos.push(ctx.accounts.token_program.to_account_info());
            account_infos.push(ctx.accounts.spot_market_oracle.clone());
            account_infos.push(ctx.accounts.spot_market.clone());
            invoke(
                &build_drift_deposit_ix(
                    &ctx.accounts,
                    ctx.accounts.position.market_index,
                    amount,
                    false,
                ),
                &account_infos,
            )?;

            ctx.accounts.position.tracked_balance = ctx
                .accounts
                .position
                .tracked_balance
                .saturating_add(amount);
        }

        current_position_token_amount(
            &ctx.accounts.drift_user,
            &ctx.accounts.spot_market,
            ctx.accounts.position.market_index,
        )
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<u64> {
        require_keys_eq!(
            ctx.accounts.drift_program.key(),
            DRIFT_PROGRAM_ID,
            DriftAdaptorError::InvalidDriftProgram
        );
        validate_passive_spot_strategy_accounts(
            &ctx.accounts.strategy_authority.key(),
            &ctx.accounts.vault_asset_mint.key(),
            &ctx.accounts.strategy_token_ata,
            &ctx.accounts.drift_user,
            &ctx.accounts.drift_user_stats,
            &ctx.accounts.spot_market,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.spot_market_oracle,
            Some(ctx.accounts.position.sub_account_id),
            ctx.accounts.position.market_index,
        )?;

        if amount > 0 {
            let mut account_infos: Vec<AccountInfo> = Vec::with_capacity(10);
            account_infos.push(ctx.accounts.drift_state.clone());
            account_infos.push(ctx.accounts.drift_user.clone());
            account_infos.push(ctx.accounts.drift_user_stats.clone());
            account_infos.push(ctx.accounts.strategy_authority.to_account_info());
            account_infos.push(ctx.accounts.spot_market_vault.clone());
            account_infos.push(ctx.accounts.drift_signer.clone());
            account_infos.push(ctx.accounts.strategy_token_ata.to_account_info());
            account_infos.push(ctx.accounts.token_program.to_account_info());
            account_infos.push(ctx.accounts.spot_market_oracle.clone());
            account_infos.push(ctx.accounts.spot_market.clone());
            invoke(
                &build_drift_withdraw_ix(
                    &ctx.accounts,
                    ctx.accounts.position.market_index,
                    amount,
                    false,
                ),
                &account_infos,
            )?;

            ctx.accounts.position.tracked_balance = ctx
                .accounts
                .position
                .tracked_balance
                .saturating_sub(amount);
        }

        current_position_token_amount(
            &ctx.accounts.drift_user,
            &ctx.accounts.spot_market,
            ctx.accounts.position.market_index,
        )
    }
}

fn current_position_token_amount(
    drift_user: &AccountInfo,
    spot_market: &AccountInfo,
    market_index: u16,
) -> Result<u64> {
    let user_data = drift_user.try_borrow_data()?;
    let spot_market_data = spot_market.try_borrow_data()?;
    ensure_user_len(&user_data)?;
    let market = load_spot_market_prefix(&spot_market_data)?;
    let position = find_spot_position(&user_data, market_index)?;

    if position.scaled_balance == 0 {
        return Ok(0);
    }
    require!(
        position.balance_type()? == SpotBalanceTypeRaw::Deposit,
        DriftAdaptorError::UnsupportedBorrowPosition
    );
    require!(
        position.open_orders == 0 && position.open_bids == 0 && position.open_asks == 0,
        DriftAdaptorError::UnexpectedSpotOrders
    );

    get_token_amount(
        u128::from(position.scaled_balance),
        &market,
        position.balance_type()?,
    )
}

fn build_drift_deposit_ix(
    accounts: &Deposit,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> Instruction {
    let args = DriftDepositArgs {
        market_index,
        amount,
        reduce_only,
    };

    let mut account_metas = vec![
        AccountMeta::new_readonly(accounts.drift_state.key(), false),
        AccountMeta::new(accounts.drift_user.key(), false),
        AccountMeta::new(accounts.drift_user_stats.key(), false),
        AccountMeta::new_readonly(accounts.strategy_authority.key(), true),
        AccountMeta::new(accounts.spot_market_vault.key(), false),
        AccountMeta::new(accounts.strategy_token_ata.key(), false),
        AccountMeta::new_readonly(accounts.token_program.key(), false),
    ];
    account_metas.push(AccountMeta::new_readonly(
        accounts.spot_market_oracle.key(),
        false,
    ));
    account_metas.push(AccountMeta::new(
        accounts.spot_market.key(),
        false,
    ));

    Instruction {
        program_id: accounts.drift_program.key(),
        accounts: account_metas,
        data: encode_anchor_ix("deposit", &args),
    }
}

fn build_drift_withdraw_ix(
    accounts: &Withdraw,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> Instruction {
    let args = DriftWithdrawArgs {
        market_index,
        amount,
        reduce_only,
    };

    let mut account_metas = vec![
        AccountMeta::new_readonly(accounts.drift_state.key(), false),
        AccountMeta::new(accounts.drift_user.key(), false),
        AccountMeta::new(accounts.drift_user_stats.key(), false),
        AccountMeta::new_readonly(accounts.strategy_authority.key(), true),
        AccountMeta::new(accounts.spot_market_vault.key(), false),
        AccountMeta::new_readonly(accounts.drift_signer.key(), false),
        AccountMeta::new(accounts.strategy_token_ata.key(), false),
        AccountMeta::new_readonly(accounts.token_program.key(), false),
    ];
    account_metas.push(AccountMeta::new_readonly(
        accounts.spot_market_oracle.key(),
        false,
    ));
    account_metas.push(AccountMeta::new(
        accounts.spot_market.key(),
        false,
    ));

    Instruction {
        program_id: accounts.drift_program.key(),
        accounts: account_metas,
        data: encode_anchor_ix("withdraw", &args),
    }
}

fn encode_anchor_ix<T: AnchorSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut data = sighash("global", name).to_vec();
    args.serialize(&mut data).unwrap();
    data
}

fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    let preimage = format!("{namespace}:{name}");
    let mut sighash = [0u8; 8];
    sighash.copy_from_slice(&hashv(&[preimage.as_bytes()]).to_bytes()[..8]);
    sighash
}

#[derive(AnchorSerialize, AnchorDeserialize)]
struct DriftDepositArgs {
    market_index: u16,
    amount: u64,
    reduce_only: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
struct DriftWithdrawArgs {
    market_index: u16,
    amount: u64,
    reduce_only: bool,
}

#[account]
pub struct AdaptorPosition {
    pub strategy: Pubkey,
    pub market_index: u16,
    pub sub_account_id: u16,
    pub bump: u8,
    pub tracked_balance: u64,
}

impl AdaptorPosition {
    const SIZE: usize = 32 + 2 + 2 + 1 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
struct AdaptorPositionV0 {
    strategy: [u8; 32],
    market_index: u16,
    bump: u8,
    tracked_balance: u64,
}

impl AdaptorPositionV0 {
    const SIZE: usize = 32 + 2 + 1 + 8;
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: vault strategy address; validated by the caller/vault
    pub strategy: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + AdaptorPosition::SIZE,
        seeds = [POSITION_SEED, strategy.key().as_ref()],
        bump
    )]
    pub position: Account<'info, AdaptorPosition>,
    /// CHECK: Drift state account
    pub drift_state: AccountInfo<'info>,
    /// CHECK: Drift user account owned by the vault strategy authority
    #[account(mut)]
    pub drift_user: AccountInfo<'info>,
    /// CHECK: Drift user stats account owned by the vault strategy authority
    #[account(mut)]
    pub drift_user_stats: AccountInfo<'info>,
    /// CHECK: real Drift program ID
    pub drift_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigratePosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: vault strategy address; validated by PDA check
    pub strategy: AccountInfo<'info>,
    /// CHECK: legacy or current position PDA, validated by PDA check
    #[account(mut)]
    pub position: AccountInfo<'info>,
    /// CHECK: Drift user account owned by the strategy authority
    pub drift_user: AccountInfo<'info>,
    /// CHECK: Drift user stats account owned by the strategy authority
    pub drift_user_stats: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// CHECK: vault strategy auth/delegate passed by the vault and reused for Drift CPI
    pub strategy_authority: Signer<'info>,
    /// CHECK: vault strategy address; validated by the caller/vault
    pub strategy: AccountInfo<'info>,
    pub vault_asset_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub strategy_token_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(
        mut,
        seeds = [POSITION_SEED, strategy.key().as_ref()],
        bump = position.bump,
        has_one = strategy
    )]
    pub position: Account<'info, AdaptorPosition>,
    /// CHECK: Drift state account
    pub drift_state: AccountInfo<'info>,
    /// CHECK: Drift user account
    #[account(mut)]
    pub drift_user: AccountInfo<'info>,
    /// CHECK: Drift user stats account
    #[account(mut)]
    pub drift_user_stats: AccountInfo<'info>,
    /// CHECK: Drift spot market account for the configured market
    #[account(mut)]
    pub spot_market: AccountInfo<'info>,
    /// CHECK: Drift spot market vault ATA for the configured market
    #[account(mut)]
    pub spot_market_vault: AccountInfo<'info>,
    /// CHECK: Drift spot market oracle for the configured market
    pub spot_market_oracle: AccountInfo<'info>,
    /// CHECK: Drift program
    pub drift_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// CHECK: vault strategy auth/delegate passed by the vault and reused for Drift CPI
    pub strategy_authority: Signer<'info>,
    /// CHECK: vault strategy address; validated by the caller/vault
    pub strategy: AccountInfo<'info>,
    pub vault_asset_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub strategy_token_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(
        mut,
        seeds = [POSITION_SEED, strategy.key().as_ref()],
        bump = position.bump,
        has_one = strategy
    )]
    pub position: Account<'info, AdaptorPosition>,
    /// CHECK: Drift state account
    pub drift_state: AccountInfo<'info>,
    /// CHECK: Drift user account
    #[account(mut)]
    pub drift_user: AccountInfo<'info>,
    /// CHECK: Drift user stats account
    #[account(mut)]
    pub drift_user_stats: AccountInfo<'info>,
    /// CHECK: Drift spot market account for the configured market
    #[account(mut)]
    pub spot_market: AccountInfo<'info>,
    /// CHECK: Drift spot market vault ATA for the configured market
    #[account(mut)]
    pub spot_market_vault: AccountInfo<'info>,
    /// CHECK: Drift spot market oracle for the configured market
    pub spot_market_oracle: AccountInfo<'info>,
    /// CHECK: Drift signer PDA required by withdraw
    pub drift_signer: AccountInfo<'info>,
    /// CHECK: Drift program
    pub drift_program: AccountInfo<'info>,
}

#[error_code]
pub enum DriftAdaptorError {
    #[msg("The provided Drift program does not match mainnet Drift.")]
    InvalidDriftProgram,
    #[msg("The provided Drift user account could not be decoded.")]
    InvalidDriftUser,
    #[msg("The provided Drift spot market account could not be decoded.")]
    InvalidSpotMarket,
    #[msg("The Drift spot balance type is invalid.")]
    InvalidSpotBalanceType,
    #[msg("The computed token amount exceeds the u64 range.")]
    TokenAmountOverflow,
    #[msg("The Drift user authority does not match the strategy authority.")]
    InvalidDriftUserAuthority,
    #[msg("The Drift user stats authority does not match the strategy authority.")]
    InvalidDriftUserStatsAuthority,
    #[msg("The Drift user PDA does not match the expected subaccount PDA.")]
    InvalidDriftUserPda,
    #[msg("The Drift user stats PDA does not match the expected PDA.")]
    InvalidDriftUserStatsPda,
    #[msg("The Drift user subaccount does not match the initialized subaccount id.")]
    InvalidDriftSubAccountId,
    #[msg("The driftbear position PDA does not match the expected address.")]
    InvalidPositionPda,
    #[msg("The driftbear position account is not owned by this program.")]
    InvalidPositionOwner,
    #[msg("The driftbear position account layout is invalid.")]
    InvalidPositionLayout,
    #[msg("The driftbear position strategy does not match the expected address.")]
    InvalidPositionStrategy,
    #[msg("The Drift user is in liquidation or bankrupt status.")]
    InvalidDriftUserStatus,
    #[msg("The Drift user has open orders that are unsupported by this strategy.")]
    UnexpectedOpenOrders,
    #[msg("The Drift user has perp exposure that is unsupported by this strategy.")]
    UnexpectedPerpPosition,
    #[msg("The Drift user has spot exposure outside the configured market.")]
    UnexpectedSpotPosition,
    #[msg("The Drift spot market does not match the configured market index.")]
    InvalidSpotMarketIndex,
    #[msg("The Drift spot market vault does not match the provided vault account.")]
    InvalidSpotMarketVault,
    #[msg("The Drift spot market mint does not match the vault asset mint.")]
    InvalidSpotMarketMint,
    #[msg("The strategy token account does not belong to the strategy authority.")]
    InvalidStrategyTokenOwner,
    #[msg("The strategy token account mint does not match the vault asset mint.")]
    InvalidStrategyTokenMint,
    #[msg("This adaptor does not support borrow positions.")]
    UnsupportedBorrowPosition,
    #[msg("This adaptor does not support open spot orders on the managed subaccount.")]
    UnexpectedSpotOrders,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct UserStatsAuthorityRaw {
    authority: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SpotPositionRaw {
    scaled_balance: u64,
    open_bids: i64,
    open_asks: i64,
    cumulative_deposits: i64,
    market_index: u16,
    balance_type: u8,
    open_orders: u8,
    padding: [u8; 4],
}

impl SpotPositionRaw {
    fn balance_type(&self) -> Result<SpotBalanceTypeRaw> {
        match self.balance_type {
            0 => Ok(SpotBalanceTypeRaw::Deposit),
            1 => Ok(SpotBalanceTypeRaw::Borrow),
            _ => err!(DriftAdaptorError::InvalidSpotBalanceType),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PerpPositionRaw {
    last_cumulative_funding_rate: i64,
    base_asset_amount: i64,
    quote_asset_amount: i64,
    quote_break_even_amount: i64,
    quote_entry_amount: i64,
    open_bids: i64,
    open_asks: i64,
    settled_pnl: i64,
    lp_shares: u64,
    last_base_asset_amount_per_lp: i64,
    last_quote_asset_amount_per_lp: i64,
    padding: [u8; 2],
    max_margin_ratio: u16,
    market_index: u16,
    open_orders: u8,
    per_lp_base: i8,
}

impl PerpPositionRaw {
    fn is_available(&self) -> bool {
        self.base_asset_amount == 0
            && self.quote_asset_amount == 0
            && self.open_bids == 0
            && self.open_asks == 0
            && self.open_orders == 0
            && self.lp_shares == 0
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct HistoricalOracleDataRaw {
    last_oracle_price: i64,
    last_oracle_conf: u64,
    last_oracle_delay: i64,
    last_oracle_price_twap: i64,
    last_oracle_price_twap_5min: i64,
    last_oracle_price_twap_ts: i64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct HistoricalIndexDataRaw {
    last_index_bid_price: u64,
    last_index_ask_price: u64,
    last_index_price_twap: u64,
    last_index_price_twap_5min: u64,
    last_index_price_twap_ts: i64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PoolBalanceRaw {
    scaled_balance: u128,
    market_index: u16,
    padding: [u8; 6],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct InsuranceFundRaw {
    vault: [u8; 32],
    total_shares: u128,
    user_shares: u128,
    shares_base: u128,
    unstaking_period: i64,
    last_revenue_settle_ts: i64,
    revenue_settle_period: i64,
    total_factor: u32,
    user_factor: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SpotMarketPrefixRaw {
    pubkey: [u8; 32],
    oracle: [u8; 32],
    mint: [u8; 32],
    vault: [u8; 32],
    name: [u8; 32],
    historical_oracle_data: HistoricalOracleDataRaw,
    historical_index_data: HistoricalIndexDataRaw,
    revenue_pool: PoolBalanceRaw,
    spot_fee_pool: PoolBalanceRaw,
    insurance_fund: InsuranceFundRaw,
    total_spot_fee: u128,
    deposit_balance: u128,
    borrow_balance: u128,
    cumulative_deposit_interest: u128,
    cumulative_borrow_interest: u128,
    total_social_loss: u128,
    total_quote_social_loss: u128,
    withdraw_guard_threshold: u64,
    max_token_deposits: u64,
    deposit_token_twap: u64,
    borrow_token_twap: u64,
    utilization_twap: u64,
    last_interest_ts: u64,
    last_twap_ts: u64,
    expiry_ts: i64,
    order_step_size: u64,
    order_tick_size: u64,
    min_order_size: u64,
    max_position_size: u64,
    next_fill_record_id: u64,
    next_deposit_record_id: u64,
    initial_asset_weight: u32,
    maintenance_asset_weight: u32,
    initial_liability_weight: u32,
    maintenance_liability_weight: u32,
    imf_factor: u32,
    liquidator_fee: u32,
    if_liquidation_fee: u32,
    optimal_utilization: u32,
    optimal_borrow_rate: u32,
    max_borrow_rate: u32,
    decimals: u32,
    market_index: u16,
}

#[derive(PartialEq, Eq)]
#[derive(Clone, Copy)]
enum SpotBalanceTypeRaw {
    Deposit,
    Borrow,
}

const USER_ACCOUNT_SIZE: usize = 4376 - ACCOUNT_DISCRIMINATOR_LEN;
const SPOT_POSITIONS_COUNT: usize = 8;
const PERP_POSITIONS_COUNT: usize = 8;
const ORDER_COUNT: usize = 32;
const ORDER_SIZE: usize = 96;
const USER_SPOT_POSITIONS_OFFSET: usize = ACCOUNT_DISCRIMINATOR_LEN + 32 + 32 + 32;
const USER_PERP_POSITIONS_OFFSET: usize =
    USER_SPOT_POSITIONS_OFFSET + SPOT_POSITIONS_COUNT * core::mem::size_of::<SpotPositionRaw>();
const USER_ORDERS_OFFSET: usize =
    USER_PERP_POSITIONS_OFFSET + PERP_POSITIONS_COUNT * core::mem::size_of::<PerpPositionRaw>();
const USER_TAIL_OFFSET: usize = USER_ORDERS_OFFSET + ORDER_COUNT * ORDER_SIZE;
const USER_SUB_ACCOUNT_ID_OFFSET: usize = USER_TAIL_OFFSET + 82;
const USER_STATUS_OFFSET: usize = USER_TAIL_OFFSET + 84;
const USER_OPEN_ORDERS_OFFSET: usize = USER_TAIL_OFFSET + 87;
const USER_HAS_OPEN_ORDER_OFFSET: usize = USER_TAIL_OFFSET + 88;
const USER_OPEN_AUCTIONS_OFFSET: usize = USER_TAIL_OFFSET + 89;
const USER_HAS_OPEN_AUCTION_OFFSET: usize = USER_TAIL_OFFSET + 90;

fn ensure_user_len(data: &[u8]) -> Result<()> {
    require!(
        data.len() >= ACCOUNT_DISCRIMINATOR_LEN + USER_ACCOUNT_SIZE,
        DriftAdaptorError::InvalidDriftUser
    );
    Ok(())
}

fn read_at<T: Copy>(data: &[u8], offset: usize) -> Result<T> {
    let size = core::mem::size_of::<T>();
    let end = offset
        .checked_add(size)
        .ok_or_else(|| error!(DriftAdaptorError::InvalidDriftUser))?;
    require!(data.len() >= end, DriftAdaptorError::InvalidDriftUser);
    let ptr = data[offset..end].as_ptr() as *const T;
    Ok(unsafe { core::ptr::read_unaligned(ptr) })
}

fn read_user_authority(data: &[u8]) -> Result<Pubkey> {
    let bytes: [u8; 32] = read_at(data, ACCOUNT_DISCRIMINATOR_LEN)?;
    Ok(Pubkey::new_from_array(bytes))
}

fn read_user_sub_account_id(data: &[u8]) -> Result<u16> {
    read_at(data, USER_SUB_ACCOUNT_ID_OFFSET)
}

fn read_user_status(data: &[u8]) -> Result<u8> {
    read_at(data, USER_STATUS_OFFSET)
}

fn user_has_open_orders(data: &[u8]) -> Result<bool> {
    let open_orders: u8 = read_at(data, USER_OPEN_ORDERS_OFFSET)?;
    let has_open_order: u8 = read_at(data, USER_HAS_OPEN_ORDER_OFFSET)?;
    let open_auctions: u8 = read_at(data, USER_OPEN_AUCTIONS_OFFSET)?;
    let has_open_auction: u8 = read_at(data, USER_HAS_OPEN_AUCTION_OFFSET)?;
    Ok(open_orders != 0 || has_open_order != 0 || open_auctions != 0 || has_open_auction != 0)
}

fn read_spot_position(data: &[u8], index: usize) -> Result<SpotPositionRaw> {
    let offset =
        USER_SPOT_POSITIONS_OFFSET + index * core::mem::size_of::<SpotPositionRaw>();
    read_at(data, offset)
}

fn read_perp_position(data: &[u8], index: usize) -> Result<PerpPositionRaw> {
    let offset =
        USER_PERP_POSITIONS_OFFSET + index * core::mem::size_of::<PerpPositionRaw>();
    read_at(data, offset)
}

fn find_spot_position(data: &[u8], market_index: u16) -> Result<SpotPositionRaw> {
    for index in 0..SPOT_POSITIONS_COUNT {
        let position = read_spot_position(data, index)?;
        if position.market_index == market_index {
            return Ok(position);
        }
    }
    Ok(SpotPositionRaw::default())
}

fn load_spot_market_prefix(data: &[u8]) -> Result<SpotMarketPrefixRaw> {
    load_account_prefix::<SpotMarketPrefixRaw>(data)
        .ok_or_else(|| error!(DriftAdaptorError::InvalidSpotMarket))
}

fn load_user_stats_authority(data: &[u8]) -> Result<UserStatsAuthorityRaw> {
    load_account_prefix::<UserStatsAuthorityRaw>(data)
        .ok_or_else(|| error!(DriftAdaptorError::InvalidDriftUser))
}

fn load_account_prefix<T: Copy>(data: &[u8]) -> Option<T> {
    let size = core::mem::size_of::<T>();
    let end = ACCOUNT_DISCRIMINATOR_LEN.checked_add(size)?;
    if data.len() < end {
        return None;
    }

    let ptr = data[ACCOUNT_DISCRIMINATOR_LEN..end].as_ptr() as *const T;
    Some(unsafe { core::ptr::read_unaligned(ptr) })
}

fn get_token_amount(
    scaled_balance: u128,
    spot_market: &SpotMarketPrefixRaw,
    balance_type: SpotBalanceTypeRaw,
) -> Result<u64> {
    let precision_decrease = 10_u128.pow(19_u32.saturating_sub(spot_market.decimals()));
    let cumulative_interest = match balance_type {
        SpotBalanceTypeRaw::Deposit => spot_market.cumulative_deposit_interest,
        SpotBalanceTypeRaw::Borrow => spot_market.cumulative_borrow_interest,
    };

    let token_amount = match balance_type {
        SpotBalanceTypeRaw::Deposit => scaled_balance
            .checked_mul(cumulative_interest)
            .and_then(|value| value.checked_div(precision_decrease))
            .ok_or_else(|| error!(DriftAdaptorError::InvalidSpotMarket))?,
        SpotBalanceTypeRaw::Borrow => {
            let numerator = scaled_balance
                .checked_mul(cumulative_interest)
                .ok_or_else(|| error!(DriftAdaptorError::InvalidSpotMarket))?;
            numerator
                .checked_add(precision_decrease.saturating_sub(1))
                .and_then(|value| value.checked_div(precision_decrease))
                .ok_or_else(|| error!(DriftAdaptorError::InvalidSpotMarket))?
        }
    };

    u64::try_from(token_amount).map_err(|_| error!(DriftAdaptorError::TokenAmountOverflow))
}

impl SpotMarketPrefixRaw {
    fn decimals(&self) -> u32 {
        self.decimals
    }

    fn pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.pubkey)
    }

    fn mint(&self) -> Pubkey {
        Pubkey::new_from_array(self.mint)
    }

    fn vault(&self) -> Pubkey {
        Pubkey::new_from_array(self.vault)
    }
}

fn validate_user_account(
    strategy_authority: &Pubkey,
    drift_user: &AccountInfo,
    drift_user_stats: &AccountInfo,
    market_index: u16,
) -> Result<u16> {
    let user_data = drift_user.try_borrow_data()?;
    ensure_user_len(&user_data)?;
    let authority = read_user_authority(&user_data)?;
    let user_stats = load_user_stats_authority(&drift_user_stats.try_borrow_data()?)?;

    require_keys_eq!(
        authority,
        *strategy_authority,
        DriftAdaptorError::InvalidDriftUserAuthority
    );
    require_keys_eq!(
        Pubkey::new_from_array(user_stats.authority),
        *strategy_authority,
        DriftAdaptorError::InvalidDriftUserStatsAuthority
    );

    let sub_account_id = read_user_sub_account_id(&user_data)?;
    validate_drift_user_pdas(
        strategy_authority,
        drift_user,
        drift_user_stats,
        sub_account_id,
    )?;
    validate_user_invariants(&user_data, market_index)?;

    Ok(sub_account_id)
}

fn validate_drift_user_pdas(
    strategy_authority: &Pubkey,
    drift_user: &AccountInfo,
    drift_user_stats: &AccountInfo,
    sub_account_id: u16,
) -> Result<()> {
    let (expected_user, _) = Pubkey::find_program_address(
        &[
            b"user",
            strategy_authority.as_ref(),
            &sub_account_id.to_le_bytes(),
        ],
        &DRIFT_PROGRAM_ID,
    );
    require_keys_eq!(
        expected_user,
        drift_user.key(),
        DriftAdaptorError::InvalidDriftUserPda
    );

    let (expected_user_stats, _) = Pubkey::find_program_address(
        &[b"user_stats", strategy_authority.as_ref()],
        &DRIFT_PROGRAM_ID,
    );
    require_keys_eq!(
        expected_user_stats,
        drift_user_stats.key(),
        DriftAdaptorError::InvalidDriftUserStatsPda
    );

    Ok(())
}

fn validate_user_invariants(user_data: &[u8], market_index: u16) -> Result<()> {
    let status = read_user_status(user_data)?;
    require!(
        status & (DRIFT_USER_STATUS_BEING_LIQUIDATED | DRIFT_USER_STATUS_BANKRUPT) == 0,
        DriftAdaptorError::InvalidDriftUserStatus
    );
    require!(
        !user_has_open_orders(user_data)?,
        DriftAdaptorError::UnexpectedOpenOrders
    );
    for index in 0..PERP_POSITIONS_COUNT {
        let position = read_perp_position(user_data, index)?;
        require!(
            position.is_available(),
            DriftAdaptorError::UnexpectedPerpPosition
        );
    }
    for index in 0..SPOT_POSITIONS_COUNT {
        let position = read_spot_position(user_data, index)?;
        let has_activity = position.scaled_balance != 0
            || position.open_orders != 0
            || position.open_bids != 0
            || position.open_asks != 0;
        if has_activity && position.market_index != market_index {
            return err!(DriftAdaptorError::UnexpectedSpotPosition);
        }
        if position.scaled_balance != 0 {
            require!(
                position.balance_type()? == SpotBalanceTypeRaw::Deposit,
                DriftAdaptorError::UnsupportedBorrowPosition
            );
        }
    }

    Ok(())
}

fn validate_passive_spot_strategy_accounts(
    strategy_authority: &Pubkey,
    vault_asset_mint: &Pubkey,
    strategy_token_ata: &Account<TokenAccount>,
    drift_user: &AccountInfo,
    drift_user_stats: &AccountInfo,
    spot_market: &AccountInfo,
    spot_market_vault: &AccountInfo,
    spot_market_oracle: &AccountInfo,
    expected_sub_account_id: Option<u16>,
    market_index: u16,
) -> Result<()> {
    let sub_account_id = validate_user_account(
        strategy_authority,
        drift_user,
        drift_user_stats,
        market_index,
    )?;
    if let Some(expected) = expected_sub_account_id {
        require!(
            sub_account_id == expected,
            DriftAdaptorError::InvalidDriftSubAccountId
        );
    }

    let market = load_spot_market_prefix(&spot_market.try_borrow_data()?)?;

    require_keys_eq!(
        strategy_token_ata.owner,
        *strategy_authority,
        DriftAdaptorError::InvalidStrategyTokenOwner
    );
    require_keys_eq!(
        strategy_token_ata.mint,
        *vault_asset_mint,
        DriftAdaptorError::InvalidStrategyTokenMint
    );
    require_keys_eq!(
        market.mint(),
        *vault_asset_mint,
        DriftAdaptorError::InvalidSpotMarketMint
    );
    require_keys_eq!(
        market.vault(),
        spot_market_vault.key(),
        DriftAdaptorError::InvalidSpotMarketVault
    );
    require_keys_eq!(
        Pubkey::new_from_array(market.oracle),
        spot_market_oracle.key(),
        DriftAdaptorError::InvalidSpotMarket
    );
    require!(
        market.market_index == market_index,
        DriftAdaptorError::InvalidSpotMarketIndex
    );
    require_keys_eq!(
        market.pubkey(),
        spot_market.key(),
        DriftAdaptorError::InvalidSpotMarket
    );

    Ok(())
}
