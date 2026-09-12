#!/usr/bin/env node
// Phase 2A dual-read capture + analysis.
//
// Captures the Worker's `presence_count_dualread {programId,d1,do,source}` log lines (and, with
// --marker admin_read_replica, the Phase-0 replica markers) during a 5k load run, so we can verify
// the per-program ProgramPresence DO live-count tracks the D1 COUNT(*) and the injected ground truth.
//
// CAPTURE:  node scripts/load/dualread-capture.mjs --out results/p2a/run.jsonl [--marker presence_count_dualread]
//             (spawns `wrangler tail` server-side-filtered to the marker — no sampling loss — appends JSONL; Ctrl-C = summary)
// ANALYZE:  node scripts/load/dualread-capture.mjs --analyze results/p2a/run.jsonl [--injected <peakActiveCount>] [--tol 0.03]
//
// Auth: reads CLOUDFLARE_API_TOKEN from credentials/cloudflare-full.key line 4 (never printed). Runs
// `wrangler tail` from apps/api (its wrangler.jsonc names the worker bhasha-api).

import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const KEY = process.env.CLOUDFLARE_CREDENTIALS_FILE || ".cloudflare-full.key";
const API_DIR = process.env.BHASHA_API_DIR || "apps/api";

// `wrangler tail --format json` PRETTY-PRINTS (multi-line) and escapes the console.log JSON string
// inside logs[].message[]. Scan each raw line for the marker and regex-extract the fields (robust to
// pretty-print vs NDJSON and to the `\"` escaping). The whole console.log JSON sits on one line.
function extractMarker(line, marker) {
  if (!line.includes(marker)) return null;
  const num = (k) => { const m = line.match(new RegExp('\\\\?"' + k + '\\\\?"\\s*:\\s*(-?\\d+)')); return m ? Number(m[1]) : undefined; };
  const str = (k) => { const m = line.match(new RegExp('\\\\?"' + k + '\\\\?"\\s*:\\s*\\\\?"([\\w.-]+)')); return m ? m[1] : undefined; };
  const boo = (k) => { const m = line.match(new RegExp('\\\\?"' + k + '\\\\?"\\s*:\\s*(true|false)')); return m ? m[1] === "true" : undefined; };
  if (marker === "presence_count_dualread") {
    const d1 = num("d1"), dov = num("do");
    if (d1 === undefined && dov === undefined) return null;
    return { msg: marker, d1, do: dov, source: str("source"), fallback: boo("fallback"), programId: str("programId") };
  }
  if (marker === "admin_read_replica") {
    const sp = boo("served_by_primary");
    if (sp === undefined) return null;
    return { msg: marker, served_by_primary: sp, served_by_region: str("served_by_region") };
  }
  return { msg: marker, raw: line.trim().slice(0, 200) };
}

async function analyze(file, injected, tol) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) try { rows.push(JSON.parse(line)); } catch {} }

  const dual = rows.filter((r) => r.msg === "presence_count_dualread" && typeof r.d1 === "number" && typeof r.do === "number");
  const repl = rows.filter((r) => r.msg === "admin_read_replica");

  console.log(`\n=== dual-read analysis: ${file} ===`);
  if (dual.length) {
    const diffs = dual.map((r) => Math.abs(r.do - r.d1));
    const pct = dual.map((r) => (r.d1 > 0 ? Math.abs(r.do - r.d1) / r.d1 : (r.do === 0 ? 0 : 1)));
    const within = pct.filter((p) => p <= tol).length;
    const maxRow = dual[diffs.indexOf(Math.max(...diffs))];
    const peakDo = Math.max(...dual.map((r) => r.do));
    const peakD1 = Math.max(...dual.map((r) => r.d1));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`samples:            ${dual.length}`);
    console.log(`DO vs D1 |Δ|:       max=${Math.max(...diffs)} mean=${mean(diffs).toFixed(1)}`);
    console.log(`DO vs D1 %Δ:        max=${(Math.max(...pct) * 100).toFixed(2)}% mean=${(mean(pct) * 100).toFixed(2)}%`);
    console.log(`within ±${(tol * 100).toFixed(0)}%:        ${within}/${dual.length} (${((100 * within) / dual.length).toFixed(1)}%)`);
    console.log(`peak counts:        DO=${peakDo} D1=${peakD1}`);
    console.log(`worst sample:       d1=${maxRow.d1} do=${maxRow.do} source=${maxRow.source} program=${maxRow.programId ?? "?"}`);
    if (injected != null) {
      console.log(`vs injected(${injected}):   DO/injected=${(peakDo / injected).toFixed(3)} D1/injected=${(peakD1 / injected).toFixed(3)}`);
    }
    const verdict = within / dual.length >= 0.95 ? "PASS" : "REVIEW";
    console.log(`ACCURACY GATE:      ${verdict} (≥95% of samples within ±${(tol * 100).toFixed(0)}% → PASS)`);
  } else {
    console.log("no presence_count_dualread samples found (is PRESENCE_LIVE_COUNT=shadow|true? is admin being polled?)");
  }
  if (repl.length) {
    const onReplica = repl.filter((r) => r.served_by_primary === false).length;
    console.log(`\nreplica reads:      ${onReplica}/${repl.length} served by replica (served_by_primary=false)`);
  }
  console.log("");
}

async function capture(outFile, marker) {
  mkdirSync(dirname(outFile), { recursive: true });
  let token = "";
  try { token = (readFileSync(KEY, "utf8").split("\n")[3] || "").trim(); } catch {}
  if (!token) { console.error("could not read CLOUDFLARE_API_TOKEN from", KEY, "line 4"); process.exit(1); }

  console.log(`capturing marker="${marker}" → ${outFile}  (Ctrl-C to stop + summarize)`);
  const wr = spawn("npx", ["wrangler", "tail", "--format", "json", "--search", marker], {
    cwd: API_DIR,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
  });
  let n = 0;
  const rl = createInterface({ input: wr.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const rec = extractMarker(line, marker);
    if (!rec) return;
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    n++;
    if (rec.msg === "presence_count_dualread") process.stdout.write(`\r#${n}  d1=${rec.d1} do=${rec.do} src=${rec.source}     `);
    else process.stdout.write(`\r#${n} captured     `);
  });
  wr.stderr.on("data", (d) => { const s = d.toString(); if (/error|Error|unauthor/i.test(s)) process.stderr.write(s); });
  const stop = () => { console.log(`\ncaptured ${n} "${marker}" events → ${outFile}`); wr.kill("SIGINT"); process.exit(0); };
  process.on("SIGINT", stop);
  wr.on("exit", (code) => { console.log(`\nwrangler tail exited (${code}); captured ${n} events → ${outFile}`); process.exit(code ?? 0); });
}

const analyzeFile = opt("--analyze", null);
if (analyzeFile) {
  const injected = opt("--injected", null);
  await analyze(analyzeFile, injected != null ? Number(injected) : null, Number(opt("--tol", "0.03")));
} else {
  const out = opt("--out", null);
  if (!out) { console.error("usage: --out <file.jsonl> [--marker presence_count_dualread] | --analyze <file.jsonl> [--injected N] [--tol 0.03]"); process.exit(1); }
  await capture(out, opt("--marker", "presence_count_dualread"));
}
