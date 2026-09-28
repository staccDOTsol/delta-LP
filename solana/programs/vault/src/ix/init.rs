//! InitVault: create the vault PDA, receipt mint, vault ATAs and the hedge-venue user objects.

use crate::{
    error::VaultError,
    ix::common::*,
    state::*,
    venue::{drift, klend, whirlpool},
};
use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeMint2;

/// data: [hedge_kind u8][params 16]
///
/// accounts (common 0..=12):
///  0 payer (w,s)          1 authority (s)          2 vault (w)
///  3 whirlpool            4 base_mint              5 quote_mint
///  6 receipt_mint (w)     7 base_ata (w)           8 quote_ata (w)
///  9 token_program        10 ata_program           11 system_program   12 rent
/// klend  (13..=18): 13 klend_program 14 lending_market 15 user_metadata (w) 16 obligation (w) 17 quote_reserve 18 base_reserve
/// drift  (13..=18): 13 drift_program 14 state (w)       15 user_stats (w)    16 user (w)       17 perp_market   18 quote_spot_market
pub fn init_vault(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 19)?;
    let mut args = Args(data);
    let kind = HedgeKind::from_u8(args.u8()?)?;
    let params = Params::from_bytes(args.0)?;

    let payer = &accounts[0];
    let authority = &accounts[1];
    let vault_acc = &accounts[2];
    let whirlpool_acc = &accounts[3];
    let base_mint = &accounts[4];
    let quote_mint = &accounts[5];
    let receipt_mint = &accounts[6];
    let base_ata = &accounts[7];
    let quote_ata = &accounts[8];
    let token_program = &accounts[9];
    let ata_program = &accounts[10];
    let system_program = &accounts[11];
    let rent_acc = &accounts[12];

    require_signer(payer)?;
    require_signer(authority)?;
    if token_program.address() != &TOKEN_PROGRAM || ata_program.address() != &ATA_PROGRAM || system_program.address() != &SYSTEM_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- whirlpool: base = token A, quote = token B
    let wp = whirlpool::read_whirlpool(whirlpool_acc)?;
    require_key(base_mint, &wp.token_mint_a)?;
    require_key(quote_mint, &wp.token_mint_b)?;
    let base_decimals = mint_decimals(base_mint)?;
    let quote_decimals = mint_decimals(quote_mint)?;

    // ---- hedge market key (klend: lending_market; drift: perp market)
    let hedge_market_acc = if kind == HedgeKind::Klend { &accounts[14] } else { &accounts[17] };
    let hedge_market: [u8; 32] = *hedge_market_acc.address().as_array();

    // ---- vault PDA
    let (vault_pda, bump) = derive_vault(program_id, whirlpool_acc.address().as_array(), &hedge_market, kind as u8);
    if vault_acc.address() != &vault_pda {
        return Err(VaultError::BadPda.into());
    }
    let rent = Rent::get()?;
    let kind_b = [kind as u8];
    {
        let bump_b = [bump];
        let seeds_arr = [Seed::from(seeds::VAULT), Seed::from(whirlpool_acc.address().as_array()), Seed::from(&hedge_market), Seed::from(&kind_b), Seed::from(&bump_b)];
        let signer = signer_from(&seeds_arr);
        CreateAccount { from: payer, to: vault_acc, lamports: rent.try_minimum_balance(VAULT_LEN)?, space: VAULT_LEN as u64, owner: program_id }.invoke_signed(&signer)?;
    }

    // ---- receipt mint PDA (plain SPL, 6 decimals, authority = vault)
    let (receipt_pda, receipt_bump) = derive_receipt(program_id, &vault_pda);
    if receipt_mint.address() != &receipt_pda {
        return Err(VaultError::BadPda.into());
    }
    {
        let rb = [receipt_bump];
        let rseeds = [Seed::from(seeds::RECEIPT), Seed::from(vault_pda.as_array()), Seed::from(&rb)];
        let rsigner = [pinocchio::cpi::Signer::from(&rseeds)];
        CreateAccount { from: payer, to: receipt_mint, lamports: rent.try_minimum_balance(82)?, space: 82, owner: &TOKEN_PROGRAM }.invoke_signed(&rsigner)?;
        InitializeMint2::new(receipt_mint, RECEIPT_DECIMALS, &vault_pda, None).invoke()?;
    }

    // ---- vault ATAs for base + quote
    pinocchio_associated_token_account::instructions::CreateIdempotent { funding_account: payer, account: base_ata, wallet: vault_acc, mint: base_mint, system_program, token_program }.invoke()?;
    pinocchio_associated_token_account::instructions::CreateIdempotent { funding_account: payer, account: quote_ata, wallet: vault_acc, mint: quote_mint, system_program, token_program }.invoke()?;
    let (o, m) = token_owner_and_mint(base_ata)?;
    if &o != vault_pda.as_array() || &m != base_mint.address().as_array() {
        return Err(VaultError::BadVenueAccount.into());
    }
    let (o, m) = token_owner_and_mint(quote_ata)?;
    if &o != vault_pda.as_array() || &m != quote_mint.address().as_array() {
        return Err(VaultError::BadVenueAccount.into());
    }

    // ---- write state
    let (hedge_account, hedge_quote, hedge_base) = {
        let v = Vault::load_uninit_acc(vault_acc)?;
        v.disc = VAULT_DISC;
        v.version = VAULT_VERSION;
        v.bump = bump;
        v.receipt_bump = receipt_bump;
        v.phase = Phase::Idle as u8;
        v.hedge_kind = kind as u8;
        v.flags = 0;
        v.quote_decimals = quote_decimals;
        v.base_decimals = base_decimals;
        v.crank = *authority.address().as_array();
        v.authority = *authority.address().as_array();
        v.quote_mint = *quote_mint.address().as_array();
        v.base_mint = *base_mint.address().as_array();
        v.receipt_mint = *receipt_mint.address().as_array();
        v.quote_ata = *quote_ata.address().as_array();
        v.base_ata = *base_ata.address().as_array();
        v.whirlpool = *whirlpool_acc.address().as_array();
        v.hedge_market = hedge_market;
        v.params = params;
        v.set_health_x100(u32::MAX);
        match kind {
            HedgeKind::Klend => {
                v.hedge_account = *accounts[16].address().as_array();
                v.hedge_quote = *accounts[17].address().as_array();
                v.hedge_base = *accounts[18].address().as_array();
            }
            HedgeKind::Drift => {
                v.hedge_account = *accounts[16].address().as_array();
                v.hedge_quote = *accounts[18].address().as_array();
                v.hedge_base = [0u8; 32];
            }
        }
        (v.hedge_account, v.hedge_quote, v.hedge_base)
    };

    // ---- venue user objects, signed by the vault PDA
    let bump_b = [bump];
    let vseeds = [Seed::from(seeds::VAULT), Seed::from(whirlpool_acc.address().as_array()), Seed::from(&hedge_market), Seed::from(&kind_b), Seed::from(&bump_b)];
    let vsigner = signer_from(&vseeds);
    match kind {
        HedgeKind::Klend => {
            let klend_program = &accounts[13];
            let lending_market = &accounts[14];
            let user_metadata = &accounts[15];
            let obligation = &accounts[16];
            let rq = klend::read_reserve(&accounts[17])?;
            let rb = klend::read_reserve(&accounts[18])?;
            if rq.lending_market != *lending_market.address().as_array() || rb.lending_market != *lending_market.address().as_array() {
                return Err(VaultError::BadVenueAccount.into());
            }
            if rq.liquidity_mint != *quote_mint.address().as_array() || rb.liquidity_mint != *base_mint.address().as_array() {
                return Err(VaultError::BadVenueAccount.into());
            }
            if hedge_quote != *accounts[17].address().as_array() || hedge_base != *accounts[18].address().as_array() {
                return Err(VaultError::UnexpectedState.into());
            }
            // PDAs under klend
            let (um, _) = Address::find_program_address(&[b"user_meta".as_ref(), vault_pda.as_array().as_ref()], &klend::ID);
            if user_metadata.address() != &um {
                return Err(VaultError::BadPda.into());
            }
            let (ob, _) = Address::find_program_address(&[&[0u8], &[0u8], vault_pda.as_array().as_ref(), lending_market.address().as_array().as_ref(), &[0u8; 32], &[0u8; 32]], &klend::ID);
            if obligation.address() != &ob || hedge_account != *ob.as_array() {
                return Err(VaultError::BadPda.into());
            }
            klend::init_user_metadata(&klend::InitUserMetadataAccounts { owner: vault_acc, fee_payer: payer, user_metadata, klend_program, rent: rent_acc, system_program }, &vsigner)?;
            klend::init_obligation(&klend::InitObligationAccounts { owner: vault_acc, fee_payer: payer, obligation, lending_market, system_program, user_metadata, rent: rent_acc, klend_program }, 0, 0, &vsigner)?;
        }
        HedgeKind::Drift => {
            let drift_program = &accounts[13];
            let state = &accounts[14];
            let user_stats = &accounts[15];
            let user = &accounts[16];
            let pm = drift::read_perp_market(&accounts[17])?;
            let sm = drift::read_spot_market(&accounts[18])?;
            if sm.market_index != pm.quote_spot_market_index || sm.mint != *quote_mint.address().as_array() {
                return Err(VaultError::BadVenueAccount.into());
            }
            let (us, _) = Address::find_program_address(&[b"user_stats".as_ref(), vault_pda.as_array().as_ref()], &drift::ID);
            let (u, _) = Address::find_program_address(&[b"user".as_ref(), vault_pda.as_array().as_ref(), 0u16.to_le_bytes().as_ref()], &drift::ID);
            if user_stats.address() != &us || user.address() != &u {
                return Err(VaultError::BadPda.into());
            }
            let a = drift::InitUserAccounts { user, user_stats, state, authority: vault_acc, payer, rent: rent_acc, system_program, drift_program };
            drift::initialize_user_stats(&a, &vsigner)?;
            let mut name = [0u8; 32];
            name[..8].copy_from_slice(b"dlp-hedg");
            drift::initialize_user(&a, 0, &name, &vsigner)?;
        }
    }
    Ok(())
}

