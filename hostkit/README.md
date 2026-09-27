# hostkit

`@dsh-harmony/hostkit` — the **optional** PC-side bridge service for the DeepSeek Harness HarmonyOS
client (D1 §6.5, "Host 侧搭桥服务").

hostkit does five things, and nothing else:

| Responsibility | Where |
|---|---|
| **保活与代持** — launch and supervise a local `dsh web` child process | `src/core/hostproc.mjs` |
| **发现** — announce a pairable Host on the LAN over UDP broadcast | `src/discovery.mjs` |
| **配对** — issue a short-lived one-time code and add a device public key to a whitelist | `src/core/pairing.mjs`, `src/core/whitelist.mjs` |
| **隧道** — an end-to-end encrypted tunnel whose *exit* is a fresh connection to `127.0.0.1:<dshPort>` | `src/core/tunnel.mjs`, `src/core/proxy.mjs`, `src/core/crypto.mjs` |
| **审计** — append-only device access / revocation log, queryable from the CLI | `src/core/audit.mjs` |

It is **optional**. L0 (phone and PC on the same machine, reaching the Host over loopback) works with
hostkit entirely absent, and nothing else in this repository depends on it.

- **Zero runtime dependencies.** Only Node built-in modules. RFC 6455 is implemented in
  `src/core/ws.mjs`; the QR encoder is implemented in `src/qr.mjs`; the test-only decoder is in
  `test/helpers/qr-decode.helper.mjs`.
- **Never patches upstream.** It only *launches* the official CLI and observes its stdout.
- **Never binds the dsh Host past loopback.** The tunnel exit is always `127.0.0.1:<dshPort>`, and
  hostkit refuses to start if asked for anything else (`assertLoopbackHost`, asserted in the
  constructor before a single socket exists).
- **Never kills a process it did not spawn.** Every `kill` is addressed to the child's own pid (or, on
  POSIX, the process group it leads because we spawned it detached). No name matching anywhere.

---

## Quick start

```bash
cd hostkit

# 1. Supervise a local Host and serve the bridge
node bin/hostkit.mjs start \
  --dsh-port 3111 \
  --dsh-cmd "dsh web --no-open --host 127.0.0.1 --port 3111"

# 1b. …or open a pairing window immediately after starting
node bin/hostkit.mjs start --pair --dsh-cmd "dsh web --no-open --host 127.0.0.1 --port 3111"

# 2. Pair a phone (opens a 120 s window, prints a QR + a dshkit:// URI + a 6-digit manual code)
node bin/hostkit.mjs pair

# 3. Inspect and manage devices
node bin/hostkit.mjs devices
node bin/hostkit.mjs revoke <deviceId>
node bin/hostkit.mjs audit --tail 50
node bin/hostkit.mjs status
node bin/hostkit.mjs discover --wait 5
```

`node bin/hostkit.mjs --help` prints every flag. Exit codes: `0` success, `1` usage error,
`2` runtime failure (for example: a pairing window that closed with no device).

### Tests

```bash
cd hostkit
node --test            # auto-discovery: every suite
node --test test/index.mjs
```

> **Platform note.** `node --test test/` (a directory argument) fails on **Node 22.20 on Windows** with
> `Cannot find module …\test`: that build treats a non-glob path argument as a module specifier rather
> than a directory to search. `node --test` with no argument and `node --test test/index.mjs` both run
> the full suite (295 tests) — `test/index.mjs` exists precisely so the directory form can be emulated.

---

## Configuration

Resolution order: **defaults ← config file ← environment ← CLI flags ← command-specific overrides**.
The config file lives at `<state-dir>/config.json` and never contains secrets.

