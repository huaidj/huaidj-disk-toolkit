# Audited bootstrap contract

The Windows entry point is `scripts/install.ps1`; it also works when copied unchanged to an arbitrary Skill directory as `scripts/bootstrap.ps1`. It reads the fixed `v0.1.0` release manifest from the project repository and never downloads a newer installer script. `scripts/bootstrap.sh` is similarly self-contained for macOS/Linux.

The default is a preview. `-Apply` (or `--apply`) prepares a versioned runtime. MCP configuration is changed only for an explicit supported client through the generic setup CLI. `-RuntimeOnly` / `--runtime-only` returns `cliCommand` and `cliArgs` without registering an MCP server or copying a Skill. Skill setup requires an explicit final Skill target. Existing different entries, edited runtimes and incomplete installations are preserved.

Complete receipts and ready results expose `nodePath`, `cliPath`, `powershellPath` and `toolkitRoot` for desktop discovery. `toolkitRoot` is the installed core folder containing `package.json` and `src`; `installRoot` is its parent installation container. On macOS/Linux, `powershellPath` is null. Optional desktop binaries under `app/` do not change the required core layout.

Install-root precedence is an explicit option, `HUAIDJ_TOOLKIT_HOME`, then the standard user data directory. There is no system PATH/UAC change, admin installer, token lookup, OS image download, or `curl | sh` / remote `Invoke-Expression` flow.

## Release manifest

Use schema version 1, package version `0.1.0`, tag `v0.1.0` and repository `yutianyu111602-glitch/huaidj-disk-toolkit`. Merge the `node` and `powershell` records from `dependencies.json` into `dependencies`.

Assets are an array of `{name,file,url,sha256,archiveRoot}` records. Required package names are:

- `windows-x64`: `huaidj-disk-toolkit-v0.1.0-windows-x64.zip`, flat root `.`.
- `source`: `huaidj-disk-toolkit-v0.1.0-source.zip`, flat root `.`.
- `skill`: `huaidj-disk-toolkit-v0.1.0-skill.zip`, one top-level `huaidj-disk-toolkit` folder.

Windows packages include the native executable, JavaScript/PowerShell/data/Skill files, npm lockfile, licensing and corresponding native source in canonical `sources/rufus/` with `sources/native-source-manifest.json`. The installer checks the recorded source files and their hashes, required engine/adapter records, and the manifest's patch/native-binary hashes. A vendor checkout is not a public package layout fallback. Packages exclude local runtime/config/state/work, npm dependencies and OS images. The source package has no physical-write claim on macOS/Linux. Publish `install.ps1`, `bootstrap.sh`, `SHA256SUMS` and the final `release-manifest.json` alongside the package assets.

The installer validates the whole ZIP before extraction, verifies portable downloads against both manifest pins and official checksum lists, and runs locked `npm ci --ignore-scripts`. PowerShell's official `hashes.sha256` currently uses a UTF-16LE BOM; the Windows reader detects it. npm uses empty user/global configurations, a private cache and a child environment without npm/GitHub auth variables.

Tests use tiny offline fake ZIPs, injected trusted local download/command helpers, and owned test directories. Those helpers are not public script parameters or MCP inputs. Passing offline tests is not a successful real release download or portable-runtime acceptance; that remains pending until the fixed release exists and is independently checked.
