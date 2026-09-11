# DSHM

DSHM is a HarmonyOS Next implementation of the DSH (DeepSeek Harness) runtime. The `entry` module owns the application, device integration, and runtime bridge.

## Current Status

The application can start the official DSH WebUI on HarmonyOS devices. `EntryAbility` loads `pages/dshm/DshmWebPage`, prepares the DSH, busybox, and pnpm runtimes inside the app sandbox, starts the local DSH service, and loads `http://127.0.0.1:3080` through ArkWeb.

- **End-to-end loop**: embedded node (`--jitless`) inside `libdsh_host` → DSH web server on `127.0.0.1:3080` → ArkWeb renders the WebUI
- **fetch/WebAssembly shim**: `_fetch-shim.cjs` (preloaded via `-r`) provides Web globals and a never-settling `WebAssembly` stub so undici's llhttp WASM never crashes under `--jitless`
- **busybox fallback applets**: ash/bash/hush, bzip2/xz, hexdump, less, nc, unzip, vi — the rest is covered by the system toybox
- Built-in pnpm; plugin installs run through an in-process worker bridge
- Workspace directory grant with persistent permission, synced into the sandbox workspace
- Declared device types: phone, tablet, 2in1, car, tv, wearable
- Public sources contain no signing materials, credentials, or machine-local files

## Runtime Constraints (verified on device)

- **`--jitless` is mandatory**: the sandbox enforces W^X, so the embedded node always starts with `--jitless --expose-internals` and uses `_fetch-shim.cjs` as the WebAssembly/Web-globals shim.
- **ArkTS http to loopback is unreliable**: server readiness is detected by polling the node log file for the `dsh web:` marker, not via HTTP probes.
- **libnode needs native hardening**: `DT_NEEDED` linking fixes a V8 TLS bootstrap race; io_uring syscalls are patched to fall back to epoll. These are applied by scripts and shipped under `entry/libs/arm64-v8a/`, not via npm.

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
bash scripts/prepare-dsh-env.sh 0.1.2-rc.1
bash scripts/fetch-busybox.sh
bash scripts/fetch-pnpm.sh
DSHM_LIBNODE_URL=<approved-libnode-url> bash scripts/fetch-libnode.sh
```

3. Configure a local development signature in DevEco Studio. Keep signing files on the local machine.
4. Build the `entry` module with Hvigor and install it on a device.
5. Run the regression script with an explicit target: `bash scripts/ui-test-phone.sh 1 <hdc-target>`.

## Documentation

- [busybox runtime](docs/dsh-busybox-linux-env.md)
- [Device runtime troubleshooting](docs/device-runtime-fixes.md)
- [Build notes](docs/build-notes.md)
- [Agent collaboration rules](AGENTS.md)

## License

MIT, see [LICENSE](LICENSE).