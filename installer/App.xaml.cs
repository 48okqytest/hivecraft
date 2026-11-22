using System.Runtime.InteropServices;
using System.Windows;

namespace Hivecraft.Setup;

public partial class App : Application
{
    [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var cli = new Cli(e.Args);
        if (cli.Val("--log") is string lp) Log.PathName = Path.GetFullPath(lp);
        if (cli.Val("--mc-dir") is string md) Places.McDirOverride = Path.GetFullPath(md);
        Providers.DataDir = Places.DataDir;
        Providers.Log = s => Log.W(s);   // secrets.dat follows HIVECRAFT_DATA_DIR / the sandbox
        bool headless = cli.Has("--selftest") || cli.Has("--unattended");
        if (headless) { try { AttachConsole(-1); } catch (Exception ex) { Log.W("no console: " + ex.Message); } Log.Echo = true; }
        Log.W($"Hivecraft-Setup {Setup.AppVersion} args: {Redacted(e.Args)}  sandbox={Places.Sandbox ?? "-"} data={Places.DataDir} mc={Places.McDir}");

        if (cli.Unknown() is string bad)
        {
            Log.W($"Unknown option {bad}.\n{Cli.Usage}");
            if (!headless) MessageBox.Show($"Unknown option {bad}.\n\n{Cli.Usage}", "Hivecraft Setup");
            Shutdown(2); return;
        }
        if (int.TryParse(cli.Val("--wait-pid"), out var pid)) Uninstaller.WaitForPid(pid);

        DispatcherUnhandledException += (_, a) =>
        {
            Log.Err("ui", a.Exception);
            MessageBox.Show("Something went wrong: " + a.Exception.Message + "\n\nDetails are in " + Log.PathName, "Hivecraft Setup", MessageBoxButton.OK, MessageBoxImage.Error);
            a.Handled = true;
        };

        if (cli.Has("--selftest")) { Shutdown(Task.Run(SelfTest.Run).GetAwaiter().GetResult()); return; }

        if (cli.Has("--uninstall"))
        {
            var dir = cli.Val("--dir") ?? UninstallEntry.InstalledDir() ?? Path.GetDirectoryName(Environment.ProcessPath) ?? "";
            if (Uninstaller.RelaunchFromTempIfNeeded(dir, e.Args.Where((a, i) => !IsDirArg(e.Args, i)))) { Shutdown(0); return; }
            if (cli.Has("--unattended")) { Shutdown(Task.Run(() => Headless.Uninstall(cli, dir)).GetAwaiter().GetResult()); return; }
            new MainWindow(WizardMode.Uninstall, dir, cli).Show();
            return;
        }

        // off the UI thread: no dispatcher context to deadlock on while we block
        if (cli.Has("--unattended")) { Shutdown(Task.Run(() => Headless.Install(cli)).GetAwaiter().GetResult()); return; }

        var installed = cli.Val("--dir") ?? UninstallEntry.InstalledDir();
        var mode = installed != null && Directory.Exists(installed) ? WizardMode.Maintenance : WizardMode.Install;
        if (cli.Has("--repair")) mode = WizardMode.Repair;
        var win = new MainWindow(mode, installed, cli);
        win.Show();
        if (cli.Val("--shots") is string shots) win.RenderAllPagesAsync(Path.GetFullPath(shots));
    }

    static bool IsDirArg(string[] a, int i) =>
        a[i].Equals("--dir", StringComparison.OrdinalIgnoreCase) || i > 0 && a[i - 1].Equals("--dir", StringComparison.OrdinalIgnoreCase);

    static string Redacted(string[] args)
    {
        var o = new List<string>();
        for (int i = 0; i < args.Length; i++) o.Add(i > 0 && args[i - 1].Equals("--api-key", StringComparison.OrdinalIgnoreCase) ? Providers.MaskKey(args[i]) : args[i]);
        return string.Join(" ", o);
    }
}

