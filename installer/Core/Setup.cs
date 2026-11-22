using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;

namespace Hivecraft.Setup;

/// <summary>What the user picked (wizard or command line).</summary>
sealed class SetupOptions
{
    public string Dir = Places.DefaultInstallDir;
    public bool AcceptEula;
    public string McName = "";
    public string DisplayName = "";
    public string ProviderKind = "claude-login";
    public string BaseUrl = "";
    public string Model = "claude-sonnet-5-5";
    public string SmallModel = "";
    public string? ApiKey;               // never written to the config (DPAPI via Providers)
    public string? ClaudeExe;            // claude-login: found / installed claude.exe
    public bool DesktopShortcut = true;
    public bool StartMenuShortcut = true;
    public bool Launch = true;
    public bool ReuseSystemRuntimes = true;
    public string? PayloadPath;
}

/// <summary>One install step: idempotent, so Retry simply runs it again (downloads resume, finished files are reused).</summary>
sealed class Step
{
    public required string Key, Title;
    public required Func<IProgress<Progress>, CancellationToken, Task<string>> Run;   // returns a short "done" text
    public string State = "waiting";   // waiting | running | done | failed | skipped
    public string Detail = "";
}

/// <summary>The install engine shared by the wizard and --unattended.</summary>
sealed class Setup
{
    public const string SetupExeName = "Hivecraft-Setup.exe";
    public const string PayloadFileName = "Hivecraft-payload.zip";
    public const string AppVersion = "1.0.0";

    public readonly SetupOptions O;
    public Setup(SetupOptions o) { O = o; }

    public string Dir => Path.GetFullPath(O.Dir);
    public string AppDir => Path.Combine(Dir, "app");
    public string RuntimeDir => Path.Combine(Dir, "runtime");
    public string CacheDir => Path.Combine(Dir, "downloads");
    public string ServerDir => Path.Combine(AppDir, "server");
    public string ConfigPath => Path.Combine(AppDir, HiveConfig.FileName);
    public bool IsRepair => File.Exists(ConfigPath) || File.Exists(Path.Combine(AppDir, "Hivecraft.exe"));

    // resolved while running
    public string NodeExe = "", JavaExe = "";
    public bool NodeIsPrivate, JavaIsPrivate;
    public PayloadInfo? Payload;

    // ------------------------------------------------------------------ steps
    /// <summary>Steps of the "Dependencies" page (everything before AI/player setup).</summary>
    public List<Step> DependencySteps() => new()
    {
        new Step { Key = "check", Title = "Check the install folder", Run = CheckFolderAsync },
        new Step { Key = "payload", Title = "Copy the Hivecraft files", Run = ExtractPayloadAsync },
        new Step { Key = "node", Title = "Node.js (runs the agents and the bridge)", Run = NodeAsync },
        new Step { Key = "java", Title = "Java 21 (runs the Minecraft server)", Run = JavaAsync },
        new Step { Key = "server", Title = $"Minecraft server {Deps.McVersion} (from Mojang)", Run = ServerAsync },
        new Step { Key = "npm", Title = "Node packages (mineflayer and friends)", Run = NpmAsync },
    };

    /// <summary>Steps run at the end (after AI + player + shortcut choices).</summary>
    public List<Step> FinishSteps() => new()
    {
        new Step { Key = "config", Title = "Save settings", Run = ConfigAsync },
        new Step { Key = "shortcuts", Title = "Shortcuts and Apps & Features entry", Run = ShortcutsAsync },
    };

    public static async Task<bool> RunStepsAsync(IEnumerable<Step> steps, Action<Step> changed, IProgress<Progress> p, CancellationToken ct)
    {
        foreach (var s in steps)
        {
            if (s.State is "done" or "skipped") continue;
            s.State = "running"; s.Detail = ""; changed(s);
            Log.W($"== step {s.Key}: {s.Title}");
            try
            {
                s.Detail = await s.Run(new SyncProgress(x => { s.Detail = x.Text; changed(s); p.Report(x); }), ct);
                s.State = "done"; changed(s);
                Log.W($"   done: {s.Detail}");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                s.State = "failed"; s.Detail = "Cancelled."; changed(s);
                Log.W($"   cancelled");
                return false;
            }
            catch (Exception e)
            {
                Log.Err(s.Key, e);
                s.State = "failed";
                s.Detail = e is InstallException ? e.Message : $"{s.Title} failed: {e.Message}";
                changed(s);
                return false;
            }
        }
        return true;
    }