| CLI flag | Environment | Default | Meaning |
|---|---|---|---|
| `--port` | `DSHKIT_PORT` | `8798` | hostkit listener port (tunnel WebSocket + `POST /pair` + status routes) |
| `--bind` | `DSHKIT_BIND_HOST` | `0.0.0.0` | hostkit listener bind address (this is *our* listener, not the Host's) |
| `--discovery-port` | `DSHKIT_DISCOVERY_PORT` | `8799` | UDP discovery port |
| `--dsh-port` | `DSHKIT_DSH_PORT` | `3111` | loopback port of the local `dsh web` Host |
| `--dsh-cmd` | `DSHKIT_DSH_CMD` | *(empty)* | command that starts the Host; empty means "supervise nothing" |
| `--name` | `DSHKIT_NAME` | `os.hostname()` | advertised name |
| `--cert` / `--key` | `DSHKIT_CERT` / `DSHKIT_CERT_KEY` | *(empty)* | PEM pair; both present → the listener speaks `https`/`wss` |
| `--tls-selfsigned` | — | `false` | mint a self-signed pair with `openssl` when no cert is given |
| `--pair-window` | — | `120` s | pairing window length |
| `--state-dir` | `DSHKIT_STATE_DIR` | platform default | state directory |
| `--no-discovery` | — | `false` | disable announce + listen |
| `--no-audit` | — | `false` | do not append to the audit log |
| `--wait` | — | `5` s | `discover` listen duration |
| `--log-level` | `DSHKIT_LOG_LEVEL` | `info` | `silent\|error\|warn\|info\|debug` |
| `--json` | — | `false` | machine-readable output |

State directory defaults:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-harmony-hostkit\` |
| macOS | `~/Library/Application Support/dsh-harmony-hostkit/` |
| Linux | `$XDG_STATE_HOME/dsh-harmony-hostkit/` (else `~/.local/state/dsh-harmony-hostkit/`) |

Contents: `identity.json` (X25519 private key, mode `0600`), `devices.json` (whitelist, mode `0600`),
`audit.jsonl` (mode `0600`), `config.json`, and `tls/` for a minted self-signed pair.

---

## Wire protocol

### Transport

* One WebSocket endpoint: `GET /tunnel` on the hostkit listener.
* The **payload is always end-to-end encrypted**. The listener may be plain `ws://` on the LAN; TLS is
  an *additional* layer, never the only one. With `--cert`/`--key` (or `--tls-selfsigned`) the listener
  serves `https`/`wss` instead — see [Limitations](#limitations) for why not both at once.
* Plain HTTP on the same listener: `POST /pair`, `GET /health`, `GET /state`, `GET /audit`.
  `/state` and `/audit` require `?token=<adminToken>` (printed by `hostkit status`, or the current
  pairing token).

### Identity

hostkit generates an X25519 keypair on first run and stores it as
`<state-dir>/identity.json` (`privateKey`, `publicKey`, both base64url of 32 raw bytes), file mode
`0600`, directory mode `0700`. The device generates its own keypair on the phone; only its public half
reaches hostkit, during pairing.

### Handshake

1. The client opens `/tunnel` and sends one **plaintext** (transport-level, not E2E) JSON frame:

   ```json
   { "v": 1, "deviceId": "<string>", "nonce": "<base64 of 16 random bytes>" }
   ```

2. The server looks up `deviceId` in the whitelist. Unknown or revoked →
   `{ "v": 1, "ok": false, "code": "unauthorized" }` and the connection is closed immediately
   (no host identity is leaked). The rejection is written to the audit log
   (`tunnel.reject`, reason `unknown-device` / `revoked-device`).
3. Otherwise:

   ```
   shared   = X25519(hostkitPriv, devicePub)
   saltHash = SHA256(hostkitPub || devicePub)
   kEnc     = HKDF-SHA256(ikm = shared, salt = saltHash, info = "dshkit-tunnel-v1-enc|dshkit-tunnel-v1")
   kMac     = HKDF-SHA256(ikm = shared, salt = saltHash, info = "dshkit-tunnel-v1-mac|dshkit-tunnel-v1")
   ```

   and the server replies `{ "v": 1, "ok": true, "hostkitPub": "<b64url>", "serverNonce": "<base64>" }`.

4. Both ends set their own nonce prefix to `nonce[0..2]` and the peer's to the peer's
   `nonce[0..2]`. The session id is `SHA256(saltHash || deviceNonce || serverNonce)[0..16)` in hex and
   appears in audit records.

### Sealed frames

```
uint32be length | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag
```

* `nonce = prefix(3) || direction(1) || counter(8, big-endian)`, where `direction` is `0` for
  client→server and `1` for server→client, and `counter` starts at `0` and increments per frame.
* **AAD** = `"dshkit-tunnel-v1" || saltHash || direction(1) || counter(8)`. This binds the frame to the
  session transcript, so a frame cannot be replayed into another session or reflected back at its
  sender.
* The prefix is 3 bytes, drawn from the handshake nonce (which is cleared, but is an HKDF/AAD input and
  an input to the session id, so both ends commit to the same transcript before any ciphertext exists).
  The single-direction counters keep nonces unique for the lifetime of a session key.
* **Replay guard.** The receiver rejects any counter that is *not strictly greater* than the highest
  counter it has already accepted (and any counter it has already seen). A violation is fatal for the
  session: the frame is not merely dropped, the tunnel is torn down and audited
  (`tunnel.reject`, reason `sealed-replay`).
* `MAX_FRAME_BYTES` = 4 MiB; a declared length above that fails the session immediately.
* A separate `uint32be` length prefix inside the (sealed) JSON envelope keeps the two framing layers
  from depending on each other.

### Plaintext envelope

Every sealed frame carries one JSON object with a `kind`. `seq` is optional (the AEAD counter already
orders frames); when present it must be a non-negative integer.

| `kind` | Fields | Direction | Meaning |
|---|---|---|---|
| `http` | `id`, `method`, `path`, `headers`, `bodyB64` | client → server | one unary RPC |
| `http-res` | `id`, `status`, `headers`, `bodyB64` **or** `id`, `error`, `message` | server → client | the Host's answer, or `too-large` / `timeout` / `bad-path` / … |
| `ws-open` | `id`, `path`, `headers?` | client → server | open a logical stream (e.g. `/api/remote.mux`) |
| `ws-open-res` | `id`, `ok`, `code?`, `message?` | server → client | whether the upstream dial succeeded |
| `ws-data` | `id`, `dataB64`, `t?` (`"b"` binary, `"t"` text; absent = binary) | both | one WebSocket message |
| `ws-close` | `id`, `code`, `reason` | both | the stream ended (either side) |
| `ping` | `t?` | both | heartbeat, default every **2000 ms** (mirrors the dsh mux) |
| `pong` | `t?` | both | heartbeat reply |
| `error` | `id?`, `code`, `message` | both | non-fatal protocol error |

Any other `kind` is answered with `{kind:'error', code:'unsupported-kind'}` — never silently ignored.

**HTTP semantics.** `method`/`path` are taken verbatim from the client (the path must be absolute, so
an absolute URL cannot be smuggled in), and the request is issued to
`http://127.0.0.1:<dshPort><path>`. The client's `Cookie`, `Host`, `Origin`, `Sec-Fetch-*` headers pass
through **untouched** — hostkit never fabricates or rewrites them. Only hop-by-hop headers
(`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailer`, `proxy-*`) are removed.
The body cap is **8 MiB** in each direction; a larger request or response becomes
`{kind:'http-res', id, error:'too-large'}` instead of being relayed.

**Why hostkit never needs the dsh token.** The phone authenticates end-to-end: it performs the
`GET /?token=…` cookie exchange itself and then sends its cookie through the tunnel. A hostkit process
that never holds the token cannot leak it, and the upstream trust fence
(`Host` must be loopback, `Origin` must equal `Host` — D2 §2.2) is satisfied because the request really
does come from loopback.

### Heartbeat and teardown

* `{kind:'ping'}` every `pingIntervalMs` (default 2000 ms, the dsh mux's own period).
* A session with **no inbound frame of any kind** for `3 × pingIntervalMs` is torn down. The threshold
  is traffic-based rather than pong-based, so a device busy streaming a large response is not killed.
* A revoked session is closed immediately, by the server that holds it.

### Pairing

`hostkit pair` opens a window for `--pair-window` seconds (default 120) and prints a QR code plus:

```
dshkit://pair?v=1&name=<name>&host=<host>&port=<port>&pub=<hostkitPub>&pairId=<id>&token=<pairToken>&exp=<ms>&tls=<0|1>
```

`pairToken` is 32 random bytes (base64url). The device then POSTs:

```json
{ "pairId": "...", "pairToken": "...", "deviceId": "...", "devicePub": "<b64url>", "deviceName": "..." }
```

to `POST /pair` on the same listener. The server verifies `pairId` + `pairToken` (constant-time
compare) + expiry, **burns the `pairId` on success**, adds the device to the whitelist, audits the
event, and answers:

```json
{ "ok": true, "v": 1, "hostkitPub": "...", "name": "...", "port": 8798, "tls": false, "deviceId": "..." }
```

A rejection is always `403 {"ok": false, "code": "pairing-rejected"}` on the wire — the *reason*
(`no-window`, `unknown-pair-id`, `expired`, `consumed`, `token-mismatch`, `bad-request`) is recorded in
the audit log but not disclosed to the caller. A wrong guess does not burn the window.

### Discovery

One JSON datagram per 3 s to `255.255.255.255:<discoveryPort>` **and** every interface's directed
broadcast address:

```json
{ "magic": "DSHKIT1", "v": 1, "instanceId": "...", "name": "...", "port": 8798, "tls": false, "pairing": false, "hostkitPub": "..." }
```

A listener ignores its own `instanceId`, ignores datagrams with the wrong magic/version/shape and
datagrams larger than 2 KiB, and emits each host once (`found`) while counting repeats (`peer`).
`hostkit discover` runs a listener for `--wait` seconds and prints what it heard.

**Why UDP broadcast instead of mDNS.** (1) There is no zero-dependency mDNS implementation in Node's
standard library, and a correct one is hundreds of lines of DNS wire format plus multicast handling,
against ~120 lines here. (2) The consumer is ArkTS: `@ohos.net.socket` exposes UDP directly, whereas an
mDNS responder needs `@ohos.net.mdns` (API-version and permission sensitive) or a hand-written DNS-SD
parser on the platform we can test least. (3) The payload we need does not fit DNS-SD's TXT-record
ergonomics any better than a 200-byte datagram. (4) Discovery is a convenience: pairing works from a
typed `dshkit://` URI or the manual code with discovery disabled.

---

## Threat model (L1 / L2, per D1 §6.4)

### What hostkit protects against

| Threat | Mitigation |
|---|---|
| A device that was never paired connects | Whitelist lookup before any key exchange; `ok:false, code:'unauthorized'`, connection closed, audited |
| A pairing code is captured and replayed | 32-byte token, constant-time compare, **single use**; `pairId` is burned on success |
| A pairing code is brute-forced on the LAN | 120 s window, 256-bit token, only open while the user runs `hostkit pair`; there is no always-on pairing endpoint |
| A LAN attacker reads or modifies tunneled traffic | AES-256-GCM frames with keys derived by X25519 + HKDF; the transport being plain `ws://` does not expose the payload |
| A frame is replayed or reordered | Strictly-increasing per-direction counters plus the counter in the AAD; a violation closes the session |
| A frame is reflected back at its sender or cross-session replayed | The direction byte lives in the nonce and the session transcript hash lives in the AAD |
| The Host is exposed to the network | The tunnel exit is a fresh `127.0.0.1:<dshPort>` connection; hostkit refuses to start against a non-loopback target |
| A stolen cookie is reused after revocation | `revoke` is a sticky whitelist flag **and** tears down live sessions immediately |
| A killed/restarted Host silently degrades | Supervision with a bounded exponential ladder (500 ms → 10 s, ≤ 5 restarts/minute) then an explicit give-up |
| Unbounded memory from a hostile peer | 4 MiB frame cap, 8 MiB body cap, 16 simultaneous sessions, 8 KiB `POST /pair` body, 2 KiB discovery datagram |

### What hostkit explicitly does **not** protect against

* **A compromised PC.** hostkit runs with the user's privileges; the identity private key, the
  whitelist and the audit log are on the same disk, and local code can read or rewrite all of them. The
  audit log is *append-only by convention*, not tamper-proof.
* **A compromised phone.** Once a device holds a valid key, hostkit authorizes it. Revocation is the
  only remedy, and it does not undo anything the device already did.
* **Metadata on the wire.** The plaintext hello exposes `deviceId` and both public keys, and the frame
  *sizes* and *timing* are visible to a passive LAN observer. TLS hides the hello when configured, but
  is not required for confidentiality of the session payload.
* **Denial of service.** A LAN attacker can flood `/tunnel` with hellos (each rejected, each audited),
  fill the 16-session budget, or flood the audit log. There is no rate limiting beyond the session cap.
* **`POST /pair` over plain HTTP.** The pairing token is sent in the clear unless TLS is configured.
  An attacker who can already observe the LAN during the 120 s window could race the legitimate device.
  Configure `--cert`/`--key` if that matters in your environment.
* **The Host's own authorization model.** hostkit forwards the client's cookie verbatim; whatever that
  cookie grants, the tunnel grants.

### Red lines, and how they are enforced structurally

1. **The dsh Host is never bound past loopback.** `assertLoopbackHost` runs in the `HostkitServer`
   constructor; `HostProxy` can only build `http://127.0.0.1:<dshPort>` URLs.
2. **No upstream patches.** hostkit spawns the CLI and reads its stdout; it never writes inside the dsh
   installation.
3. **hostkit is optional.** `L0` needs no hostkit, and no other component imports it.
4. **No killing by name.** `platform/*.killTree(pid)` is the only kill path, and it is only ever called
   with the pid of a child this process spawned. There is no `taskkill /IM`, no `pkill -f`, no
   `Stop-Process -Name`.

---

## Limitations

Every deliberate deviation from the task book, and everything that is untested, is listed here.

### Deviations

1. **UDP broadcast instead of mDNS** (`src/discovery.mjs`). Justified in
   [Discovery](#discovery); the announce payload is a 200-byte JSON datagram, and there is no
   zero-dependency mDNS implementation for Node or an equally safe one for ArkTS.
2. **Self-signed TLS is optional, not mandatory.** The tunnel payload is end-to-end encrypted before it
   reaches the transport, so TLS only protects the plaintext hello and the pairing token. hostkit runs
   plain `ws://` unless `--cert`/`--key` or `--tls-selfsigned` is given. `--tls-selfsigned` shells out
   to `openssl` and fails loudly if none is found, rather than silently falling back to plaintext.
3. **TLS and plaintext cannot share one port.** With TLS configured the listener serves only
   `https`/`wss`; without it, only `http`/`ws`. Serving both would need SNI-style protocol sniffing on
   the raw socket, which is a large amount of fragile code for a marginal benefit.
4. **The 6-digit manual code is a convenience, not an independent secret.** It is derived from the
   pairing token for display; the server still requires the full `pairId` + `pairToken` over `POST /pair`.
   A UI that accepts only the 6 digits would be weaker than the protocol requires.
5. **`revoke` from the CLI does not reach into a running server.** `hostkit revoke` updates the
   whitelist (so the device cannot reconnect) and audits it; it cannot close a session owned by another
   process. Immediate teardown of a *live* session happens when the revocation goes through the server
   object (`HostkitServer.revoke`), which is what `GET /state` and the tests exercise. Cross-process
   revocation needs an admin route that was out of scope here.
6. **`GET /state` and `GET /audit` authenticate with the pairing token or the per-run admin token**, not
   with a device key. There is no dedicated client-facing status API yet.
7. **`--pair` is a flag on `start`**, rather than a separate "pairing mode" daemon. A window opened
   this way closes on first success or on expiry.
8. **One pairing window at a time.** Opening a new window supersedes the previous one instead of
   keeping both valid.
9. **The supervised Host's stdout is parsed, not its state.** hostkit detects the
   `dsh web: http://127.0.0.1:<port>/?token=…` line (the upstream format recorded in D2 §2.1) for
   diagnostics only; the token is never stored, and health is decided by `GET /` on loopback accepting
   *any* HTTP status.
10. **A `SIGKILL`-resistant child cannot be reclaimed on Windows.** `taskkill /PID <pid> /T /F` is used,
    which is pid-scoped, but a child that ignores termination may survive hostkit's exit. hostkit never
    falls back to matching by name.

### Untested / not verified here

* **No real phone has connected.** The end-to-end test drives a *fake* dsh Host (a plain `node:http`
  server answering `POST /api/ping` and upgrading `/api/remote.mux` to a WS echo) with a device paired
  in-test. The real Host's `/api/remote.mux` framing (D2 §8.3) and the ArkTS client are exercised
  elsewhere.
* **No real `dsh` process is spawned by the test suite.** `hostproc.test.mjs` injects `spawnImpl`, so
  the restart ladder, the give-up cap and the announce parse are tested, but the actual CLI invocation
  is not. `bin/hostkit.mjs start --dsh-cmd …` has been run manually against a real `dsh web`.
* **The QR code has not been scanned by a camera.** It is verified by an independent decoder
  (`test/helpers/qr-decode.helper.mjs`) that re-reads the rendered matrix with its own un-masking,
  de-interleaving and Reed–Solomon implementation, plus closed-form checks on all three ISO/IEC 18004
  tables. That catches encoder bugs, but not, for instance, a terminal that renders the half-block
  characters at the wrong aspect ratio.
* **TLS is not covered by tests.** `resolveTls` and `mintSelfSigned` exist and fail loudly, but no test
  starts a `wss` listener or checks certificate validity.
* **The `--tls-selfsigned` path is untested** (it depends on an `openssl` binary being present).
* **Discovery has only been exercised on loopback and one LAN interface.** Directed-broadcast behaviour
  across multiple interfaces, and Wi-Fi client isolation, are not covered.
* **`/state` and the CLI `status` probe are not load-tested**; the CLI `revoke`-while-running caveat
  above (item 5) has no integration test.
* **Windows-only paths** (`windowsHide`, `taskkill`) are exercised only through the platform objects'
  shapes, not by actually spawning and killing a child on every platform.

### Known rough edges

* The audit log is written with one `appendFileSync` per record. Records are far below `PIPE_BUF`, so
  concurrent appends do not interleave in practice, but the log is not fsync'd per record.
* `hostkit pair` refuses to share a port with a running `hostkit start`; use the pairing window opened
  by `start --pair` in that case.
* The whitelist file is rewritten in full on every change. That is fine for tens of devices and would
  need rethinking for thousands.