/// <summary>--unattended install / uninstall (no window). Exit 0 = OK.</summary>
static class Headless
{
    public static int Install(Cli cli)
    {
        try
        {
            var o = new SetupOptions
            {
                Dir = cli.Val("--dir") ?? UninstallEntry.InstalledDir() ?? Places.DefaultInstallDir,
                AcceptEula = cli.Has("--accept-eula"),
                McName = cli.Val("--player") ?? "",
                DisplayName = cli.Val("--display-name") ?? "",
                ProviderKind = Providers.NormalizeKind(cli.Val("--provider") ?? "claude-login"),
                BaseUrl = cli.Val("--base-url") ?? "",
                SmallModel = cli.Val("--small-model") ?? "",
                ApiKey = cli.Val("--api-key") ?? Environment.GetEnvironmentVariable("HIVE_API_KEY"),
                DesktopShortcut = !cli.Has("--no-shortcuts"),
                StartMenuShortcut = !cli.Has("--no-shortcuts"),
                Launch = !cli.Has("--no-launch"),
                ReuseSystemRuntimes = !cli.Has("--no-reuse-runtimes"),
                PayloadPath = cli.Val("--payload"),
            };
            var info = ProviderGlue.Get(o.ProviderKind);
            o.Model = cli.Val("--model") ?? info.DefaultModel;
            o.ClaudeExe = cli.Val("--claude") ?? ProviderGlue.FindClaude();
            if (!o.AcceptEula) { Log.W("FAILED: --accept-eula is required (Minecraft EULA: https://aka.ms/MinecraftEULA)."); return 3; }
            if (!HiveConfig.ValidMcName(o.McName)) { Log.W("FAILED: --player must be a Minecraft name (3-16 letters, digits, _)."); return 3; }
            var problem = ProviderGlue.Validate(o);
            if (problem != null) Log.W("warning (provider): " + problem);

            var s = new Setup(o);
            var steps = s.DependencySteps().Concat(s.FinishSteps()).ToList();
            var p = new Progress<Progress>(_ => { });
            bool ok = Setup.RunStepsAsync(steps, st => { if (st.State is "done" or "failed") Log.W($"[{st.State}] {st.Title}: {st.Detail}"); }, p, CancellationToken.None).GetAwaiter().GetResult();
            if (!ok) { Log.W("FAILED: " + steps.First(x => x.State == "failed").Detail); return 1; }
            if (o.ClaudeExe == null) Log.W("note: Claude Code was not found; Hivecraft asks to install it on first start (or rerun setup).");
            if (cli.Has("--test-connection"))
            {
                var r = ProviderGlue.TestAsync(o, CancellationToken.None).GetAwaiter().GetResult();
                Log.W($"connection test: {(r.Ok ? "OK" : "FAILED")} — {r.Message}");
                if (!r.Ok) return 4;
            }
            if (o.Launch) s.LaunchHivecraft();
            Log.W("RESULT: OK - installed to " + s.Dir);
            return 0;
        }
        catch (Exception e) { Log.Err("unattended", e); Log.W("FAILED: " + e.Message); return 1; }
    }

    public static int Uninstall(Cli cli, string dir)
    {
        try
        {
            var o = new UninstallOptions
            {
                Dir = dir,
                RemoveMinecraftProfile = cli.Has("--remove-minecraft-profile"),
                RemoveUserData = !cli.Has("--keep-user-data"),
                KeepWorlds = !cli.Has("--no-keep-worlds"),
            };
            var done = Uninstaller.RunAsync(o, new Progress<Progress>(x => Log.W(x.Text))).GetAwaiter().GetResult();
            Log.W("RESULT: OK - " + string.Join("; ", done));
            Uninstaller.ScheduleSelfDelete();
            return 0;
        }
        catch (Exception e) { Log.Err("uninstall", e); Log.W("FAILED: " + e.Message); return 1; }
    }
}
