# Architecture and upstream choices

The Node.js CLI and local stdio MCP server call the same application functions. Disk operations use a fixed Windows backend and exact-target plans; compatibility queries use versioned, manufacturer-sourced JSON. The skill guides an agent through those interfaces and does not add execution permission.

## Components

| Component | Responsibility |
| --- | --- |
| `src/cli.mjs`, `src/server.mjs` | CLI parsing and narrowly scoped MCP tools |
| `src/core.mjs`, `src/locks.mjs` | Image plans, device identity, expiring confirmation, cross-process ownership and job state |
| `src/images.mjs` | Local image-root checks, image signatures and SHA-256 |
| `src/windows-backend.ps1` | Windows USB inventory, physical identity and fixed native launch |
| `src/disks.mjs`, `src/disk-backend.ps1` | Format/repartition plans and independent physical-prefix verification |
| Rufus native adapter | Original Rufus image scanning, boot-media formatting and image-writing engine |
| `src/compatibility.mjs`, `src/data/` | OS/player filesystem support, audio constraints, library types, firmware conditions and version advisories |
| `src/export-libraries.mjs` | Export-metadata inspection, versioned verified snapshots and controlled same-media restoration |

Each writable USB job owns both a cross-process application reservation and a native Windows per-device mutex. A late response or timed-out privileged submission is an **unknown result**, not a safe failure: the reservation remains until the final status resolves it. Existing metadata is preserved during snapshot restoration; unexpected nodes or changes stop the operation.

## Why Rufus and GPL

[Rufus](https://github.com/pbatard/rufus) supplies a mature Windows boot-media engine under GPL-3.0-or-later. The adapter keeps its original write paths and explicitly identifies the build as a derivative. The toolkit's main license is also GPL-3.0-or-later; component notices are retained. GPL permits commercial distribution while placing source and license obligations on distribution. See [licensing](LICENSING.md).

There are lower-level permissive alternatives, but they solve different portions of this project:

| Project | License | Relevant capability and boundary |
| --- | --- | --- |
| [DiscUtils](https://github.com/DiscUtils/DiscUtils) | MIT | Managed disk-image/virtual-disk and filesystem libraries, including FAT/NTFS functionality. It is not a complete replacement for Rufus's Windows boot-media workflows. |
| [Etcher SDK](https://github.com/balena-io-modules/etcher-sdk) | Apache-2.0 | Block-device image-writing components. Image flashing is different from general filesystem formatting or preparing every Windows installer ISO. |

These projects were researched as alternatives; they are not bundled dependencies of this release. The choice avoids rewriting a mature physical-disk engine solely to obtain a different license.

## Database boundaries

The compatibility reference distinguishes a desktop main library from an exported Device Library and OneLibrary. Manufacturer documents do not establish an open PDB/SQLite interchange specification for every file, so the toolkit does not invent one. Candidate filenames are presence evidence, not a full integrity verdict.

Snapshots preserve complete export metadata and sidecars. Music is excluded; optional analysis backup is preservation-only in this version. Restore is limited to the same identified Windows USB or an owned isolated test fixture and restores `PIONEER/rekordbox` metadata only. No live desktop `master.db` or SQLCipher key is opened.

## Acceptance boundaries

Reference queries are distinct from this host's executable adapter capabilities. Native Windows disk operations, source-only cross-platform queries, physical image readback, live OS boot, and DJ-player playback have separate acceptance records. Tests on an owned VHD are not physical USB or CDJ acceptance. See [support](SUPPORT.md) and `tests/acceptance/`.