/// InitFarms (klend only, permissionless): create the obligation's farm user state for a reserve.
/// data: [mode u8]  (0 = collateral farm of `reserve`, 1 = debt farm)
/// accounts: 0 payer (w,s) 1 vault 2 obligation (w) 3 lending_market_authority 4 reserve (w)
///           5 reserve_farm_state (w) 6 obligation_farm (w) 7 lending_market 8 farms_program
///           9 rent 10 system_program 11 klend_program
pub fn init_farms(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 12)?;
    let mode = Args(data).u8()?;
    let vault_acc = &accounts[1];
    let d = vault_acc.try_borrow()?;
    let v = Vault::load(&d)?;
    check_vault_pda(program_id, vault_acc, v)?;
    if v.hedge_kind()? != HedgeKind::Klend {
        return Err(VaultError::HedgeKindMismatch.into());
    }
    require_key(&accounts[2], &v.hedge_account)?;
    require_key(&accounts[7], &v.hedge_market)?;
    let reserve_key = accounts[4].address().as_array();
    if reserve_key != &v.hedge_quote && reserve_key != &v.hedge_base {
        return Err(VaultError::BadVenueAccount.into());
    }
    require_signer(&accounts[0])?;
    klend::init_obligation_farms_for_reserve(
        &klend::InitObligationFarmsAccounts {
            payer: &accounts[0],
            owner: vault_acc,
            obligation: &accounts[2],
            lending_market_authority: &accounts[3],
            reserve: &accounts[4],
            reserve_farm_state: &accounts[5],
            obligation_farm: &accounts[6],
            lending_market: &accounts[7],
            farms_program: &accounts[8],
            rent: &accounts[9],
            system_program: &accounts[10],
            klend_program: &accounts[11],
        },
        mode,
    )
}

