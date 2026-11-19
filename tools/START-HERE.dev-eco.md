# DSHM DevEco Workspace

This bundle is a source-complete DSHM beta workspace prepared for DevEco Studio.

## First Run

1. Extract the archive to a short path without spaces or non-ASCII characters.
2. In the extracted directory, copy `build-profile.portable.json5` to `build-profile.json5`.
3. Open the directory, not a parent directory, in DevEco Studio.
4. Wait for project sync to finish. If dependencies are missing, run `ohpm install --all`.
5. Open `File > Project Structure > Signing Configs` and enable automatic signing for:
   - Product: `default`
   - Bundle name: `com.dshm.dshmbeta`
6. Select a connected HarmonyOS device or a simulator supported by that DevEco host.
7. Build the `entry:default` HAP before changing application code.

## Included Build Inputs

- `entry/libs/arm64-v8a/`
- `entry/src/main/cpp/node-headers/`
- `entry/src/main/resources/resfile/`
- `third_party/`
- All current source, documents, tools, local tests, and Git metadata

## Intentionally Excluded

- `dist/`
- all `build/`, `.cxx/`, `.hvigor/`, `.idea/`, and `oh_modules/` directories
- `tmp-gp/`
- machine-bound `build-profile.json5` and `build-profile.local.json5`

The machine-bound profiles contain signing passwords and certificate paths. They
must never be copied to another machine. DevEco automatic signing creates a new
local profile for the new device.

## Safety

- Do not run `git clean`, `git reset --hard`, or delete `entry/libs`.
- Do not delete `entry/src/main/resources/resfile`; it contains required core,
  toolchain, and VM assets.
- Preserve the current worktree. The export includes uncommitted and untracked
  files.

See `docs/211-迁移到DevEco-Studio与鸿蒙PC.md` for the full handoff checklist.
