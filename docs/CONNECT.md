# Connect the current agent

The minimal Skill and Windows software/MCP package share one core. The
public MCP server name remains `huaidj-rufus`; the CLI aliases are
`huaidj-disk` and `huaidj-rufus`. Existing working entries can be reused.

Copy the connection prompt at the top of [README](../README.md) to the
agent that should receive the tools. The request covers installing the
per-user runtime and registering that client. It does not authorize disk
formatting, image writing or export restoration.

## Fixed release and checksums

Use repository
[`yutianyu111602-glitch/huaidj-disk-toolkit`](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit)
and tag [`v0.1.0`](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/tag/v0.1.0).
Save these files from that tag's release assets into an owned local folder:

- `release-manifest.json`
- `SHA256SUMS`
- Windows: `install.ps1`
- macOS/Linux: `bootstrap.sh`

Before executing the saved installer, calculate its SHA-256 and compare it
with both the matching `assets` array record in the manifest and its line
in `SHA256SUMS`. Also check the manifest's repository, version `0.1.0` and
tag `v0.1.0`. A missing release, mismatch or conflicting pin stops setup.
These are HTTPS-origin and integrity checks, not an upstream Authenticode
signature for the modified native engine.

Do not run a downloaded script through `Invoke-Expression` or a remote
shell pipe. Run the checked local file normally.

## Windows desktop setup

The ZIP contains the desktop .NET runtime and compiled native engine, but
does not contain Node.js or PowerShell 7. On a clean Windows machine, use
the verified local installer before opening the desktop:

```powershell
powershell -NoProfile -File .\install.ps1 -RuntimeOnly
$installed = powershell -NoProfile -File .\install.ps1 -RuntimeOnly -Apply | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $installed.status -ne 'ready') { throw 'Setup did not complete; inspect its result before continuing.' }
$desktop = Join-Path $installed.toolkitRoot 'app\HuaiDJ.DiskToolkit.exe'
& $desktop --toolkit-root $installed.toolkitRoot --node-path $installed.nodePath
```

Use `-InstallRoot <chosen-folder>` on both installer calls to select a
different per-user destination. This setup does not register a client,
change system PATH, request elevation or write USB media. Opening the
application is a separate action; the installer does not launch it.
If compatible Node.js 22.15+ and PowerShell 7 are already available, the
complete extracted Windows ZIP can also be used directly.

## Preview, then apply the requested client setup

The Windows entry point runs in Windows PowerShell 5.1 and needs no admin
installer. For a Codex example:

```powershell
powershell -NoProfile -File .\install.ps1 -Flavor Mcp -Client codex
powershell -NoProfile -File .\install.ps1 -Flavor Mcp -Client codex -Apply
```

Use the actual client ID: `codex`, `claude-code`, `claude-desktop`, `gemini`,
`opencode` or `vscode`. The default invocation previews changes. Apply uses
verified backups and compare-and-swap; it preserves unrelated settings and
refuses conflicting existing entries.

For macOS/Linux, run the saved local file with the same supported client:

```sh
bash ./bootstrap.sh --flavor Mcp --client codex
bash ./bootstrap.sh --flavor Mcp --client codex --apply
```

These hosts support reference/query and stdio in this release, not physical
disk writes. For an unrecognized client, use `-RuntimeOnly -Apply` or
`--runtime-only --apply` and obtain the verified runtime paths before
preparing a client-specific configuration.

The installer returns the installed toolkit, Node.js and CLI paths. Use
those results; do not guess a user-data location. The stdio shape is:

```text
<returned-node-path> <returned-cli-path> mcp
```

No API key or network listener is needed by this local MCP server. Missing
dependencies are downloaded from the fixed official sources/pins; no
system PATH, UAC, trust or auto-approval settings are changed. Running apps
and existing chats are not forcibly restarted.

## Verify the actual client

Confirm tool discovery through the client's real MCP interface, then make
one read-only call such as `list_dj_models` with `query: CDJ`. A CLI config
listing proves only configuration recognition. An isolated SDK handshake
does not prove that this client or an existing chat has loaded the tools.

If the host cannot hot-reload, report that a reconnect, new chat or later
user-controlled reload is required. Keep connection status separate from
runtime installation, GUI acceptance and physical-disk acceptance. Report
only the necessary status/tool names, not private settings or credentials.
