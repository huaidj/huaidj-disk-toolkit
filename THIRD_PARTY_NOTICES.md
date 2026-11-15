# Third-party notices

HuaiDJ Disk Toolkit is released under GPL-3.0-or-later. It includes
third-party components whose original copyright and license notices remain
applicable.

| Component | Terms | Source and notices |
| --- | --- | --- |
| Original HuaiDJ bridge, CLI/MCP interfaces, PowerShell backend, skills and project documentation | GPL-3.0-or-later | Root `LICENSE`; copyright 2026 HuaiDJ contributors |
| Rufus and the HuaiDJ native adapter derived from Rufus | GPL-3.0-or-later; component notices remain applicable | [Rufus upstream](https://github.com/pbatard/rufus), `patches/native-adapter.patch`, generated `sources/rufus/`, and `docs/licenses/GPL-3.0.txt` |
| Model Context Protocol TypeScript SDK | MIT | Copyright 2024 Anthropic, PBC; [source](https://github.com/modelcontextprotocol/typescript-sdk); installed package `LICENSE` |
| Zod | MIT | Copyright 2025 Colin McDonnell; [source](https://github.com/colinhacks/zod); installed package `LICENSE` |
| jsonc-parser | MIT | [Microsoft source](https://github.com/microsoft/node-jsonc-parser); installed package license and notices |
| smol-toml | BSD-3-Clause | [Source](https://github.com/squirrelchat/smol-toml); installed package `LICENSE` |
| Microsoft.NETCore.App.Runtime.win-x64 and Microsoft.WindowsDesktop.App.Runtime.win-x64 10.0.10, when included with the self-contained desktop app | MIT and preserved third-party notices | Exact runtime-pack license files are in `docs/licenses/` and the desktop distribution's `licenses/`; [upstream source](https://github.com/dotnet/dotnet/tree/f7d90799ce4ef09a0bb257852a57248d2a8fb8dd) |
| Other npm dependencies | Their individual package licenses | Versions are pinned by `package-lock.json`; installation preserves each package's notices |

Rufus includes additional third-party code, boot components, and resources.
Their original copyright and license notices are preserved in the complete
Rufus source tree. Consult those notices when modifying or redistributing a
component separately. This notice does not replace them.

The MIT notices above remain intact for the respective third-party source;
the toolkit's GPL license does not claim ownership of those components.
Node.js, PowerShell, Windows SDK/MSVC build tools, operating-system images,
and user-selected disk images are not relicensed by HuaiDJ. Local development
runtimes and operating-system images are excluded from the public source
package. The Windows software package can include the unmodified self-contained
.NET desktop runtime with its own MIT licenses and notices; those components
are not relicensed as HuaiDJ code.

The HuaiDJ native executable is a modified build, not an official Rufus
release or an upstream-signed binary. No upstream endorsement is implied.

A binary distribution of the modified native engine must include its exact
Corresponding Source, build instructions, applicable notices, GPL text, and
source/binary hashes. `scripts/prepare-public.py --include-native-binary`
creates that source bundle and refuses an out-of-date native patch. See
[the distribution procedure](docs/DISTRIBUTION.md).
