using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace Hivecraft.Setup;

/// <summary>
/// Every place outside the install folder that setup touches, overridable for tests:
///  HIVECRAFT_TEST_SANDBOX=&lt;dir&gt;  -> Desktop, Start menu, Documents, %APPDATA%\Hivecraft, .minecraft and the
///                                   "registry" (a JSON file) all live inside that dir; nothing real is touched.
///  HIVECRAFT_MC_DIR / --mc-dir     -> the .minecraft folder;  HIVECRAFT_DATA_DIR -> %APPDATA%\Hivecraft.
/// </summary>
static class Places
{
    public static string? Sandbox => Env("HIVECRAFT_TEST_SANDBOX");
    public static string? McDirOverride { get; set; }

    static string? Env(string n) { var v = Environment.GetEnvironmentVariable(n); return string.IsNullOrWhiteSpace(v) ? null : Path.GetFullPath(v); }
    static string Sf(Environment.SpecialFolder f) => Environment.GetFolderPath(f);
    static string In(string sub, Environment.SpecialFolder real) => Sandbox != null ? Path.Combine(Sandbox, sub) : Sf(real);

    public static string DefaultInstallDir => Path.Combine(Sf(Environment.SpecialFolder.LocalApplicationData), "Programs", "Hivecraft");
    public static string Desktop => In("Desktop", Environment.SpecialFolder.DesktopDirectory);
    public static string StartMenuDir => Path.Combine(In(Path.Combine("StartMenu", "Programs"), Environment.SpecialFolder.Programs), "Hivecraft");
    public static string Documents => In("Documents", Environment.SpecialFolder.MyDocuments);
    public static string DataDir => Env("HIVECRAFT_DATA_DIR") ?? (Sandbox != null ? Path.Combine(Sandbox, "AppData", "Hivecraft") : Path.Combine(Sf(Environment.SpecialFolder.ApplicationData), "Hivecraft"));
    public static string McDir => McDirOverride ?? Env("HIVECRAFT_MC_DIR") ?? (Sandbox != null ? Path.Combine(Sandbox, ".minecraft") : Path.Combine(Sf(Environment.SpecialFolder.ApplicationData), ".minecraft"));
    /// <summary>true when .minecraft is NOT the real one (then it is written into hivecraft.config.json so the launcher uses it too)</summary>
    public static bool McDirIsCustom => McDirOverride != null || Env("HIVECRAFT_MC_DIR") != null || Sandbox != null;

    public static string DesktopLink => Path.Combine(Desktop, "Hivecraft.lnk");
    public static string StartLink => Path.Combine(StartMenuDir, "Hivecraft.lnk");
    public static string StartUninstallLink => Path.Combine(StartMenuDir, "Uninstall Hivecraft.lnk");
}

/// <summary>Apps &amp; Features entry under HKCU (per-user, no admin); a JSON file instead when sandboxed.</summary>
static class UninstallEntry
{
    public const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Hivecraft";
    static string SandboxFile => Path.Combine(Places.Sandbox!, "uninstall-registry.json");

    public static void Write(string installDir, string version, long sizeKb)
    {
        var setup = Path.Combine(installDir, Setup.SetupExeName);
        var v = new Dictionary<string, object>
        {
            ["DisplayName"] = "Hivecraft",
            ["DisplayVersion"] = version,
            ["Publisher"] = "Hivecraft",
            ["InstallLocation"] = installDir,
            ["DisplayIcon"] = Path.Combine(installDir, "app", "Hivecraft.exe") + ",0",
            ["UninstallString"] = $"\"{setup}\" --uninstall",
            ["QuietUninstallString"] = $"\"{setup}\" --uninstall --unattended",
            ["ModifyPath"] = $"\"{setup}\" --repair",
            ["NoRepair"] = 0,
            ["EstimatedSize"] = (int)Math.Min(int.MaxValue, sizeKb),
            ["InstallDate"] = DateTime.Now.ToString("yyyyMMdd"),
        };
        if (Places.Sandbox != null)
        {
            Directory.CreateDirectory(Places.Sandbox);
            File.WriteAllText(SandboxFile, JsonSerializer.Serialize(v, new JsonSerializerOptions { WriteIndented = true }));
            return;
        }
        using var k = Registry.CurrentUser.CreateSubKey(KeyPath, true);
        foreach (var kv in v)
            if (kv.Value is int i) k.SetValue(kv.Key, i, RegistryValueKind.DWord);
            else k.SetValue(kv.Key, kv.Value.ToString()!, RegistryValueKind.String);
    }

    /// <summary>InstallLocation of an existing install, or null.</summary>
    public static string? InstalledDir()
    {
        try
        {
            if (Places.Sandbox != null)
                return File.Exists(SandboxFile) ? (string?)JsonNode.Parse(File.ReadAllText(SandboxFile))?["InstallLocation"] : null;
            using var k = Registry.CurrentUser.OpenSubKey(KeyPath);
            return k?.GetValue("InstallLocation") as string;
        }
        catch (Exception e) { Log.W("reading the uninstall entry failed: " + e.Message); return null; }
    }

    public static void Remove()
    {
        if (Places.Sandbox != null) { Log.TryDelete(SandboxFile); return; }
        Registry.CurrentUser.DeleteSubKeyTree(KeyPath, false);
    }
}

/// <summary>.lnk files through the Windows shell (IShellLinkW + IPersistFile).</summary>
static class Shortcut
{
    public static void Create(string lnk, string target, string args, string workDir, string description, string? icon = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(lnk)!);
        var link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(target);
            link.SetArguments(args);
            link.SetWorkingDirectory(workDir);
            link.SetDescription(description);
            link.SetIconLocation(icon ?? target, 0);
            ((IPersistFile)link).Save(lnk, true);
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }

    /// <summary>Target path of a .lnk (selftest), or null.</summary>
    public static string? Target(string lnk)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(lnk, 0);
            var sb = new System.Text.StringBuilder(1024);
            link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
            return sb.ToString();
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }
}
