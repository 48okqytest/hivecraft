using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hivecraft;

class StartConfig
{
    public List<string> Names { get; set; } = new();
    public string Model { get; set; } = "claude-sonnet-5-5";
    public List<string> Personas { get; set; } = new();
    public bool NewWorld { get; set; } = true;
    public string Seed { get; set; } = "";
    public string GameMode { get; set; } = "survival";
    public bool Economy { get; set; } = true;
    public bool OverlayMod { get; set; } = true;
    /// <summary>Extra env for the crew only (provider key etc., Providers.CrewEnv); the bridge never gets it.</summary>
    public Dictionary<string, string> ProviderEnv { get; set; } = new();
}

/// <summary>A child process we own: stdout/stderr lines are forwarded, it lives in the Job Object.</summary>
sealed class Managed
{
    public string Name = "";
    public Process? P;
    public bool Alive { get { try { return P != null && !P.HasExited; } catch { return false; } } }
    public int ExitCode { get { try { return P?.ExitCode ?? -1; } catch { return -1; } } }
    public readonly List<string> Tail = new();
    public event Action<int>? Exited;

    public void Start(string file, string args, string cwd, Action<string, string> log, Action<string>? lineHook = null, string? logFile = null, IDictionary<string, string>? env = null)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        if (env != null) foreach (var kv in env) psi.Environment[kv.Key] = kv.Value;
        P = new Process { StartInfo = psi, EnableRaisingEvents = true };
        StreamWriter? lf = null;
        if (logFile != null) { try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)!); lf = new StreamWriter(new FileStream(logFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true }; } catch { } }
        void Line(string? l)
        {
            if (l == null) return;
            lock (Tail) { Tail.Add(l); if (Tail.Count > 30) Tail.RemoveAt(0); }
            try { lf?.WriteLine(l); } catch { }
            log(Name, l);
            try { lineHook?.Invoke(l); } catch { }
        }
        P.OutputDataReceived += (_, e) => Line(e.Data);
        P.ErrorDataReceived += (_, e) => Line(e.Data);
        P.Exited += (_, _) => { try { Exited?.Invoke(P!.ExitCode); } catch { } try { lf?.Dispose(); } catch { } };
        P.Start();
        Job.Add(P);
        P.BeginOutputReadLine();
        P.BeginErrorReadLine();
    }

    public void Send(string line)
    {
        try { if (Alive) { P!.StandardInput.WriteLine(line); P.StandardInput.Flush(); } } catch { }
    }

    public string TailText() { lock (Tail) return string.Join("\n", Tail.TakeLast(6)); }
}