    /// <summary>IProgress that reports synchronously (Progress&lt;T&gt; posts to the UI thread itself; the UI marshals).</summary>
    sealed class SyncProgress(Action<Progress> a) : IProgress<Progress> { public void Report(Progress v) => a(v); }

    // ------------------------------------------------------------------ 1. folder
    Task<string> CheckFolderAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var d = Dir;
        if (d.Length > 150) throw new InstallException("The install folder path is too long. Pick a shorter folder (Node packages need short paths).");
        var bad = new[] { Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.System) };
        if (bad.Any(b => !string.IsNullOrEmpty(b) && d.StartsWith(b, StringComparison.OrdinalIgnoreCase))) throw new InstallException("Hivecraft cannot be installed inside the Windows folder. Pick another folder.");
        if (Path.GetPathRoot(d) == d) throw new InstallException("Pick a folder, not a whole drive (for example " + Places.DefaultInstallDir + ").");
        if (Directory.Exists(d) && !IsRepair && Directory.EnumerateFileSystemEntries(d).Any(e => !new[] { "app", "runtime", "downloads", SetupExeName, PayloadFileName }.Contains(Path.GetFileName(e), StringComparer.OrdinalIgnoreCase)))
            throw new InstallException($"{d} already contains other files. Pick an empty folder or a new one (setup only deletes what it installed).");
        Directory.CreateDirectory(d);
        // write test
        var probe = Path.Combine(d, ".write-test");
        try { File.WriteAllText(probe, "ok"); File.Delete(probe); }
        catch (Exception e) { throw new InstallException($"Setup cannot write to {d} ({e.Message}). Pick a folder in your user profile — no admin rights are needed there.", e); }
        var drive = new DriveInfo(Path.GetPathRoot(d)!);
        long freeMb = drive.AvailableFreeSpace / 1048576;
        if (freeMb < 2500) throw new InstallException($"Only {freeMb} MB free on {drive.Name}. Hivecraft needs about 2.5 GB (runtimes, Node packages, Minecraft server, worlds).");
        var running = RunningLauncher(d);
        if (running != null) throw new InstallException("Hivecraft is running from this folder. Close it (TERMINATE, then close the window) and press Retry.");
        return Task.FromResult(IsRepair ? $"Existing install found — updating it (settings, worlds and memory are kept). {freeMb / 1024.0:0.0} GB free." : $"{d} ({freeMb / 1024.0:0.0} GB free)");
    }

    /// <summary>A Hivecraft.exe started from inside dir, if any (we never stop it; the user closes it).</summary>
    public static Process? RunningLauncher(string dir)
    {
        foreach (var p in Process.GetProcessesByName("Hivecraft"))
        {
            try { if (p.MainModule?.FileName is string f && f.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase)) return p; }
            catch (Exception e) { Log.W($"cannot inspect process {p.Id}: {e.Message}"); }
        }
        return null;
    }

    // ------------------------------------------------------------------ 2. payload
    async Task<string> ExtractPayloadAsync(IProgress<Progress> p, CancellationToken ct)
    {
        Payload = PayloadInfo.Open(O.PayloadPath) ?? throw new InstallException(
            "This setup has no Hivecraft files attached (no embedded payload and no " + PayloadFileName + " next to it). Download the full Hivecraft-Setup.exe again.");
        Log.W($"payload: {Payload.Source} version {Payload.Version} nodeModules={Payload.HasNodeModules}");
        int n = await Task.Run(() =>
        {
            using var s = Payload.OpenStream();
            return Zip.Extract(s, AppDir, false, KeepOnUpdate, p, "Hivecraft files", ct);
        }, ct);
        foreach (var d in new[] { "data", "server", "crew\\logs", "crew\\work" }) Directory.CreateDirectory(Path.Combine(AppDir, d));
        if (!File.Exists(Path.Combine(AppDir, "Hivecraft.exe")) || !File.Exists(Path.Combine(AppDir, "bridge", "server.js")))
            throw new InstallException("The attached Hivecraft files are incomplete (Hivecraft.exe or bridge\\server.js missing). Download the setup again.");
        return $"Hivecraft {Payload.Version}: {n} files copied.";
    }

    /// <summary>Repair/update keeps what belongs to the user: settings, data/** (worlds live in server/), edited roster.</summary>
    public static bool KeepOnUpdate(string rel)
    {
        rel = rel.Replace('\\', '/');
        return rel.Equals(HiveConfig.FileName, StringComparison.OrdinalIgnoreCase)
            || rel.StartsWith("data/", StringComparison.OrdinalIgnoreCase)
            || rel.StartsWith("server/", StringComparison.OrdinalIgnoreCase)
            || rel.Equals("crew/roster.json", StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------ 3/4. runtimes
    async Task<string> NodeAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var mine = Path.Combine(RuntimeDir, "node", "node.exe");
        var have = await Task.Run(() => Deps.CheckPrivate(mine, false), ct);
        if (have != null) { NodeExe = mine; NodeIsPrivate = true; return $"Using Hivecraft's Node.js {have.Version}."; }
        bool needNpm = !(Payload?.HasNodeModules ?? false);
        if (O.ReuseSystemRuntimes)
        {
            var sys = await Task.Run(() => Deps.FindSystemNode(needNpm), ct);
            if (sys != null) { NodeExe = sys.Exe; NodeIsPrivate = false; return $"Found Node.js {sys.Version} on this PC ({sys.Exe}) — reusing it."; }
        }
        NodeExe = await Deps.InstallNodeAsync(RuntimeDir, CacheDir, p, ct);
        NodeIsPrivate = true;
        return "Node.js downloaded and verified (SHA-256).";
    }

    async Task<string> JavaAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var mine = Path.Combine(RuntimeDir, "java", "bin", "java.exe");
        var have = await Task.Run(() => Deps.CheckPrivate(mine, true), ct);
        if (have != null) { JavaExe = mine; JavaIsPrivate = true; return $"Using Hivecraft's Java ({have.Version})."; }
        if (O.ReuseSystemRuntimes)
        {
            var sys = await Task.Run(Deps.FindSystemJava, ct);
            if (sys != null) { JavaExe = sys.Exe; JavaIsPrivate = false; return $"Found Java {sys.Major} on this PC ({sys.Exe}) — reusing it."; }
        }
        JavaExe = await Deps.InstallJavaAsync(RuntimeDir, CacheDir, p, ct);
        JavaIsPrivate = true;
        return "Java 21 (Eclipse Temurin JRE) downloaded and verified (SHA-256).";
    }

    // ------------------------------------------------------------------ 5. server
    async Task<string> ServerAsync(IProgress<Progress> p, CancellationToken ct)
    {
        if (!O.AcceptEula) throw new InstallException("Please read the Minecraft EULA and tick “I accept” — the Minecraft server cannot run without it.");
        Directory.CreateDirectory(ServerDir);
        await Deps.InstallServerJarAsync(ServerDir, p, ct);
        var cfg = LoadOrNewConfig();
        WriteServerFiles(ServerDir, cfg, DateTime.Now);
        return $"server.jar verified (SHA-1), EULA accepted, server.properties ready (port {cfg.Server.Port}, offline mode, RCON on).";
    }

    public const string ServerPropsTemplate =
        "#Minecraft server properties (written by Hivecraft setup)\n" +
        "motd=Hivecraft\nlevel-name=world\nlevel-seed=\ngamemode=survival\ndifficulty=easy\nmax-players=20\n" +
        "online-mode=false\nenforce-secure-profile=true\nspawn-protection=0\nview-distance=8\nsimulation-distance=8\n" +
        "player-idle-timeout=0\nallow-nether=true\npvp=true\nenable-command-block=true\nspawn-animals=true\nspawn-monsters=true\nspawn-npcs=true\n" +
        "server-ip=127.0.0.1\nserver-port=25590\nenable-rcon=true\nrcon.port=25591\nrcon.password=\nbroadcast-rcon-to-ops=true\n";

    /// <summary>eula.txt (only called after the user accepted) + server.properties (template on first install, our keys
    /// applied over an existing file on repair: level name/seed and every other setting the user changed stay).</summary>
    public static void WriteServerFiles(string serverDir, HiveConfig cfg, DateTime now)
    {
        Directory.CreateDirectory(serverDir);
        File.WriteAllText(Path.Combine(serverDir, "eula.txt"),
            "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n" +
            "#Accepted in Hivecraft setup on " + now.ToString("ddd MMM dd HH:mm:ss yyyy") + "\neula=true\n", new UTF8Encoding(false));
        var sp = Path.Combine(serverDir, "server.properties");
        var text = File.Exists(sp) ? File.ReadAllText(sp) : ServerPropsTemplate;
        text = FileEdits.ApplyServerProps(text, false, "", "", cfg);
        // offline-mode server + RCON: listen on this PC only (no LAN joins under someone else's name, no firewall prompt)
        if (string.IsNullOrWhiteSpace(FileEdits.GetProp(text, "server-ip"))) text = SetProp(text, "server-ip", "127.0.0.1");
        File.WriteAllText(sp, text, new UTF8Encoding(false));
    }

    static string SetProp(string text, string key, string val)
    {
        var lines = text.Replace("\r\n", "\n").TrimEnd('\n').Split('\n').ToList();
        int i = lines.FindIndex(l => !l.StartsWith('#') && l.Contains('=') && l[..l.IndexOf('=')].Trim() == key);
        if (i >= 0) lines[i] = key + "=" + val; else lines.Add(key + "=" + val);
        return string.Join("\n", lines) + "\n";
    }

    // ------------------------------------------------------------------ 6. npm
    async Task<string> NpmAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var nm = Path.Combine(AppDir, "node_modules");
        if (Payload?.HasNodeModules == true && Directory.Exists(nm)) return "Node packages came with the setup (no download needed).";
        var lockFile = Path.Combine(AppDir, "package-lock.json");
        var stamp = Path.Combine(nm, ".hivecraft-lock.sha256");
        string lockHash = File.Exists(lockFile) ? await Net.HashFileAsync(lockFile, "sha256", ct) : "";
        if (lockHash != "" && File.Exists(stamp) && File.ReadAllText(stamp).Trim() == lockHash && Directory.Exists(Path.Combine(nm, "mineflayer")))
            return "Node packages are already up to date.";
        if (string.IsNullOrEmpty(NodeExe)) throw new InstallException("Node.js is not ready yet — press Retry.");
        var cli = Deps.NpmCli(NodeExe);
        if (!File.Exists(cli)) throw new InstallException($"npm was not found next to {NodeExe}. Untick reuse or press Retry to download Hivecraft's own Node.js.");
        var args = $"\"{cli}\" {(File.Exists(lockFile) ? "ci" : "install")} --omit=dev --no-audit --no-fund --loglevel=error --no-update-notifier";
        p.Report(new Progress("Node packages: downloading from the npm registry (about 250 MB, a few minutes)…"));
        var psi = new ProcessStartInfo(NodeExe, args)
        {
            WorkingDirectory = AppDir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        psi.Environment["PATH"] = Path.GetDirectoryName(NodeExe) + ";" + Environment.GetEnvironmentVariable("PATH");
        psi.Environment["npm_config_cache"] = Path.Combine(CacheDir, "npm-cache");
        psi.Environment["PUPPETEER_SKIP_DOWNLOAD"] = "1";
        psi.Environment["NODE_OPTIONS"] = "";
        Log.W($"npm: {NodeExe} {args} (cwd {AppDir})");
        var tail = new Queue<string>();
        using var proc = new Process { StartInfo = psi };
        void Line(string? l)
        {
            if (string.IsNullOrWhiteSpace(l)) return;
            Log.W("npm> " + l);
            lock (tail) { tail.Enqueue(l); if (tail.Count > 8) tail.Dequeue(); }
        }
        proc.OutputDataReceived += (_, e) => Line(e.Data);
        proc.ErrorDataReceived += (_, e) => Line(e.Data);
        proc.Start();
        proc.BeginOutputReadLine(); proc.BeginErrorReadLine();
        var t0 = DateTime.UtcNow;
        while (!proc.HasExited)
        {
            try { await Task.Delay(1000, ct); }
            catch (OperationCanceledException) { try { proc.Kill(true); } catch (Exception k) { Log.W("npm: could not stop: " + k.Message); } throw; }
            var secs = (int)(DateTime.UtcNow - t0).TotalSeconds;
            long mb = 0;
            try { if (Directory.Exists(nm) && secs % 5 == 0) mb = DirSizeMb(nm); } catch (Exception e) { Log.W("npm size probe: " + e.Message); }
            p.Report(new Progress($"Node packages: installing… {secs / 60}:{secs % 60:00}{(mb > 0 ? $" ({mb} MB so far)" : "")}"));
            if (secs > 1800) { try { proc.Kill(true); } catch (Exception k) { Log.W("npm: could not stop: " + k.Message); } throw new InstallException("Installing Node packages took over 30 minutes and was stopped. Check your internet connection and press Retry."); }
        }
        proc.WaitForExit();
        if (proc.ExitCode != 0)
        {
            string last; lock (tail) last = string.Join("\n", tail);
            throw new InstallException($"Installing Node packages failed (npm exit code {proc.ExitCode}). Check your internet connection and press Retry.\n{last}");
        }
        if (!Directory.Exists(Path.Combine(nm, "mineflayer"))) throw new InstallException("npm finished but mineflayer is missing from node_modules. Press Retry.");
        if (lockHash != "") File.WriteAllText(stamp, lockHash);
        return $"Node packages installed ({DirSizeMb(nm)} MB).";
    }

    static long DirSizeMb(string d) => new DirectoryInfo(d).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1048576;

    // ------------------------------------------------------------------ finish: config
    public HiveConfig LoadOrNewConfig()
    {
        var c = File.Exists(ConfigPath) ? HiveConfig.Load(AppDir) : new HiveConfig().WithRoot(AppDir);
        if (c.LoadError != null) Log.W("existing config unreadable, starting fresh: " + c.LoadError);
        // a real random RCON password (replaces the legacy dev default)
        if (string.IsNullOrEmpty(c.Server.RconPassword) || c.Server.RconPassword == HiveConfig.LegacyRconPassword) c.Server.RconPassword = HiveConfig.NewRconPassword();
        if (!File.Exists(ConfigPath)) SaveConfig(c);   // so later steps (server.properties) and a resumed setup use the same password
        return c;
    }

    void SaveConfig(HiveConfig c)
    {
        Directory.CreateDirectory(AppDir);
        c.Save(ConfigPath);
    }

    /// <summary>Path stored in the config: relative to app\ for our private runtimes (the folder can move), absolute otherwise.</summary>
    string RuntimeRef(string exe, bool isPrivate, string fallback)
    {
        if (string.IsNullOrEmpty(exe)) return fallback;
        return isPrivate ? Path.GetRelativePath(AppDir, exe) : exe;
    }

    async Task<string> ConfigAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var c = LoadOrNewConfig();
        c.Version = Math.Max(c.Version, 1);
        if (!string.IsNullOrWhiteSpace(O.McName)) c.Player.McName = O.McName.Trim();
        if (!string.IsNullOrWhiteSpace(O.DisplayName)) c.Player.DisplayName = O.DisplayName.Trim();
        else if (string.IsNullOrWhiteSpace(c.Player.DisplayName)) c.Player.DisplayName = c.Player.McName;
        c.Provider.Kind = O.ProviderKind;
        c.Provider.BaseUrl = O.BaseUrl.Trim();
        c.Provider.Model = O.Model.Trim();
        c.Provider.SmallModel = O.SmallModel.Trim();
        c.Runtime.Node = RuntimeRef(NodeExe, NodeIsPrivate, c.Runtime.Node);
        c.Runtime.Java = RuntimeRef(JavaExe, JavaIsPrivate, c.Runtime.Java);
        if (!string.IsNullOrEmpty(O.ClaudeExe)) c.Runtime.Claude = O.ClaudeExe;
        if (string.IsNullOrWhiteSpace(c.Server.Dir)) c.Server.Dir = "server";
        c.Minecraft.Dir = Places.McDirIsCustom ? Places.McDir : c.Minecraft.Dir;
        SaveConfig(c);
        // server.properties must match the config (ports + RCON password)
        if (File.Exists(Path.Combine(ServerDir, "server.jar")) && O.AcceptEula) WriteServerFiles(ServerDir, c, DateTime.Now);
        var keyNote = await ProviderGlue.SaveKeyAsync(O, ct);
        return $"Settings saved ({HiveConfig.FileName}). {keyNote}";
    }

    // ------------------------------------------------------------------ finish: shortcuts + uninstall entry
    Task<string> ShortcutsAsync(IProgress<Progress> p, CancellationToken ct)
    {
        var exe = Path.Combine(AppDir, "Hivecraft.exe");
        var setupCopy = Path.Combine(Dir, SetupExeName);
        CopySelfInto(setupCopy);
        var made = new List<string>();
        RemoveShortcuts();
        if (O.DesktopShortcut) { Shortcut.Create(Places.DesktopLink, exe, "", AppDir, "Hivecraft: AI agents playing Minecraft with you"); made.Add("Desktop"); }
        if (O.StartMenuShortcut)
        {
            Shortcut.Create(Places.StartLink, exe, "", AppDir, "Hivecraft: AI agents playing Minecraft with you");
            Shortcut.Create(Places.StartUninstallLink, setupCopy, "--uninstall", Dir, "Uninstall or repair Hivecraft", exe);
            made.Add("Start menu");
        }
        long kb = 0;
        try { kb = new DirectoryInfo(Dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024; }
        catch (Exception e) { Log.W("size estimate failed: " + e.Message); }
        UninstallEntry.Write(Dir, Payload?.Version ?? AppVersion, kb);
        made.Add("Apps & Features");
        return Task.FromResult("Added: " + string.Join(", ", made) + ".");
    }

    public static void RemoveShortcuts()
    {
        Log.TryDelete(Places.DesktopLink);
        Log.TryDelete(Places.StartLink);
        Log.TryDelete(Places.StartUninstallLink);
        try { if (Directory.Exists(Places.StartMenuDir) && !Directory.EnumerateFileSystemEntries(Places.StartMenuDir).Any()) Directory.Delete(Places.StartMenuDir); }
        catch (Exception e) { Log.W("cleanup: start menu folder: " + e.Message); }
    }

    /// <summary>Keep a copy of this setup (with its payload) in the install folder for repair/uninstall.</summary>
    void CopySelfInto(string dest)
    {
        var me = Environment.ProcessPath;
        if (me == null || !me.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || Path.GetFileName(me).Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase)) return;
        if (!string.Equals(Path.GetFullPath(me), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(me, dest + ".new", true);
            File.Move(dest + ".new", dest, true);
        }
        // a sibling payload (not embedded) has to come along, or repair would have nothing to install
        if (Payload?.Source is string src && src.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) && File.Exists(src))
        {
            var pd = Path.Combine(Dir, PayloadFileName);
            if (!string.Equals(Path.GetFullPath(src), Path.GetFullPath(pd), StringComparison.OrdinalIgnoreCase)) File.Copy(src, pd, true);
        }
    }

    public void LaunchHivecraft()
    {
        var exe = Path.Combine(AppDir, "Hivecraft.exe");
        Log.W("launching " + exe);
        Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = AppDir, UseShellExecute = true });
    }
}

