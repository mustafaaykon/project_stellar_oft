# OFT Testkit

A local and testnet test harness for LayerZero-style Omnichain Fungible Token (OFT) deployments on Stellar.

USDT0 reached Stellar through LayerZero's OFT standard with a three-contract pattern: a classic asset wrapped as a Stellar Asset Contract (SAC), a SAC Manager holding the mint role, and the OFT contract that burns on send and mints on receive. LayerZero's Stellar docs walk through the deployment but give no way to unit test the send and receive path, no mock endpoint, and no checker for the misconfigurations they themselves list: a peer silently stored as `None`, an issuer whose master key was never locked, enforced options never set, a shared-decimals value that cannot be changed after deployment. This kit supplies those three things.

**Testnet only. The mock endpoint stands in for LayerZero; it does not simulate DVN verification, message libraries or fees. The contracts are unaudited.**

## What is in the box

| Piece | Where | What it does |
| --- | --- | --- |
| `mock-lz-endpoint` | `contracts/mock-lz-endpoint` | A Soroban test double for the LayerZero endpoint: `quote`, `send`, `deliver`, `deliver_inbound`, in-memory routing between simulated chains (`set_remote`), delivery modes `Auto`, `Manual`, `Fail`. Deployable to testnet so two "chains" can live on one network. |
| `sac-manager` | `contracts/sac-manager` | The admin layer in front of the SAC: owner, `MINTER` role, pause. After `set_admin`, minting goes through role checks, which classic assets do not offer. |
| `oft` | `contracts/oft` | A worked MintBurn OFT: `set_peer(eid, Option<BytesN<32>>)`, `set_enforced_options`, `quote_oft`, `send`, `lz_receive`. Shared decimals 6 over local 7, so the seventh decimal is removed as dust and stays with the sender. The issuer may be neither sender nor recipient. |
| Test matrix | `contracts/oft/src/test.rs` | 14 tests: round trip, dropped seventh decimal, dust rejection, slippage, issuer, contract-address recipient, missing peer, untrusted sender, manual delivery, simulated failure and retry, pause, MINTER role, nonces and guids, events. |
| `oftkit` | `bin/oftkit.mjs`, `lib/` | `keys new`, `deploy`, `link`, `check`, `relay`, `send`, `mint`. Installed as `stellar-oftkit`, it also runs as `stellar oftkit …`. |
| Simulation | `sim/run.mjs` | 20 testnet wallets: fund, trust, seed, A→B, relay, the no-trustline retry, B→A to self, neighbour and a contract address, dust and slippage rejections, conservation check. Writes `sim/report.json` and `sim/report.md`. |
| Dashboard | `web/` | Live view of both chains, the check rules re-read from testnet, wallet balances from Horizon, and the transaction log. |
| Demo | `demo/make-demo.mjs` | Records the terminal takes and the dashboard with Playwright and cuts the MP4 with ffmpeg. |

New to the kit? Read [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md): fifteen minutes from `cargo test` to a token crossing between two testnet chains, with what each step means and what to do when something fails.

## Quick start

```
cargo test                                   # the matrix, against the mock endpoint
stellar contract build                       # three Wasm files under target/wasm32v1-none/release
npm install

node bin/oftkit.mjs deploy --config oftkit.toml --chain A     # keys are created and funded on demand
node bin/oftkit.mjs deploy --config oftkit.toml --chain B
node bin/oftkit.mjs link --a deploy/A.json --b deploy/B.json --delivery manual
node bin/oftkit.mjs check --deploy deploy/A.json --remotes 30102 --shared-decimals 6

node sim/run.mjs                              # the 20-wallet simulation (several minutes)
node bin/oftkit.mjs relay --deploy deploy/A.json --watch        # a relayer loop, if you keep sending

npm run web                                   # builds the dashboard and serves it on http://localhost:4173
node demo/make-demo.mjs                       # the video
```

Keys live in `.keys/` (gitignored). Everything is a throwaway funded by Friendbot.

## What `oftkit check` reads

All reads go through RPC simulation and Horizon; `check` never submits a transaction and exits 1 on any failing rule.

| Rule | Source of the rule |
| --- | --- |
| `peer[eid]` is set and non-empty | LayerZero Stellar OFT docs: stellar-cli 25.1.0 may silently store `None` for an `Option<BytesN<32>>` argument |
| `enforced_options[eid, SEND]` present | OFT docs: `set_enforced_options` is part of the configuration step |
| issuer master weight = 0 | OFT docs: the issuer must be locked or the RBAC model can be bypassed |
| SAC admin = SAC Manager | OFT docs: `set_admin` after deploying the SAC Manager |
| `MINTER` granted to the OFT | OFT docs: grant `MINTER_ROLE` on the SAC Manager to the OFT |
| shared decimals as configured and ≤ local | OFT docs: `shared_decimals` cannot be changed after deployment |
| endpoint remote registered (mock only) | needed for anything to be delivered |

## Wire format and known limits

The OFT message is 41 bytes: one byte recipient kind (0 account, 1 contract), the 32-byte key, and the amount in shared decimals as a big-endian u64. A G-address recipient needs a trustline for the asset; a failed receive leaves the packet pending on the mock endpoint and `relay` retries it later. Contract (C) recipients need no trustline.

Not covered: LockUnlock mode, real DVN verification, message libraries, fee quoting (`quote` returns zero), OApp types other than OFT, mainnet.

One Soroban-specific behaviour the simulation surfaced and the kit now documents: the packet guid is derived from the endpoint's outbound nonce, so two sends simulated against the same nonce and applied in the same ledger make the second one write a storage key that was not in its declared footprint. The host traps the transaction (`invokeHostFunctionTrapped`), with no state change and no funds lost. Senders through one endpoint therefore need to be serialised, or re-simulated on failure. `sim/run.mjs` sends sequentially for this reason; `oftkit send` retries after re-simulating.

## Evidence

`deploy/*.json` carry every contract id and transaction hash; `sim/report.json` every simulation transaction with explorer links; `evidence/demo/` the video, captions and the captured `check` outputs.
