//! sac-manager: the admin layer an issuer puts in front of a classic asset wrapped as a Stellar
//! Asset Contract. After `set_admin` on the SAC points here, minting goes through role checks and
//! a pause switch, which classic assets do not offer on their own (the gap the USDT0 team named
//! in the 8 Oct 2026 AMA). MintBurn OFTs are granted the MINTER role.
#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol};

pub const MINTER: Symbol = symbol_short!("MINTER");

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Token,
    Paused,
    Role(Symbol, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ManagerError {
    MissingRole = 1,
    Paused = 2,
    InvalidAmount = 3,
}

#[contract]
pub struct SacManager;

#[contractimpl]
impl SacManager {
    pub fn __constructor(env: Env, owner: Address, token: Address) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    pub fn token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    pub fn set_owner(env: Env, new_owner: Address) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::Owner, &new_owner);
    }

    pub fn grant_role(env: Env, role: Symbol, who: Address) {
        Self::owner(env.clone()).require_auth();
        env.storage().persistent().set(&DataKey::Role(role.clone(), who.clone()), &true);
        env.events().publish((symbol_short!("role"), symbol_short!("granted")), (role, who));
    }

    pub fn revoke_role(env: Env, role: Symbol, who: Address) {
        Self::owner(env.clone()).require_auth();
        env.storage().persistent().remove(&DataKey::Role(role.clone(), who.clone()));
        env.events().publish((symbol_short!("role"), symbol_short!("revoked")), (role, who));
    }

    pub fn has_role(env: Env, role: Symbol, who: Address) -> bool {
        env.storage().persistent().get(&DataKey::Role(role, who)).unwrap_or(false)
    }

    pub fn pause(env: Env) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("manager"), symbol_short!("paused")), ());
    }

    pub fn unpause(env: Env) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("manager"), symbol_short!("unpaused")), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    /// Mints `amount` of the managed asset to `to`. `minter` must authorize and hold MINTER.
    pub fn mint(env: Env, minter: Address, to: Address, amount: i128) -> Result<(), ManagerError> {
        minter.require_auth();
        if amount <= 0 {
            return Err(ManagerError::InvalidAmount);
        }
        if !Self::has_role(env.clone(), MINTER, minter) {
            return Err(ManagerError::MissingRole);
        }
        if Self::is_paused(env.clone()) {
            return Err(ManagerError::Paused);
        }
        let token = Self::token(env.clone());
        token::StellarAssetClient::new(&env, &token).mint(&to, &amount);
        Ok(())
    }
}
