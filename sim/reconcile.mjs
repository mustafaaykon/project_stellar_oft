// Recomputes the conservation check of sim/report.json counting value in flight: packets that
// were burned on the source chain but not yet delivered when a balance snapshot was taken.
// The 2026-11-23 run inherited six such packets from an earlier run that crashed mid round 1
// (see README, "known limits": concurrent sends trap on apply). Packets stay readable on the
// mock endpoint after delivery, so their amounts can be recovered and the books balanced.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { readDeploy, net, loadKey, view, sc } from "../lib/oftkit.mjs";

const report = JSON.parse(readFileSync("sim/report.json", "utf8"));
const A = readDeploy("deploy/A.json");
const n = net(A.network);
const viewer = loadKey("owner").publicKey();

const round1 = new Set(report.txs.filter((t) => t.phase === "round1").map((t) => t.guid));
const relayed = report.txs.filter((t) => t.phase === "relay1" && t.delivered);
const inherited = relayed.filter((t) => !round1.has(t.guid));

let inFlightAtSeed = 0n;
const details = [];
for (const t of inherited) {
  const p = await view(n, viewer, A.contracts.endpoint, "packet", [sc.bytesN(Buffer.from(t.guid, "hex"))]);
  const msg = Buffer.from(p.message);
  const amountSd = msg.readBigUInt64BE(33);
  const amountLd = amountSd * 10n; // conversion rate 10^(7-6)
  inFlightAtSeed += amountLd;
  details.push({ guid: t.guid, nonce: Number(p.nonce), amount: (Number(amountLd) / 1e7).toFixed(7), delivered_tx: t.hash });
}

const seed = report.phases.find((p) => p.phase === "balances:after-seed");
const final = report.phases.find((p) => p.phase === "balances:final");
const contractBal = Number(report.conservation.contract_recipient_balance);
const before = Number(seed.total) + Number(inFlightAtSeed) / 1e7;
const after = Number(final.total) + contractBal;
report.conservation = {
  minted_in_wallets_at_seed: seed.total,
  in_flight_at_seed: (Number(inFlightAtSeed) / 1e7).toFixed(7),
  in_flight_packets: details,
  total_before: before.toFixed(7),
  wallets_after: final.total,
  contract_recipient: report.conservation.contract_recipient,
  contract_recipient_balance: contractBal.toFixed(7),
  total_after: after.toFixed(7),
  conserved: Math.abs(before - after) < 1e-6,
  note: "burns on one chain equal mints on the other, dust never leaves the sender, and value in flight (burned, not yet delivered) is counted. The six inherited packets came from an earlier run that stopped mid round 1; their amounts were read back from the mock endpoint, which keeps packets after delivery.",
};
writeFileSync("sim/report.json", JSON.stringify(report, null, 2));
copyFileSync("sim/report.json", "web/public/data/report.json");

let md = readFileSync("sim/report.md", "utf8");
md = md.replace(/Conservation: .*\n/, `Conservation: ${before.toFixed(7)} before (wallets ${seed.total} + ${(Number(inFlightAtSeed) / 1e7).toFixed(7)} in flight from an earlier run) vs ${after.toFixed(7)} after (wallets ${final.total} + ${contractBal.toFixed(7)} at the contract recipient) -> ${report.conservation.conserved ? "conserved" : "MISMATCH"}.\n`);
writeFileSync("sim/report.md", md);
console.log(`in flight at seed: ${(Number(inFlightAtSeed) / 1e7).toFixed(7)} across ${details.length} packets; before ${before.toFixed(7)} after ${after.toFixed(7)} -> ${report.conservation.conserved ? "CONSERVED" : "MISMATCH"}`);
