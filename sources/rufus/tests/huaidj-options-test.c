/* Offline parser/contract tests. GPL-3.0-or-later. No storage or Windows APIs. */
#include "../src/huaidj_options.h"
#include <stdio.h>
#include <string.h>

static unsigned checks;
static int failed;
#define CHECK(test) do { ++checks; if (!(test)) { fprintf(stderr, "FAIL at line %u\n", (unsigned)__LINE__); failed = 1; } } while (0)
static int Parse(huaidj_options_t* o, const wchar_t* key, const wchar_t* value)
{
    const char* error = NULL;
    return HuaidjParseExtraOption(o, key, value, &error);
}
int main(void)
{
    huaidj_options_t o;
    HuaidjInitOptions(&o);
    CHECK(o.filesystem == HJ_FS_AUTO && o.quick_format == 1 && !o.format_only);
    CHECK(HuaidjValidateExtraOptions(&o, 1, 1, 1) == NULL);
    CHECK(HuaidjValidateExtraOptions(&o, 0, 0, 1) != NULL);
    CHECK(Parse(&o, L"--huaidj-filesystem", L"ntfs") == 1);
    CHECK(Parse(&o, L"--huaidj-filesystem", L"fat32") == -1);
    CHECK(HuaidjValidateExtraOptions(&o, 1, 1, 1) != NULL);
    CHECK(HuaidjValidateExtraOptions(&o, 1, 1, 0) == NULL);
    HuaidjInitOptions(&o);
    CHECK(Parse(&o, L"--huaidj-operation", L"format") == 1);
    CHECK(HuaidjValidateExtraOptions(&o, 0, 0, 0) != NULL);
    CHECK(Parse(&o, L"--huaidj-filesystem", L"exfat") == 1);
    CHECK(Parse(&o, L"--huaidj-partition-scheme", L"gpt") == 1);
    CHECK(Parse(&o, L"--huaidj-cluster-size", L"32768") == 1);
    CHECK(Parse(&o, L"--huaidj-volume-label", L"DJ USB") == 1);
    CHECK(Parse(&o, L"--huaidj-quick-format", L"false") == 1);
    CHECK(o.filesystem == HJ_FS_EXFAT && o.partition_scheme == HJ_PT_GPT && o.cluster_size == 32768 && !o.quick_format);
    CHECK(HuaidjValidateExtraOptions(&o, 0, 0, 0) == NULL);
    CHECK(HuaidjValidateExtraOptions(&o, 1, 0, 0) != NULL);
    CHECK(HuaidjValidateExtraOptions(&o, 0, 1, 0) != NULL);
    CHECK(Parse(&o, L"--huaidj-target-system", L"uefi") == 1);
    CHECK(HuaidjValidateExtraOptions(&o, 0, 0, 0) != NULL);
    const wchar_t* bad_clusters[] = {L"0", L"-512", L"1025", L"512.0", L"42949672960", L"9999999999999999999999999", L"33554433"};
    for (unsigned i = 0; i < sizeof(bad_clusters)/sizeof(bad_clusters[0]); ++i) {
        HuaidjInitOptions(&o);
        CHECK(Parse(&o, L"--huaidj-cluster-size", bad_clusters[i]) == -1);
    }
    const wchar_t* bad_values[][2] = {
        {L"--huaidj-filesystem",L"unknown"}, {L"--huaidj-partition-scheme",L"sfd"},
        {L"--huaidj-target-system",L"legacy-uefi"}, {L"--huaidj-quick-format",L"1"},
        {L"--huaidj-operation",L"secure-erase"}, {L"--huaidj-volume-label",L"bad/name"},
        {L"--huaidj-volume-label",L"bad\nname"}, {L"--huaidj-volume-label",L"123456789012345678901234567890123"}
    };
    for (unsigned i = 0; i < sizeof(bad_values)/sizeof(bad_values[0]); ++i) {
        HuaidjInitOptions(&o);
        CHECK(Parse(&o, bad_values[i][0], bad_values[i][1]) == -1);
    }
    CHECK(HuaidjValidateLabel(L"DJ USB", HJ_FS_FAT32) == NULL);
    CHECK(HuaidjValidateLabel(L"123456789012", HJ_FS_FAT32) != NULL);
    CHECK(HuaidjValidateLabel(L"\x6E2C\x8A66", HJ_FS_FAT32) != NULL);
    CHECK(HuaidjValidateLabel(L"DJ.USB", HJ_FS_FAT32) != NULL);
    CHECK(HuaidjValidateLabel(L"123456789012345", HJ_FS_EXFAT) == NULL);
    CHECK(HuaidjValidateLabel(L"1234567890123456", HJ_FS_EXFAT) != NULL);
    CHECK(HuaidjValidateLabel(L"\x6E2C\x8A66", HJ_FS_EXFAT) == NULL);
    HuaidjInitOptions(&o);
    CHECK(Parse(&o, L"--huaidj-quick-format", L"true") == 1);
    CHECK(HuaidjValidateExtraOptions(&o, 1, 1, 1) != NULL);
    HuaidjInitOptions(&o);
    CHECK(Parse(&o, L"--huaidj-not-supported", L"true") == 0);
    CHECK(Parse(&o, L"--huaidj-volume-label", L"") == 1);
    CHECK(HuaidjInstallerBcdIsNonSystem(1, 1, 1, 0));
    CHECK(!HuaidjInstallerBcdIsNonSystem(0, 1, 1, 0));
    CHECK(!HuaidjInstallerBcdIsNonSystem(1, 0, 1, 0));
    CHECK(!HuaidjInstallerBcdIsNonSystem(1, 1, 0, 0));
    CHECK(!HuaidjInstallerBcdIsNonSystem(1, 1, 1, 1));
    CHECK(!HuaidjInstallerBcdIsNonSystem(0, 0, 0, 0));
    CHECK(!HuaidjInstallerBcdIsNonSystem(0, 0, 0, 1));
    printf("%s: %u native option checks; no storage APIs linked\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
