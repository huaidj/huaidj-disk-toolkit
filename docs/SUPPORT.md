# Support and validation boundaries

HuaiDJ Disk Toolkit is an independent project. The native engine is based
on Rufus; this is not an official Rufus release.

The Windows bridge exposes only the commands and MCP tools implemented in
the published version. It does not automatically expose every feature in
the Rufus graphical application. Use CLI help, the tool schemas and the
version's feature table as the supported contract.

Disk enumeration, image inspection, offline unit tests, native build,
native dry run, destructive media write, independent media read-back,
firmware boot and operating-system installation are separate validation
stages. Record each as `PASS`, `FAIL` or `NOT_RUN` for the specific version
and target. A process-start receipt is not a completed-write receipt.

The MCP server uses local standard input/output, requires no API key, and
does not open a network listener. Individual agents may require a restart,
reconnection, workspace trust or their ordinary tool approval before using
a newly registered local server. Registration alone is not runtime
acceptance. The toolkit does not change an agent's approval or trust mode.

Windows elevation can require a visible UAC interaction. Preparing a USB
does not install Linux on an internal disk; a native dual-boot installation
still needs the computer's boot and installer workflow.

When reporting a problem, include the toolkit version, operation, final
status and a redacted error. Remove personal paths, disk serial numbers,
usernames, machine names, credentials and unrelated agent configuration.
Do not upload operating-system images or private registration backups.
