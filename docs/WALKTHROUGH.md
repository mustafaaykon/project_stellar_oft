# OFT Testkit walkthrough

A step-by-step guide for a developer who wants to bring a token to Stellar through a LayerZero-style OFT and test it before anything touches a real cross-chain route. Each step says what you type, what you should see, and why it matters. Fifteen minutes end to end, plus seven minutes if you run the full simulation.

## 1. What you are working with

Five words you will meet everywhere:

| Word | Meaning here |
| --- | --- |
| **OFT** | Omnichain Fungible Token. A contract that burns tokens on the chain they leave and mints them on the chain they arrive. Same total supply across chains. |
| **Endpoint** | The LayerZero contract that carries messages between chains. This kit ships a **mock endpoint** that behaves like one but lives entirely on Stellar testnet, so two "chains" can be simulated side by side. |
| **eid** | Endpoint id. A number that names a chain to the endpoint. The kit uses 30101 for chain A and 30102 for chain B. |
| **SAC** | Stellar Asset Contract. A classic Stellar asset (code + issuer) exposed as a Soroban token. Your OFT token is one of these. |
| **SAC Manager** | The admin contract placed in front of the SAC. It holds the mint role and a pause switch, so only the OFT can mint, and only when not paused. |
| **Peer** | The OFT contract on the other chain that this OFT trusts. A missing peer means nothing can be sent or received. |

The pattern you deploy is always the same three contracts: **SAC → SAC Manager → OFT**, plus an endpoint. The kit's job is to let you unit test that pattern, deploy it in one command, and verify it is configured correctly before you send anything.

## 2. Prerequisites

- Rust with the `wasm32v1-none` target (`rustup target add wasm32v1-none`)
- stellar-cli 25 or newer (`stellar --version`)
- Node 20 or newer
- Nothing else. Every account is a throwaway funded by Friendbot. No real value is involved at any point.

```
cd oft-testkit
npm install
```

## 3. Run the tests first

```
cargo test
```

You should see 14 tests pass in under a second. They run two simulated chains inside one test environment, joined by two mock endpoints. Read the names; they are the behaviours you care about:

```
round_trip_a_to_b_and_back
seventh_decimal_is_dropped_and_stays_with_sender
dust_below_conversion_rate_is_rejected
slippage_guard_uses_post_dust_amount
issuer_can_neither_send_nor_receive
receive_to_contract_address
no_peer_refuses_send
packet_from_untrusted_peer_is_not_minted
manual_delivery_holds_then_delivers_once
simulated_failure_then_retry
paused_manager_blocks_receive_until_unpaused
minter_role_is_required_to_mint
nonces_increase_per_destination_and_guids_are_unique
events_are_emitted_on_send_and_receive
```

Why this matters: every one of these cases is something LayerZero's docs warn about or something that broke a real deployment. If you change the OFT, these tell you within a second whether you broke one of them.

To use the mock in your own contract's tests, add `mock_lz_endpoint` as a dev-dependency and copy the `world()` helper from `contracts/oft/src/test.rs`. It deploys both chains, links them, and hands you addresses.

## 4. Build the contracts

```
stellar contract build
```

Three Wasm files appear under `target/wasm32v1-none/release/`: `mock_lz_endpoint.wasm`, `sac_manager.wasm`, `oft.wasm`.

## 5. Look at the config

Open `oftkit.toml`. It describes the chains you are about to deploy:

```toml
network = "testnet"
shared_decimals = 6

[chains.A]
eid = 30101
asset_code = "OFTA"
owner = "owner"          # key name; created and funded on first use
issuer = "issuerA"
owner_can_mint = true    # lets the owner seed test balances
lock_issuer = true       # master weight 0 after set_admin

[chains.B]
eid = 30102
asset_code = "OFTB"
owner = "owner"
issuer = "issuerB"
owner_can_mint = true
lock_issuer = true
```

Two things to understand:

- **shared_decimals = 6** while a Stellar asset has 7. Amounts cross chains in 6 decimals, so the seventh decimal is removed as "dust" before sending and stays in the sender's wallet. This value cannot be changed after deployment; the kit checks it.
- **lock_issuer = true** sets the issuer account's master weight to zero after the SAC Manager becomes the SAC admin. Without this, the issuer key could still mint and bypass the role model. It is irreversible, which is fine for a throwaway testnet issuer.