/// <summary>The app zip: --payload file, else embedded resource "payload.zip", else Hivecraft-payload.zip next to the exe.</summary>
sealed class PayloadInfo
{
    public string Source = "";            // file path or "embedded"
    public string Version = Setup.AppVersion;
    public bool HasNodeModules;
    Func<Stream> _open = () => Stream.Null;
    public Stream OpenStream() => _open();

    public static PayloadInfo? Open(string? explicitPath)
    {
        PayloadInfo? pi = null;
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            var f = Path.GetFullPath(explicitPath);
            if (!File.Exists(f)) throw new InstallException("Payload file not found: " + f);
            pi = new PayloadInfo { Source = f, _open = () => File.OpenRead(f) };
        }
        else if (Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.zip") != null)
            pi = new PayloadInfo { Source = "embedded", _open = () => Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")! };
        else
        {
            foreach (var dir in new[] { Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "", AppContext.BaseDirectory })
            {
                var f = Path.Combine(dir, Setup.PayloadFileName);
                if (dir != "" && File.Exists(f)) { pi = new PayloadInfo { Source = f, _open = () => File.OpenRead(f) }; break; }
            }
        }
        if (pi == null) return null;
        using (var s = pi.OpenStream())
        using (var za = new System.IO.Compression.ZipArchive(s, System.IO.Compression.ZipArchiveMode.Read))
        {
            var m = za.GetEntry("manifest.json");
            if (m != null)
            {
                using var r = new StreamReader(m.Open());
                var j = JsonNode.Parse(r.ReadToEnd());
                pi.Version = (string?)j?["version"] ?? pi.Version;
                pi.HasNodeModules = (bool?)j?["hasNodeModules"] ?? false;
            }
        }
        return pi;
    }
}
