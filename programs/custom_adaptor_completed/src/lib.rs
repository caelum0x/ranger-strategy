/// Custom Adaptor Program — completed from Workshop 2 template.
///
/// Bridges a Ranger Earn (Voltr) vault to the cToken market program
/// (simplified lending protocol) via CPI.
///
/// Three required adapter instructions:
///   1. initialize — set up market + user accounts for the strategy
///   2. deposit — deposit liquidity tokens → receive cTokens → report holdings
///   3. withdraw — burn cTokens → receive liquidity tokens → report holdings
///
/// Critical: account ordering must match what the vault passes as remaining accounts.
///
/// Completed from: hackathon-workshop-02/programs/custom-adaptor-program
use ::ctoken_market_program::{Market, CTOKEN_MINT_SEED, MARKET_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use ctoken_market_program::program::CtokenMarketProgram;

declare_id!("G5RgbPTWyYePXebLMsP6sZTQKkKZhwP3Zn1CnSGhPnPi");

#[program]
pub mod custom_adaptor_program {

    use super::*;

    /// Initialize: set up the cToken market and user accounts for this strategy.
    /// CPI to ctoken_market_program::initialize_market_and_user
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // TODO_2: CPI INITIALIZE — COMPLETED
        ctoken_market_program::cpi::initialize_market_and_user(CpiContext::new(
            ctx.accounts.ctoken_market_program.to_account_info(),
            ctoken_market_program::cpi::accounts::InitializeMarketAndUser {
                payer: ctx.accounts.payer.to_account_info(),
                user: ctx.accounts.authority.to_account_info(),
                market: ctx.accounts.market.to_account_info(),
                liquidity_mint: ctx.accounts.liquidity_mint.to_account_info(),
                ctoken_mint: ctx.accounts.ctoken_mint.to_account_info(),
                market_liquidity_ata: ctx.accounts.market_liquidity_ata.to_account_info(),
                user_ctoken_ata: ctx.accounts.user_ctoken_ata.to_account_info(),
                associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
                ctoken_token_program: ctx.accounts.ctoken_token_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ))?;
        Ok(())
    }

    /// Deposit: transfer liquidity tokens to cToken market, receive cTokens.
    /// Returns current position value (in liquidity token units).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<u64> {
        if amount > 0 {
            // TODO_4: CPI DEPOSIT AND RELOAD — COMPLETED
            ctoken_market_program::cpi::deposit_market(
                CpiContext::new(
                    ctx.accounts.ctoken_market_program.to_account_info(),
                    ctoken_market_program::cpi::accounts::DepositOrWithdraw {
                        user: ctx.accounts.user.to_account_info(),
                        market: ctx.accounts.market.to_account_info(),
                        liquidity_mint: ctx.accounts.token_mint.to_account_info(),
                        ctoken_mint: ctx.accounts.ctoken_mint.to_account_info(),
                        user_liquidity_ata: ctx.accounts.user_token_ata.to_account_info(),
                        market_liquidity_ata: ctx.accounts.market_liquidity_ata.to_account_info(),
                        user_ctoken_ata: ctx.accounts.user_ctoken_ata.to_account_info(),
                        liquidity_token_program: ctx.accounts.token_program.to_account_info(),
                        ctoken_token_program: ctx.accounts.ctoken_token_program.to_account_info(),
                    },
                ),
                amount,
            )?;

            // Reload accounts to get fresh state after CPI
            ctx.accounts.market.reload()?;
            ctx.accounts.user_ctoken_ata.reload()?;
        }

        // TODO_5: CALCULATE CURRENT HOLDINGS — COMPLETED
        // Holdings = user's cToken balance converted to liquidity token value
        let ctoken_balance = ctx.accounts.user_ctoken_ata.amount;
        let holdings = ctx.accounts.market.ctoken_to_liquidity(ctoken_balance);
        Ok(holdings)
    }

    /// Withdraw: burn cTokens to receive liquidity tokens back.
    /// The vault passes a liquidity token amount, but the lending program
    /// expects a cToken amount — conversion is required.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<u64> {
        if amount > 0 {
            // TODO_7: CALCULATE NUMBER OF CTOKEN AMOUNT TO REDEEM — COMPLETED
            // Convert requested liquidity token amount → cToken amount to burn
            let ctoken_amount = ctx.accounts.market.liquidity_to_ctoken(amount);

            // TODO_8: CPI WITHDRAW AND RELOAD — COMPLETED
            ctoken_market_program::cpi::withdraw_market(
                CpiContext::new(
                    ctx.accounts.ctoken_market_program.to_account_info(),
                    ctoken_market_program::cpi::accounts::DepositOrWithdraw {
                        user: ctx.accounts.user.to_account_info(),
                        market: ctx.accounts.market.to_account_info(),
                        liquidity_mint: ctx.accounts.token_mint.to_account_info(),
                        ctoken_mint: ctx.accounts.ctoken_mint.to_account_info(),
                        user_liquidity_ata: ctx.accounts.user_token_ata.to_account_info(),
                        market_liquidity_ata: ctx.accounts.market_liquidity_ata.to_account_info(),
                        user_ctoken_ata: ctx.accounts.user_ctoken_ata.to_account_info(),
                        liquidity_token_program: ctx.accounts.token_program.to_account_info(),
                        ctoken_token_program: ctx.accounts.ctoken_token_program.to_account_info(),
                    },
                ),
                ctoken_amount,
            )?;

            // Reload accounts to get fresh state
            ctx.accounts.market.reload()?;
            ctx.accounts.user_ctoken_ata.reload()?;
        }

        // TODO_9: CALCULATE CURRENT HOLDINGS — COMPLETED
        let ctoken_balance = ctx.accounts.user_ctoken_ata.amount;
        let holdings = ctx.accounts.market.ctoken_to_liquidity(ctoken_balance);
        Ok(holdings)
    }
}

