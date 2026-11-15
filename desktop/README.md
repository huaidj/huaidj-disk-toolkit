# HuaiDJ Disk Toolkit desktop

This native WinForms frontend targets .NET 10 and shares the toolkit CLI. It is an `asInvoker` application: startup, inventory, recommendations and metadata listing do not request elevation. A destructive operation first displays an exact-target review and then calls the existing core. Native Windows operations may separately require normal UAC approval.

Build from the repository with a .NET 10 SDK:

```powershell
./desktop/build.ps1
./desktop/build.ps1 -SelfContained
```

Outputs are `work/desktop-build/framework-dependent` and `work/desktop-build/self-contained`. The self-contained folder must remain complete. It still needs the toolkit core and its Node/PowerShell dependencies; the one-click installer supplies those separately. Release builds omit PDBs and map source paths to `/src`.

Development launch arguments:

```text
HuaiDJ.DiskToolkit.exe --toolkit-root <absolute toolkit folder> [--node-path <node.exe>]
```

Installed launches can locate an adjacent/ancestor toolkit or installation receipt. The installer can explicitly pass the recorded `toolkitRoot` and `nodePath` for deterministic startup. The application never automatically downloads runtimes or weakens UAC.

The UI offers Traditional Chinese and English, USB identity-bound preview/execute flows, rule-based DJ/media recommendations, boot image inspection/write/readback, versioned export-library snapshots and controlled restoration. Snapshot listings remain summaries; restore preview performs the full core validation. Changing target or inputs invalidates old reviews. A submitted job is not killed by closing the window; its ID is retained locally for status polling.

The actual Windows GUI has partial acceptance for startup, its observed Chinese layout, recommendation constraints, input invalidation and the unconfirmed format review. See `tests/acceptance/desktop-windows-partial.json`. The user stopped further interaction; preview cancellation was not confirmed. Remaining tabs/languages, multi-DPI, keyboard and desktop write/restore acceptance are still NOT_RUN. Ordinary compilation is not GUI acceptance. No destructive GUI action is performed by the build script.
