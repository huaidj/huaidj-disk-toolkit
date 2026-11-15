/*
 * HuaiDJ local automation adapter for the original Rufus engine.
 * GPL-3.0-or-later. This is a local derivative, not an official Rufus build.
 * No disk writes are implemented here: Rufus retains its original write paths.
 */
#include <windows.h>
#include <winioctl.h>
#include <wincrypt.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "rufus.h"
#include "msapi_utf8.h"
#include "huaidj_autopilot.h"

BOOL huaidj_automation = FALSE;
BOOL huaidj_dry_run = FALSE;
BOOL huaidj_dd_mode = TRUE;
DWORD huaidj_device_number = MAXDWORD;
huaidj_options_t huaidj_options;
static uint64_t expected_size;
static uint64_t source_bytes;
static char expected_serial[1024];
static char expected_sha256[65];
static wchar_t status_path[MAX_PATH], source_path[MAX_PATH];
static HANDLE source_lock = INVALID_HANDLE_VALUE;
static HANDLE device_mutex;
static SRWLOCK status_lock = SRWLOCK_INIT;
static BOOL final_status, failed;
static DWORD failure_code;
static char failure_message[2048];
static char current_phase[64] = "validating";
static double current_progress;
static BOOL effective_ready, effective_quick, effective_large;
static int effective_fs, effective_partition, effective_target;
static DWORD effective_cluster;
static char effective_label[256];

static const char* FsName(int fs)
{
    switch (fs) { case FS_FAT16: return "fat16"; case FS_FAT32: return "fat32"; case FS_NTFS: return "ntfs"; case FS_EXFAT: return "exfat"; default: return "other"; }
}

static void JsonEscape(const char* input, char* output, size_t capacity)
{
    size_t used = 0;
    const unsigned char* p = (const unsigned char*)input;
    if (p == NULL) p = (const unsigned char*)"";
    while (*p && used + 7 < capacity) {
        unsigned char c = *p++;
        if (c == '"' || c == '\\') { output[used++] = '\\'; output[used++] = c; }
        else if (c < 32) { used += sprintf_s(output + used, capacity - used, "\\u%04x", c); }
        else output[used++] = c;
    }
    output[used] = 0;
}