sealed class Orchestrator
{
    // ports/paths come from <root>\hivecraft.config.json (HiveConfig; defaults = the classic dev values)
    static HiveConfig? _cfgStatic;
    /// <summary>The app's hivecraft.config.json (loaded once from FindRoot(); Reload() re-reads it).</summary>
    public static HiveConfig Cfg => _cfgStatic ??= LoadCfg(FindRoot());
    public static HiveConfig Reload(string? root = null) => _cfgStatic = LoadCfg(root ?? FindRoot());
    static HiveConfig LoadCfg(string root)
    {
        var c = HiveConfig.Load(root);
        FileEdits.JoinPort = c.Server.Port;
        return c;
    }
    public static int ServerPort => Cfg.Server.Port;
    public static int RconPort => Cfg.Server.RconPort;
    public static int BridgePort => Cfg.Bridge.Port;
    public static string Base => Cfg.BridgeBase;
    public static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(4) };

    public readonly string Root;
    public event Action<string, string>? OnLog;      // source, line
    public event Action<string>? OnStatus;           // current step
    public event Action<string>? OnHint;             // hint banner text
    public event Action? OnProcessChange;            // a child exited / became ready

    public Managed Server = new() { Name = "server" }, Bridge = new() { Name = "bridge" }, Crew = new() { Name = "crew" };
    public volatile bool ServerReady;
    public volatile bool Running;                    // between a successful Start and Terminate
    readonly SemaphoreSlim _gate = new(1, 1);
    readonly HashSet<string> _handled = new(StringComparer.OrdinalIgnoreCase);
    StartConfig _cfg = new();

    public Orchestrator(string root)
    {
        Root = root;
        Hc = Reload(root);
        if (Hc.LoadError != null) Log("launcher", "hivecraft.config.json unreadable, using defaults: " + Hc.LoadError);
    }

    /// <summary>This run's config (same object as Cfg).</summary>
    public readonly HiveConfig Hc;

    /// <summary>App root = the folder holding bridge\server.js: HIVECRAFT_ROOT, the exe's folder or one of its parents
    /// (dev builds run from launcher\bin\…\ or launcher\publish\); else the exe folder.</summary>
    public static string FindRoot()
    {
        var exeDir = AppContext.BaseDirectory.TrimEnd('\\');
        var cands = new List<string>();
        for (var d = new DirectoryInfo(exeDir); d != null && cands.Count < 6; d = d.Parent) cands.Add(d.FullName);
        var env = Environment.GetEnvironmentVariable("HIVECRAFT_ROOT");
        if (!string.IsNullOrWhiteSpace(env)) cands.Insert(0, env.Trim().Trim('"'));
        foreach (var d in cands)
            if (File.Exists(Path.Combine(d, "bridge", "server.js"))) return Path.GetFullPath(d);
        return exeDir;
    }

    string ServerDir => Hc.ServerDir;
    string DataDir => Path.Combine(Root, "data");
    /// <summary>.minecraft: minecraft.dir from the config, else %APPDATA%\.minecraft.</summary>
    public static string McDir => Cfg.McDir;

    void Log(string src, string line) => OnLog?.Invoke(src, line);
    void Step(string s) { OnStatus?.Invoke(s); Log("launcher", s); }

    // ---------------------------------------------------------------- helpers
    static bool PortListening(int port)
    {
        try { return IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port); } catch { return false; }
    }

    public static async Task<bool> BridgeHealthy()
    {
        try { using var r = await Http.GetAsync(Base + "/health"); return r.IsSuccessStatusCode; } catch { return false; }
    }

    static void TaskKill(int pid)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo("taskkill", $"/PID {pid} /T /F") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true });
            p?.WaitForExit(8000);
        }
        catch { }
    }

    static async Task<string> RunPowerShell(string script, int timeoutMs = 15000)
    {
        var enc = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + enc)
        { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        using var p = Process.Start(psi)!;
        var outTask = p.StandardOutput.ReadToEndAsync();
        if (!p.WaitForExit(timeoutMs)) { try { p.Kill(true); } catch { } }
        return await outTask;
    }

    static string ScanScript => ScanScriptTemplate.Replace("47960,25590", BridgePort + "," + ServerPort);
    const string ScanScriptTemplate = @"
