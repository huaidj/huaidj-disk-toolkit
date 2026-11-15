# Building the native engine

The original toolkit and the Rufus-derived native engine are GPL-3.0-or-later.
The native executable is built from a pinned Rufus revision plus the HuaiDJ
patch. `patches/native-engine.json` identifies the sealed source and binary
used for the local build record.

Development prerequisites:

- Node.js 22 or later and npm for the CLI/MCP bridge.
- PowerShell 7 on Windows for the backend and build wrapper.
- Python 3.11+ and Git for source/release staging.
- Visual Studio Build Tools with C++ MSVC v143 and a Windows SDK for the
  validated x64 native build route.

Install the bridge dependencies and run offline tests:

```powershell
npm ci --ignore-scripts
Copy-Item config.example.json config.json
npm test
```

Edit the local configuration deliberately. Do not overwrite an existing
configuration with the example. The example contains no private image
locations or credentials.

In a public source package, `sources/rufus/` is the complete patched native
source/build-input tree. Build it without downloading a moving upstream
branch:

```powershell
pwsh -File scripts/build-native.ps1 -SourceRoot sources/rufus -OutputDirectory dist/native -PlatformToolset v143
```

The wrapper uses this argument structure in the native source directory:

```text
MSBuild.exe rufus.sln /m /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v143 /p:OutDir=<output-directory>/ /fl /flp:logfile=<build-log>;verbosity=normal /nologo /v:quiet
```

For this build process only, the wrapper also sets compiler options
`/utf-8 /experimental:deterministic /pathmap:<source-root>=.` and linker
option `/PDBALTPATH:%_PDB%`. The compiler's deterministic option is required
for `/pathmap` to take effect with the tested MSVC toolset. Previous
compiler/linker and temporary-directory environment values are restored
after the build. Use `-Rebuild` after changing compiler options.

The result is `dist/native/rufus.exe`. A developer may copy a reviewed build
to `bin/rufus-huaidj.exe` for the bridge, then update the build manifest after
checking its actual identity. The public packaging script refuses to
include a binary whose SHA-256 differs from the sealed manifest.

A clean build from the exported source tree completed locally with
MSBuild/MSVC v143. The packaged expanded engine passed a scan for the
developer's project/home paths and is bound to its complete source and
patch in the manifests. Its hardware acceptance remains NOT_RUN; the
accepted Zorin receipt refers to the separately preserved baseline engine.
A fresh-checkout CI build and the optional MinGW route are separate checks. Exact binary-byte
reproducibility across toolchain versions or timestamps is not claimed.

The native CI workflow builds the disk engine without executing it, then
runs the standalone non-storage tests. It never formats a runner disk,
writes a USB device, changes boot configuration or accepts a UAC prompt.

The pure native option parser has a separate ordinary-user test executable:

```powershell
pwsh -File scripts/run-native-options-tests.ps1 -SourceRoot sources/rufus -OutputDirectory dist/native-option-tests
```

This executable contains only the option module and its contract tests. It
does not link the Rufus UI, device inspection or formatting implementation.
