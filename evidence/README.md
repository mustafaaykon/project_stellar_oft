# Evidence index

Maps the three SOW deliverables to what a reviewer can open, run or watch. Everything is on Stellar testnet; every transaction hash below resolves on https://stellar.expert/explorer/testnet.

## Deliverable 1: mock-lz-endpoint (test double for the LayerZero endpoint)

- Source: `contracts/mock-lz-endpoint/src/lib.rs`
- Test matrix that exercises it: `contracts/oft/src/test.rs` (14 tests). Run `cargo test -p oft`; the captured output of the run used for the video is `evidence/demo/cargo-test.txt`.
- The same contract deployed to testnet as the routing layer between the two simulated chains: contract ids under `contracts.endpoint` in `deploy/A.json` and `deploy/B.json`.

## Deliverable 2: oftkit deploy and oftkit check, live on testnet

- Deploy records with every contract id and transaction hash: `deploy/A.json` (11 transactions, issuer locked), `deploy/B.json`, `deploy/BROKEN.json` (the deliberately misconfigured deployment), `deploy/link-A-B.json` (remotes, peers, enforced options).
- Check outputs: `evidence/demo/check-A.txt` (PASS, no failing rules) and `evidence/demo/check-BROKEN.txt` (FAIL: None peer, missing enforced options, unlocked issuer, unregistered remote). Re-run with `node bin/oftkit.mjs check --deploy deploy/A.json --remotes 30102 --shared-decimals 6`; the command never submits a transaction and exits 1 on any failing rule.
- The dashboard (`web/`) re-reads the same rules from testnet in the browser.

## Deliverable 3: worked example, test matrix and write-up

- Worked MintBurn example: `contracts/sac-manager`, `contracts/oft`, deployed twice (chain A and chain B).
- Matrix cases covered in `contracts/oft/src/test.rs`: seventh decimal dropped and kept by the sender, dust below the conversion rate refused, slippage guard on the post-dust amount, issuer as sender or recipient refused, contract-address recipient, missing peer, untrusted sender, manual delivery, simulated failure and retry, paused manager, MINTER role, nonces and guids, events.
- The 20-wallet simulation on testnet: `sim/report.json` (every transaction with explorer link, balances before and after, conservation check), `sim/report.md` (summary), `sim/run.log` (the run as it happened).
- Known limits: README section "Wire format and known limits".

## Demo video

`evidence/demo/oft-testkit-demo.mp4` with captions in `oft-testkit-demo.srt`; scene timings in `takes.json`. Produced by `node demo/make-demo.mjs`.
