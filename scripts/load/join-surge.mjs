#!/usr/bin/env node
// Simulates a crowd joining a stream through the CURRENT listener API:
//   POST /api/listeners/request  ->  POST /api/listeners/token  ->  POST /api/listeners/connected
// (then, optionally, heartbeats and leave). It exercises the control plane only: it mints
// LiveKit tokens but never opens a media connection. Use `lk perf load-test` for the media path.
//
// Every simulated listener reports the SAME client address in X-Forwarded-For, which is what a
// venue behind one NAT looks like to the server. That makes this the test for the per-IP rate
// limit: with default limits all of them must get through.
//
// Point --base-url at the app itself (e.g. http://127.0.0.1:8787), NOT at Caddy: Caddy would
// overwrite X-Forwarded-For with this machine's address, which is also a valid single-NAT test.
//
//   node scripts/load/join-surge.mjs --base-url http://127.0.0.1:8787 --program-slug demo \
//        --listeners 1000 --ramp-seconds 60
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
    options: {
        'base-url': { type: 'string' },
        'program-slug': { type: 'string' },
        'stream-id': { type: 'string' },
        listeners: { type: 'string', default: '1000' },
        'ramp-seconds': { type: 'string', default: '30' },
        'client-ip': { type: 'string', default: '203.0.113.50' },
        'hold-seconds': { type: 'string', default: '0' },
        'heartbeat-seconds': { type: 'string', default: '90' },
        'max-p95-ms': { type: 'string', default: '0' },
        help: { type: 'boolean', default: false },
    },
});

if (args.help || !args['base-url'] || !args['program-slug']) {
    console.log(`Usage: node scripts/load/join-surge.mjs --base-url <url> --program-slug <slug> [options]

  --stream-id <id>         Language stream to join (default: the first active one)
  --listeners <n>          Simulated listeners (default 1000)
  --ramp-seconds <n>       Spread the joins evenly over this long (default 30)
  --client-ip <ip>         Address reported in X-Forwarded-For for ALL listeners (default 203.0.113.50)
  --hold-seconds <n>       Stay connected this long, sending heartbeats, before leaving (default 0)
  --heartbeat-seconds <n>  Heartbeat interval while holding (default 90, like the real page)
  --max-p95-ms <n>         Exit non-zero if any step's p95 latency exceeds this (0 = off)`);
    process.exit(args.help ? 0 : 2);
}

const base = args['base-url'].replace(/\/+$/, '');
const programSlug = args['program-slug'];
const listeners = Number(args.listeners);
const rampMs = Number(args['ramp-seconds']) * 1000;
const holdMs = Number(args['hold-seconds']) * 1000;
const heartbeatMs = Number(args['heartbeat-seconds']) * 1000;
const maxP95 = Number(args['max-p95-ms']);

const latencies = {}; // step -> [ms]
const statuses = {}; // step -> { code: count }
let networkErrors = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(step, path, body) {
    const started = performance.now();
    try {
        const response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-forwarded-for': args['client-ip'],
                'user-agent': 'bhasha-join-surge/1.0',
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        (latencies[step] ??= []).push(performance.now() - started);
        const bucket = (statuses[step] ??= {});
        bucket[response.status] = (bucket[response.status] ?? 0) + 1;
        let json = {};
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            /* non-JSON body */
        }
        return { status: response.status, json };
    } catch {
        networkErrors += 1;
        const bucket = (statuses[step] ??= {});
        bucket.network_error = (bucket.network_error ?? 0) + 1;
        return { status: 0, json: {} };
    }
}

async function discoverStream() {
    if (args['stream-id']) {
        return args['stream-id'];
    }
    const response = await fetch(`${base}/api/public/programs/${encodeURIComponent(programSlug)}`);
    const body = await response.json();
    const stream = (body.streams ?? []).find((s) => s.isActive);
    if (!stream) {
        throw new Error(`no active stream found for program "${programSlug}"`);
    }
    return stream.id;
}

async function listener(index, streamId) {
    const clientId = `surge_${Date.now().toString(36)}_${index}`;
    const request = await call('request', '/api/listeners/request', {
        programSlug,
        streamId,
        clientId,
    });
    if (request.status !== 201) {
        return false;
    }
    const connectionId = request.json.connectionId;
    const token = await call('token', '/api/listeners/token', {
        programSlug,
        streamId,
        connectionId,
    });
    if (token.status !== 200) {
        return false;
    }
    const connected = await call('connected', '/api/listeners/connected', { connectionId });
    if (connected.status !== 200) {
        return false;
    }
    if (holdMs > 0) {
        const until = Date.now() + holdMs;
        while (Date.now() + heartbeatMs < until) {
            await sleep(heartbeatMs);
            await call('heartbeat', '/api/listeners/heartbeat', { connectionId });
        }
        await sleep(Math.max(0, until - Date.now()));
        await call('leave', '/api/listeners/leave', { connectionId, reason: 'surge_test_done' });
    }
    return true;
}

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return NaN;
    }
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const streamId = await discoverStream();
console.log(
    `join-surge: ${listeners} listeners over ${args['ramp-seconds']}s -> ${base} ` +
        `(program ${programSlug}, stream ${streamId}, all from ${args['client-ip']})`,
);

const started = performance.now();
const outcomes = await Promise.all(
    Array.from({ length: listeners }, async (_, index) => {
        await sleep((index / listeners) * rampMs);
        return listener(index, streamId);
    }),
);
const wallSeconds = (performance.now() - started) / 1000;

const joined = outcomes.filter(Boolean).length;
console.log(`\njoined ${joined}/${listeners} in ${wallSeconds.toFixed(1)}s`);
console.log('\nstep        requests   p50 ms   p95 ms   p99 ms   max ms   status codes');
let worstP95 = 0;
for (const step of ['request', 'token', 'connected', 'heartbeat', 'leave']) {
    const sorted = (latencies[step] ?? []).slice().sort((a, b) => a - b);
    if (sorted.length === 0 && !statuses[step]) {
        continue;
    }
    const p95 = percentile(sorted, 95);
    worstP95 = Math.max(worstP95, Number.isNaN(p95) ? 0 : p95);
    console.log(
        `${step.padEnd(11)} ${String(sorted.length).padStart(8)}   ` +
            `${percentile(sorted, 50).toFixed(1).padStart(6)}   ${p95.toFixed(1).padStart(6)}   ` +
            `${percentile(sorted, 99).toFixed(1).padStart(6)}   ${(sorted.at(-1) ?? NaN).toFixed(1).padStart(6)}   ` +
            JSON.stringify(statuses[step] ?? {}),
    );
}

const rateLimited = Object.values(statuses).reduce((sum, bucket) => sum + (bucket[429] ?? 0), 0);
console.log(`\nrate limited (429): ${rateLimited}   network errors: ${networkErrors}`);

const failed = joined !== listeners || rateLimited > 0 || networkErrors > 0;
if (maxP95 > 0 && worstP95 > maxP95) {
    console.log(`FAIL: worst p95 ${worstP95.toFixed(1)} ms exceeds --max-p95-ms ${maxP95}`);
    process.exit(1);
}
if (failed) {
    console.log('FAIL: not every listener joined cleanly');
    process.exit(1);
}
console.log('PASS: every listener joined, none were rate limited');
