using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Hivecraft;

/// <summary>Windows Job Object with KILL_ON_JOB_CLOSE: every child we start dies with the launcher, even on a crash.</summary>
static class Job
{
    static IntPtr _h;

    [StructLayout(LayoutKind.Sequential)]
    struct BASIC
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinWs, MaxWs;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IOC { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXT
    {
        public BASIC Basic;
        public IOC Io;
        public UIntPtr ProcMem, JobMem, PeakProc, PeakJob;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string? name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr h, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr h, IntPtr proc);

    public static void Init()
    {
        if (_h != IntPtr.Zero) return;
        _h = CreateJobObject(IntPtr.Zero, null);
        var ext = new EXT();
        ext.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf<EXT>();
        IntPtr p = Marshal.AllocHGlobal(len);
        try { Marshal.StructureToPtr(ext, p, false); SetInformationJobObject(_h, 9, p, (uint)len); }
        finally { Marshal.FreeHGlobal(p); }
    }

    public static bool Add(Process p)
    {
        try { return _h != IntPtr.Zero && AssignProcessToJobObject(_h, p.Handle); } catch { return false; }
    }
}

static class ConsoleAttach
{
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
    public static void Attach() { try { AttachConsole(-1); } catch { } }
}
