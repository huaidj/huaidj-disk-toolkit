# Preparing public source, Windows and Skill packages

Only a reviewed staging directory is published. Do not push the working
directory or use an unrestricted recursive ZIP of a developer checkout.

From the project root, with Python 3.11+ and Git available:

```powershell
python scripts/prepare-public.py --destination ./dist/public-source
```

The destination must be new and empty. The script does not remove an
existing directory, publish a repository, upload a file, or use account
credentials.

Source staging includes the original desktop and installer sources, but
omits their `bin/`, `obj/`, cache, PDB, log and build-artifact directories.
The complete tracked Rufus source is exported separately, so its required
`.vs` build projects remain included.

For a native binary package:

```powershell
python scripts/prepare-public.py --destination ./dist/public-native --include-native-binary
```

This includes `bin/rufus-huaidj.exe` only when the complete matching native
source can be prepared. It exports the pinned upstream Git revision into
`sources/rufus/`, applies `patches/native-adapter.patch`, and checks the
result against the current native source. No upstream `.git` directory is
copied. Complete native source and license text accompany the executable.

The generated `sources/native-source-manifest.json` records the upstream
repository, commit, patch hash, source inventory hash, and optional binary
hash. `PUBLIC-MANIFEST.json` records the files in the staging directory.
Inspect both before publishing. A manifest is an identity record, not a
claim of completed hardware or boot acceptance.

Staging includes a root `.gitattributes` that disables automatic text
conversion. This preserves source/license bytes and the recorded hashes
when the public repository is cloned on another platform. Upstream's own
attribute and build files remain present in the native source tree.

## Files excluded from publication

The allowlist excludes local `config.json`, `CONTROL.md`, `work/`, `state/`,
`runtime/`, `node_modules/`, Git metadata, operating-system ISOs, user disk
images, agent settings and registration backups. Machine-specific agent
registration scripts are not exported by default. `config.example.json`
contains neutral defaults and no local image aliases or private paths.

Public-code directories are scanned for known developer-local paths and
private configuration filenames. A failure stops package preparation; fix
the source or the allowlist and create a new staging directory.

The scanner obtains developer paths at runtime from the checkout and home
directory, and detects literal user-profile paths without publishing a
developer account or personal drive layout in the scanner. C#, project,
application-manifest and resource text is checked as well as CLI/MCP code.

## Build the fixed release assets

The release builder reads the sealed version, tag and repository from
`installers/release-manifest.schema.json` and the pinned dependencies from
`installers/dependencies.json`. It refuses a package-version mismatch.

For a preview while the desktop publish is not ready:

```powershell
python scripts/build-release.py --destination ./dist/release-preview --source-only
```

This creates source and Skill ZIPs, standalone installer assets,
`release-manifest.preview.json` and `SHA256SUMS`. The preview deliberately
does not have the final installer manifest filename and must not be
published as a complete Windows release.

For the complete candidate:

```powershell
python scripts/build-release.py --destination ./dist/release-candidate --app-folder ./path-to-final-self-contained-publish
```

The Windows desktop folder must contain the owned executable and managed
assembly, `deps`/`runtimeconfig` files, the x64 CLR host and Windows Forms
runtime. Framework-dependent output and empty executable placeholders are
refused. The owned EXE/DLL are scanned for developer-local paths. Runtime
licenses and third-party notices must be retained in the publish folder;
`--app-license-file <file>` may be repeated for additional exact notice
files. The verified .NET runtime and Windows Desktop MIT notices are
accepted under their explicit runtime-notice filenames.

The desktop .NET runtime is self-contained. Node.js/PowerShell and npm
dependencies are provisioned by the audited bootstrap contract; their
presence in a working developer environment does not mean they are bundled
in these ZIPs.

The output includes:

- `huaidj-disk-toolkit-v0.1.0-source.zip`: flat CLI/MCP/desktop/installer
  source root, licensing and complete patched Rufus source; no local runtime
  or native executable.
- `huaidj-disk-toolkit-v0.1.0-windows-x64.zip`: the same flat core/source
  layout, the hash-matched native executable, and the self-contained
  desktop under `app/`, including its runtime DLLs and notices.
- `huaidj-disk-toolkit-v0.1.0-skill.zip`: one top-level
  `huaidj-disk-toolkit/` folder containing `SKILL.md`, `LICENSE`, references,
  scripts and agent metadata. It contains neither core `src/` nor
  `node_modules/`.
- Unchanged `install.ps1` and `bootstrap.sh` assets, copied from the exact
  source snapshot used for the ZIPs. Skill bootstrap bytes must match them.
- `release-manifest.json`: an assets **array**, archive-root declarations,
  exact asset hashes and sealed dependency pins.
- `SHA256SUMS`: hashes for the package/installer assets and the separate
  manifest. Neither the manifest's asset array nor the checksum file hashes
  itself, avoiding a self-hash cycle.

ZIP file paths include dotfiles such as `.github` and `.gitignore`.
All ZIP entry timestamps use the builder's actual UTC creation instant,
recorded as `normalizedUTC` in the release manifest. Local source-file
modification times are not embedded; ZIP's timestamp precision still
applies. No pre-existing destination is removed
or overwritten. Staging directories and `BUILD-RESULT.json` remain local
review evidence; publish only the reviewed asset files.

The builder does not launch the desktop or native engine. GUI and physical
media acceptance remain separately recorded; a successfully built package
does not turn `NOT_RUN` into `PASS`.

Run the offline packaging-contract checks with:

```powershell
python -m unittest discover -s tests -p test_release_builder.py
```

## Release acceptance

Before publishing a native release, record the actual commit, patch and
binary hashes, successful build and offline test results, hardware test
results, and remaining `NOT_RUN` items. A successful build or an MCP
handshake does not establish that media was written correctly, boots on a
computer, or installs an operating system successfully.

Do not describe Windows installer customization, Windows To Go, persistence,
bad-block testing, unsupported filesystems or any other upstream Rufus
feature as available through this bridge unless the published interface
implements and validates it.
