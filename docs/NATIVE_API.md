# Restricted native automation contract

The modified native executable calls the original Rufus formatting and
image-writing engine. It retains a hidden dialog/message loop. It is not a
GUI launcher presented as a completed operation, nor a replacement for every
advanced setting in the graphical Rufus application.

Every operation identifies a physical USB by number, serial and exact byte
capacity, checks protected volumes, and uses a per-device mutex. The actual
write handle is checked again inside the original write path. Internal,
system and protected Windows/boot/recovery media remain refused.

An ordinary Windows installer USB may contain an installer BCD. That alone
is not treated as the active system: it is eligible only when the actual
active boot volume has been resolved to another disk and the target
volume's device identity is known. Unknown boot identity stays refused;
a complete Windows SYSTEM hive, active boot media, reserved/recovery
partitions and the other protections are not exempted.

## Base arguments

```text
--huaidj-device <physical-number>
--huaidj-serial <exact-storage-serial>
--huaidj-size <exact-capacity-bytes>
--huaidj-status <local-status-json>
--huaidj-dry-run
```

An actual destructive operation omits `--huaidj-dry-run` and requires the
exact `--huaidj-confirm ERASE:<physical-number>:<capacity-bytes>` value.
Unknown, missing or duplicate arguments are rejected. A dry run performs
the image/format configuration, original boot/pre-write checks and target
checks, then returns before the format thread is created. It does not prove
that a later write, filesystem read-back or firmware boot will succeed.

## Image operation

```text
--huaidj-operation image
--huaidj-image <local-iso-or-disk-image>
--huaidj-sha256 <64-hex-digit-source-hash>
--huaidj-mode dd|iso
```

`image` is the backward-compatible operation default. An actual image write
requires a hash. The same source handle remains locked against modification
while hashing and writing; final paths and source/status aliases are
checked. Source and status files cannot be on the target USB.

DD mode writes the image's own layout. Custom filesystem, partition,
target-system, cluster, label and quick-format choices are not applicable.
Do not emit a quick-format argument for DD, even if its value is `true`.

ISO extraction supports the standard Windows installation choice and the
original supported Linux ISO workflow. Windows customization is disabled:
no additional WUE answer file, account/locale/privacy changes, TPM or Secure
Boot bypass, BitLocker modification or Windows To Go selection is applied.
Customizations already contained in the selected ISO are not rewritten.
Known revoked bootloaders and unexpected prompts stop the operation.
Additional bootloader downloads or other interactive workflows are not
automatically approved.

## Format-only operation

```text
--huaidj-operation format
--huaidj-filesystem fat32|ntfs|exfat
```

This selects the original non-bootable formatting engine. There is no source
image and no source hash: `image`, `sha256` and image-write `mode` arguments
are rejected. No fake image or hash is generated. Target-system must be
`auto`; the effective result is `non-bootable`.

Large FAT32 uses Rufus's existing large-volume FAT32 engine. That route
supports quick formatting only; an explicit full-format request is
rejected. Availability and cluster choices remain bounded by the original
Rufus engine and device geometry.

## Formatting options

| Argument | Values |
| --- | --- |
| `--huaidj-filesystem` | `auto`, `fat32`, `ntfs`, `exfat`; format-only requires an explicit filesystem |
| `--huaidj-partition-scheme` | `auto`, `mbr`, `gpt`; MBR above 2 TiB is refused |
| `--huaidj-target-system` | `auto`, `bios`, `uefi`; format-only accepts `auto` |
| `--huaidj-cluster-size` | `auto` or an unsigned power-of-two byte count present in Rufus's allowed choices |
| `--huaidj-volume-label` | FAT32: up to 11 ASCII characters, normalized to uppercase; exFAT: 15 UTF-16 units; NTFS: 32 UTF-16 units |
| `--huaidj-quick-format` | Exact `true` or `false`; defaults to `true` |

All explicit labels must fit the native 63-byte UTF-8 format buffer.
Reserved/control characters and incompatible choices are refused rather
than truncated or silently substituted. The `bios` target corresponds to
the original Rufus BIOS-compatible selection, which can also include UEFI
files for an image that supports both boot modes.

## Status

The JSON status includes `operation`, `sourceBytes`, `sourceSha256` and
`effectiveOptions`. Before the options are validated, `effectiveOptions`
is `null`. Format-only reports `sourceBytes: 0` and `sourceSha256: null`.
Its `bytesTotal` is the target capacity, not an invented source length.

Effective formatting options use `filesystem`, `partitionScheme`,
`targetSystem`, `clusterSize`, `volumeLabel`, `quickFormat`, `largeFat32` and
`windowsCustomization`. DD reports `image-defined` layout fields and null
formatting values. The effective controls are checked again before erase.

## Validation status

The expanded native candidate has compiled with MSVC v143 and passed the
standalone parser/contract tests. Those tests run as an ordinary user and
link no storage or Rufus UI implementation. Candidate production execution,
Windows ISO dry-run, large FAT32 media formatting, write/read-back and boot
acceptance are recorded separately in the native manifest; unrun stages
remain `NOT_RUN`. The previously accepted DD engine remains a separate
rollback baseline until explicit candidate acceptance.
