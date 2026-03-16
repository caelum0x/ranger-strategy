use ::ctoken_market_program::{Market, CTOKEN_MINT_SEED, MARKET_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use ctoken_market_program::program::CtokenMarketProgram;

declare_id!("G5RgbPTWyYePXebLMsP6sZTQKkKZhwP3Zn1CnSGhPnPi");

#[program]
pub mod custom_adaptor_program {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // TODO_2: CPI INITIALIZE
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<u64> {
        if amount > 0 {
            // TODO_4: CPI DEPOSIT AND RELOAD
        }
        // TODO_5: CALCULATE CURRENT HOLDINGS
        Ok(0)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<u64> {
        // TODO_7: CALCULATE NUMBER OF CTOKEN AMOUNT TO REDEEM BACK FOR LIQUIDITY TOKEN
        // TODO_8: CPI WITHDRAW AND RELOAD
        // TODO_9: CALCULATE CURRENT HOLDINGS
        Ok(0)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: check in CPI call
    // #[account(constraint = strategy.key() == market.key())]
    pub strategy: AccountInfo<'info>,

    /// CHECK: check in CPI call
    pub system_program: AccountInfo<'info>,
    // TODO_1: fill in relevant accounts
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: check in CPI call
    // #[account(constraint = strategy.key() == market.key())]
    pub strategy: AccountInfo<'info>,

    /// CHECK: check in CPI call
    #[account(mut)]
    pub token_mint: AccountInfo<'info>,

    /// CHECK: check in CPI call
    #[account(mut)]
    pub user_token_ata: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    // TODO_6: fill in relevant accounts
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: check in CPI call
    // #[account(constraint = strategy.key() == market.key())]
    pub strategy: AccountInfo<'info>,

    /// CHECK: check in CPI call
    #[account(mut)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: check in CPI call
    #[account(mut)]
    pub user_token_ata: AccountInfo<'info>,

    /// CHECK: check in CPI call
    pub token_program: AccountInfo<'info>,
    // TODO_3: fill in relevant accounts
}
