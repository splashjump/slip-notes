# Q31 verify: WM_NCHITTEST hit-test pass-through (OS level)
# Usage: node tests/nchittest-check.mjs (recommended) or:
#   powershell -File tests/nchittest-check.ps1 <hwnd> <x> <y> (screen physical px)
param(
    [int]$Hwnd = 0,
    [int]$X = 0,
    [int]$Y = 0
)

# KEY: declare per-monitor DPI awareness, otherwise cross-process SendMessage coords
# get DPI-virtualized (logical -> physical x1.5) and won't match real screen pixels.
if (-not ("SlipDpi" -as [type])) {
    Add-Type -ErrorAction SilentlyContinue -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlipDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value); // 2 = per-monitor
}
"@
}
try {
    if ([Environment]::OSVersion.Version.Major -ge 10) {
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE = -4
        [void][SlipDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
    }
} catch {}
# fallback: legacy API when context API unavailable
[void][SlipDpi]::SetProcessDpiAwareness(2)

if (-not ("SlipHitTest" -as [type])) {
    Add-Type -ErrorAction SilentlyContinue -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlipHitTest {
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public static int HitTest(IntPtr hwnd, int x, int y) {
        uint WM_NCHITTEST = 0x0084;
        IntPtr lParam = (IntPtr)((((long)y) & 0xFFFF) << 16 | (((long)x) & 0xFFFF));
        return (int)SendMessage(hwnd, WM_NCHITTEST, IntPtr.Zero, lParam);
    }
}
"@
}

$hwndPtr = [IntPtr]$Hwnd
if ($hwndPtr -eq [IntPtr]::Zero) { Write-Error "hwnd cannot be 0"; exit 1 }
$code = [SlipHitTest]::HitTest($hwndPtr, $X, $Y)
Write-Output "HWND=$Hwnd at ($X,$Y) => NCHITTEST=$code (1=HTCLIENT hit, -1=HTTRANSPARENT pass)"