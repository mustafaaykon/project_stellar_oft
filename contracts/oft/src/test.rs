//! The test matrix: two simulated chains (eid 30101 and 30102) inside one Env, each with a SAC,
//! a SAC Manager and an OFT, joined by two mock endpoints.
#![cfg(test)]
extern crate std;

use super::*;
use mock_lz_endpoint::{DeliveryMode, MockLzEndpoint, MockLzEndpointClient};
use sac_manager::{SacManager, SacManagerClient, MINTER};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{vec, Address, BytesN, Env};

const EID_A: u32 = 30101;
const EID_B: u32 = 30102;
const SHARED: u32 = 6;

struct Chain {
    issuer: Address,
    token: Address,
    manager: Address,
    endpoint: Address,
    oft: Address,
}

struct World {
    env: Env,
    owner: Address,
    a: Chain,
    b: Chain,
}

fn bytes32_of(addr: &Address) -> BytesN<32> {
    match addr.to_payload().unwrap() {
        AddressPayload::ContractIdHash(h) => h,
        AddressPayload::AccountIdPublicKeyEd25519(k) => k,
    }
}

fn is_contract(addr: &Address) -> bool {
    matches!(addr.to_payload().unwrap(), AddressPayload::ContractIdHash(_))
}

fn deploy_chain(env: &Env, owner: &Address, eid: u32) -> Chain {
    let sac = env.register_stellar_asset_contract_v2(owner.clone());
    let token = sac.address();
    let issuer = sac.issuer().address();
    let manager = env.register(SacManager, (owner.clone(), token.clone()));
    StellarAssetClient::new(env, &token).set_admin(&manager);
    let endpoint = env.register(MockLzEndpoint, (eid,));
    let oft = env.register(Oft, (owner.clone(), token.clone(), manager.clone(), endpoint.clone(), issuer.clone(), SHARED));
    let mgr = SacManagerClient::new(env, &manager);
    mgr.grant_role(&MINTER, &oft);
    mgr.grant_role(&MINTER, owner);
    Chain { issuer, token, manager, endpoint, oft }
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let a = deploy_chain(&env, &owner, EID_A);
    let b = deploy_chain(&env, &owner, EID_B);
    MockLzEndpointClient::new(&env, &a.endpoint).set_remote(&EID_B, &b.endpoint);
    MockLzEndpointClient::new(&env, &b.endpoint).set_remote(&EID_A, &a.endpoint);
    OftClient::new(&env, &a.oft).set_peer(&EID_B, &Some(bytes32_of(&b.oft)));
    OftClient::new(&env, &b.oft).set_peer(&EID_A, &Some(bytes32_of(&a.oft)));
    World { env, owner, a, b }
}

fn seed(w: &World, chain: &Chain, to: &Address, amount: i128) {
    SacManagerClient::new(&w.env, &chain.manager).mint(&w.owner, to, &amount);
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

// ---------------------------------------------------------------------------------------------

#[test]
fn round_trip_a_to_b_and_back() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 100_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    let oft_b = OftClient::new(&w.env, &w.b.oft);

    let r = oft_a.send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &25_0000000, &25_0000000);
    assert_eq!(r.amount_sent_ld, 25_0000000);
    assert_eq!(balance(&w.env, &w.a.token, &alice), 75_0000000);
    assert_eq!(balance(&w.env, &w.b.token, &alice), 25_0000000);
    assert!(MockLzEndpointClient::new(&w.env, &w.a.endpoint).is_delivered(&r.guid));
    assert_eq!(oft_a.total_sent(), 25_0000000);
    assert_eq!(oft_b.total_received(), 25_0000000);

    let back = oft_b.send(&alice, &EID_A, &bytes32_of(&alice), &is_contract(&alice), &10_0000000, &0);
    assert_eq!(back.amount_sent_ld, 10_0000000);
    assert_eq!(balance(&w.env, &w.b.token, &alice), 15_0000000);
    assert_eq!(balance(&w.env, &w.a.token, &alice), 85_0000000);
}

#[test]
fn seventh_decimal_is_dropped_and_stays_with_sender() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 10_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    assert_eq!(oft_a.decimal_conversion_rate(), 10);
    assert_eq!(oft_a.remove_dust(&1_0000001), 1_0000000);
    assert_eq!(oft_a.quote_oft(&EID_B, &1_0000009), (1_0000000, 1_0000000));

    let r = oft_a.send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000001, &0);
    assert_eq!(r.amount_sent_ld, 1_0000000);
    assert_eq!(balance(&w.env, &w.a.token, &alice), 9_0000000, "the dust stroop stays with the sender");
    assert_eq!(balance(&w.env, &w.b.token, &alice), 1_0000000);
}

#[test]
fn dust_below_conversion_rate_is_rejected() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 1_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    let r = oft_a.try_send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &9, &0);
    assert_eq!(r, Err(Ok(OftError::ZeroAmount)));
    assert_eq!(balance(&w.env, &w.a.token, &alice), 1_0000000);
}

#[test]
fn slippage_guard_uses_post_dust_amount() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 10_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    let r = oft_a.try_send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000005, &1_0000005);
    assert_eq!(r, Err(Ok(OftError::SlippageExceeded)));
}