// ── Account Contexts ────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: vault strategy address; validated by the caller/vault
    pub strategy: AccountInfo<'info>,

    /// CHECK: check in CPI call
    pub system_program: AccountInfo<'info>,

    // TODO_1: fill in relevant accounts — COMPLETED
    // These are the remaining accounts needed for cToken market initialization.
    // Order matters — must match what the vault passes.

    /// Market PDA (derived from liquidity mint)
    /// CHECK: validated in CPI
    #[account(mut)]
    pub market: AccountInfo<'info>,

    /// The liquidity token mint (e.g., USDC)
    pub liquidity_mint: Box<InterfaceAccount<'info, Mint>>,

    /// cToken mint PDA (derived from liquidity mint)
    /// CHECK: validated in CPI
    #[account(mut)]
    pub ctoken_mint: AccountInfo<'info>,

    /// Market's ATA for the liquidity token
    /// CHECK: validated in CPI
    #[account(mut)]
    pub market_liquidity_ata: AccountInfo<'info>,

    /// User's ATA for the cToken
    /// CHECK: validated in CPI
    #[account(mut)]
    pub user_ctoken_ata: AccountInfo<'info>,

    /// Associated Token Program
    /// CHECK: validated in CPI
    pub associated_token_program: AccountInfo<'info>,

    /// Liquidity token program (Token or Token-2022)
    pub liquidity_token_program: Interface<'info, TokenInterface>,

    /// cToken token program (standard Token)
    /// CHECK: validated in CPI
    pub ctoken_token_program: AccountInfo<'info>,

    /// Rent sysvar
    pub rent: Sysvar<'info, Rent>,

    /// cToken market program
    pub ctoken_market_program: Program<'info, CtokenMarketProgram>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: vault strategy address
    pub strategy: AccountInfo<'info>,

    /// Liquidity token mint (= vault asset mint)
    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// User's ATA for the liquidity token
    /// CHECK: validated in CPI
    #[account(mut)]
    pub user_token_ata: AccountInfo<'info>,

    /// Liquidity token program
    /// CHECK: validated in CPI
    pub token_program: AccountInfo<'info>,

    // TODO_3: fill in relevant accounts — COMPLETED

    /// Market PDA
    #[account(
        mut,
        seeds = [MARKET_SEED, token_mint.key().as_ref()],
        bump,
        seeds::program = ctoken_market_program.key(),
    )]
    pub market: Account<'info, Market>,

    /// cToken mint PDA
    #[account(
        mut,
        seeds = [CTOKEN_MINT_SEED, token_mint.key().as_ref()],
        bump,
        seeds::program = ctoken_market_program.key(),
    )]
    pub ctoken_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Market's ATA for the liquidity token
    /// CHECK: validated in CPI
    #[account(mut)]
    pub market_liquidity_ata: AccountInfo<'info>,

    /// User's ATA for the cToken
    #[account(
        mut,
        associated_token::mint = ctoken_mint,
        associated_token::authority = user,
        associated_token::token_program = ctoken_token_program,
    )]
    pub user_ctoken_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// cToken token program (standard Token)
    /// CHECK: validated in CPI
    pub ctoken_token_program: AccountInfo<'info>,

    /// cToken market program
    pub ctoken_market_program: Program<'info, CtokenMarketProgram>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: vault strategy address
    pub strategy: AccountInfo<'info>,

    /// Liquidity token mint (= vault asset mint)
    /// CHECK: validated in CPI
    #[account(mut)]
    pub token_mint: AccountInfo<'info>,

    /// User's ATA for the liquidity token
    /// CHECK: validated in CPI
    #[account(mut)]
    pub user_token_ata: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    // TODO_6: fill in relevant accounts — COMPLETED
    // Same accounts as Deposit (the lending program uses the same context)

    /// Market PDA
    #[account(mut)]
    pub market: Account<'info, Market>,

    /// cToken mint PDA
    #[account(mut)]
    pub ctoken_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Market's ATA for the liquidity token
    /// CHECK: validated in CPI
    #[account(mut)]
    pub market_liquidity_ata: AccountInfo<'info>,

    /// User's ATA for the cToken
    #[account(mut)]
    pub user_ctoken_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// cToken token program (standard Token)
    /// CHECK: validated in CPI
    pub ctoken_token_program: AccountInfo<'info>,

    /// cToken market program
    pub ctoken_market_program: Program<'info, CtokenMarketProgram>,
}