/* Caller holds the lock. A status write failure permanently blocks writing. */
static BOOL WriteStatus(BOOL success, const char* message)
{
    wchar_t temporary[MAX_PATH];
    char text[32768], escaped_message[12288], escaped_error[12288], escaped_label[2048], options_json[4096], hash_json[68];
    HANDLE file;
    DWORD bytes, count;
    int length;
    if (!status_path[0]) return FALSE;
    JsonEscape(message, escaped_message, sizeof(escaped_message));
    JsonEscape(failed ? failure_message : "", escaped_error, sizeof(escaped_error));
    strcpy_s(options_json, sizeof(options_json), "null");
    strcpy_s(hash_json, sizeof(hash_json), "null");
    if (!huaidj_options.format_only && expected_sha256[0]) sprintf_s(hash_json, sizeof(hash_json), "\"%s\"", expected_sha256);
    if (effective_ready) {
        JsonEscape(effective_label, escaped_label, sizeof(escaped_label));
        if (!huaidj_options.format_only && huaidj_dd_mode)
            strcpy_s(options_json, sizeof(options_json), "{\"filesystem\":\"image-defined\",\"partitionScheme\":\"image-defined\",\"targetSystem\":\"image-defined\",\"clusterSize\":null,\"volumeLabel\":null,\"quickFormat\":null,\"windowsCustomization\":\"none\"}");
        else sprintf_s(options_json, sizeof(options_json),
            "{\"filesystem\":\"%s\",\"partitionScheme\":\"%s\",\"targetSystem\":\"%s\",\"clusterSize\":%lu,\"volumeLabel\":\"%s\",\"quickFormat\":%s,\"largeFat32\":%s,\"windowsCustomization\":\"none\"}",
            FsName(effective_fs), effective_partition == PARTITION_STYLE_GPT ? "gpt" : "mbr",
            huaidj_options.format_only ? "non-bootable" : (effective_target == TT_UEFI ? "uefi" : "bios"),
            effective_cluster, escaped_label, effective_quick ? "true" : "false", effective_large ? "true" : "false");
    }
    length = sprintf_s(text, sizeof(text),
        "{\"phase\":\"%s\",\"progress\":%.3f,\"message\":\"%s\",\"error\":%s%s%s,"
        "\"success\":%s,\"final\":%s,\"deviceNumber\":%lu,\"bytesTotal\":%llu,"
        "\"errorCode\":%lu,\"engine\":\"Rufus HuaiDJ local autopilot\",\"dryRun\":%s,"
        "\"operation\":\"%s\",\"sourceBytes\":%llu,\"sourceSha256\":%s,\"effectiveOptions\":%s}\n",
        current_phase, current_progress, escaped_message, failed ? "\"" : "", failed ? escaped_error : "null", failed ? "\"" : "",
        success ? "true" : "false", final_status ? "true" : "false", huaidj_device_number,
        (unsigned long long)(huaidj_options.format_only ? expected_size : source_bytes), failure_code, huaidj_dry_run ? "true" : "false",
        huaidj_options.format_only ? "format" : "image", (unsigned long long)source_bytes, hash_json, options_json);
    if (length <= 0 || swprintf_s(temporary, MAX_PATH, L"%s.tmp.%lu", status_path, GetCurrentProcessId()) < 0) return FALSE;
    file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    bytes = (DWORD)length;
    BOOL ok = WriteFile(file, text, bytes, &count, NULL) && count == bytes && FlushFileBuffers(file);
    CloseHandle(file);
    if (ok) ok = MoveFileExW(temporary, status_path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    if (!ok) DeleteFileW(temporary);
    return ok;
}

static BOOL Fail(DWORD code, const char* message)
{
    AcquireSRWLockExclusive(&status_lock);
    if (!failed) {
        failed = TRUE;
        failure_code = code ? code : ERROR_INVALID_DATA;
        strncpy_s(failure_message, sizeof(failure_message), message, _TRUNCATE);
    }
    ReleaseSRWLockExclusive(&status_lock);
    return FALSE;
}

BOOL HuaidjHasFailed(void) { return failed; }
int HuaidjExitCode(void) { return failed || !final_status ? 1 : 0; }
BOOL HuaidjPreserveExplicitLabel(void) { return huaidj_automation && huaidj_options.has_label; }
BOOL HuaidjRejectOption(const char* message) { ErrorStatus = RUFUS_ERROR(ERROR_INVALID_PARAMETER); return Fail(ERROR_INVALID_PARAMETER, message); }

void HuaidjCaptureOptions(int fs, int partition, int target, DWORD cluster, const char* label, BOOL quick, BOOL large)
{
    AcquireSRWLockExclusive(&status_lock);
    effective_fs = fs; effective_partition = partition; effective_target = target; effective_cluster = cluster;
    strncpy_s(effective_label, sizeof(effective_label), label, _TRUNCATE);
    effective_quick = quick; effective_large = large; effective_ready = TRUE;
    ReleaseSRWLockExclusive(&status_lock);
}

BOOL HuaidjEffectiveOptionsMatch(int fs, int partition, int target, DWORD cluster, const char* label, BOOL quick)
{
    if (!huaidj_automation) return TRUE;
    if (!effective_ready) return HuaidjRejectOption("Native effective options were not captured");
    if (!huaidj_options.format_only && huaidj_dd_mode) return TRUE;
    if (fs != effective_fs || partition != effective_partition || target != effective_target || cluster != effective_cluster ||
        strcmp(label, effective_label) != 0 || quick != effective_quick)
        return HuaidjRejectOption("Native formatting controls changed after the prepared options were validated");
    return TRUE;
}

void HuaidjStatus(const char* phase, double progress, const char* message)
{
    if (!huaidj_automation) return;
    AcquireSRWLockExclusive(&status_lock);
    if (!final_status) {
        strncpy_s(current_phase, sizeof(current_phase), phase, _TRUNCATE);
        current_progress = progress;
        if (!WriteStatus(FALSE, message) && !failed) {
            failed = TRUE;
            failure_code = ERROR_WRITE_FAULT;
            strcpy_s(failure_message, sizeof(failure_message), "Cannot atomically write native status file");
        }
    }
    ReleaseSRWLockExclusive(&status_lock);
}

void HuaidjFinish(BOOL success, const char* message)
{
    if (!huaidj_automation) return;
    AcquireSRWLockExclusive(&status_lock);
    if (!final_status) {
        if (!success && !failed) {
            failed = TRUE;
            failure_code = ErrorStatus ? ErrorStatus : ERROR_CANCELLED;
            strncpy_s(failure_message, sizeof(failure_message), message, _TRUNCATE);
        }
        final_status = TRUE;
        strcpy_s(current_phase, sizeof(current_phase), (success && !failed) ? (huaidj_dry_run ? "dry_run_complete" : "complete") : "failed");
        if (success && !failed) current_progress = 100.0;
        if (!WriteStatus(success && !failed, message)) {
            failed = TRUE;
            failure_code = ERROR_WRITE_FAULT;
        }
    }
    ReleaseSRWLockExclusive(&status_lock);
}

int HuaidjRejectDialog(UINT type, const char* text)
{
    if (!huaidj_automation) return -1;
    /* Raw dialog text can include local paths, drive labels or account names.
       Keep it out of the automation/MCP status channel. */
    (void)text;
    Fail(ERROR_CANCELLED, "Rufus requires a local interactive decision; automation declined it");
    ErrorStatus = RUFUS_ERROR(ERROR_CANCELLED);
    HuaidjStatus("blocked", current_progress, "Unexpected native dialog was declined; no automatic Yes response");
    if ((type & 15) == MB_YESNO) return IDNO;
    if ((type & 15) == MB_ABORTRETRYIGNORE) return IDABORT;
    return IDCANCEL;
}

/* Returns -1 if identity cannot be established; otherwise whether the volume includes the target. */
static int VolumeContainsTarget(const wchar_t* volume)
{
    wchar_t name[MAX_PATH];
    BYTE data[65536];
    DWORD bytes;
    HANDLE handle;
    VOLUME_DISK_EXTENTS* extents = (VOLUME_DISK_EXTENTS*)data;
    wcscpy_s(name, MAX_PATH, volume);
    size_t length = wcslen(name);
    if (length && name[length - 1] == L'\\') name[length - 1] = 0;
    handle = CreateFileW(name, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (handle == INVALID_HANDLE_VALUE) return -1;
    BOOL ok = DeviceIoControl(handle, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, NULL, 0, data, sizeof(data), &bytes, NULL);
    CloseHandle(handle);
    if (!ok || bytes < sizeof(VOLUME_DISK_EXTENTS) || extents->NumberOfDiskExtents > (bytes - offsetof(VOLUME_DISK_EXTENTS, Extents)) / sizeof(DISK_EXTENT)) return -1;
    for (DWORD i = 0; i < extents->NumberOfDiskExtents; ++i)
        if (extents->Extents[i].DiskNumber == huaidj_device_number) return 1;
    return 0;
}

static BOOL RequirePathOffTarget(const wchar_t* path, const char* reason)
{
    wchar_t mount[MAX_PATH], volume[MAX_PATH];
    if (!GetVolumePathNameW(path, mount, MAX_PATH) || !GetVolumeNameForVolumeMountPointW(mount, volume, MAX_PATH))
        return Fail(ERROR_INVALID_DATA, "Cannot establish the backing disk for a protected path");
    int result = VolumeContainsTarget(volume);
    if (result != 0) return Fail(ERROR_ACCESS_DENIED, result > 0 ? reason : "Cannot verify protected path disk extents");
    return TRUE;
}

static BOOL CheckProtectedVolumes(void)
{
    wchar_t windows[MAX_PATH], executable[MAX_PATH], volume[MAX_PATH], candidate[MAX_PATH], device[MAX_PATH], boot[MAX_PATH];
    DWORD boot_size = sizeof(boot);
    BOOL has_boot = RegGetValueW(HKEY_LOCAL_MACHINE, L"SYSTEM\\Setup", L"SystemPartition", RRF_RT_REG_SZ, NULL, boot, &boot_size) == ERROR_SUCCESS && boot[0] != 0;
    BOOL boot_resolved_off_target = FALSE, installer_bcd = FALSE, all_bcd_volumes_mapped = TRUE;
    if (!GetWindowsDirectoryW(windows, MAX_PATH) || !GetModuleFileNameW(NULL, executable, MAX_PATH))
        return Fail(ERROR_INVALID_DATA, "Cannot locate Windows or the running native engine");
    if (!RequirePathOffTarget(windows, "Refusing the active Windows system disk") ||
        (!huaidj_options.format_only && !RequirePathOffTarget(source_path, "Source ISO is on the target disk")) ||
        !RequirePathOffTarget(status_path, "Status file is on the target disk") ||
        !RequirePathOffTarget(executable, "Native engine is running from the target disk")) return FALSE;
    HANDLE find = FindFirstVolumeW(volume, MAX_PATH);
    if (find == INVALID_HANDLE_VALUE) return Fail(GetLastError(), "Cannot enumerate volumes for Windows/boot protection");
    BOOL safe = TRUE;
    do {
        BOOL mapped = FALSE, is_active_boot = FALSE;
        int contains = VolumeContainsTarget(volume);
        if (has_boot) {
            wcscpy_s(candidate, MAX_PATH, volume + 4);
            size_t length = wcslen(candidate);
            if (length && candidate[length - 1] == L'\\') candidate[length - 1] = 0;
            mapped = QueryDosDeviceW(candidate, device, MAX_PATH) != 0;
            is_active_boot = mapped && _wcsicmp(device, boot) == 0;
            if (is_active_boot) {
                if (contains < 0) { safe = Fail(ERROR_INVALID_DATA, "Cannot establish active boot volume disk extents"); break; }
                if (contains > 0) { safe = Fail(ERROR_ACCESS_DENIED, "Refusing Windows firmware/system boot partition"); break; }
                boot_resolved_off_target = TRUE;
            }
        }
        if (contains != 1) continue;
        if (has_boot && !mapped) { safe = Fail(GetLastError(), "Cannot identify target volume device"); break; }
        swprintf_s(candidate, MAX_PATH, L"%sWindows\\System32\\config\\SYSTEM", volume);
        DWORD attributes = GetFileAttributesW(candidate);
        if (attributes != INVALID_FILE_ATTRIBUTES) { safe = Fail(ERROR_ACCESS_DENIED, "Target contains a Windows installation; refusing to erase"); break; }
        if (GetLastError() == ERROR_ACCESS_DENIED) { safe = Fail(ERROR_ACCESS_DENIED, "Cannot inspect target for a Windows installation"); break; }
        swprintf_s(candidate, MAX_PATH, L"%sEFI\\Microsoft\\Boot\\BCD", volume);
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            installer_bcd = TRUE;
            all_bcd_volumes_mapped = all_bcd_volumes_mapped && mapped && !is_active_boot;
        } else if (GetLastError() == ERROR_ACCESS_DENIED) {
            safe = Fail(ERROR_ACCESS_DENIED, "Cannot inspect target for a Windows boot store");
            break;
        }
    } while (FindNextVolumeW(find, volume, MAX_PATH));
    FindVolumeClose(find);
    if (safe && installer_bcd && !HuaidjInstallerBcdIsNonSystem(has_boot, boot_resolved_off_target, all_bcd_volumes_mapped, FALSE))
        return Fail(ERROR_ACCESS_DENIED, "Target has a Windows boot store but its non-system identity cannot be proven");
    return safe;
}

BOOL HuaidjVerifyOpenTarget(HANDLE disk)
{
    BYTE data[65536];
    STORAGE_PROPERTY_QUERY query = { StorageDeviceProperty, PropertyStandardQuery, {0} };
    STORAGE_DEVICE_DESCRIPTOR* descriptor = (STORAGE_DEVICE_DESCRIPTOR*)data;
    GET_LENGTH_INFORMATION length;
    STORAGE_DEVICE_NUMBER number;
    DWORD bytes;
    if (!huaidj_automation) return TRUE;
    if (failed || huaidj_dry_run) return Fail(ERROR_ACCESS_DENIED, "Write attempted during failed or dry-run operation");
    if (!DeviceIoControl(disk, IOCTL_STORAGE_QUERY_PROPERTY, &query, sizeof(query), data, sizeof(data), &bytes, NULL) || bytes < sizeof(STORAGE_DEVICE_DESCRIPTOR))
        return Fail(GetLastError(), "Cannot read native storage descriptor");
    if (descriptor->BusType != BusTypeUsb) return Fail(ERROR_ACCESS_DENIED, "Refusing non-USB/internal disk");
    if (!descriptor->SerialNumberOffset || descriptor->SerialNumberOffset >= bytes ||
        memchr(data + descriptor->SerialNumberOffset, 0, bytes - descriptor->SerialNumberOffset) == NULL ||
        strcmp((char*)data + descriptor->SerialNumberOffset, expected_serial) != 0)
        return Fail(ERROR_INVALID_DATA, "Native USB serial number does not exactly match the prepared target");
    if (!DeviceIoControl(disk, IOCTL_STORAGE_GET_DEVICE_NUMBER, NULL, 0, &number, sizeof(number), &bytes, NULL) || number.DeviceNumber != huaidj_device_number)
        return Fail(ERROR_INVALID_DATA, "Native device number changed");
    if (!DeviceIoControl(disk, IOCTL_DISK_GET_LENGTH_INFO, NULL, 0, &length, sizeof(length), &bytes, NULL) || (uint64_t)length.Length.QuadPart != expected_size)
        return Fail(ERROR_INVALID_DATA, "Native USB capacity changed");
    if (!DeviceIoControl(disk, IOCTL_DISK_GET_DRIVE_LAYOUT_EX, NULL, 0, data, sizeof(data), &bytes, NULL))
        return Fail(GetLastError(), "Cannot inspect native target partition layout");
    DRIVE_LAYOUT_INFORMATION_EX* layout = (DRIVE_LAYOUT_INFORMATION_EX*)data;
    const GUID msr = { 0xe3c9e316, 0x0b5c, 0x4db8, {0x81,0x7d,0xf9,0x2d,0xf0,0x02,0x15,0xae} };
    const GUID recovery = { 0xde94bba4, 0x06d1, 0x4d40, {0xa1,0x6a,0xbf,0xd5,0x01,0x79,0xd6,0xac} };
    if (bytes < offsetof(DRIVE_LAYOUT_INFORMATION_EX, PartitionEntry) ||
        layout->PartitionCount > (bytes - offsetof(DRIVE_LAYOUT_INFORMATION_EX, PartitionEntry)) / sizeof(PARTITION_INFORMATION_EX))
        return Fail(ERROR_INVALID_DATA, "Invalid target partition layout");
    for (DWORD i = 0; i < layout->PartitionCount; ++i) {
        PARTITION_INFORMATION_EX* partition = &layout->PartitionEntry[i];
        if (partition->PartitionStyle == PARTITION_STYLE_GPT &&
            (memcmp(&partition->Gpt.PartitionType, &msr, sizeof(GUID)) == 0 || memcmp(&partition->Gpt.PartitionType, &recovery, sizeof(GUID)) == 0))
            return Fail(ERROR_ACCESS_DENIED, "Target contains Windows reserved/recovery partitions; refusing to erase");
    }
    return TRUE;
}

BOOL HuaidjValidateTarget(void)
{
    wchar_t path[64];
    if (!huaidj_automation || failed) return !failed;
    swprintf_s(path, 64, L"\\\\.\\PhysicalDrive%lu", huaidj_device_number);
    HANDLE disk = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (disk == INVALID_HANDLE_VALUE) return Fail(GetLastError(), "Cannot open target disk for read-only native verification");
    /* This verifier is shared with the actual write handle; allow only its read-only preflight here. */
    BOOL was_dry = huaidj_dry_run;
    huaidj_dry_run = FALSE;
    BOOL safe = HuaidjVerifyOpenTarget(disk);
    huaidj_dry_run = was_dry;
    CloseHandle(disk);
    if (!safe) return FALSE;
    return CheckProtectedVolumes();
}

static BOOL ParseUnsigned(const wchar_t* value, uint64_t* result)
{
    wchar_t* end;
    if (!value || !*value) return FALSE;
    for (const wchar_t* p = value; *p; ++p) if (*p < '0' || *p > '9') return FALSE;
    errno = 0;
    *result = _wcstoui64(value, &end, 10);
    return errno == 0 && *end == 0;
}

static BOOL VerifyLockedSourceHash(void)
{
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    BYTE* buffer = (BYTE*)malloc(1024 * 1024);
    BYTE digest[32];
    char actual[65];
    DWORD count, digest_size = sizeof(digest);
    BOOL ok = FALSE;
    LARGE_INTEGER zero = {0};
    if (!expected_sha256[0]) return TRUE; /* Optional only for read-only dry-runs. */
    HuaidjStatus("hashing", 0, "Verifying SHA-256 while the same ISO file is locked against modification");
    if (!buffer || !CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) || !SetFilePointerEx(source_lock, zero, NULL, FILE_BEGIN)) goto cleanup;
    for (;;) {
        if (!ReadFile(source_lock, buffer, 1024 * 1024, &count, NULL)) goto cleanup;
        if (count == 0) break;
        if (!CryptHashData(hash, buffer, count, 0)) goto cleanup;
    }
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &digest_size, 0) || digest_size != 32) goto cleanup;
    for (unsigned i = 0; i < 32; ++i) sprintf_s(actual + i * 2, sizeof(actual) - i * 2, "%02x", digest[i]);
    ok = _stricmp(actual, expected_sha256) == 0;
