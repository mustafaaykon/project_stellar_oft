//! oft: a worked MintBurn Omnichain Fungible Token for Stellar, in the shape LayerZero's Stellar
//! OFT uses: a SEP-41 token (here a Stellar Asset Contract), a SAC Manager holding the mint
//! role, and this contract, which burns on send and mints on receive through the manager.
//!
//! Amounts cross chains in `shared_decimals` (6); the local token has 7, so the seventh decimal
//! is removed as dust before sending and stays with the sender. The issuer account may be
//! neither sender nor recipient, because for a classic asset that is a burn or a mint.
#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token, Address,
    Bytes, BytesN, Env,
};
use soroban_sdk::address_payload::AddressPayload;

#[contractclient(name = "EndpointClient")]
pub trait Endpoint {
    fn quote(env: Env, dst_eid: u32, message: Bytes, options: Bytes) -> i128;
    fn send(env: Env, sender: Address, dst_eid: u32, receiver: BytesN<32>, message: Bytes, options: Bytes) -> BytesN<32>;
}

#[contractclient(name = "ManagerClient")]
pub trait Manager {
    fn mint(env: Env, minter: Address, to: Address, amount: i128);
}

/// Message type used for enforced options, as in LayerZero's OFT (SEND = 1).
pub const MSG_TYPE_SEND: u32 = 1;
const RECIPIENT_ACCOUNT: u8 = 0;
const RECIPIENT_CONTRACT: u8 = 1;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Token,
    Manager,
    Endpoint,
    Issuer,
    SharedDecimals,
    LocalDecimals,
    Peer(u32),
    EnforcedOptions(u32, u32),
    TotalSent,
    TotalReceived,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OftError {
    NoPeer = 1,
    InvalidSender = 2,
    SlippageExceeded = 3,
    InvalidMessage = 4,
    ZeroAmount = 5,
    IssuerNotAllowed = 6,
    InvalidDecimals = 7,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OftReceipt {
    pub guid: BytesN<32>,
    pub amount_sent_ld: i128,
    pub amount_received_ld: i128,
}

#[contract]
pub struct Oft;

#[contractimpl]
impl Oft {
    pub fn __constructor(env: Env, owner: Address, token: Address, sac_manager: Address, endpoint: Address, issuer: Address, shared_decimals: u32) {
        let local_decimals = token::TokenClient::new(&env, &token).decimals();
        if shared_decimals > local_decimals {
            panic!("shared decimals exceed local decimals");
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Manager, &sac_manager);
        env.storage().instance().set(&DataKey::Endpoint, &endpoint);
        env.storage().instance().set(&DataKey::Issuer, &issuer);
        env.storage().instance().set(&DataKey::SharedDecimals, &shared_decimals);
        env.storage().instance().set(&DataKey::LocalDecimals, &local_decimals);
    }

    // ----- views ---------------------------------------------------------------------------

    pub fn owner(env: Env) -> Address { env.storage().instance().get(&DataKey::Owner).unwrap() }
    pub fn token(env: Env) -> Address { env.storage().instance().get(&DataKey::Token).unwrap() }
    pub fn sac_manager(env: Env) -> Address { env.storage().instance().get(&DataKey::Manager).unwrap() }
    pub fn endpoint(env: Env) -> Address { env.storage().instance().get(&DataKey::Endpoint).unwrap() }
    pub fn issuer(env: Env) -> Address { env.storage().instance().get(&DataKey::Issuer).unwrap() }
    pub fn shared_decimals(env: Env) -> u32 { env.storage().instance().get(&DataKey::SharedDecimals).unwrap() }
    pub fn local_decimals(env: Env) -> u32 { env.storage().instance().get(&DataKey::LocalDecimals).unwrap() }
    pub fn total_sent(env: Env) -> i128 { env.storage().instance().get(&DataKey::TotalSent).unwrap_or(0) }
    pub fn total_received(env: Env) -> i128 { env.storage().instance().get(&DataKey::TotalReceived).unwrap_or(0) }

    pub fn peer(env: Env, eid: u32) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Peer(eid))
    }

    pub fn enforced_options(env: Env, eid: u32, msg_type: u32) -> Bytes {
        env.storage().persistent().get(&DataKey::EnforcedOptions(eid, msg_type)).unwrap_or(Bytes::new(&env))
    }

    pub fn decimal_conversion_rate(env: Env) -> i128 {
        let diff = Self::local_decimals(env.clone()) - Self::shared_decimals(env);
        10i128.pow(diff)
    }

    /// Removes the dust below one shared-decimal unit. The remainder stays with the sender.
    pub fn remove_dust(env: Env, amount_ld: i128) -> i128 {
        let rate = Self::decimal_conversion_rate(env);
        (amount_ld / rate) * rate
    }

    /// (amount that would leave the sender, amount the recipient would receive), both in local decimals.
    pub fn quote_oft(env: Env, _dst_eid: u32, amount_ld: i128) -> (i128, i128) {
        let sent = Self::remove_dust(env, amount_ld);
        (sent, sent)
    }

    /// Native fee the endpoint would charge (zero on the mock).
    pub fn quote_send(env: Env, dst_eid: u32, to: BytesN<32>, to_is_contract: bool, amount_ld: i128) -> i128 {
        let amount_sd = Self::to_sd(&env, Self::remove_dust(env.clone(), amount_ld));
        let message = Self::encode(&env, &to, to_is_contract, amount_sd);
        let options = Self::enforced_options(env.clone(), dst_eid, MSG_TYPE_SEND);
        EndpointClient::new(&env, &Self::endpoint(env.clone())).quote(&dst_eid, &message, &options)
    }

    // ----- owner configuration -------------------------------------------------------------

    /// Sets or clears the trusted OFT on `eid`. `None` clears it. (A stellar-cli 25.1.0 bug
    /// stored `None` when handed an `Option<BytesN<32>>` argument; `oftkit check` catches it.)
    pub fn set_peer(env: Env, eid: u32, peer: Option<BytesN<32>>) {
        Self::owner(env.clone()).require_auth();
        match peer {
            Some(p) => env.storage().persistent().set(&DataKey::Peer(eid), &p),
            None => env.storage().persistent().remove(&DataKey::Peer(eid)),
        }
        env.events().publish((symbol_short!("oft"), symbol_short!("peer")), eid);
    }

    pub fn set_enforced_options(env: Env, eid: u32, msg_type: u32, options: Bytes) {
        Self::owner(env.clone()).require_auth();
        env.storage().persistent().set(&DataKey::EnforcedOptions(eid, msg_type), &options);
    }

    // ----- send and receive ----------------------------------------------------------------

    /// Burns `amount_ld` (less dust) from `from` and asks the endpoint to carry it to `to` on
    /// `dst_eid`. Returns the packet guid.
    pub fn send(env: Env, from: Address, dst_eid: u32, to: BytesN<32>, to_is_contract: bool, amount_ld: i128, min_amount_ld: i128) -> Result<OftReceipt, OftError> {
        from.require_auth();
        if from == Self::issuer(env.clone()) {
            return Err(OftError::IssuerNotAllowed);
        }
        let peer = Self::peer(env.clone(), dst_eid).ok_or(OftError::NoPeer)?;
        let amount_sent = Self::remove_dust(env.clone(), amount_ld);
        if amount_sent <= 0 {
            return Err(OftError::ZeroAmount);
        }
        if amount_sent < min_amount_ld {
            return Err(OftError::SlippageExceeded);
        }
        token::TokenClient::new(&env, &Self::token(env.clone())).burn(&from, &amount_sent);

        let amount_sd = Self::to_sd(&env, amount_sent);
        let message = Self::encode(&env, &to, to_is_contract, amount_sd);
        let options = Self::enforced_options(env.clone(), dst_eid, MSG_TYPE_SEND);
        let guid = EndpointClient::new(&env, &Self::endpoint(env.clone())).send(&env.current_contract_address(), &dst_eid, &peer, &message, &options);

        let total = Self::total_sent(env.clone()) + amount_sent;
        env.storage().instance().set(&DataKey::TotalSent, &total);
        env.events().publish((symbol_short!("oft"), symbol_short!("sent"), from), (dst_eid, to, amount_sent, guid.clone()));
        Ok(OftReceipt { guid, amount_sent_ld: amount_sent, amount_received_ld: amount_sent })
    }

    /// Called by the endpoint when a packet from a trusted peer arrives; mints to the recipient.
    pub fn lz_receive(env: Env, src_eid: u32, sender: BytesN<32>, nonce: u64, guid: BytesN<32>, message: Bytes) -> Result<(), OftError> {
        Self::endpoint(env.clone()).require_auth();
        match Self::peer(env.clone(), src_eid) {
            Some(p) if p == sender => {}
            _ => return Err(OftError::InvalidSender),
        }
        let (to, amount_sd) = Self::decode(&env, &message)?;
        if to == Self::issuer(env.clone()) {
            return Err(OftError::IssuerNotAllowed);
        }
        let amount_ld = amount_sd * Self::decimal_conversion_rate(env.clone());
        ManagerClient::new(&env, &Self::sac_manager(env.clone())).mint(&env.current_contract_address(), &to, &amount_ld);

        let total = Self::total_received(env.clone()) + amount_ld;
        env.storage().instance().set(&DataKey::TotalReceived, &total);
        env.events().publish((symbol_short!("oft"), symbol_short!("received"), to), (src_eid, nonce, amount_ld, guid));
        Ok(())
    }

    // ----- codec ---------------------------------------------------------------------------

    fn to_sd(env: &Env, amount_ld: i128) -> i128 {
        amount_ld / Self::decimal_conversion_rate(env.clone())
    }

    /// Wire format: 1 byte recipient kind (0 account, 1 contract), 32 bytes key, 8 bytes amount
    /// in shared decimals, big-endian. 41 bytes in all.
    fn encode(env: &Env, to: &BytesN<32>, to_is_contract: bool, amount_sd: i128) -> Bytes {
        let mut m = Bytes::new(env);
        m.push_back(if to_is_contract { RECIPIENT_CONTRACT } else { RECIPIENT_ACCOUNT });
        m.append(&Bytes::from(to.clone()));
        m.extend_from_array(&(amount_sd as u64).to_be_bytes());
        m
    }

    fn decode(env: &Env, message: &Bytes) -> Result<(Address, i128), OftError> {
        if message.len() != 41 {
            return Err(OftError::InvalidMessage);
        }
        let kind = message.get(0).unwrap();
        let mut key = [0u8; 32];
        message.slice(1..33).copy_into_slice(&mut key);
        let mut amt = [0u8; 8];
        message.slice(33..41).copy_into_slice(&mut amt);
        let key = BytesN::from_array(env, &key);
        let to = match kind {
            RECIPIENT_ACCOUNT => Address::from_payload(env, AddressPayload::AccountIdPublicKeyEd25519(key)),
            RECIPIENT_CONTRACT => Address::from_payload(env, AddressPayload::ContractIdHash(key)),
            _ => return Err(OftError::InvalidMessage),
        };
        Ok((to, u64::from_be_bytes(amt) as i128))
    }
}

#[cfg(test)]
mod test;
