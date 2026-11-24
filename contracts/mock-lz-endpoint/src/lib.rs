//! mock-lz-endpoint: a test double for the LayerZero V2 endpoint on Stellar.
//!
//! It implements the surface an OApp or OFT calls (`quote`, `send`) and the delivery side
//! (`deliver`, `deliver_inbound`) with in-memory routing between simulated chains. Each endpoint
//! instance carries one endpoint id (eid); `set_remote` tells it which endpoint contract stands
//! for a remote eid. Messages can be delivered automatically, held for a relayer (`Manual`), or
//! made to fail on purpose (`Fail`) so retry and refund paths are reachable from a unit test.
//!
//! It does not simulate DVN verification, message libraries, or fee pricing. `quote` always
//! returns zero. Testnet and local use only.
#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Vec,
};
use soroban_sdk::address_payload::AddressPayload;

#[contractclient(name = "OAppClient")]
pub trait OApp {
    fn lz_receive(env: Env, src_eid: u32, sender: BytesN<32>, nonce: u64, guid: BytesN<32>, message: Bytes);
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Packet {
    pub guid: BytesN<32>,
    pub nonce: u64,
    pub src_eid: u32,
    pub sender: BytesN<32>,
    pub dst_eid: u32,
    pub receiver: BytesN<32>,
    pub message: Bytes,
    pub options: Bytes,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DeliveryMode {
    Auto = 0,
    Manual = 1,
    Fail = 2,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Eid,
    Mode,
    Remote(u32),
    Nonce(u32),
    Pending,
    Packet(BytesN<32>),
    Delivered(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EndpointError {
    UnknownRemote = 1,
    UnknownPacket = 2,
    AlreadyDelivered = 3,
    DeliveryFailed = 4,
    SimulatedFailure = 5,
    InvalidReceiver = 6,
}

#[contract]
pub struct MockLzEndpoint;

#[contractimpl]
impl MockLzEndpoint {
    pub fn __constructor(env: Env, eid: u32) {
        env.storage().instance().set(&DataKey::Eid, &eid);
        env.storage().instance().set(&DataKey::Mode, &DeliveryMode::Auto);
        env.storage().persistent().set(&DataKey::Pending, &Vec::<BytesN<32>>::new(&env));
    }

    // ----- configuration -------------------------------------------------------------------

    pub fn eid(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Eid).unwrap()
    }

    pub fn delivery_mode(env: Env) -> DeliveryMode {
        env.storage().instance().get(&DataKey::Mode).unwrap_or(DeliveryMode::Auto)
    }

    pub fn set_delivery_mode(env: Env, mode: DeliveryMode) {
        env.storage().instance().set(&DataKey::Mode, &mode);
    }

    /// Registers the endpoint contract that stands for `remote_eid`.
    pub fn set_remote(env: Env, remote_eid: u32, endpoint: Address) {
        env.storage().persistent().set(&DataKey::Remote(remote_eid), &endpoint);
    }

    pub fn remote(env: Env, remote_eid: u32) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Remote(remote_eid))
    }

    // ----- OApp-facing surface -------------------------------------------------------------

    /// The mock charges no fee. Real endpoints return a native fee here.
    pub fn quote(_env: Env, _dst_eid: u32, _message: Bytes, _options: Bytes) -> i128 {
        0
    }

    /// Accepts an outbound packet from `sender` (the OApp). Returns the packet guid.
    pub fn send(env: Env, sender: Address, dst_eid: u32, receiver: BytesN<32>, message: Bytes, options: Bytes) -> BytesN<32> {
        sender.require_auth();
        let src_eid = Self::eid(env.clone());
        let nonce: u64 = env.storage().persistent().get(&DataKey::Nonce(dst_eid)).unwrap_or(0) + 1;
        env.storage().persistent().set(&DataKey::Nonce(dst_eid), &nonce);

        let sender_bytes = match sender.to_payload() {
            Some(AddressPayload::ContractIdHash(h)) => h,
            Some(AddressPayload::AccountIdPublicKeyEd25519(k)) => k,
            None => panic!("unsupported sender address"),
        };

        let mut preimage = Bytes::new(&env);
        preimage.extend_from_array(&src_eid.to_be_bytes());
        preimage.extend_from_array(&dst_eid.to_be_bytes());
        preimage.extend_from_array(&nonce.to_be_bytes());
        preimage.append(&Bytes::from(sender_bytes.clone()));
        preimage.append(&Bytes::from(receiver.clone()));
        let guid: BytesN<32> = env.crypto().sha256(&preimage).to_bytes();

        let packet = Packet { guid: guid.clone(), nonce, src_eid, sender: sender_bytes, dst_eid, receiver, message, options };
        env.storage().persistent().set(&DataKey::Packet(guid.clone()), &packet);
        let mut pending: Vec<BytesN<32>> = env.storage().persistent().get(&DataKey::Pending).unwrap_or(Vec::new(&env));
        pending.push_back(guid.clone());
        env.storage().persistent().set(&DataKey::Pending, &pending);
        env.events().publish((symbol_short!("lz"), symbol_short!("sent")), packet);

        if Self::delivery_mode(env.clone()) == DeliveryMode::Auto {
            // Auto mode delivers in the same transaction; a failure here fails the send.
            if !Self::deliver(env.clone(), guid.clone()) {
                panic!("auto delivery failed");
            }
        }
        guid
    }

    // ----- delivery side -------------------------------------------------------------------

    /// Attempts to deliver a pending packet to its destination endpoint. Returns `true` when
    /// the destination OApp accepted it. A failed attempt leaves the packet pending so it can
    /// be retried (for example once a recipient has created a trustline).
    pub fn deliver(env: Env, guid: BytesN<32>) -> bool {
        let packet: Packet = env.storage().persistent().get(&DataKey::Packet(guid.clone())).unwrap_or_else(|| panic!("unknown packet"));
        if env.storage().persistent().has(&DataKey::Delivered(guid.clone())) {
            panic!("already delivered");
        }
        if Self::delivery_mode(env.clone()) == DeliveryMode::Fail {
            env.events().publish((symbol_short!("lz"), symbol_short!("failed")), (guid, symbol_short!("simfail")));
            return false;
        }
        let remote: Address = env.storage().persistent().get(&DataKey::Remote(packet.dst_eid)).unwrap_or_else(|| panic!("unknown remote"));
        let result = MockLzEndpointClient::new(&env, &remote).try_deliver_inbound(&packet);
        match result {
            Ok(Ok(())) => {
                Self::mark_delivered(&env, &guid);
                env.events().publish((symbol_short!("lz"), symbol_short!("delivered")), guid);
                true
            }
            _ => {
                env.events().publish((symbol_short!("lz"), symbol_short!("failed")), (guid, symbol_short!("receive")));
                false
            }
        }
    }

    /// Called by the source endpoint for `packet.src_eid`; invokes the receiver OApp.
    pub fn deliver_inbound(env: Env, packet: Packet) {
        let source: Address = env.storage().persistent().get(&DataKey::Remote(packet.src_eid)).unwrap_or_else(|| panic!("unknown remote"));
        source.require_auth();
        let receiver = Address::from_payload(&env, AddressPayload::ContractIdHash(packet.receiver.clone()));
        OAppClient::new(&env, &receiver).lz_receive(&packet.src_eid, &packet.sender, &packet.nonce, &packet.guid, &packet.message);
        env.events().publish((symbol_short!("lz"), symbol_short!("inbound")), packet.guid);
    }

    // ----- views ---------------------------------------------------------------------------

    pub fn pending(env: Env) -> Vec<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Pending).unwrap_or(Vec::new(&env))
    }

    pub fn packet(env: Env, guid: BytesN<32>) -> Option<Packet> {
        env.storage().persistent().get(&DataKey::Packet(guid))
    }

    pub fn is_delivered(env: Env, guid: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Delivered(guid))
    }

    pub fn outbound_nonce(env: Env, dst_eid: u32) -> u64 {
        env.storage().persistent().get(&DataKey::Nonce(dst_eid)).unwrap_or(0)
    }

    fn mark_delivered(env: &Env, guid: &BytesN<32>) {
        env.storage().persistent().set(&DataKey::Delivered(guid.clone()), &true);
        let pending: Vec<BytesN<32>> = env.storage().persistent().get(&DataKey::Pending).unwrap_or(Vec::new(env));
        let mut kept = Vec::new(env);
        for g in pending.iter() {
            if g != *guid {
                kept.push_back(g);
            }
        }
        env.storage().persistent().set(&DataKey::Pending, &kept);
    }
}
