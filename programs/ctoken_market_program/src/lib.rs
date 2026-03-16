use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction::create_account};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{InitializeMint, Mint as TokenMint, Token},
    token_2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

declare_id!("DPk5Ptke7pfV64sn3RtqQjYGCNYwtA6vmENxXakVfwpJ");

#[program]
pub mod ctoken_market_program {

    use super::*;

    pub fn initialize_market_and_user(ctx: Context<InitializeMarketAndUser>) -> Result<()> {
        if ctx.accounts.ctoken_mint.data_is_empty() {
            let rent_exemption = ctx.accounts.rent.minimum_balance(TokenMint::LEN);
            let create_mint_ix = create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.ctoken_mint.key(),
                rent_exemption,
                u64::try_from(TokenMint::LEN)?,
                &ctx.accounts.ctoken_token_program.key(),
            );

            let mint_seeds = &[
                CTOKEN_MINT_SEED,
                &ctx.accounts.liquidity_mint.key().to_bytes(),
                &[ctx.bumps.ctoken_mint],
            ];

            invoke_signed(
                &create_mint_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.ctoken_mint.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[mint_seeds],
            )?;

            anchor_spl::token::initialize_mint(
                CpiContext::new_with_signer(
                    ctx.accounts.ctoken_token_program.to_account_info(),
                    InitializeMint {
                        mint: ctx.accounts.ctoken_mint.clone(),
                        rent: ctx.accounts.rent.to_account_info(),
                    },
                    &[mint_seeds],
                ),
                ctx.accounts.liquidity_mint.decimals,
                &ctx.accounts.market.key(),
                None,
            )?;
        }

        if ctx.accounts.market_liquidity_ata.data_is_empty() {
            anchor_spl::associated_token::create(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                anchor_spl::associated_token::Create {
                    payer: ctx.accounts.payer.to_account_info(),
                    associated_token: ctx.accounts.market_liquidity_ata.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.liquidity_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.liquidity_token_program.to_account_info(),
                },
            ))?;
        }

        anchor_spl::associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            anchor_spl::associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.user_ctoken_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
                mint: ctx.accounts.ctoken_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.ctoken_token_program.to_account_info(),
            },
        ))?;

        Ok(())
    }

    pub fn deposit_market(ctx: Context<DepositOrWithdraw>, liquidity_amount: u64) -> Result<()> {
        token_2022::transfer_checked(
            CpiContext::new(
                ctx.accounts.liquidity_token_program.to_account_info(),
                token_2022::TransferChecked {
                    from: ctx.accounts.user_liquidity_ata.to_account_info(),
                    to: ctx.accounts.market_liquidity_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.liquidity_mint.to_account_info(),
                },
            ),
            liquidity_amount,
            ctx.accounts.liquidity_mint.decimals,
        )?;

        let market_seeds = &[
            MARKET_SEED,
            &ctx.accounts.liquidity_mint.key().to_bytes(),
            &[ctx.bumps.market],
        ];

        let ctoken_mint_amount = ctx.accounts.market.liquidity_to_ctoken(liquidity_amount);

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.ctoken_token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.ctoken_mint.to_account_info(),
                    to: ctx.accounts.user_ctoken_ata.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[market_seeds],
            ),
            ctoken_mint_amount,
        )?;

        ctx.accounts
            .market
            .increment_liquidity_deposited(liquidity_amount)?;
        ctx.accounts
            .market
            .increment_ctokens_minted(ctoken_mint_amount)?;

        Ok(())
    }

    pub fn withdraw_market(ctx: Context<DepositOrWithdraw>, ctoken_amount: u64) -> Result<()> {
        anchor_spl::token::burn(
            CpiContext::new(
                ctx.accounts.ctoken_token_program.to_account_info(),
                anchor_spl::token::Burn {
                    mint: ctx.accounts.ctoken_mint.to_account_info(),
                    from: ctx.accounts.user_ctoken_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            ctoken_amount,
        )?;

        let market_seeds = &[
            MARKET_SEED,
            &ctx.accounts.liquidity_mint.key().to_bytes(),
            &[ctx.bumps.market],
        ];

        let liquidity_transfer_amount = ctx.accounts.market.ctoken_to_liquidity(ctoken_amount);

        token_2022::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.liquidity_token_program.to_account_info(),
                token_2022::TransferChecked {
                    from: ctx.accounts.market_liquidity_ata.to_account_info(),
                    to: ctx.accounts.user_liquidity_ata.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.liquidity_mint.to_account_info(),
                },
                &[market_seeds],
            ),
            liquidity_transfer_amount,
            ctx.accounts.liquidity_mint.decimals,
        )?;

        ctx.accounts
            .market
            .decrement_liquidity_deposited(liquidity_transfer_amount)?;
        ctx.accounts
            .market
            .decrement_ctokens_minted(ctoken_amount)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMarketAndUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account()]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = std::mem::size_of::<Market>() + 8,
        seeds = [MARKET_SEED, liquidity_mint.key().as_ref()], 
        bump
    )]
    pub market: Account<'info, Market>,

    #[account()]
    pub liquidity_mint: InterfaceAccount<'info, Mint>,

    /// CHECK:
    #[account(
        mut,
        seeds = [CTOKEN_MINT_SEED, liquidity_mint.key().as_ref()], 
        bump
    )]
    pub ctoken_mint: AccountInfo<'info>,

    /// CHECK:
    #[account(
        mut, 
        constraint = market_liquidity_ata.key() == 
            get_associated_token_address_with_program_id(
                &market.key(), 
                &liquidity_mint.key(), 
                liquidity_token_program.key
            )
    )]
    pub market_liquidity_ata: AccountInfo<'info>,

    /// CHECK:
    #[account(
        mut, 
        constraint = user_ctoken_ata.key() == 
            get_associated_token_address_with_program_id(
                user.key, 
                ctoken_mint.key, 
                ctoken_token_program.key
            )
    )]
    pub user_ctoken_ata: AccountInfo<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub liquidity_token_program: Interface<'info, TokenInterface>,
    pub ctoken_token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositOrWithdraw<'info> {
    #[account()]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, liquidity_mint.key().as_ref()], 
        bump
    )]
    pub market: Account<'info, Market>,

    #[account()]
    pub liquidity_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [CTOKEN_MINT_SEED, liquidity_mint.key().as_ref()], 
        bump
    )]
    pub ctoken_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = liquidity_mint,
        associated_token::authority = user,
        associated_token::token_program = liquidity_token_program,
    )]
    pub user_liquidity_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = liquidity_mint,
        associated_token::authority = market,
        associated_token::token_program = liquidity_token_program,
    )]
    pub market_liquidity_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = ctoken_mint,
        associated_token::authority = user,
        associated_token::token_program = ctoken_token_program,
    )]
    pub user_ctoken_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub liquidity_token_program: Interface<'info, TokenInterface>,
    pub ctoken_token_program: Program<'info, Token>,
}