cleanup:
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    free(buffer);
    SetFilePointerEx(source_lock, zero, NULL, FILE_BEGIN);
    return ok ? TRUE : Fail(ERROR_CRC, "SHA-256 mismatch or inability to hash the locked source image");
}

/* Read all HuaiDJ flags before the ordinary Rufus argument processing or any UI. */
int HuaidjConfigure(void)
{
    int argc, i;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    wchar_t* image = NULL; wchar_t* serial = NULL; wchar_t* confirm = NULL;
    uint64_t number = UINT64_MAX;
    uint32_t seen = 0;
    BOOL invalid = FALSE, mode_seen = FALSE;
    const char* option_error = NULL;
    const wchar_t* const base_flags[] = { L"--huaidj-image", L"--huaidj-device", L"--huaidj-size", L"--huaidj-serial", L"--huaidj-sha256", L"--huaidj-confirm", L"--huaidj-status", L"--huaidj-mode" };
    HuaidjInitOptions(&huaidj_options);
    if (!argv) return 0;
    for (i = 1; i < argc; ++i) if (wcsncmp(argv[i], L"--huaidj-", 9) == 0) huaidj_automation = TRUE;
    if (!huaidj_automation) { LocalFree(argv); return 0; }
    for (i = 1; i < argc; ++i) {
        wchar_t* flag = argv[i];
        if (wcscmp(flag, L"--huaidj-dry-run") == 0) {
            if (seen & (1U << 8)) invalid = TRUE;
            seen |= 1U << 8; huaidj_dry_run = TRUE; continue;
        }
        if (i + 1 >= argc) { invalid = TRUE; continue; }
        wchar_t* value = argv[++i];
        const char* parse_error = NULL;
        int extra = HuaidjParseExtraOption(&huaidj_options, flag, value, &parse_error);
        if (extra) {
            if (extra < 0) { invalid = TRUE; if (!option_error) option_error = parse_error; }
            continue;
        }
        int base = -1;
        for (int j = 0; j < 8; ++j) if (wcscmp(flag, base_flags[j]) == 0) { base = j; break; }
        if (base < 0 || (seen & (1U << base))) { invalid = TRUE; continue; }
        seen |= 1U << base;
        if (base == 0) image = value;
        else if (base == 1) invalid |= !ParseUnsigned(value, &number);
        else if (base == 2) invalid |= !ParseUnsigned(value, &expected_size);
        else if (base == 3) serial = value;
        else if (base == 4) {
            if (wcslen(value) != 64) invalid = TRUE;
            else for (unsigned j = 0; j < 64; ++j) {
                if (!((value[j] >= L'0' && value[j] <= L'9') || (value[j] >= L'a' && value[j] <= L'f') || (value[j] >= L'A' && value[j] <= L'F'))) invalid = TRUE;
                expected_sha256[j] = (char)value[j];
            }
        } else if (base == 5) confirm = value;
        else if (base == 6) {
            DWORD resolved = GetFullPathNameW(value, MAX_PATH, status_path, NULL);
            if (resolved == 0 || resolved >= MAX_PATH - 32 || wcslen(value) >= MAX_PATH - 32) invalid = TRUE;
        } else if (base == 7) {
            mode_seen = TRUE;
            huaidj_dd_mode = wcscmp(value, L"dd") == 0;
            if (!huaidj_dd_mode && wcscmp(value, L"iso") != 0) invalid = TRUE;
        }
    }
    const char* contract_error = HuaidjValidateExtraOptions(&huaidj_options, image != NULL, expected_sha256[0] != 0, huaidj_dd_mode);
    if (contract_error && !option_error) option_error = contract_error;
    if (huaidj_options.format_only && mode_seen) { invalid = TRUE; option_error = "Format-only does not accept an image-write mode"; }
    huaidj_device_number = number <= 63 ? (DWORD)number : MAXDWORD;
    wchar_t required[128];
    swprintf_s(required, 128, L"ERASE:%lu:%llu", huaidj_device_number, (unsigned long long)expected_size);
    if (invalid || option_error || huaidj_device_number == MAXDWORD || expected_size < 8 * MB || !serial || !*serial ||
        !status_path[0] || (!huaidj_dry_run && (!confirm || wcscmp(confirm, required) != 0 || (!huaidj_options.format_only && !expected_sha256[0]))))
        Fail(ERROR_INVALID_PARAMETER, option_error ? option_error : "Missing/invalid/duplicate native flags or exact ERASE:<disk>:<size> confirmation");
    if (serial) {
        char* utf8 = wchar_to_utf8(serial);
        if (!utf8 || strlen(utf8) >= sizeof(expected_serial)) Fail(ERROR_INVALID_PARAMETER, "USB serial is invalid or too long");
        else strcpy_s(expected_serial, sizeof(expected_serial), utf8);
        free(utf8);
    }
    if (image) {
        DWORD resolved = GetFullPathNameW(image, MAX_PATH, source_path, NULL);
        if (resolved == 0 || resolved >= MAX_PATH || wcslen(image) >= MAX_PATH)
            Fail(ERROR_INVALID_PARAMETER, "Invalid source image path");
    }
    if (status_path[0] && source_path[0] && _wcsicmp(status_path, source_path) == 0) {
        status_path[0] = 0;
        Fail(ERROR_INVALID_PARAMETER, "Status and source image paths must differ");
    }
    if (status_path[0] && huaidj_device_number != MAXDWORD && !RequirePathOffTarget(status_path, "Status output must not write to the target USB"))
        status_path[0] = 0;

    /* Lock an image before the first status write, even for rejected arguments.
       This also protects hard-link/junction aliases from replacement by status. */
    if (image && source_path[0]) {
        source_lock = CreateFileW(source_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (source_lock == INVALID_HANDLE_VALUE) {
            status_path[0] = 0;
            Fail(GetLastError(), "Cannot safely lock source ISO against modification during the job");
        } else {
            LARGE_INTEGER length;
            wchar_t actual[MAX_PATH];
            DWORD resolved = GetFinalPathNameByHandleW(source_lock, actual, MAX_PATH, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
            if (!resolved || resolved >= MAX_PATH) Fail(ERROR_INVALID_DATA, "Cannot resolve final source path from the locked ISO handle");
            else if (wcsncmp(actual, L"\\\\?\\UNC\\", 8) == 0) Fail(ERROR_INVALID_DATA, "Network ISO sources are not supported by native automation");
            else wcscpy_s(source_path, MAX_PATH, wcsncmp(actual, L"\\\\?\\", 4) == 0 ? actual + 4 : actual);
            if (!GetFileSizeEx(source_lock, &length) || length.QuadPart <= 0 || (uint64_t)length.QuadPart > expected_size)
                Fail(ERROR_INVALID_DATA, "Source image is empty or larger than the target USB");
            else source_bytes = (uint64_t)length.QuadPart;
            HANDLE previous_status = CreateFileW(status_path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
            if (previous_status != INVALID_HANDLE_VALUE) {
                BY_HANDLE_FILE_INFORMATION source_id, status_id;
                if (!GetFileInformationByHandle(source_lock, &source_id) || !GetFileInformationByHandle(previous_status, &status_id) ||
                    (source_id.dwVolumeSerialNumber == status_id.dwVolumeSerialNumber && source_id.nFileIndexHigh == status_id.nFileIndexHigh && source_id.nFileIndexLow == status_id.nFileIndexLow)) {
                    status_path[0] = 0;
                    Fail(ERROR_INVALID_PARAMETER, "Status must not alias the source image");
                }
                CloseHandle(previous_status);
            }
        }
    }
    if (!failed) {
        uint64_t identity_hash = 14695981039346656037ULL;
        wchar_t mutex_name[128];
        for (const unsigned char* p = (const unsigned char*)expected_serial; *p; ++p)
            identity_hash = (identity_hash ^ *p) * 1099511628211ULL;
        swprintf_s(mutex_name, 128, L"Global\\HuaiDJ_Rufus_USB_%lu_%016llx", huaidj_device_number, (unsigned long long)identity_hash);
        device_mutex = CreateMutexW(NULL, FALSE, mutex_name);
        if (!device_mutex) Fail(GetLastError(), "Cannot create native USB operation mutex");
        else {
            DWORD acquired = WaitForSingleObject(device_mutex, 0);
            if (acquired != WAIT_OBJECT_0 && acquired != WAIT_ABANDONED)
                Fail(ERROR_BUSY, "Native USB target is already owned by another operation");
        }
    }
    HuaidjStatus("validating", 0, "Read-only native USB identity and protected-volume checks");
    if (!failed) HuaidjValidateTarget();
    if (!failed && !huaidj_options.format_only) VerifyLockedSourceHash();
    if (!failed) {
        free(image_path);
        image_path = huaidj_options.format_only ? NULL : wchar_to_utf8(source_path);
        if (!huaidj_options.format_only && !image_path) Fail(ERROR_NOT_ENOUGH_MEMORY, "Cannot allocate source image path");
    }
    LocalFree(argv);
    if (failed) { HuaidjFinish(FALSE, failure_message); return -1; }
    HuaidjStatus(huaidj_options.format_only ? "configuring" : "scanning", 0,
        huaidj_options.format_only ? "Target verified; configuring non-bootable original Rufus format engine" : "Target verified; scanning image with the original Rufus engine");
    return 1;
}

void HuaidjShutdown(void)
{
    if (!huaidj_automation) return;
    if (!final_status) HuaidjFinish(FALSE, "Native engine exited before completing the operation");
    if (source_lock != INVALID_HANDLE_VALUE) { CloseHandle(source_lock); source_lock = INVALID_HANDLE_VALUE; }
    if (device_mutex) { ReleaseMutex(device_mutex); CloseHandle(device_mutex); device_mutex = NULL; }
}
