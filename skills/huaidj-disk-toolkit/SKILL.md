---
name: huaidj-disk-toolkit
license: GPL-3.0-or-later
description: Prepare USB boot media, format selected USB volumes, compare Windows/macOS/DJ-player media requirements, and preserve rekordbox USB export libraries through HuaiDJ CLI or MCP. Use for disk and USB preparation or exported-library recovery planning, not audio conversion or playlist curation.
---

# HuaiDJ Disk Toolkit

Use the installed MCP tools or `huaidj-disk` CLI. The skill and MCP package share one core.

1. If the CLI is missing, run bundled `scripts/bootstrap.ps1 -Flavor Skill -RuntimeOnly -Apply` on Windows, or `bash scripts/bootstrap.sh --flavor Skill --runtime-only --apply` on macOS/Linux. The bootstrap downloads a fixed release and missing official dependencies with SHA-256 verification. Use its returned CLI command/path; do not guess an install location.
2. Start with `--help` and `capabilities`. macOS/Linux support reference queries; physical disk operations in this release use the Windows adapter.
3. Read [the relevant workflow](references/workflows.md) before a disk write, snapshot or restore. Use current hardware identity and exact-target plans; reuse valid authorization for the same physical target and scope.
4. Query sourced compatibility before choosing a DJ preset. Unknown firmware, library state or audio properties remain unknown. A matching hash, booting an OS and DJ-player playback are separate outcomes.

The bootstrap installs dependencies and the CLI only unless registration is explicitly requested. It does not format media. Never reduce UAC or approval settings to avoid prompts; prepare necessary checks first and avoid repeating completed privileged tests.

