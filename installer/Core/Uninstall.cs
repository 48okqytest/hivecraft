using System.Diagnostics;

namespace Hivecraft.Setup;

sealed class UninstallOptions
{
    public string Dir = "";
    /// <summary>Also remove the Hivecraft launcher profile, versions\hivecraft-1.21.1 and .minecraft\hivecraft (explicit opt-in).</summary>
    public bool RemoveMinecraftProfile;
    /// <summary>Remove %APPDATA%\Hivecraft (launcher settings + saved API keys).</summary>
    public bool RemoveUserData = true;
    /// <summary>Move worlds to Documents\Hivecraft worlds backup before deleting.</summary>
    public bool KeepWorlds = true;
}

static class Uninstaller
{
    /// <summary>
    /// The running exe cannot delete itself: when started from inside the install folder, copy to %TEMP% and run that
    /// copy (--uninstall-stage2 --wait-pid). Returns true if the caller should exit now.
    /// </summary>
    public static bool RelaunchFromTempIfNeeded(string dir, IEnumerable<string> args)
    {
        var me = Environment.ProcessPath;
        if (me == null || !Path.GetFullPath(me).StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return false;
        var tmp = Path.Combine(Path.GetTempPath(), "hivecraft-uninstall-" + Guid.NewGuid().ToString("N")[..8] + ".exe");
        File.Copy(me, tmp);
        var a = string.Join(" ", args.Select(Quote)) + $" --dir {Quote(dir)} --wait-pid {Environment.ProcessId}";
        Log.W($"uninstall: relaunching from {tmp} {a}");
        Process.Start(new ProcessStartInfo(tmp, a) { UseShellExecute = false });
        return true;
    }

    static string Quote(string s) => s.Contains(' ') || s.Length == 0 ? "\"" + s.TrimEnd('\\') + "\"" : s;

    public static void WaitForPid(int pid)
    {
        try { using var p = Process.GetProcessById(pid); p.WaitForExit(15000); }
        catch (ArgumentException) { /* already gone */ }
    }

    /// <summary>Checks that dir really is a Hivecraft install before deleting anything.</summary>
    public static string? ValidateDir(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return "No install folder given.";
        var d = Path.GetFullPath(dir);
        if (!Directory.Exists(d)) return $"{d} does not exist (already uninstalled?).";
        if (Path.GetPathRoot(d) == d) return "Refusing to delete a whole drive.";
        bool looks = File.Exists(Path.Combine(d, "app", "Hivecraft.exe")) || File.Exists(Path.Combine(d, "app", HiveConfig.FileName)) || File.Exists(Path.Combine(d, Setup.SetupExeName));
        if (!looks) return $"{d} does not look like a Hivecraft install folder (no app\\Hivecraft.exe). Nothing was deleted.";
        return null;
    }

    public static async Task<List<string>> RunAsync(UninstallOptions o, IProgress<Progress> p, CancellationToken ct = default)
    {
        var done = new List<string>();
        var dir = Path.GetFullPath(o.Dir);
        var err = ValidateDir(dir);
        if (err != null) throw new InstallException(err);
        if (Setup.RunningLauncher(dir) != null) throw new InstallException("Hivecraft is still running. Close it (TERMINATE, then close the window) and try again.");

        // what the config says about .minecraft (tests point it at a temp folder)
        var cfg = HiveConfig.Load(Path.Combine(dir, "app"));
        var mcDir = !string.IsNullOrWhiteSpace(cfg.Minecraft.Dir) ? cfg.McDir : Places.McDir;

        // 1. worlds backup
        if (o.KeepWorlds)
        {
            var server = cfg.FromFile ? cfg.ServerDir : Path.Combine(dir, "app", "server");
            var worlds = new[] { "worlds", "world" }.Select(n => Path.Combine(server, n)).Where(Directory.Exists).ToList();
            if (worlds.Count > 0)
            {
                var dest = Path.Combine(Places.Documents, "Hivecraft worlds backup " + DateTime.Now.ToString("yyyy-MM-dd HHmm"));
                p.Report(new Progress("Saving your worlds to " + dest + "…"));
                Directory.CreateDirectory(dest);
                foreach (var w in worlds) await Task.Run(() => CopyDir(w, Path.Combine(dest, Path.GetFileName(w))), ct);
                done.Add("Worlds copied to " + dest);
            }
        }

        // 2. shortcuts + Apps & Features entry
        p.Report(new Progress("Removing shortcuts…"));
        Setup.RemoveShortcuts();
        UninstallEntry.Remove();
        done.Add("Shortcuts and the Apps & Features entry removed");

        // 3. Minecraft launcher profile (opt-in)
        if (o.RemoveMinecraftProfile)
        {
            p.Report(new Progress("Removing the Hivecraft Minecraft profile…"));
            var lp = Path.Combine(mcDir, "launcher_profiles.json");
            if (File.Exists(lp))
            {
                File.Copy(lp, lp + ".bak-hivecraft-uninstall", true);
                File.WriteAllText(lp, MinecraftCheck.RemoveProfile(File.ReadAllText(lp)), new System.Text.UTF8Encoding(false));
            }
            foreach (var d in new[] { Path.Combine(mcDir, "versions", FileEdits.VersionId), Path.Combine(mcDir, "hivecraft") })
                if (Directory.Exists(d)) Directory.Delete(d, true);
            done.Add($"Minecraft: Hivecraft profile, versions\\{FileEdits.VersionId} and the hivecraft game folder removed (backup: launcher_profiles.json.bak-hivecraft-uninstall)");
        }

        // 4. user data (settings + API keys)
        if (o.RemoveUserData)
        {
            p.Report(new Progress("Removing saved settings and API keys…"));
            await ProviderGlue.DeleteAllKeysAsync(ct);
            if (Directory.Exists(Places.DataDir)) Directory.Delete(Places.DataDir, true);
            done.Add("Saved settings and API keys removed (" + Places.DataDir + ")");
        }

        // 5. the install folder
        p.Report(new Progress("Deleting " + dir + "…"));
        await Task.Run(() => DeleteDir(dir), ct);
        done.Add("Deleted " + dir);
        foreach (var d in done) Log.W("uninstall: " + d);
        return done;
    }

    static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(src)) CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
    }

    /// <summary>Delete with a few retries (antivirus / indexer handles); clears read-only flags.</summary>
    static void DeleteDir(string dir)
    {
        for (int i = 1; ; i++)
        {
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    var a = File.GetAttributes(f);
                    if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(f, a & ~FileAttributes.ReadOnly);
                }
                Directory.Delete(dir, true);
                return;
            }
            catch (Exception e) when (i < 5 && (e is IOException or UnauthorizedAccessException))
            {
                Log.W($"uninstall: delete {dir} try {i}: {e.Message}");
                Thread.Sleep(800 * i);
            }
            catch (Exception e)
            {
                throw new InstallException($"Some files in {dir} could not be deleted ({e.Message}). Close anything using them (Hivecraft, a terminal, Explorer) and run uninstall again.", e);
            }
        }
    }

    /// <summary>After stage 2: delete our temp copy a few seconds after we exit.</summary>
    public static void ScheduleSelfDelete()
    {
        var me = Environment.ProcessPath;
        if (me == null || !Path.GetFileName(me).StartsWith("hivecraft-uninstall-", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 4 > nul & del /f /q \"{me}\"") { CreateNoWindow = true, UseShellExecute = false });
        }
        catch (Exception e) { Log.W("could not schedule temp uninstaller cleanup: " + e.Message); }
    }
}