/// ReopenObligation (klend only, permissionless): re-create the obligation after klend closed it
/// on a full unwind. accounts: 0 payer (w,s) 1 vault (w) 2 obligation (w) 3 lending_market
///                             4 system_program 5 user_metadata 6 rent 7 klend_program
pub fn reopen_obligation(program_id: &Address, accounts: &mut [AccountView], _data: &[u8]) -> ProgramResult {
    let accounts = need(views(accounts), 8)?;
    let vault_acc = &accounts[1];
    let seeds = {
        let d = vault_acc.try_borrow()?;
        let v = Vault::load(&d)?;
        check_vault_pda(program_id, vault_acc, v)?;
        if v.hedge_kind()? != HedgeKind::Klend {
            return Err(VaultError::HedgeKindMismatch.into());
        }
        require_key(&accounts[2], &v.hedge_account)?;
        require_key(&accounts[3], &v.hedge_market)?;
        VaultSeeds::from_vault(v)
    };
    require_signer(&accounts[0])?;
    if klend::obligation_is_open(&accounts[2]) {
        return Err(VaultError::UnexpectedState.into());
    }
    let arr = seeds.seeds();
    let signer = signer_from(&arr);
    klend::init_obligation(
        &klend::InitObligationAccounts { owner: vault_acc, fee_payer: &accounts[0], obligation: &accounts[2], lending_market: &accounts[3], system_program: &accounts[4], user_metadata: &accounts[5], rent: &accounts[6], klend_program: &accounts[7] },
        0,
        0,
        &signer,
    )
}
