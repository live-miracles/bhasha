const REALTIME_SMOKE_PAGE = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Realtime smoke console</title>
    <style>
      :root {
        color-scheme: light;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
        background: #f4f6f8;
        color: #14212b;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
      }

      header {
        border-bottom: 1px solid #d9e0e6;
        background: #ffffff;
      }

      .wrap {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
      }

      header .wrap {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        padding: 18px 0;
      }

      h1,
      h2 {
        margin: 0;
        font-weight: 650;
        letter-spacing: 0;
      }

      h1 {
        font-size: 22px;
      }

      h2 {
        font-size: 16px;
      }

      main.wrap {
        display: grid;
        grid-template-columns: minmax(260px, 320px) 1fr 1fr;
        gap: 16px;
        padding: 16px 0;
      }

      section {
        min-width: 0;
        border: 1px solid #d9e0e6;
        border-radius: 8px;
        background: #ffffff;
      }

      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #e4e9ee;
        padding: 14px;
      }

      .panel-body {
        display: grid;
        gap: 12px;
        padding: 14px;
      }

      label {
        display: grid;
        gap: 6px;
        color: #52616d;
        font-size: 12px;
        font-weight: 620;
      }

      input {
        width: 100%;
        min-height: 38px;
        border: 1px solid #c8d2dc;
        border-radius: 6px;
        padding: 8px 10px;
        color: #14212b;
        font: inherit;
        font-size: 14px;
      }

      input:focus {
        border-color: #2563eb;
        outline: 2px solid #bfdbfe;
        outline-offset: 0;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      button {
        min-height: 38px;
        border: 1px solid #b9c5d0;
        border-radius: 6px;
        background: #ffffff;
        color: #14212b;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        font-weight: 620;
        padding: 8px 12px;
      }

      button.primary {
        border-color: #155eef;
        background: #155eef;
        color: #ffffff;
      }

      button.danger {
        border-color: #dc2626;
        color: #b91c1c;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      audio {
        width: 100%;
      }

      output,
      pre {
        display: block;
        min-height: 38px;
        margin: 0;
        border-radius: 6px;
        background: #eef2f6;
        color: #273845;
        font-family:
          "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 12px;
        line-height: 1.45;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .status {
        color: #52616d;
        font-size: 12px;
        font-weight: 620;
      }

      .log {
        grid-column: 1 / -1;
      }

      @media (max-width: 900px) {
        main.wrap {
          grid-template-columns: 1fr;
        }

        header .wrap {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="wrap">
        <h1>Realtime smoke console</h1>
        <div class="status" id="runtime-status">Idle</div>
        <div class="status" id="turn-status">TURN: unknown</div>
      </div>
    </header>

    <main class="wrap">
      <section aria-label="Shared route fields">
        <div class="panel-head">
          <h2>Route</h2>
        </div>
        <div class="panel-body">
          <label>
            Program ID
            <input id="program-id" autocomplete="off" />
          </label>
          <label>
            Stream ID
            <input id="stream-id" autocomplete="off" />
          </label>
          <label>
            Listener client ID
            <input id="client-id" autocomplete="off" value="smoke-listener" />
          </label>
        </div>
      </section>

      <section aria-label="Translator publisher controls">
        <div class="panel-head">
          <h2>Translator</h2>
        </div>
        <div class="panel-body">
          <label>
            Translator email
            <input id="translator-email" type="email" autocomplete="username" />
          </label>
          <label>
            Password
            <input id="translator-password" type="password" autocomplete="current-password" />
          </label>
          <div class="actions">
            <button id="translator-login">Log in</button>
            <button id="translator-publish" class="primary">Publish mic</button>
            <button id="translator-stop" class="danger">Stop</button>
          </div>
          <audio id="local-audio" controls muted></audio>
          <output id="translator-state">Not connected</output>
        </div>
      </section>

      <section aria-label="Listener subscriber controls">
        <div class="panel-head">
          <h2>Listener</h2>
        </div>
        <div class="panel-body">
          <div class="actions">
            <button id="listener-start" class="primary">Subscribe</button>
            <button id="listener-connected">Mark connected</button>
            <button id="listener-leave" class="danger">Leave</button>
          </div>
          <audio id="remote-audio" controls autoplay></audio>
          <output id="listener-state">Not connected</output>
        </div>
      </section>

      <section class="log" aria-label="Event log">
        <div class="panel-head">
          <h2>Log</h2>
          <button id="clear-log">Clear</button>
        </div>
        <div class="panel-body">
          <pre id="log"></pre>
        </div>
      </section>
    </main>

    <script type="module">
      const $ = (id) => document.getElementById(id);
      const logNode = $("log");
      const runtimeStatus = $("runtime-status");
      const turnStatus = $("turn-status");
      const translatorState = $("translator-state");
      const listenerState = $("listener-state");
      const localAudio = $("local-audio");
      const remoteAudio = $("remote-audio");

      const translator = {
        pc: null,
        stream: null,
        publishSessionId: "",
        streamId: "",
        track: null,
        transceiver: null
      };
      const listener = {
        pc: null,
        connectionId: "",
        remoteStream: null
      };

      function setStatus(message) {
        runtimeStatus.textContent = message;
      }

      // Inspect only the ICE URLs so the operator can confirm TURN was issued
      // without ever rendering the short-lived TURN username/credential values.
      function summarizeIceServers(iceServers) {
        if (!Array.isArray(iceServers)) {
          return "TURN: unknown";
        }
        const hasTurn = iceServers.some((server) => {
          const urls = Array.isArray(server.urls)
            ? server.urls
            : [server.urls];
          return urls.some(
            (url) => typeof url === "string" && /^turns?:/i.test(url)
          );
        });
        return hasTurn
          ? "TURN: included"
          : "TURN: not configured (STUN only)";
      }

      function setTurnStatus(iceServers) {
        turnStatus.textContent = summarizeIceServers(iceServers);
      }

      function log(message, data) {
        const timestamp = new Date().toLocaleTimeString();
        const detail =
          data === undefined ? "" : "\n" + JSON.stringify(data, null, 2);
        logNode.textContent =
          "[" +
          timestamp +
          "] " +
          message +
          detail +
          "\n\n" +
          logNode.textContent;
      }

      function requiredValue(id) {
        const value = $(id).value.trim();
        if (!value) {
          $(id).focus();
          throw new Error(id + " is required");
        }
        return value;
      }

      function toSessionDescription(description) {
        if (!description) {
          throw new Error("missing session description");
        }
        return {
          type: description.type,
          sdp: description.sdp
        };
      }

      async function api(path, body) {
        const response = await fetch(path, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const text = await response.text();
        let payload = {};
        if (text.trim()) {
          payload = JSON.parse(text);
        }
        if (!response.ok) {
          const message = payload.error || response.statusText || "request failed";
          throw new Error(path + " " + response.status + ": " + message);
        }
        return payload;
      }

      function newPeerConnection(iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }]) {
        const pc = new RTCPeerConnection({
          iceServers,
          bundlePolicy: "max-bundle"
        });
        pc.addEventListener("connectionstatechange", () => {
          setStatus("Peer state: " + pc.connectionState);
        });
        pc.addEventListener("iceconnectionstatechange", () => {
          log("ICE state: " + pc.iceConnectionState);
        });
        return pc;
      }

      async function translatorLogin() {
        setStatus("Logging in translator");
        const payload = await api("/api/translator/login", {
          programId: requiredValue("program-id"),
          email: requiredValue("translator-email"),
          password: requiredValue("translator-password")
        });
        translatorState.value = "Logged in";
        log("Translator login ok", {
          translator: payload.translator,
          assignedStreams: payload.assignedStreams
        });
      }

      async function publishMic() {
        setStatus("Publishing mic");
        translator.streamId = requiredValue("stream-id");
        translator.stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
        localAudio.srcObject = translator.stream;
        translator.track = translator.stream.getAudioTracks()[0];
        translator.pc = newPeerConnection();
        translator.transceiver = translator.pc.addTransceiver(translator.track, {
          direction: "sendonly"
        });

        await translator.pc.setLocalDescription(await translator.pc.createOffer());
        const session = await api("/api/translator/realtime/session", {
          streamId: translator.streamId,
          sessionDescription: toSessionDescription(translator.pc.localDescription)
        });
        translator.publishSessionId = session.publishSessionId;
        if (Array.isArray(session.iceServers)) {
          setTurnStatus(session.iceServers);
          translator.pc.setConfiguration({
            iceServers: session.iceServers,
            bundlePolicy: "max-bundle"
          });
        }
        await translator.pc.setRemoteDescription(session.sessionDescription);

        await translator.pc.setLocalDescription(await translator.pc.createOffer());
        const published = await api("/api/translator/realtime/publish", {
          streamId: translator.streamId,
          publishSessionId: translator.publishSessionId,
          sessionDescription: toSessionDescription(translator.pc.localDescription),
          track: {
            mid: translator.transceiver.mid,
            trackName: translator.track.id
          }
        });
        if (published.sessionDescription) {
          await translator.pc.setRemoteDescription(published.sessionDescription);
        }
        translatorState.value = "Publishing " + translator.track.id;
        log("Translator publish ok", published);
      }

      async function stopPublishing() {
        setStatus("Stopping publisher");
        if (translator.publishSessionId && translator.streamId) {
          await api("/api/translator/realtime/stop", {
            streamId: translator.streamId,
            publishSessionId: translator.publishSessionId
          });
        }
        translator.pc?.close();
        translator.stream?.getTracks().forEach((track) => track.stop());
        localAudio.srcObject = null;
        translator.pc = null;
        translator.stream = null;
        translator.publishSessionId = "";
        translatorState.value = "Stopped";
        log("Translator stopped");
      }

      async function startListener() {
        setStatus("Starting listener");
        listener.remoteStream = new MediaStream();
        remoteAudio.srcObject = listener.remoteStream;
        listener.pc = newPeerConnection();
        listener.pc.ontrack = (event) => {
          listener.remoteStream.addTrack(event.track);
          log("Listener received track", {
            id: event.track.id,
            kind: event.track.kind
          });
        };
        listener.pc.addTransceiver("audio", { direction: "recvonly" });

        await listener.pc.setLocalDescription(await listener.pc.createOffer());
        const session = await api("/api/listeners/subscribe/session", {
          programId: requiredValue("program-id"),
          streamId: requiredValue("stream-id"),
          clientId: requiredValue("client-id"),
          sessionDescription: toSessionDescription(listener.pc.localDescription)
        });
        listener.connectionId = session.connectionId;
        if (Array.isArray(session.iceServers)) {
          setTurnStatus(session.iceServers);
          listener.pc.setConfiguration({
            iceServers: session.iceServers,
            bundlePolicy: "max-bundle"
          });
        }
        await listener.pc.setRemoteDescription(session.sessionDescription);

        const track = await api("/api/listeners/subscribe/track", {
          connectionId: listener.connectionId
        });
        if (track.requiresImmediateRenegotiation && track.sessionDescription) {
          if (track.sessionDescription.type === "offer") {
            await listener.pc.setRemoteDescription(track.sessionDescription);
            await listener.pc.setLocalDescription(await listener.pc.createAnswer());
            await api("/api/listeners/subscribe/renegotiate", {
              connectionId: listener.connectionId,
              sessionDescription: toSessionDescription(listener.pc.localDescription)
            });
          } else if (track.sessionDescription.type === "answer") {
            await listener.pc.setRemoteDescription(track.sessionDescription);
          }
        }

        await markListenerConnected();
        listenerState.value = "Subscribed " + listener.connectionId;
        log("Listener subscribe ok", {
          connectionId: listener.connectionId,
          track: track.track
        });
      }

      async function markListenerConnected() {
        if (!listener.connectionId) {
          throw new Error("listener connection is required");
        }
        await api("/api/listeners/connected", {
          connectionId: listener.connectionId
        });
        listenerState.value = "Connected " + listener.connectionId;
        log("Listener marked connected");
      }

      async function leaveListener() {
        setStatus("Leaving listener");
        if (listener.connectionId) {
          await api("/api/listeners/leave", {
            connectionId: listener.connectionId,
            reason: "client_disconnect"
          });
        }
        listener.pc?.close();
        remoteAudio.srcObject = null;
        listener.pc = null;
        listener.remoteStream = null;
        listener.connectionId = "";
        listenerState.value = "Left";
        log("Listener left");
      }

      async function run(action) {
        try {
          await action();
          setStatus("Ready");
        } catch (error) {
          setStatus("Error");
          log(error instanceof Error ? error.message : "operation failed");
        }
      }

      $("translator-login").addEventListener("click", () => run(translatorLogin));
      $("translator-publish").addEventListener("click", () => run(publishMic));
      $("translator-stop").addEventListener("click", () => run(stopPublishing));
      $("listener-start").addEventListener("click", () => run(startListener));
      $("listener-connected").addEventListener("click", () => run(markListenerConnected));
      $("listener-leave").addEventListener("click", () => run(leaveListener));
      $("clear-log").addEventListener("click", () => {
        logNode.textContent = "";
      });
    </script>
  </body>
</html>`;

export function realtimeSmokePage(): Response {
  return new Response(REALTIME_SMOKE_PAGE, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8"
    }
  });
}
