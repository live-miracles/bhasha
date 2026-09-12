**✅ Got it — thanks for the clear architecture details.** This is a classic **one-to-many audio broadcast** setup for an IRL event:

- **1 English speaker** (source)
- **1 translator** (Hindi) → publishes translated audio to DigitalOcean (DO) → DO publishes a single stable stream to Cloudflare Realtime SFU
- **~5,000 mobile listeners** (Android/iOS phones) → **only subscribe** to the translated audio stream (no publishing)
- The DO relay ensures the translated stream stays available even if the translator has brief drops or reconnects.

This design is smart for reliability in a live IRL setting.

### Load Testing Focus for This Exact Flow
You mainly need to stress-test the **subscriber side at scale** (5k mobile clients joining and reliably receiving the translated audio stream).

**Key things to validate:**
- High success rate of mobile clients joining + subscribing to the published stream.
- Stable media reception (low packet loss, acceptable jitter/latency for live translation).
- The published stream from DO reaches all subscribers consistently.
- Your app’s join/subscribe flow on real mobile conditions.
- No repull issues (thanks to the DO-published stream).
- Behavior under realistic mobile network variability.

You do **not** need heavy publisher simulation (only the translator side needs light validation).

### Recommended Tools (Tailored to Subscriber-Only + Mobile)
| Tool                  | Best For                          | Mobile Simulation | Scale (approx.)     | Cost     | Recommendation |
|-----------------------|-----------------------------------|-------------------|---------------------|----------|----------------|
| **k6 + xk6-browser** (hybrid) | Signaling + real WebRTC subscribers | Good (headless Chrome) | Thousands         | Free    | **Strong starting point** |
| **webrtcperf**        | Pure WebRTC subscriber load      | Excellent        | Hundreds–low thousands per machine | Free    | **Highly recommended** for media stats |
| **LoadView**          | Real browser + mobile-like       | Very good        | High (cloud)        | Paid    | Good for validation |
| **Loadero**           | WebRTC-specific                  | Good             | High                | Paid    | Solid alternative |

**Top picks for you:**
- Start with **webrtcperf** → excellent for collecting detailed RTC stats on many subscribers.
- Use **k6 hybrid** for easy ramp-up tests + CI integration (signaling heavy + subset with real media).

### Updated Step-by-Step Load Testing Plan
1. **Prepare Test Environment**
   - Set up a test room/session with the translator publishing via DO to SFU (use a loopback or recorded Hindi audio for repeatable tests).
   - Make sure listeners can join via your webapp (mobile-optimized flow).
   - Have monitoring ready: Cloudflare Realtime metrics (if exposed), your backend logs, load generator resources, and WebRTC `getStats()`.

2. **Test Scenarios (Subscriber-Focused)**
   - **Ramp-up test**: Gradually add subscribers (e.g., 0 → 100 → 500 → 1k → 2.5k → 5k) over 10–20 minutes.
   - **Steady-state hold**: Hold 5k subscribers for 15–30+ minutes while the translated stream is live.
   - **Network variability** (important for mobile IRL): Emulate 4G/5G conditions, packet loss, latency.
   - **Resilience test**: Briefly stop/restart the translator or DO publish and verify subscribers recover without repulling.
   - Optional: Mix in some real mobile devices for smaller-scale validation.

3. **Key Metrics to Track**
   - Join/subscribe success rate & time.
   - ICE connection success (`connected` state).
   - Media quality from `getStats()`:
     - `bytesReceived`, `packetsReceived`, `packetsLost`
     - `jitter`, `roundTripTime`
     - Audio-specific stats (if available)
   - Reconnection rate or stream interruptions.
   - End-to-end perceived latency (from translator speaking to listener hearing).
   - Resource usage on load generators (CPU/RAM/network).

4. **Mobile Simulation Notes**
   - Headless Chrome (in k6-browser or webrtcperf) gives a very good approximation for WebRTC behavior.
   - Use network throttling to simulate mobile conditions.
   - For highest fidelity, run smaller tests on real Android/iOS devices (BrowserStack, Sauce Labs, or physical devices) in parallel with synthetic load.

5. **Infrastructure for 5k Scale**
   - One powerful machine can often handle 300–800+ headless subscribers (depending on audio bitrate — Opus is efficient).
   - For full 5k you’ll likely need **multiple load generator machines** (distributed setup).
   - Free/cheap options: Oracle Cloud Always Free VMs, multiple cheap cloud instances, or Docker/Kubernetes.
   - Bandwidth: Calculate expected audio bitrate × 5k (egress from load generators).

### Quick Start Recommendations
- **Easiest first test**: Use `webrtcperf` pointed at your join URL. Configure it to subscribe to the translated audio track only. It will give you nice stats reports.
- **For ramp-up + CI**: Use the hybrid k6 approach we discussed earlier — most VUs do lightweight signaling/join, a smaller % run full browser WebRTC subscription.
- **Translator side**: Light test to confirm the DO → SFU publish is stable under load.

This setup should give you high confidence that 5k mobile attendees can reliably hear the live Hindi translation during your IRL event.

Would you like me to provide:
- A sample **webrtcperf** configuration for subscriber-only flow?
- A **k6 hybrid script** skeleton tailored to this (join → subscribe to specific audio track)?
- Help with network emulation settings for mobile simulation?
- Guidance on distributed load generator setup?

Just let me know the next piece you want to tackle!