# DSHM

DSHM is a HarmonyOS Next implementation of the DSH (DeepSeek Harness) runtime. The `entry` module owns the application, device integration, and runtime bridge.

## Current Status

The application can start the official DSH WebUI on HarmonyOS devices. `EntryAbility` loads `pages/dshm/DshmWebPage`, prepares the DSH, busybox, and pnpm runtimes inside the app sandbox, starts the local DSH service, and loads `http://127.0.0.1:3080` through ArkWeb.

- **Two runtime modes** (Harness → Runtime Mode, persisted in `<filesDir>/runtime-mode.txt`):
  - `auto` (default): prefers a host dsh installed by Harmonybrew (system node, ~**9s** to ready)
  - `host`: always use the host dsh (`~/.harmonybrew/bin/dsh`)
  - `embedded`: use the bundled `libnode` + `rawfile/dsh` environment under `--jitless` (~**11.4s** to ready)
  - ⚠️ The two modes use different `$DSH_HOME` values (host = `/storage/Users/currentUser`, embedded = `<filesDir>/home`), so their **session stores are separate** — check `runtime-mode-active.txt` first when sessions "disappear".
- **fetch/WebAssembly shim**: `_fetch-shim.cjs` (preloaded via `-r`) provides Web globals and a never-settling `WebAssembly` stub so undici's llhttp WASM never crashes under `--jitless`
- **busybox fallback applets**: ash/bash/hush, bzip2/xz, hexdump, less, nc, unzip, vi — the rest is covered by the system toybox
- Built-in pnpm; plugin installs run through an in-process worker bridge
- Workspace directory grant with persistent permission, synced into the sandbox workspace
- **No in-app online update**: the menu exposes local actions only (Home / About / Runtime Mode / Check App Update / Reset Runtime / Restart Service, plus Refresh and a zsh terminal under Edit). Upgrading dsh means rebuilding the environment and installing a new HAP — see [docs/dsh-version-upgrade.md](docs/dsh-version-upgrade.md)
- **Slimmed environment**: `rawfile/dsh` went from 253.5MB / 26,762 files to **110.7MB / 12,485 files**; the HAP from 385MB to **238MB**; install time from 60s to **9.8s**. Handled by `scripts/prune-dsh-env.mjs`, which also runs a package-entry integrity self-check.
- Declared device types: phone, tablet, 2in1, car, tv, wearable
- Public sources contain no signing materials, credentials, or machine-local files

## Runtime Constraints (verified on device)

- **`--jitless` is mandatory** (embedded mode): the sandbox enforces W^X, so the bundled node always starts with `--jitless --expose-internals` and uses `_fetch-shim.cjs` as the WebAssembly/Web-globals shim.
- **ArkTS http to loopback is unreliable**: server readiness is detected by polling the node log file for the `dsh web:` marker, not via HTTP probes.
- **libnode needs native hardening**: `DT_NEEDED` linking fixes a V8 TLS bootstrap race; io_uring syscalls are patched to fall back to epoll. These are applied by scripts and shipped under `entry/libs/arm64-v8a/`, not via npm.
- **HAPs are stored uncompressed**: every MB removed from `rawfile` removes a MB from the HAP, so size work means pruning environment files (matching "platform build artifact" shapes only — never prune just because a path contains `win32`; see the upgrade guide §4.1).

## Repository Layout

```text
DSHM/
├── entry/                 # Application layer, Ability, ArkWeb page, and runtime bridge
├── scripts/               # Runtime preparation and device regression scripts
├── docs/                  # Architecture, build, and runtime records
├── tools/                 # Development tooling (icon generation, scans)
├── .rules/                # Shared Agent engineering rules
├── .agent-rules/          # Project rules and bug log
└── AGENTS.md              # Workspace collaboration rules
```

`entry/src/main/resources/rawfile/dsh/`, `busybox/`, and native runtime files are generated or downloaded by preparation scripts and ignored by Git.

## Development

1. Open the repository in DevEco Studio.
2. Prepare the runtime files:

```bash
bash scripts/prepare-dsh-env.sh 0.1.5-rc.2   # also prunes the env and runs the package-entry self-check
bash scripts/fetch-busybox.sh
bash scripts/fetch-pnpm.sh
DSHM_LIBNODE_URL=<approved-libnode-url> bash scripts/fetch-libnode.sh
```

3. Configure a local development signature in DevEco Studio. Keep signing files on the local machine.
4. Build the `entry` module with Hvigor and install it on a device.
5. Run the regression script with an explicit target: `bash scripts/ui-test-phone.sh 1 <hdc-target>`.

## Documentation

- [dsh version upgrade guide](docs/dsh-version-upgrade.md) — upgrade flow, 27 pitfalls, runtime modes
- [busybox runtime](docs/dsh-busybox-linux-env.md)
- [Device runtime troubleshooting](docs/device-runtime-fixes.md)
- [Build notes](docs/build-notes.md)
- [Agent collaboration rules](AGENTS.md)

## License

MIT, see [LICENSE](LICENSE).