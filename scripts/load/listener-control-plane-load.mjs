#!/usr/bin/env node

const DEFAULT_DURATION_MS = 1000;
const HIGH_CONCURRENCY_WARNING = 200;

function usage() {
  return `Usage:
  node scripts/load/listener-control-plane-load.mjs --base-url <url> --program-slug <slug> --stream-id <stream> [options]

Options:
  --listeners <n>       Number of simulated listeners. Default: 1
  --concurrency <n>     Maximum concurrent listeners. Default: 1
  --duration-ms <n>     Delay between heartbeat and leave. Default: ${DEFAULT_DURATION_MS}
  --dry-run             Print parsed config without network calls
  --help                Show this help
`;
}

function parseArgs(argv) {
  const config = {
    baseUrl: "",
    programSlug: "",
    streamId: "",
    listeners: 1,
    concurrency: 1,
    durationMs: DEFAULT_DURATION_MS,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--base-url":
        config.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--program-slug":
        config.programSlug = next();
        break;
      case "--stream-id":
        config.streamId = next();
        break;
      case "--listeners":
        config.listeners = positiveInteger("--listeners", next());
        break;
      case "--concurrency":
        config.concurrency = positiveInteger("--concurrency", next());
        break;
      case "--duration-ms":
        config.durationMs = nonNegativeInteger("--duration-ms", next());
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!config.baseUrl) {
    throw new Error("--base-url is required");
  }
  if (!config.programSlug) {
    throw new Error("--program-slug is required");
  }
  if (!config.streamId) {
    throw new Error("--stream-id is required");
  }

  config.concurrency = Math.min(config.concurrency, config.listeners);
  return config;
}

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function clientIdFor(index) {
  return `load_client_${String(index + 1).padStart(6, "0")}`;
}

function offerDescription() {
  return {
    type: "offer",
    sdp: [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 0.0.0.0",
      "a=mid:0",
      "a=recvonly",
      "a=rtpmap:111 opus/48000/2",
      ""
    ].join("\r\n")
  };
}

async function postJson(config, path, body) {
  const started = performance.now();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "translation-load-harness/1.0"
    },
    body: JSON.stringify(body)
  });
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = { rawBody: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${path}`);
    error.status = response.status;
    error.body = json;
    error.elapsedMs = elapsedMs;
    throw error;
  }
  return { json, elapsedMs };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runListener(config, index) {
  const clientId = clientIdFor(index);
  const result = {
    clientId,
    ok: false,
    joinMs: 0,
    disconnectReason: "not_started",
    error: null
  };

  try {
    const subscribe = await postJson(config, "/api/listeners/subscribe/session", {
      programSlug: config.programSlug,
      streamId: config.streamId,
      clientId,
      sessionDescription: offerDescription()
    });
    const connectionId = subscribe.json.connectionId;
    result.joinMs = subscribe.elapsedMs;
    if (!connectionId) {
      throw new Error("subscribe response did not include connectionId");
    }

    await postJson(config, "/api/listeners/connected", { connectionId });
    await postJson(config, "/api/listeners/heartbeat", { connectionId });
    if (config.durationMs > 0) {
      await sleep(config.durationMs);
    }
    await postJson(config, "/api/listeners/leave", {
      connectionId,
      reason: "load_test_complete"
    });
    result.ok = true;
    result.disconnectReason = "load_test_complete";
  } catch (error) {
    result.error = normalizeError(error);
    result.disconnectReason = result.error.reason;
  }

  return result;
}

function normalizeError(error) {
  if (error && typeof error === "object") {
    return {
      reason: error.message ?? "unknown_error",
      status: error.status,
      body: error.body
    };
  }
  return { reason: String(error) };
}

async function runPool(config) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < config.listeners) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await runListener(config, current);
    }
  }

  await Promise.all(
    Array.from({ length: config.concurrency }, () => worker())
  );
  return results;
}

function summarize(config, results) {
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const disconnectReasons = {};
  for (const result of results) {
    disconnectReasons[result.disconnectReason] =
      (disconnectReasons[result.disconnectReason] ?? 0) + 1;
  }
  const averageJoinMs =
    successful.length === 0
      ? 0
      : successful.reduce((sum, result) => sum + result.joinMs, 0) /
        successful.length;

  return {
    baseUrl: config.baseUrl,
    programSlug: config.programSlug,
    streamId: config.streamId,
    listenersRequested: config.listeners,
    concurrency: config.concurrency,
    successfulListeners: successful.length,
    failedListeners: failed.length,
    joinSuccessRate:
      config.listeners === 0 ? 0 : successful.length / config.listeners,
    averageJoinMs: Number(averageJoinMs.toFixed(1)),
    disconnectReasons,
    errors: failed.slice(0, 20).map((result) => ({
      clientId: result.clientId,
      ...result.error
    }))
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.concurrency > HIGH_CONCURRENCY_WARNING) {
    console.error(
      `Warning: concurrency ${config.concurrency} can exhaust local sockets or hit provider rate limits. ` +
        "Treat failures as client/load-generator artifacts until reproduced with a staged ramp."
    );
  }
  if (config.dryRun) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const started = performance.now();
  const results = await runPool(config);
  const summary = summarize(config, results);
  summary.elapsedMs = Number((performance.now() - started).toFixed(1));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failedListeners > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
});