#[account]
pub struct Market {
    liquidity_deposited: u64,
    ctokens_minted: u64,
}

impl Market {
    fn liquidity_to_ctoken(&self, liquidity_amount: u64) -> u64 {
        if self.liquidity_deposited == 0 {
            return liquidity_amount;
        }

        (liquidity_amount as u128)
            .checked_mul(self.ctokens_minted as u128)
            .unwrap()
            .checked_div(self.liquidity_deposited as u128)
            .unwrap() as u64
    }

    pub fn ctoken_to_liquidity(&self, ctoken_amount: u64) -> u64 {
        (ctoken_amount as u128)
            .checked_mul(self.liquidity_deposited as u128)
            .unwrap()
            .checked_div(self.ctokens_minted as u128)
            .unwrap() as u64
    }

    fn decrement_liquidity_deposited(&mut self, decrement_amount: u64) -> Result<()> {
        self.liquidity_deposited = self
            .liquidity_deposited
            .checked_sub(decrement_amount)
            .unwrap();
        Ok(())
    }

    fn increment_liquidity_deposited(&mut self, increment_amount: u64) -> Result<()> {
        self.liquidity_deposited = self
            .liquidity_deposited
            .checked_add(increment_amount)
            .unwrap();
        Ok(())
    }

    fn decrement_ctokens_minted(&mut self, decrement_amount: u64) -> Result<()> {
        self.ctokens_minted = self.ctokens_minted.checked_sub(decrement_amount).unwrap();
        Ok(())
    }

    fn increment_ctokens_minted(&mut self, increment_amount: u64) -> Result<()> {
        self.ctokens_minted = self.ctokens_minted.checked_add(increment_amount).unwrap();
        Ok(())
    }
}

pub const CTOKEN_MINT_SEED: &[u8] = b"ctoken_mint";
pub const MARKET_SEED: &[u8] = b"market";
