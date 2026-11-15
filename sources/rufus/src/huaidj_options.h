/* HuaiDJ native option contract. GPL-3.0-or-later. */
#pragma once
#include <stdint.h>
#include <wchar.h>

enum { HJ_FS_AUTO = -1, HJ_FS_FAT32, HJ_FS_NTFS, HJ_FS_EXFAT };
enum { HJ_PT_AUTO = -1, HJ_PT_MBR, HJ_PT_GPT };
enum { HJ_TARGET_AUTO = -1, HJ_TARGET_BIOS, HJ_TARGET_UEFI };
typedef struct {
    int format_only, filesystem, partition_scheme, target_system, quick_format;
    uint32_t cluster_size, present;
    int has_label;
    wchar_t volume_label[33];
} huaidj_options_t;

void HuaidjInitOptions(huaidj_options_t* options);
/* 1 = recognized; 0 = not an extra option; -1 = rejected. */
int HuaidjParseExtraOption(huaidj_options_t* options, const wchar_t* flag, const wchar_t* value, const char** error);
const char* HuaidjValidateExtraOptions(const huaidj_options_t* options, int has_image, int has_sha, int dd_mode);
const char* HuaidjValidateLabel(const wchar_t* label, int filesystem);
/* Installer BCD alone is not an OS; all active-boot identity proofs are required. */
int HuaidjInstallerBcdIsNonSystem(int has_boot_registry, int boot_resolved_off_target, int target_volume_mapped, int target_is_boot);
