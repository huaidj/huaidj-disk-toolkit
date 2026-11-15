/* HuaiDJ local automation adapter for Rufus. GPL-3.0-or-later. */
#pragma once
#include <windows.h>
#include "huaidj_options.h"

#define UM_HUAIDJ_SCAN_COMPLETE (WM_APP + 0x510)
#define TID_HUAIDJ_PROGRESS 0x510
extern BOOL huaidj_automation;
extern BOOL huaidj_dry_run;
extern BOOL huaidj_dd_mode;
extern DWORD huaidj_device_number;
extern huaidj_options_t huaidj_options;
BOOL HuaidjRejectOption(const char* message);
BOOL HuaidjPreserveExplicitLabel(void);
void HuaidjNormalizeAutoLabel(char* label, int filesystem);
void HuaidjCaptureOptions(int filesystem, int partition, int target, DWORD cluster, const char* label, BOOL quick, BOOL large_fat32);
BOOL HuaidjEffectiveOptionsMatch(int filesystem, int partition, int target, DWORD cluster, const char* label, BOOL quick);
int HuaidjConfigure(void);
BOOL HuaidjValidateTarget(void);
BOOL HuaidjVerifyOpenTarget(HANDLE disk);
BOOL HuaidjHasFailed(void);
int HuaidjRejectDialog(UINT type, const char* text);
void HuaidjStatus(const char* phase, double progress, const char* message);
void HuaidjFinish(BOOL success, const char* message);
void HuaidjShutdown(void);
int HuaidjExitCode(void);
