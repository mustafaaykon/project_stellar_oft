# Simulation report (testnet, 2026-11-23T12:06:17.081Z)

20 wallets, 86 transactions, 439 s.

| Phase | Result |
| --- | --- |
| fund | 20 wallets funded by friendbot |
| trust | trustlines for OFTA on all 20; OFTB on 19 (W20 left without one to show the retry path) |
| seed | 100 OFTA minted to each wallet by the owner (MINTER) through sac_manager |
| balances:after-seed |  A 2556.5000000 / B 0.0000000 / total 2556.5000000 |
| round1-send | 20 sends A->B; each amount ends in 3 stroops of dust that stays with the sender |
| relay1 | a failed receive leaves the packet pending on the endpoint delivered 25, failed 1 |
| retry | the same packet, delivered once the trustline exists; nothing was re-sent delivered 1 |
| balances:after-round1 |  A 2361.5000000 / B 238.5000000 / total 2600.0000000 |
| round2-send | 16 sends B->A with mixed recipients; W17 (dust) and W18 (slippage) rejected by the contract before any burn |
| relay2 |  delivered 16, failed 0 |
| balances:final |  A 2417.7500000 / B 176.5000000 / total 2594.2500000 |

Expected rejections: W17 0.0000005 -> error #5 (as expected); W18 1.0000005 -> error #3 (as expected)

Conservation: 2600.0000000 before (wallets 2556.5000000 + 43.5000000 in flight from an earlier run) vs 2600.0000000 after (wallets 2594.2500000 + 5.7500000 at the contract recipient) -> conserved.

OFT totals: A sent 238.5000000 / received 62.0000000; B sent 62.0000000 / received 238.5000000.