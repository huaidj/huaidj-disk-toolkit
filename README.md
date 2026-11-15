# HuaiDJ Disk Toolkit

[繁體中文快速開始](README.zh-TW.md) · [Agent connection details](docs/CONNECT.md) · [v0.1.0 release assets](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/tag/v0.1.0)

Prepare USB media, choose a sourced DJ-device format, preserve rekordbox export metadata, or connect the same core to an agent through CLI/MCP.

## Choose a package

| Package | How to start |
| --- | --- |
| [Minimal Skill ZIP](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/download/v0.1.0/huaidj-disk-toolkit-v0.1.0-skill.zip) | Install its single `huaidj-disk-toolkit` folder in your agent's Skill location. Its standalone bootstrap obtains the fixed `v0.1.0` core and missing official dependencies over HTTPS with SHA-256 checks. The Skill does not contain a second copy of the core. |
| [Windows software / MCP ZIP](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/download/v0.1.0/huaidj-disk-toolkit-v0.1.0-windows-x64.zip) | On a clean machine, first save and verify the same-tag `install.ps1`, then preview and apply its `-RuntimeOnly` setup as shown in [desktop setup](docs/CONNECT.md#windows-desktop-setup). It installs this package and missing Node.js/PowerShell dependencies per user. If those dependencies already exist, extract the complete ZIP and open `app/HuaiDJ.DiskToolkit.exe`. The .NET desktop runtime is self-contained; CLI and MCP share the same core. |

The Windows desktop provides USB/media planning, fast device-format matching, and export-library snapshots. Start with a preview and review the selected physical device and operation scope. macOS/Linux provide reference/query and stdio support; this release has no physical-disk writer for those hosts.

## Copy this prompt to your agent

```text
Connect HuaiDJ Disk Toolkit to this agent. First identify the actual host OS and MCP client, and reuse an existing working huaidj-rufus server entry. Do not replace a working configuration just to change its location.

If it is missing, use only repository yutianyu111602-glitch/huaidj-disk-toolkit, fixed tag v0.1.0. Download release-manifest.json, SHA256SUMS and the appropriate saved installer (install.ps1 on Windows; bootstrap.sh on macOS/Linux) from that tag. Verify its SHA-256 against the manifest asset record and SHA256SUMS before running the local file. Do not use a remote execution pipe or fall back to latest/unverified assets.

On Windows use the per-user PowerShell 5.1 installer with Flavor Mcp and the detected supported Client. On macOS/Linux use the saved bash bootstrap for reference/query/stdio only; do not claim physical writes. Supported setup clients are codex, claude-code, claude-desktop, gemini, opencode and vscode. For another client, install RuntimeOnly and return the verified stdio entry instead of guessing its configuration schema.

Preview setup changes, preserve verified backups, and use compare-and-swap before applying this requested registration. Keep conflicting entries unchanged. Do not change auto-approval, workspace trust, UAC or system PATH, and do not force-restart applications.

Verify actual tool discovery in this client and one read-only call, such as list_dj_models with query CDJ. A config listing or isolated SDK test is not client acceptance. If reloading or a new chat is required, report that precisely and leave running applications alone. Report status and tool names without dumping private agent configuration or secrets. This request authorizes connection setup, not disk formatting or writing.
```

See [connection and checksum steps](docs/CONNECT.md). If the fixed release is not available, report that instead of substituting another download.

## Core and supported scope

The Windows adapter uses the real Rufus engine for boot media and Windows storage APIs for formatting. Reference queries cover Windows, macOS and a bounded catalog of DJ players. This release does not provide a native macOS/Linux physical-disk writer.

## What it does

- Identifies physical USB devices and binds operations to hardware identity and capacity.
- Prepares expiring plans for image writing, formatting one partition or reinitializing a whole USB.
- Writes compatible ISO/IMG media with Rufus and independently verifies physical image bytes by SHA-256.
- Formats FAT, FAT32, NTFS, exFAT and UDF through the Windows adapter; reports runtime limitations and refuses ReFS USB formatting.
- Compares filesystems, audio properties, library types, software versions and firmware conditions across 13 researched DJ products, with 32 manufacturer sources.
- Distinguishes desktop main libraries, traditional Device Library and OneLibrary. Provides version-specific export advisories.
- Creates verified, independent export-metadata snapshots and controlled same-media restoration with quarantine and failure rollback.
- Provides CLI/MCP setup helpers and the `huaidj-disk-toolkit` skill.

A feature being implemented, a process starting, a completed write, a matching readback hash and successful playback are separate outcomes. See [support and test scope](docs/SUPPORT.md).

## Requirements and installation

- Node.js 22.15 or newer.
- Windows physical-disk operations: PowerShell 7 and the Storage module supplied by Windows.
- Building the native Rufus adapter from a source checkout only: Windows, Visual Studio C++ Build Tools v143 and a Windows SDK. The Windows software package already contains the built adapter. Python 3.11+ and Git are needed only for source-packaging development tasks.

```powershell
npm ci --ignore-scripts
npm link
if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json }
New-Item -ItemType Directory -Path images -Force
huaidj-disk --help
huaidj-disk capabilities
```

The public default image root is `./images`, relative to the project. Add intentional local image roots or neutral aliases to the private `config.json`; it is ignored by Git. Network paths are refused. `huaidj-rufus` remains a compatible CLI alias.

For native boot-media writing, build the adapter using [the build instructions](docs/BUILDING.md), then place the reviewed executable at `bin/rufus-huaidj.exe`. The normal Windows UAC prompt may appear for physical disk operations. Read-only inventory, compatibility queries and local image hashing require no elevation.

## Prepare an image-writing plan

First list devices and inspect the intended physical USB. Device numbers and drive letters are not persistent identifiers.

```powershell
huaidj-disk devices
huaidj-disk details --device <current-device-number>
huaidj-disk inspect --image ./images/linux.iso --sha256 <publisher-sha256>
huaidj-disk prepare --device <current-device-number> --image ./images/linux.iso --sha256 <publisher-sha256> --mode dd
```

Replace bracketed values with the actual inventory and publisher-provided hash. Use the returned plan ID and exact confirmation:

```powershell
huaidj-disk dry-run --plan <plan-id> --confirm <returned-confirmation>
huaidj-disk write --plan <new-plan-id> --confirm <returned-confirmation> --erase
huaidj-disk job --id <job-id> --wait
huaidj-disk verify --device <current-device-number> --image ./images/linux.iso --sha256 <publisher-sha256>
```

A plan expires and can be used once; a dry run consumes its plan. DD mode requires a partitioned/hybrid image. Windows installer ISO handling and native options have their own documented scope; do not infer that every ISO can be written in DD mode.

## Format a partition or reinitialize a USB

```powershell
huaidj-disk prepare-disk --operation format-volume --device <number> --partition <number> --filesystem exFAT --label DJUSB
huaidj-disk prepare-disk --operation initialize-usb --device <number> --partition-style MBR --filesystem FAT32 --label DJUSB
huaidj-disk execute-disk --plan <reviewed-plan-id> --confirm <returned-confirmation> --erase
```

Formatting one partition and erasing the entire USB are different operations. Plans include the exact scope; active system/internal disks are refused for writes. Large FAT32 volumes depend on the selected formatter and its runtime limits. A rejected FAT32 request is never silently changed to exFAT.

## Compare DJ media requirements

```powershell
huaidj-disk formats --platform macos --filesystem ntfs
huaidj-disk dj-models --query CDJ
huaidj-disk dj-model --model cdj-3000
huaidj-disk dj-recommend --models 'cdj-3000,cdj-3000x' --platforms 'windows,macos'
huaidj-disk dj-audio --model cdj-3000 --format wav --sample-rate 96000 --bit-depth 24
huaidj-disk rekordbox-advice --version 7
```

Supply actual firmware with `--firmware 'cdj-3000=1.20'` and the rekordbox version with `--version 6.6.2` when a feature requires them. The reference preserves unknowns and non-exhaustive audio rates. M4A alone does not identify AAC versus ALAC. Filesystem interoperability does not certify a USB controller, encoded audio, database contents or player firmware.

The research data is in `src/data/`; every supported statement has manufacturer references and an as-of timestamp. An absent device is unconfirmed, not necessarily unsupported.

## Preserve rekordbox USB export metadata

```powershell
huaidj-disk export-inspect --root <selected-media-root> --hash
huaidj-disk snapshot-preview --root <selected-media-root>
huaidj-disk snapshot-create --root <selected-media-root> --exporter-version 6.8.7
huaidj-disk restore-preview --snapshot <snapshot-id> --root <same-media-root>
```

Close rekordbox cleanly before taking a snapshot or restoring one. Snapshots include the complete `PIONEER/rekordbox` metadata directory and sidecars. `--analysis` optionally preserves `PIONEER/USBANLZ`; music in `Contents` is neither scanned nor backed up.

Restoration requires the preview ID, exact snapshot digest and confirmation returned by `restore-preview`. It is limited to the same identified Windows USB. Existing export metadata is moved into quarantine before replacement. This version restores metadata only; analysis/music and desktop main libraries are not restored. Presence detection and a successful byte restore are not database repair or DJ-player acceptance.

## MCP and skill

The local stdio entry is:

```text
node /absolute/project/path/src/cli.mjs mcp
```

The server needs no credentials and opens no network listener. It exposes narrow tools for inventory, image/format plans, write/status/readback, sourced compatibility and export snapshots/restoration. Destructive calls require the matching plan and explicit confirmation. No auto-approve list is installed.

The skill is under `skills/huaidj-disk-toolkit`. The public setup helper previews changes by default, preserves existing settings and creates verified backups when explicitly applied. See `huaidj-disk --help` for the current setup commands. Existing agent sessions may need reloading; configuration insertion is not runtime acceptance.

## Tests and acceptance

```powershell
npm test
node tests/mcp-smoke.mjs
```

| Check | What is established |
| --- | --- |
| Windows storage adapter | FAT/FAT32/NTFS/exFAT/UDF and GPT/MBR checks passed on owned isolated VHD fixtures. This does not certify a physical USB controller or DJ player. |
| Zorin DD baseline | A real 32 GB USB write and full image-length physical SHA-256 readback matched the image. The sanitized receipt refers to the preserved **FFEC baseline** native build. No Linux boot or internal OS installation was performed. |
| Expanded native build | Standard Windows ISO extraction, native format-only/large FAT32 and formatting options are implemented. The installed **3bc** build passed compilation/privacy checks and 53 pure native policy/options tests; its production execution, Windows ISO dry-run and physical-media acceptance remain **NOT_RUN**. The baseline Zorin result is not acceptance of this expanded build. |
| Desktop | Windows x64 self-contained files compile successfully. Startup, Chinese layout, recommendation constraints and an unconfirmed format review were observed in the actual GUI. [Partial UI receipt](tests/acceptance/desktop-windows-partial.json); remaining tabs, languages, multi-DPI and desktop write/restore acceptance remain **NOT_RUN**. |
| Export preservation | Isolated metadata snapshot/restore fixtures passed. Live rekordbox GUI, real-media metadata restoration and DJ-player playback remain **NOT_RUN**. |
| Network bootstrap | Offline installer fixtures passed. Actual fixed-release download/install acceptance is separate from those tests and depends on publication. |

Booting Linux, installing an internal OS and physical DJ-player playback remain separate acceptance stages. See [native scope](docs/NATIVE_API.md), [support boundaries](docs/SUPPORT.md) and the sanitized receipt under `tests/acceptance/`.

Do not run physical-media tests on an unspecified drive. Offline CI does not format runner disks or request elevation. A `submission-unknown` result keeps the USB reservation while the launch outcome is unresolved.

## License and upstream

The main project is **GPL-3.0-or-later**. Commercial use and distribution are permitted subject to its terms. Rufus and other third-party notices are preserved; this is an independent derivative, not an official Rufus release. See [LICENSE](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), [licensing](docs/LICENSING.md) and [architecture/alternatives](docs/ARCHITECTURE.md).

Private configuration, snapshots, agent backups, runtime copies and OS images are excluded from the public source package. Binary distributions must include the exact corresponding source and build information. See [distribution](docs/DISTRIBUTION.md).