$ErrorActionPreference='SilentlyContinue'
$all=@(Get-CimInstance Win32_Process)
foreach($p in $all){
  $c=$p.CommandLine; if(-not $c){continue}
  if($p.Name -eq 'claude.exe' -and $c -match 'crew.work'){ ""claude $($p.ProcessId)"" }
  elseif($p.Name -eq 'node.exe' -and $c -match 'mc-mcp\.js' -and $c -match 'Hivecraft'){ ""mcp $($p.ProcessId)"" }
  elseif($p.Name -eq 'node.exe' -and $c -match 'crew[\\/]crew\.js'){
    $kids=@($all | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.CommandLine -match 'crew.work' })
    if($c -match 'Hivecraft' -or $kids.Count -gt 0){ ""crew $($p.ProcessId)"" } }
}
foreach($t in @(Get-NetTCPConnection -State Listen -LocalPort 47960,25590)){
  $pr=$all | Where-Object { $_.ProcessId -eq $t.OwningProcess } | Select-Object -First 1
  ""port$($t.LocalPort) $($t.OwningProcess) $($pr.Name)""
}";

    record Found(string Kind, int Pid, string Name);

    static async Task<List<Found>> ScanPrevious()
    {
        var res = new List<Found>();
        string o;
        try { o = await RunPowerShell(ScanScript); } catch { return res; }
        foreach (var l in o.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = l.Split(' ');
            if (parts.Length >= 2 && int.TryParse(parts[1], out var pid))
                res.Add(new Found(parts[0], pid, parts.Length > 2 ? parts[2] : ""));
        }
        return res;
    }

    // ---------------------------------------------------------------- stop
    public async Task StopAllAsync(Action<string>? say = null)
    {
        say ??= s => Step(s);
        var found = await ScanPrevious();

        // 1. crew (+ every claude.exe child): kill the whole tree
        if (Crew.Alive) { say("Stopping agents…"); TaskKill(Crew.P!.Id); }
        foreach (var f in found.Where(f => f.Kind == "crew")) { say($"Stopping old crew (pid {f.Pid})…"); TaskKill(f.Pid); }
        foreach (var f in found.Where(f => f.Kind is "claude" or "mcp")) TaskKill(f.Pid);

        // 2. bridge: graceful shutdown, then kill
        bool bridgeUp = Bridge.Alive || found.Any(f => f.Kind == "port" + BridgePort) || PortListening(BridgePort);
        if (bridgeUp)
        {
            say("Stopping bridge…");
            try { using var r = await Http.PostAsync(Base + "/admin/shutdown", new StringContent("{}", Encoding.UTF8, "application/json")); } catch { }
            for (int i = 0; i < 25 && (Bridge.Alive || PortListening(BridgePort)); i++) await Task.Delay(200);
            if (Bridge.Alive) TaskKill(Bridge.P!.Id);
            foreach (var f in found.Where(f => f.Kind == "port" + BridgePort && f.Name.StartsWith("node", StringComparison.OrdinalIgnoreCase))) TaskKill(f.Pid);
            for (int i = 0; i < 15 && PortListening(BridgePort); i++) await Task.Delay(200);
        }

        // 3. Minecraft server: stdin 'stop' (ours) or RCON 'stop' (foreign), then kill
        if (Server.Alive)
        {
            say("Saving and stopping Minecraft server…");
            Server.Send("stop");
            try { await Task.Run(() => Server.P!.WaitForExit(30000)); } catch { }
            if (Server.Alive) { say("Server did not stop in 30 s — killing it."); TaskKill(Server.P!.Id); }
        }
        else if (PortListening(ServerPort))
        {
            say("Stopping old Minecraft server (RCON)…");
            try { await Rcon.SendAsync("stop", Hc.Server.RconPassword, RconPort); } catch (Exception e) { Log("launcher", "rcon: " + e.Message); }
            for (int i = 0; i < 100 && PortListening(ServerPort); i++) await Task.Delay(300);
            if (PortListening(ServerPort))
            {
                foreach (var f in found.Where(f => f.Kind == "port" + ServerPort && f.Name.StartsWith("java", StringComparison.OrdinalIgnoreCase))) { say("Killing old server."); TaskKill(f.Pid); }
            }
        }
        ServerReady = false;
        Running = false;
        OnProcessChange?.Invoke();
    }

    public async Task TerminateAsync()
    {
        _startCts?.Cancel();
        await _gate.WaitAsync();
        try
        {
            OnStatus?.Invoke("Stopping…");
            await StopAllAsync();
            OnStatus?.Invoke("Stopped");
            Log("launcher", "Stopped.");
        }
        finally { _gate.Release(); }
    }

    // ---------------------------------------------------------------- start
    CancellationTokenSource? _startCts;

    public async Task StartAsync(StartConfig cfg)
    {
        _cfg = cfg;
        _startCts = new CancellationTokenSource();
        var ct = _startCts.Token;
        if (!await _gate.WaitAsync(0)) throw new InvalidOperationException("Already starting.");
        try
        {
            _handled.Clear();
            ServerReady = false;

            // 1 -- clear leftovers
            Step("Checking for a previous run…");
            await StopAllAsync(s => Step(s));
            ct.ThrowIfCancellationRequested();

            if (!File.Exists(Path.Combine(ServerDir, "server.jar"))) throw new Exception($"The Minecraft server (server.jar) is missing in {ServerDir}. Run Hivecraft-Setup again (Repair) to download it.");
            if (!File.Exists(Path.Combine(Root, "bridge", "server.js"))) throw new Exception("bridge\\server.js is missing next to Hivecraft.");

            // 2 -- server.properties
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            Step(cfg.NewWorld ? "Preparing a new world…" : "Continuing the last world…");
            FileEdits.WriteServerProps(Path.Combine(ServerDir, "server.properties"), cfg.NewWorld, "worlds/world-" + stamp, cfg.Seed, Hc);

            // 3 -- fresh team state
            if (cfg.NewWorld)
            {
                Step("Archiving old team memory…");
                var dest = FileEdits.ArchiveState(Root, stamp);
                Log("launcher", "archived to " + dest);
            }
            ct.ThrowIfCancellationRequested();

            // 4 -- server
            Step("Starting Minecraft server (this takes a minute)…");
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Server = new Managed { Name = "server" };
            Server.Exited += code => done.TrySetException(new Exception($"Minecraft server exited (code {code}).\n{Server.TailText()}"));
            Log("launcher", $"java: {Hc.JavaExe}   node: {Hc.NodeExe}");
            Server.Start(Hc.JavaExe, "-Xms1G -Xmx3G -jar server.jar nogui", ServerDir, Log, l =>
            {
                if (l.Contains("Done (") && l.Contains("For help")) { ServerReady = true; done.TrySetResult(); OnProcessChange?.Invoke(); }
                var m = JoinRx.Match(l);
                if (m.Success) OnJoin(m.Groups[1].Value);
            });
            await WaitTask(done.Task, 240, "Minecraft server did not finish starting within 240 s.", ct);
            Step("Minecraft server is up.");
            Server.Exited += code => { OnStatus?.Invoke($"Server exited (code {code})"); OnProcessChange?.Invoke(); };

            // 5 -- bridge
            Step("Starting bridge…");
            Bridge = new Managed { Name = "bridge" };
            OverlayMod = cfg.OverlayMod;
            var featureEnv = new Dictionary<string, string> { ["HIVE_ECONOMY"] = cfg.Economy ? "1" : "0" };
            Log("launcher", $"Economy {(cfg.Economy ? "ON" : "OFF")}, overlay mod {(cfg.OverlayMod ? "ON" : "OFF")}");
            Bridge.Start(Hc.NodeExe, $"\"{Path.Combine(Root, "bridge", "server.js")}\"", Root, Log, null, Path.Combine(DataDir, "bridge.log"), featureEnv);
            var t0 = DateTime.UtcNow;
            while (!await BridgeHealthy())
            {
                ct.ThrowIfCancellationRequested();
                if (!Bridge.Alive) throw new Exception("Bridge exited early.\n" + Bridge.TailText());
                if ((DateTime.UtcNow - t0).TotalSeconds > 30) throw new Exception($"Bridge did not become healthy within 30 s (port {BridgePort}).");
                await Task.Delay(500, ct);
            }
            Bridge.Exited += code => { OnStatus?.Invoke($"Bridge exited (code {code})"); OnProcessChange?.Invoke(); };
            Step("Bridge is up.");

            // 6 -- goal
            if (cfg.NewWorld)
            {
                try
                {
                    var body = JsonSerializer.Serialize(new
                    {
                        text = $"No task yet. Say hi, then WAIT: do nothing until {Hc.HumanName} gives the team a task in chat (check_messages wait_seconds=60 repeatedly).",
                        by = Hc.HumanName
                    });
                    using var r = await Http.PostAsync(Base + "/goal", new StringContent(body, Encoding.UTF8, "application/json"));
                    if (!r.IsSuccessStatusCode) Log("launcher", "goal POST -> " + (int)r.StatusCode);
                }
                catch (Exception e) { Log("launcher", "goal POST failed: " + e.Message); }
            }

            // 7 -- crew
            Step("Starting agents…");
            Crew = new Managed { Name = "crew" };
            var personaFile = Path.Combine(DataDir, "personalities.json");
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(personaFile, Settings.PersonasJson(cfg.Names, cfg.Personas), new System.Text.UTF8Encoding(false));
            var crewArgs = $"\"{Path.Combine(Root, "crew", "crew.js")}\" --names {string.Join(",", cfg.Names)} --model \"{cfg.Model}\" --minutes 0 --personas \"{personaFile}\"" + (cfg.NewWorld ? "" : " --continue");
            var crewEnv = new Dictionary<string, string>(featureEnv);
            foreach (var kv in cfg.ProviderEnv) crewEnv[kv.Key] = kv.Value;
            Crew.Start(Hc.NodeExe, crewArgs, Root, Log, null, Path.Combine(DataDir, "crew.log"), crewEnv);
            for (int i = 0; i < 12; i++)
            {
                await Task.Delay(250, ct);
                if (!Crew.Alive) throw new Exception($"Agents failed to start (exit {Crew.ExitCode}).\n{Crew.TailText()}");
            }
            Crew.Exited += code => { OnStatus?.Invoke(code == 0 ? "Agents finished." : $"Agents exited (code {code})"); OnProcessChange?.Invoke(); };

            Running = true;
            OnProcessChange?.Invoke();
            Step("Team is running — agents are joining.");

            // 8 -- Minecraft
            try { await OpenMinecraftAsync(); } catch (Exception e) { Log("launcher", "open Minecraft: " + e.Message); OnHint?.Invoke($"Could not open Minecraft automatically. Open the launcher and join localhost:{ServerPort}."); }
        }
        catch (OperationCanceledException)
        {
            Log("launcher", "Start cancelled.");
        }
        catch
        {
            // clean stop on any failure, then surface the error
            try { await StopAllAsync(s => Log("launcher", s)); } catch { }
            throw;
        }
        finally { _gate.Release(); }
    }

    static readonly Regex JoinRx = new(@"\]: (\w{3,16}) joined the game\s*$");

    static async Task WaitTask(Task t, int seconds, string timeoutMsg, CancellationToken ct)
    {
        var win = await Task.WhenAny(t, Task.Delay(TimeSpan.FromSeconds(seconds), ct));
        ct.ThrowIfCancellationRequested();
        if (win != t) throw new Exception(timeoutMsg);
        await t;
    }

    void OnJoin(string name)
    {
        if (_cfg.Names.Any(n => n.Equals(name, StringComparison.OrdinalIgnoreCase))) return;
        if (!_handled.Add(name)) return;
        Log("launcher", $"{name} joined — op + {_cfg.GameMode}");
        _ = Task.Run(async () =>
        {
            await Task.Delay(1500);
            Server.Send($"op {name}");
            Server.Send($"gamemode {_cfg.GameMode} {name}");
            await Task.Delay(300);
            Server.Send("tellraw " + name + " [{\"text\":\"[Hivecraft] \",\"color\":\"gold\",\"bold\":true},{\"text\":\"Welcome! Type the team's task right here in chat (e.g. \\\"build a house by the lake\\\") - your agents answer you first.\",\"color\":\"white\",\"bold\":false}]");
        });
    }

    // ---------------------------------------------------------------- Minecraft launcher
    static List<Process> LauncherProcesses()
    {
        var list = new List<Process>();
        foreach (var name in new[] { "Minecraft", "MinecraftLauncher" })
            foreach (var p in Process.GetProcessesByName(name))
            {
                string? path = null;
                try { path = p.MainModule?.FileName; } catch { }
                // only the Store launcher (never javaw/java, never a game window)
                if (path != null && path.Contains(@"\WindowsApps\Microsoft.4297127D64EC6", StringComparison.OrdinalIgnoreCase)) list.Add(p);
            }
        return list;
    }

    public static bool MinecraftLauncherRunning() => LauncherProcesses().Count > 0;

    /// <summary>Opens the Minecraft Launcher: the Microsoft Store / Xbox app one if installed, else the classic minecraft.net one.</summary>
    void StartMinecraftLauncher()
    {
        bool store = Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Packages", "Microsoft.4297127D64EC6_8wekyb3d8bbwe"));
        if (!store)
        {
            var classic = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Minecraft Launcher", "MinecraftLauncher.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Minecraft Launcher", "MinecraftLauncher.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Minecraft Launcher", "MinecraftLauncher.exe"),
            }.FirstOrDefault(File.Exists);
            if (classic != null)
            {
                Log("launcher", "Opening the Minecraft Launcher: " + classic);
                Process.Start(new ProcessStartInfo(classic) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(classic)! });
                return;
            }
            Log("launcher", "No Store Minecraft Launcher package found; trying the app entry anyway.");
        }
        Process.Start(new ProcessStartInfo("explorer.exe", @"shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft") { UseShellExecute = false });
    }

    /// <summary>The launcher rewrites launcher_profiles.json from memory, so it must be closed before we edit it. Only the Store launcher is closed (never the game). Returns true if one was closed.</summary>
    public static async Task<bool> CloseMinecraftLauncherAsync(Action<string> log)
    {
        var running = LauncherProcesses();
        if (running.Count == 0) return false;
        log($"Closing the running Minecraft launcher ({running.Count} processes) to select the Hivecraft profile…");
        foreach (var p in running) { try { p.Kill(true); } catch { } }
        for (int i = 0; i < 25 && LauncherProcesses().Count > 0; i++) await Task.Delay(200);
        if (LauncherProcesses().Count > 0) log("launcher still shutting down; continuing anyway");
        await Task.Delay(500);
        return true;
    }

    /// <summary>False = plain Minecraft (vanilla auto-join version, no Fabric / overlay mod).</summary>
    public bool OverlayMod { get; set; } = true;

    public async Task OpenMinecraftAsync()
    {
        if (!OverlayMod)
        {
            Step("Preparing Minecraft (overlay mod off: plain Minecraft)…");
            FileEdits.EnsureVersion(McDir); // writes the vanilla auto-join version json over the Fabric one
            await CloseMinecraftLauncherAsync(m => Log("launcher", m));
            FileEdits.WriteProfile(McDir, Fabric.GameDir(McDir));
            Log("launcher", "Hivecraft profile selected in the Minecraft launcher (game folder " + Fabric.GameDir(McDir) + ").");
            StartMinecraftLauncher();
            OnHint?.Invoke("Overlay mod is OFF: plain Minecraft.\nIn the launcher pick “Hivecraft” and press PLAY — it joins the server automatically.\nFirst time only: tick “Don’t warn me again” and press Play.");
            return;
        }
        // Fabric + Fabric API + the Hivecraft Overlay mod (Core/Fabric.cs). Never throws: on any problem the version is
        // the plain vanilla auto-join one and Problem says why (shown in the log and the hint below).
        Step("Preparing Minecraft (Fabric + Hivecraft Overlay mod)…");
        var fab = await Fabric.InstallAsync(McDir, Root, s => Log("launcher", s));
        if (fab.Fabric) Step($"Hivecraft Overlay mod installed (Fabric {fab.Loader}, {fab.FabricApi}).");
        else Step("Overlay mod not installed: " + fab.Problem);
        await CloseMinecraftLauncherAsync(m => Log("launcher", m));
        FileEdits.WriteProfile(McDir, Fabric.GameDir(McDir));
        Log("launcher", "Hivecraft profile selected in the Minecraft launcher (game folder " + Fabric.GameDir(McDir) + ").");
        StartMinecraftLauncher();
        OnHint?.Invoke((fab.Fabric ? "Hivecraft Overlay mod is installed (keys: see README, or Options → Controls → Hivecraft).\n" : "Overlay mod not installed: " + fab.Problem + "\nThe game still starts and joins the server.\n") +
            "In the launcher pick “Hivecraft” and press PLAY — it joins the server automatically.\nFirst time only: tick “Don’t warn me again” and press Play.");
    }
}
