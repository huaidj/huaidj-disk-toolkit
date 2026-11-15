/* HuaiDJ native option contract. GPL-3.0-or-later.
 * Pure parsing/validation: this module has no Windows, storage or UI APIs.
 */
#include "huaidj_options.h"
#include <string.h>
#include <limits.h>

void HuaidjInitOptions(huaidj_options_t* o)
{
    memset(o, 0, sizeof(*o));
    o->filesystem = HJ_FS_AUTO;
    o->partition_scheme = HJ_PT_AUTO;
    o->target_system = HJ_TARGET_AUTO;
    o->quick_format = 1;
}

static int Choice(const wchar_t* value, const wchar_t* const* choices, int count)
{
    for (int i = 0; i < count; ++i) if (wcscmp(value, choices[i]) == 0) return i;
    return -1;
}

int HuaidjParseExtraOption(huaidj_options_t* o, const wchar_t* flag, const wchar_t* value, const char** error)
{
    static const wchar_t* const flags[] = { L"--huaidj-operation", L"--huaidj-filesystem", L"--huaidj-partition-scheme", L"--huaidj-target-system", L"--huaidj-cluster-size", L"--huaidj-volume-label", L"--huaidj-quick-format" };
    static const wchar_t* const operations[] = { L"image", L"format" };
    static const wchar_t* const filesystems[] = { L"auto", L"fat32", L"ntfs", L"exfat" };
    static const wchar_t* const partitions[] = { L"auto", L"mbr", L"gpt" };
    static const wchar_t* const targets[] = { L"auto", L"bios", L"uefi" };
    int index = Choice(flag, flags, 7), selected;
    *error = NULL;
    if (index < 0) return 0;
    if (!value || (o->present & (1U << index))) {
        *error = "Missing or duplicate native option";
        return -1;
    }
    o->present |= 1U << index;
    switch (index) {
    case 0:
        selected = Choice(value, operations, 2);
        if (selected >= 0) { o->format_only = selected; return 1; }
        break;
    case 1:
        selected = Choice(value, filesystems, 4);
        if (selected >= 0) { o->filesystem = selected - 1; return 1; }
        break;
    case 2:
        selected = Choice(value, partitions, 3);
        if (selected >= 0) { o->partition_scheme = selected - 1; return 1; }
        break;
    case 3:
        selected = Choice(value, targets, 3);
        if (selected >= 0) { o->target_system = selected - 1; return 1; }
        break;
    case 4: {
        if (wcscmp(value, L"auto") == 0) { o->cluster_size = 0; return 1; }
        uint64_t size = 0;
        if (!*value) break;
        for (const wchar_t* p = value; *p; ++p) {
            if (*p < L'0' || *p > L'9' || size > UINT32_MAX / 10U) { *error = "Cluster size must be an unsigned byte count"; return -1; }
            size = size * 10 + (*p - L'0');
        }
        if (size < 512 || size > 32 * 1024 * 1024 || (size & (size - 1))) break;
        o->cluster_size = (uint32_t)size;
        return 1;
    }
    case 5:
        if (wcslen(value) > 32) { *error = "Volume label exceeds 32 UTF-16 code units"; return -1; }
        for (const wchar_t* p = value; *p; ++p) if (*p < 32 || *p == 127 || wcschr(L"\\/:*?\"<>|", *p)) {
            *error = "Volume label contains a reserved or control character";
            return -1;
        }
        wmemcpy(o->volume_label, value, wcslen(value) + 1);
        o->has_label = 1;
        return 1;
    case 6:
        if (wcscmp(value, L"true") == 0) { o->quick_format = 1; return 1; }
        if (wcscmp(value, L"false") == 0) { o->quick_format = 0; return 1; }
        break;
    }
    *error = "Invalid native option value";
    return -1;
}

const char* HuaidjValidateExtraOptions(const huaidj_options_t* o, int has_image, int has_sha, int dd_mode)
{
    if (o->format_only) {
        if (has_image || has_sha) return "Format-only does not accept a source image or source hash";
        if (o->filesystem == HJ_FS_AUTO) return "Format-only requires an explicit filesystem";
        if (o->target_system != HJ_TARGET_AUTO) return "Non-bootable formatting requires target-system auto";
    } else {
        if (!has_image) return "Image operation requires a source image";
        if (dd_mode && (o->filesystem != HJ_FS_AUTO || o->partition_scheme != HJ_PT_AUTO || o->target_system != HJ_TARGET_AUTO || o->cluster_size || o->has_label || (o->present & (1U << 6))))
            return "DD writes preserve the source layout and do not accept formatting options";
    }
    return NULL;
}

const char* HuaidjValidateLabel(const wchar_t* label, int filesystem)
{
    size_t length = wcslen(label);
    if (filesystem == HJ_FS_FAT32) {
        if (length > 11) return "FAT32 volume labels are limited to 11 ASCII characters";
        for (const wchar_t* p = label; *p; ++p) if (*p >= 128 || wcschr(L".,;+=[]", *p))
            return "FAT32 label contains unsupported non-ASCII or reserved characters";
    } else if (filesystem == HJ_FS_EXFAT) {
        if (length > 15) return "exFAT volume labels are limited to 15 UTF-16 code units";
    } else if (length > 32) return "NTFS volume labels are limited to 32 UTF-16 code units";
    return NULL;
}

int HuaidjInstallerBcdIsNonSystem(int has_boot_registry, int boot_resolved_off_target, int target_volume_mapped, int target_is_boot)
{
    return has_boot_registry && boot_resolved_off_target && target_volume_mapped && !target_is_boot;
}