#[test]
fn issuer_can_neither_send_nor_receive() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 10_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);

    // from = issuer: refused before anything is burned
    let r = oft_a.try_send(&w.a.issuer, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    assert_eq!(r, Err(Ok(OftError::IssuerNotAllowed)));

    // to = issuer on chain B: the receive fails, the packet stays pending, the sender's burn stands
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    let r = oft_a.send(&alice, &EID_B, &bytes32_of(&w.b.issuer), &false, &1_0000000, &0);
    assert!(!ep_a.deliver(&r.guid));
    assert_eq!(ep_a.pending(), vec![&w.env, r.guid.clone()]);
    assert_eq!(balance(&w.env, &w.a.token, &alice), 9_0000000);
}

#[test]
fn receive_to_contract_address() {
    let w = world();
    let alice = Address::generate(&w.env);
    let vault = Address::generate(&w.env); // a C address on chain B
    seed(&w, &w.a, &alice, 5_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    oft_a.send(&alice, &EID_B, &bytes32_of(&vault), &true, &5_0000000, &0);
    assert_eq!(balance(&w.env, &w.b.token, &vault), 5_0000000);
}

#[test]
fn no_peer_refuses_send() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    oft_a.set_peer(&EID_B, &None); // the stellar-cli 25.1.0 footgun, reproduced on purpose
    assert_eq!(oft_a.peer(&EID_B), None);
    let r = oft_a.try_send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    assert_eq!(r, Err(Ok(OftError::NoPeer)));
}

#[test]
fn packet_from_untrusted_peer_is_not_minted() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    let r = OftClient::new(&w.env, &w.a.oft).send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    // chain B stops trusting chain A's OFT before delivery
    OftClient::new(&w.env, &w.b.oft).set_peer(&EID_A, &None);
    assert!(!ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 0);
    // trust restored: the same packet now lands
    OftClient::new(&w.env, &w.b.oft).set_peer(&EID_A, &Some(bytes32_of(&w.a.oft)));
    assert!(ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 1_0000000);
}

#[test]
fn manual_delivery_holds_then_delivers_once() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    let r = OftClient::new(&w.env, &w.a.oft).send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &2_0000000, &0);
    assert_eq!(balance(&w.env, &w.a.token, &alice), 3_0000000, "burned at send");
    assert_eq!(balance(&w.env, &w.b.token, &alice), 0, "not yet minted");
    assert_eq!(ep_a.pending().len(), 1);
    assert!(ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 2_0000000);
    assert_eq!(ep_a.pending().len(), 0);
    assert!(ep_a.try_deliver(&r.guid).is_err(), "a second delivery is refused");
}

#[test]
fn simulated_failure_then_retry() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    let r = OftClient::new(&w.env, &w.a.oft).send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &2_0000000, &0);
    ep_a.set_delivery_mode(&DeliveryMode::Fail);
    assert!(!ep_a.deliver(&r.guid), "the DVN stand-in fails on purpose");
    assert_eq!(ep_a.pending().len(), 1);
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    assert!(ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 2_0000000);
}

#[test]
fn paused_manager_blocks_receive_until_unpaused() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);
    ep_a.set_delivery_mode(&DeliveryMode::Manual);
    let mgr_b = SacManagerClient::new(&w.env, &w.b.manager);
    let r = OftClient::new(&w.env, &w.a.oft).send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &2_0000000, &0);
    mgr_b.pause();
    assert!(!ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 0);
    mgr_b.unpause();
    assert!(ep_a.deliver(&r.guid));
    assert_eq!(balance(&w.env, &w.b.token, &alice), 2_0000000);
}

#[test]
fn minter_role_is_required_to_mint() {
    let w = world();
    let stranger = Address::generate(&w.env);
    let mgr_a = SacManagerClient::new(&w.env, &w.a.manager);
    assert!(!mgr_a.has_role(&MINTER, &stranger));
    assert!(mgr_a.try_mint(&stranger, &stranger, &1).is_err());
    mgr_a.revoke_role(&MINTER, &w.a.oft);
    assert!(!mgr_a.has_role(&MINTER, &w.a.oft));
}

#[test]
fn nonces_increase_per_destination_and_guids_are_unique() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    let ep_a = MockLzEndpointClient::new(&w.env, &w.a.endpoint);
    let oft_a = OftClient::new(&w.env, &w.a.oft);
    let r1 = oft_a.send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    let r2 = oft_a.send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    assert_ne!(r1.guid, r2.guid);
    assert_eq!(ep_a.outbound_nonce(&EID_B), 2);
    assert_eq!(ep_a.packet(&r2.guid).unwrap().nonce, 2);
}

#[test]
fn events_are_emitted_on_send_and_receive() {
    let w = world();
    let alice = Address::generate(&w.env);
    seed(&w, &w.a, &alice, 5_0000000);
    OftClient::new(&w.env, &w.a.oft).send(&alice, &EID_B, &bytes32_of(&alice), &is_contract(&alice), &1_0000000, &0);
    let all = w.env.events().all();
    let mut seen: std::vec::Vec<std::string::String> = std::vec::Vec::new();
    for ev in all.events() {
        let soroban_sdk::xdr::ContractEventBody::V0(body) = &ev.body;
        for topic in body.topics.iter() {
            if let soroban_sdk::xdr::ScVal::Symbol(sym) = topic {
                seen.push(sym.to_utf8_string().unwrap());
            }
        }
    }
    for name in ["sent", "delivered", "received"] {
        assert!(seen.iter().any(|s| s == name), "missing event topic {name}; saw {seen:?}");
    }
}