To use your own asset, change `asset_code`. To use a real LayerZero endpoint instead of the mock, add `endpoint = "C..."` to the chain.

## 6. Deploy chain A

```
node bin/oftkit.mjs deploy --config oftkit.toml --chain A
```

The first run creates and funds the `owner` and `issuerA` keys in `.keys/` (gitignored). Then you watch eleven transactions go by:

```
[A] upload endpoint wasm ...
[A] upload manager wasm ...
[A] upload oft wasm ...
[A] deploy SAC for OFTA:GDLHWQ… ...
[A] deploy sac-manager ...
[A] set_admin(SAC) -> sac-manager ...
[A] deploy mock endpoint (eid 30101) ...
[A] deploy oft ...
[A] grant MINTER -> oft ...
[A] grant MINTER -> owner (seeding) ...
[A] lock issuer (master weight 0) ...
[A] done: oft CAQ7…
wrote deploy/A.json
```

`deploy/A.json` now holds every contract id, every transaction hash and an explorer link for each. Keep it; every later command reads it.

Deploy chain B the same way:

```
node bin/oftkit.mjs deploy --config oftkit.toml --chain B
```

Wasm uploads are cached in `deploy/wasm-testnet.json`, so chain B skips them.

## 7. Link the two chains

```
node bin/oftkit.mjs link --a deploy/A.json --b deploy/B.json --delivery manual
```

This does four things on each side: tells endpoint A that eid 30102 is served by endpoint B (and vice versa), sets each OFT's peer to the other OFT, sets enforced options for the SEND message type, and puts the mock endpoints into **manual** delivery mode, meaning packets wait for a relayer rather than being delivered in the same transaction. Manual mode is what lets you watch a packet sit pending and retry it.

## 8. Check the deployment

```
node bin/oftkit.mjs check --deploy deploy/A.json --remotes 30102 --shared-decimals 6
```

Expected:

```
  PASS  peer[30102] set                        peer = CDUU…
  PASS  enforced_options[30102, SEND] present  0x0003010011010000000000000000000000000000c350
  PASS  issuer master weight = 0               issuer GDLH… master weight 0
  PASS  SAC admin = sac_manager                admin CCIQ…
  PASS  MINTER role granted to oft             sac_manager.has_role(MINTER, oft) = true
  PASS  shared decimals                        shared 6, local 7, expected 6
  INFO  sac_manager paused                     not paused
  PASS  endpoint remote[30102] registered      -> CDB6…
  INFO  endpoint                               mock, eid 30101, delivery mode Manual, 0 pending

  result: PASS (no failing rules)
```

`check` only reads. It never submits a transaction, and it exits with code 1 when any rule fails, so it belongs in CI after every configuration change.

What each failure means when you see it:

| Rule | If it fails |
| --- | --- |
| peer set | Sends to that chain are refused; receives from it are refused. This is the stellar-cli 25.1.0 bug where an `Option<BytesN<32>>` argument was stored as `None`. Re-run `set_peer`. |
| enforced options | Sends carry no executor options. On a real route the message may not be executed. Run `set_enforced_options`. |
| issuer master weight = 0 | The issuer key can still mint around the SAC Manager. Lock it with `setOptions masterWeight 0`. |
| SAC admin = sac_manager | Minting through the manager will fail; the OFT cannot mint on receive. Run `set_admin` from the current admin. |
| MINTER granted | Same effect: receives fail. Grant the role. |
| shared decimals | Wrong conversion rate, and it cannot be changed. Redeploy. |
| endpoint remote | The mock has nowhere to deliver. Run `link`. |

To see what a bad deployment looks like, the config includes a `BROKEN` chain with no peer, no options and an unlocked issuer:

```
node bin/oftkit.mjs deploy --config oftkit.toml --chain BROKEN
node bin/oftkit.mjs check --deploy deploy/BROKEN.json --remotes 30102 --shared-decimals 6
```

## 9. Send a token across

Create a wallet, give it a trustline for both assets, and seed it:

```
node bin/oftkit.mjs keys new alice
```

Trustlines are classic Stellar operations; the simulation script does them for you, but by hand you can use Stellar Lab or any wallet with the asset code and issuer from `deploy/A.json`. Then:

```
node bin/oftkit.mjs mint --deploy deploy/A.json --minter owner --to <alice G...> --amount 100
node bin/oftkit.mjs send --deploy deploy/A.json --from alice --to <alice G...> --dst-eid 30102 --amount 25.0000003
```

Note the amount: 25.0000003 is sent, 25.0000000 is burned, and the 3 stroops stay with alice. The output shows `amount_sent_ld` and the packet guid.

Nothing has arrived yet. The packet is pending on endpoint A because delivery is manual. Deliver it:

```
node bin/oftkit.mjs relay --deploy deploy/A.json
```

```
  delivered 0bb2b59ace7f…  tx b776…
```

Alice now holds 25 OFTB on chain B. Send some back with `--deploy deploy/B.json --dst-eid 30101` and relay chain B.

If alice had no trustline for OFTB, the relay would print `FAILED (retriable)` and leave the packet pending. Add the trustline and run `relay` again; the same packet is delivered. Nothing is re-sent and nothing is lost.

For a long session, keep a relayer running:

```
node bin/oftkit.mjs relay --deploy deploy/A.json --watch
```

## 10. Run the 20-wallet simulation

```
node sim/run.mjs
```

About seven minutes and 86 transactions. It funds 20 wallets, gives them trustlines (W20 deliberately gets none on chain B), seeds 100 OFTA each, sends A→B from every wallet, relays, shows W20 failing and then succeeding after its trustline, sends B→A to self, to a neighbour and to a contract address, has W17 rejected for dust and W18 for slippage, relays again, and finally proves conservation: the sum over both chains plus value in flight is the same at the end as at the start.

It writes `sim/report.json` (every transaction with an explorer link), `sim/report.md` (the summary) and copies what the dashboard needs into `web/public/data/`. Run it twice and it reuses the wallets.

## 11. Open the dashboard

```
npm run web
```

Open http://localhost:4173 (the command prints it). `npm run web:serve` skips the build when `web/dist` already exists; `npm run web:dev` runs Vite with hot reload on port 5173 while you edit the dashboard. The page shows both chains with explorer links, re-runs the `check` rules live from testnet in the browser (chain A beside BROKEN), lists the 20 wallets with balances read from Horizon, and the full transaction log filterable by phase. "Refresh live data" re-reads everything.

## 12. Make the video

```
node demo/make-demo.mjs
```

Re-runs the tests and checks, records each terminal take and the dashboard with Playwright, and cuts a one-minute MP4 with captions into `evidence/demo/`. Use `--skip-capture` to re-cut without re-running the commands.

## 13. Troubleshooting

**A send failed after a successful simulation, with `invokeHostFunctionTrapped`.** Two senders went through the same endpoint in the same ledger. The packet guid depends on the endpoint's outbound nonce, so the second send wrote a key that was not in its declared footprint. No funds moved. Send again; `oftkit send` already re-simulates and retries three times. Serialise senders through one endpoint.

**Relay says FAILED.** The receive on the far chain refused the mint. Usual causes: the recipient G-address has no trustline for that asset, the SAC Manager is paused, or the far OFT no longer trusts this one as a peer. Fix the cause and relay again; the packet is still pending.

**`check` says peer is None right after `link`.** You ran `link` with records from a different deployment. Both `--a` and `--b` must be the records of the chains you mean.

**Friendbot returns 429.** Wait a minute. The simulation retries on its own.

**Horizon shows the issuer with no master signer.** That is what a locked issuer looks like; it is correct.

## 14. What the kit does not do

- No real DVN verification, message libraries or fee pricing. `quote` returns zero. The mock routes messages; it does not secure them.
- MintBurn mode only. LockUnlock is a documented follow-on.
- Testnet only. The contracts are unaudited.
- It does not replace LayerZero's own endpoint. When you move to a real route, keep the SAC, SAC Manager and OFT, point `endpoint` at LayerZero's contract, and keep running `check`.
