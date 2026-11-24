#!/usr/bin/env node
// oftkit: a stellar-cli plugin (installed as `stellar-oftkit`, invoked as `stellar oftkit ...`)
// and a standalone CLI for deploying, linking, checking and relaying MintBurn OFTs on testnet.
import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { keysNew, deploy, link, check, formatCheck, relay, send, mint, readDeploy, DELIVERY } from "../lib/oftkit.mjs";

const program = new Command();
program.name("oftkit").description("Local and testnet test harness for LayerZero-style OFTs on Stellar").version("0.1.0");

const keys = program.command("keys").description("manage throwaway testnet keys in .keys/");
keys.command("new <name>").option("--no-fund", "do not call friendbot").action(async (name, o) => { await keysNew(name, { fundIt: o.fund }); });

program.command("deploy")
  .description("deploy SAC, SAC Manager (set_admin), mock endpoint and OFT for one chain, then grant MINTER")
  .requiredOption("--config <file>", "oftkit.toml")
  .requiredOption("--chain <name>", "chain key in the config, e.g. A")
  .option("--out <file>", "deployment record to write", undefined)
  .option("--network <name>", "testnet")
  .action(async (o) => {
    const out = o.out ?? `deploy/${o.chain}.json`;
    await deploy({ config: o.config, chain: o.chain, out, network: o.network });
    console.log(`wrote ${out}`);
  });

program.command("link")
  .description("register remotes, peers and enforced options between two deployed chains")
  .requiredOption("--a <file>").requiredOption("--b <file>")
  .option("--options <hex>", "enforced options bytes for SEND")
  .option("--delivery <mode>", "auto | manual | fail (mock endpoints)", "manual")
  .action(async (o) => {
    const mode = DELIVERY[o.delivery[0].toUpperCase() + o.delivery.slice(1).toLowerCase()];
    const r = await link({ a: o.a, b: o.b, options: o.options, deliveryMode: mode });
    const out = `deploy/link-${nameOf(o.a)}-${nameOf(o.b)}.json`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`wrote ${out}`);
  });

program.command("check")
  .description("read a deployed OFT and report pass/fail per rule; never submits a transaction")
  .option("--oft <C...>", "OFT contract id")
  .option("--deploy <file>", "deployment record (supplies --oft)")
  .option("--remotes <eids>", "comma-separated remote eids expected to have peers")
  .option("--shared-decimals <n>", "expected shared decimals")
  .option("--network <name>", "testnet")
  .option("--json", "machine-readable output")
  .action(async (o) => {
    const oft = o.oft ?? readDeploy(o.deploy).contracts.oft;
    const remotes = (o.remotes ? o.remotes.split(",") : []).map((e) => ({ eid: Number(e.trim()) }));
    const report = await check({ oft, remotes, sharedDecimals: o.sharedDecimals, network: o.network ?? "testnet" });
    console.log(o.json ? JSON.stringify(report, null, 2) : formatCheck(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program.command("relay")
  .description("deliver every pending packet on a chain's mock endpoint once")
  .requiredOption("--deploy <file>")
  .option("--relayer <key>", "key name in .keys (default: the chain owner)")
  .option("--watch", "keep polling every 10 s")
  .action(async (o) => {
    do {
      const r = await relay({ deploy: o.deploy, relayer: o.relayer });
      if (r.pending === 0) console.log("nothing pending");
      if (o.watch) await new Promise((res) => setTimeout(res, 10_000));
    } while (o.watch);
  });

program.command("send")
  .description("send through the OFT of a chain to an address on a remote eid")
  .requiredOption("--deploy <file>").requiredOption("--from <key>").requiredOption("--to <address>")
  .requiredOption("--dst-eid <n>").requiredOption("--amount <decimal>")
  .option("--min <decimal>", "minimum amount after dust removal")
  .action(async (o) => {
    const r = await send({ deploy: o.deploy, from: o.from, to: o.to, dstEid: Number(o.dstEid), amount: o.amount, minAmount: o.min });
    console.log(JSON.stringify(r, null, 2));
  });

program.command("mint")
  .description("mint through the SAC Manager (the minter key must hold MINTER)")
  .requiredOption("--deploy <file>").requiredOption("--minter <key>").requiredOption("--to <address>").requiredOption("--amount <decimal>")
  .action(async (o) => {
    const r = await mint({ deploy: o.deploy, minter: o.minter, to: o.to, amount: o.amount });
    console.log(`minted ${o.amount} to ${o.to}  tx ${r.hash}`);
  });

function nameOf(p) { return p.replace(/\\/g, "/").split("/").pop().replace(/\.json$/, ""); }

program.parseAsync(process.argv).catch((e) => {
  console.error(`oftkit: ${e.message}`);
  if (e.contractError != null) console.error(`  contract error code ${e.contractError}`);
  process.exit(1);
});
