using System.Text;
using System.Windows;

namespace Hivecraft;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args.Contains("--selftest") || e.Args.Contains("--selftest-net"))
        {
            // --selftest-net additionally downloads Fabric + Fabric API into a TEMP .minecraft (never the real one)
            int code = SelfTest.Run(e.Args.Contains("--selftest-net"));
            Shutdown(code);
            return;
        }
        if (e.Args.Contains("--install-overlay"))
        {
            // CLI: install Fabric + Fabric API + the overlay jar into the REAL .minecraft and select the Hivecraft profile; nothing is started
            Shutdown(InstallCli.Run());
            return;
        }
        Job.Init();
        DispatcherUnhandledException += (_, a) =>
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "hivecraft-launcher-error.log"), DateTime.Now + " " + a.Exception + "\n"); } catch { }
            a.Handled = true;
        };
        var win = new MainWindow();
        win.Show();
        int si = Array.IndexOf(e.Args, "--shot");
        if (si >= 0 && si + 1 < e.Args.Length) // dev aid: render the window to a PNG and exit (no desktop capture)
        {
            string path = e.Args[si + 1];
            int fi = Array.IndexOf(e.Args, "--shot-focus");   // optional: scroll a named element into view first
            if (fi >= 0 && fi + 1 < e.Args.Length && win.FindName(e.Args[fi + 1]) is FrameworkElement fe)
                win.Dispatcher.BeginInvoke(() => fe.BringIntoView(), System.Windows.Threading.DispatcherPriority.Loaded);
            var t = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
            t.Tick += (_, _) =>
            {
                t.Stop();
                var el = (FrameworkElement)win.Content;
                var rtb = new System.Windows.Media.Imaging.RenderTargetBitmap((int)el.ActualWidth, (int)el.ActualHeight, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
                rtb.Render(el);
                var enc = new System.Windows.Media.Imaging.PngBitmapEncoder();
                enc.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(rtb));
                using (var fs = File.Create(path)) enc.Save(fs);
                Environment.Exit(0);
            };
            t.Start();
        }
        int pi = Array.IndexOf(e.Args, "--shot-provider");   // dev aid: render the AI provider dialog (optional --shot-kind <kind>) and exit
        if (pi >= 0 && pi + 1 < e.Args.Length)
        {
            string path = e.Args[pi + 1];
            int ki = Array.IndexOf(e.Args, "--shot-kind");
            var kind = ki >= 0 && ki + 1 < e.Args.Length ? e.Args[ki + 1] : "claude-login";
            var pw = new ProviderWindow(new ProviderSettings { Kind = kind, Model = Providers.Get(kind)?.DefaultModel ?? "" }, null) { Owner = win };
            pw.Show();
            var t = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
            t.Tick += (_, _) =>
            {
                t.Stop();
                var el = (FrameworkElement)pw.Content;
                var rtb = new System.Windows.Media.Imaging.RenderTargetBitmap((int)el.ActualWidth, (int)el.ActualHeight, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
                rtb.Render(el);
                var enc = new System.Windows.Media.Imaging.PngBitmapEncoder();
                enc.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(rtb));
                using (var fs = File.Create(path)) enc.Save(fs);
                Environment.Exit(0);
            };
            t.Start();
        }
    }
}

/// <summary>--install-overlay: what START does for Minecraft (Fabric.InstallAsync + closing the launcher + WriteProfile), without starting anything.
/// Summary goes to stdout and %TEMP%hivecraft-install.txt.</summary>
static class InstallCli
{
    public static int Run()
    {
        var o = new StringBuilder();
        void P(string s) { o.AppendLine(s); }
        int code = 1;
        try
        {
            string mc = Orchestrator.McDir, root = Orchestrator.FindRoot();
            string gd = Fabric.GameDir(mc);
            P("Hivecraft --install-overlay  " + DateTime.Now.ToString("s"));
            P("Minecraft folder: " + mc + "   Hivecraft root: " + root);
            var lp = Path.Combine(mc, "launcher_profiles.json");
            if (!File.Exists(lp)) { P("FAILED: " + lp + " does not exist (start the Minecraft launcher once first)."); return Finish(o, 1); }
            // 1. launcher closed, then a timestamped backup of launcher_profiles.json (WriteProfile also keeps the first pristine .bak-hivecraft)
            bool closed = Task.Run(() => Orchestrator.CloseMinecraftLauncherAsync(P)).GetAwaiter().GetResult();
            P(closed ? "Minecraft launcher was open: closed." : "Minecraft launcher was not running.");
            var bak = lp + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            File.Copy(lp, bak);
            P("Backup: " + bak);
            // 2. Fabric Loader + Fabric API + overlay jar
            var fab = Task.Run(() => Fabric.InstallAsync(mc, root, P)).GetAwaiter().GetResult();
            // 3. the profile (as START does)
            FileEdits.WriteProfile(mc, gd);
            P("Profile \"" + FileEdits.ProfileName + "\" written to launcher_profiles.json (game folder " + gd + ", version " + FileEdits.VersionId + ", selected).");
            P("");
            P("RESULT: " + (fab.Fabric ? "OK - Fabric " + fab.Loader + ", " + fab.FabricApi + ", overlay jar installed." : "NOT INSTALLED - " + fab.Problem + " (profile is plain Minecraft with auto-join)"));
            var mods = Path.Combine(gd, "mods");
            if (Directory.Exists(mods)) foreach (var f in Directory.GetFiles(mods)) P("  mods\\" + Path.GetFileName(f) + "  (" + new FileInfo(f).Length + " bytes)");
            code = fab.Fabric ? 0 : 2;
        }
        catch (Exception ex) { P("FAILED: " + ex); }
        return Finish(o, code);
    }

    static int Finish(StringBuilder o, int code)
    {
        var s = o.ToString();
        try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "hivecraft-install.txt"), s); } catch { }
        try { Console.Out.Write(s); Console.Out.Flush(); } catch { }
        return code;
    }
}

/// <summary>--selftest: runs the file transforms on temp copies and prints PASS/FAIL (stdout + %TEMP%\hivecraft-selftest.txt).</summary>
static class SelfTest
{
    static readonly StringBuilder Out = new();
    static int _fail;
    static void Check(string what, bool ok, string detail = "") { Out.AppendLine($"{(ok ? "PASS" : "FAIL")}  {what}{(detail != "" ? "  -> " + detail : "")}"); if (!ok) _fail++; }

    public static int Run(bool net = false)
    {
        ConsoleAttach.Attach();
        var tmp = Path.Combine(Path.GetTempPath(), "hivecraft-selftest-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(tmp);
        try
        {
            string root = Orchestrator.FindRoot();
            Out.AppendLine("root: " + root);

            // ---- server.properties
            string src = Path.Combine(root, "server", "server.properties");
            string orig = File.Exists(src) ? File.ReadAllText(src) : "level-name=world\nlevel-seed=1\nmotd=x\n";
            string sp = Path.Combine(tmp, "server.properties");
            File.WriteAllText(sp, orig);
            FileEdits.WriteServerProps(sp, true, "worlds/world-20260101-000000", "my seed 42");
            string after = File.ReadAllText(sp);
            Check("props: level-name set", FileEdits.GetProp(after, "level-name") == "worlds/world-20260101-000000", FileEdits.GetProp(after, "level-name") ?? "null");
            Check("props: seed set", FileEdits.GetProp(after, "level-seed") == "my seed 42");
            Check("props: rcon/online-mode/port", FileEdits.GetProp(after, "online-mode") == "false" && FileEdits.GetProp(after, "server-port") == "25590"
                && FileEdits.GetProp(after, "enable-rcon") == "true" && FileEdits.GetProp(after, "rcon.port") == "25591" && FileEdits.GetProp(after, "rcon.password") == new HiveConfig().Server.RconPassword);
            // every other line unchanged
            static bool PropSetByUs(string l) => new[] { "level-name=", "level-seed=", "online-mode=", "server-port=", "enable-rcon=", "rcon.port=", "rcon.password=" }.Any(l.StartsWith);
            var o = orig.Replace("\r\n", "\n").TrimEnd('\n').Split('\n').Where(l => !PropSetByUs(l)).ToList();
            var a = after.TrimEnd('\n').Split('\n').Where(l => !PropSetByUs(l)).ToList();
            Check("props: all other lines kept", o.SequenceEqual(a));
            FileEdits.WriteServerProps(sp, true, "worlds/x", "");
            Check("props: blank seed -> empty", FileEdits.GetProp(File.ReadAllText(sp), "level-seed") == "");
            File.WriteAllText(sp, "level-name=oldworld\nlevel-seed=5\nonline-mode=true\n");
            FileEdits.WriteServerProps(sp, false, "worlds/new", "zzz");
            var cont = File.ReadAllText(sp);
            Check("props: continue keeps level-name+seed", FileEdits.GetProp(cont, "level-name") == "oldworld" && FileEdits.GetProp(cont, "level-seed") == "5");
            Check("props: continue forces online-mode=false + adds rcon", FileEdits.GetProp(cont, "online-mode") == "false" && FileEdits.GetProp(cont, "enable-rcon") == "true");

            // ---- launcher profiles
            string lp = Path.Combine(Orchestrator.McDir, "launcher_profiles.json");
            string pj = File.Exists(lp) ? File.ReadAllText(lp) : "{\"profiles\":{},\"settings\":{\"a\":1},\"version\":6}";
            var before = System.Text.Json.Nodes.JsonNode.Parse(pj)!.AsObject();
            string np = FileEdits.ApplyProfile(pj, DateTime.UtcNow);
            var afterJ = System.Text.Json.Nodes.JsonNode.Parse(np)!.AsObject();
            var prof = afterJ["profiles"]!.AsObject();
            var mine = prof.FirstOrDefault(kv => (string?)kv.Value!["name"] == "Hivecraft" && (string?)kv.Value["lastVersionId"] == "hivecraft-1.21.1");
            Check("profile: Hivecraft profile present", mine.Value != null);
            Check("profile: type custom + Grass", (string?)mine.Value?["type"] == "custom" && (string?)mine.Value?["icon"] == "Grass");
            bool othersSame = true;
            foreach (var kv in before["profiles"]!.AsObject())
            {
                if ((string?)kv.Value!["lastVersionId"] == "hivecraft-1.21.1") continue;   // ours: lastUsed is meant to change
                if (prof[kv.Key]?.ToJsonString() != kv.Value!.ToJsonString()) othersSame = false;
            }
            Check("profile: all existing profiles unchanged", othersSame, $"{before["profiles"]!.AsObject().Count} existing");
            Check("profile: settings/version unchanged", afterJ["settings"]!.ToJsonString() == before["settings"]!.ToJsonString() && afterJ["version"]!.ToJsonString() == before["version"]!.ToJsonString());
            string np2 = FileEdits.ApplyProfile(np, DateTime.UtcNow);
            Check("profile: applying twice does not duplicate", System.Text.Json.Nodes.JsonNode.Parse(np2)!["profiles"]!.AsObject().Count == prof.Count);

            string sel = FileEdits.ApplyProfile("{\"profiles\":{\"abc\":{\"name\":\"x\"}},\"selectedProfile\":\"abc\",\"version\":6}", DateTime.UtcNow);
            var selJ = System.Text.Json.Nodes.JsonNode.Parse(sel)!.AsObject();
            Check("profile: selectedProfile (if present) points at Hivecraft", (string?)selJ["profiles"]![(string)selJ["selectedProfile"]!]!["name"] == "Hivecraft");

            // version json + backup (on a temp .minecraft)
            string mc = Path.Combine(tmp, ".minecraft"); Directory.CreateDirectory(mc);
            File.WriteAllText(Path.Combine(mc, "launcher_profiles.json"), pj);
            FileEdits.EnsureVersion(mc);
            FileEdits.WriteProfile(mc);
            Check("version json written + valid", System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(mc, "versions", "hivecraft-1.21.1", "hivecraft-1.21.1.json")))?["inheritsFrom"]?.ToString() == "1.21.1");
            Check("backup created, equals original", File.Exists(Path.Combine(mc, "launcher_profiles.json.bak-hivecraft")) && File.ReadAllText(Path.Combine(mc, "launcher_profiles.json.bak-hivecraft")) == pj);

            // ---- archive
            string r2 = Path.Combine(tmp, "root");
            Directory.CreateDirectory(Path.Combine(r2, "data", "logs")); Directory.CreateDirectory(Path.Combine(r2, "data", "memory"));
            File.WriteAllText(Path.Combine(r2, "data", "hub.json"), "{}"); File.WriteAllText(Path.Combine(r2, "data", "memory", "Ash.md"), "m");
            Directory.CreateDirectory(Path.Combine(r2, "crew", "work", "Ash")); File.WriteAllText(Path.Combine(r2, "crew", "work", "Ash", "cursor.json"), "{}");
            File.WriteAllText(Path.Combine(r2, "crew", "work", "Ash", "mcp.json"), "{}");
            Directory.CreateDirectory(Path.Combine(r2, "data", "blueprints", "builds")); File.WriteAllText(Path.Combine(r2, "data", "blueprints", "builds", "b1.json"), "{}");
            File.WriteAllText(Path.Combine(r2, "data", "blueprints", "house.json"), "{}");
            Directory.CreateDirectory(Path.Combine(r2, "data", "ledger")); File.WriteAllText(Path.Combine(r2, "data", "ledger", "l.json"), "{}");
            Directory.CreateDirectory(Path.Combine(r2, "data", "photos")); File.WriteAllText(Path.Combine(r2, "data", "photos", "p.png"), "x");
            var dest = FileEdits.ArchiveState(r2, "T1");
            Check("archive: hub.json/logs/memory moved", File.Exists(Path.Combine(dest, "hub.json")) && Directory.Exists(Path.Combine(dest, "memory")) && Directory.Exists(Path.Combine(dest, "logs")) && !File.Exists(Path.Combine(r2, "data", "hub.json")));
            Check("archive: builds/ledger/photos moved", File.Exists(Path.Combine(dest, "builds", "b1.json")) && File.Exists(Path.Combine(dest, "ledger", "l.json")) && File.Exists(Path.Combine(dest, "photos", "p.png"))
                && !Directory.Exists(Path.Combine(r2, "data", "blueprints", "builds")) && !Directory.Exists(Path.Combine(r2, "data", "ledger")) && !Directory.Exists(Path.Combine(r2, "data", "photos")));
            Check("archive: saved blueprint designs stay", File.Exists(Path.Combine(r2, "data", "blueprints", "house.json")));
            Check("archive: cursor.json deleted, mcp.json kept", !File.Exists(Path.Combine(r2, "crew", "work", "Ash", "cursor.json")) && File.Exists(Path.Combine(r2, "crew", "work", "Ash", "mcp.json")));
            FileEdits.ArchiveState(r2, "T2"); // missing sources must not throw
            Check("archive: second run with nothing to move is fine", true);

            // ---- name validation
            Check("names: defaults valid", Settings.Validate(new[] { "Ash", "Flint", "Wren" }) == null);
            Check("names: too short rejected", Settings.Validate(new[] { "Al" }) != null);
            Check("names: bad char rejected", Settings.Validate(new[] { "Bad Name" }) != null);
            Check("names: 17 chars rejected", Settings.Validate(new[] { new string('a', 17) }) != null);
            Check("names: duplicate (case-insens) rejected", Settings.Validate(new[] { "Ash", "ash" }) != null);
            Check("names: the human's own name rejected", Settings.Validate(new[] { Settings.HumanName.ToLowerInvariant() }) != null);
            Check("names: 9 agents rejected", Settings.Validate(Enumerable.Range(1, 9).Select(i => "Bot" + i).ToList()) != null);

            // ---- personalities
            var pj2 = Settings.PersonasJson(new[] { "Ash", "Flint", "Wren" }, new[] { "  grumpy perfectionist ", "", new string('x', 400) });
            var pd = System.Text.Json.Nodes.JsonNode.Parse(pj2)!.AsObject();
            Check("personas: only non-empty, trimmed, capped at 300", pd.Count == 2 && (string?)pd["Ash"] == "grumpy perfectionist" && ((string?)pd["Flint"]) == null && ((string?)pd["Wren"])!.Length == 300);
            Check("personas: all empty -> {}", System.Text.Json.Nodes.JsonNode.Parse(Settings.PersonasJson(new[] { "Ash" }, new[] { " " }))!.AsObject().Count == 0);

            // ---- rcon packet
            var pk = Rcon.Packet(7, 3, "pw");
            Check("rcon: packet layout", BitConverter.ToInt32(pk, 0) == 12 && BitConverter.ToInt32(pk, 4) == 7 && BitConverter.ToInt32(pk, 8) == 3 && pk.Length == 16);

            ProviderChecks(tmp);
            FabricChecks(tmp, pj);
            if (net) FabricNetChecks(tmp);
        }
        catch (Exception ex) { Check("selftest crashed", false, ex.ToString()); }
        finally { try { Directory.Delete(tmp, true); } catch { } }

        Out.AppendLine(_fail == 0 ? "ALL PASS" : $"{_fail} FAILED");
        return Finish();
    }

    // ---- AI providers (Core/Providers.cs): key store in a temp dir, env building, parsers. No network, no claude runs.
    static void ProviderChecks(string tmp)
    {
        var fake = string.Join("-", "sk", "or", "v1", "FAKE0SELFTEST0KEY0123456789");   // built so release scans don't flag it
        var prevDir = Environment.GetEnvironmentVariable("HIVECRAFT_DATA_DIR");
        Providers.DataDir = Path.Combine(tmp, "keys");
        try
        {
            Check("keys: none at start", !Providers.HasKey("openrouter") && Providers.GetKey("anthropic-key") == null);
            Check("keys: save ok", Providers.SaveKey("openrouter", "  " + fake + " ") == null);
            Check("keys: round-trip (trimmed)", Providers.GetKey("openrouter") == fake);
            var raw = File.ReadAllBytes(Providers.SecretsPath);
            Check("keys: file is encrypted (no plaintext)", !Encoding.UTF8.GetString(raw).Contains("FAKE0SELFTEST") && !Encoding.Unicode.GetString(raw).Contains("FAKE0SELFTEST"));
            Providers.SaveKey("anthropic-key", "fake-anthropic-key-0001");
            Check("keys: per kind", Providers.GetKey("openrouter") == fake && Providers.GetKey("anthropic-key") == "fake-anthropic-key-0001");
            Providers.DeleteKey("openrouter");
            Check("keys: delete one", !Providers.HasKey("openrouter") && Providers.HasKey("anthropic-key"));
            Check("keys: CrewEnv passes stored key only for key kinds",
                Providers.CrewEnv(new ProviderSettings { Kind = "anthropic-key" }).GetValueOrDefault("HIVE_PROVIDER_KEY") == "fake-anthropic-key-0001"
                && Providers.CrewEnv(new ProviderSettings { Kind = "claude-login" }).Count == 0);
            Check("keys: mask hides the key", Providers.MaskKey(fake) is var mk && !mk.Contains("SELFTEST") && mk.EndsWith("6789"));
            Check("keys: delete all", Providers.DeleteAllKeys() == null && !File.Exists(Providers.SecretsPath) && !Providers.HasKey("anthropic-key"));
            File.WriteAllBytes(Providers.SecretsPath, new byte[] { 1, 2, 3, 4, 5 });
            Check("keys: corrupt file -> empty + reason", Providers.GetKey("openrouter") == null && Providers.LastSecretError != null, Providers.LastSecretError ?? "no reason");
            Check("keys: HIVECRAFT_DATA_DIR honoured", WithEnvDataDir(Path.Combine(tmp, "envdir")) == Path.Combine(tmp, "envdir", "secrets.dat"));
        }
        finally { Providers.DataDir = null!; Environment.SetEnvironmentVariable("HIVECRAFT_DATA_DIR", prevDir); }

        // env building (mirror of crew/providers.js)
        var or = Providers.CleanEnv(new ProviderSettings { Kind = "openrouter", Model = "claude-sonnet-5-5" }, fake);
        Check("env openrouter: base/token/empty api key", or["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api" && or["ANTHROPIC_AUTH_TOKEN"] == fake && or["ANTHROPIC_API_KEY"] == "");
        Check("env openrouter: aliases pinned, stray vars removed", or["ANTHROPIC_DEFAULT_SONNET_MODEL"] == "anthropic/claude-sonnet-5.5" && or["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "anthropic/claude-haiku-5.5"
            && or.ContainsKey("ANTHROPIC_MODEL") && or["ANTHROPIC_MODEL"] == null && or["CLAUDE_CODE_USE_BEDROCK"] == null && or["HIVE_PROVIDER_KEY"] == null);
        var cl = Providers.CleanEnv(new ProviderSettings { Kind = "claude-login" }, fake);
        Check("env claude-login: every API var removed, key unused", cl["ANTHROPIC_API_KEY"] == null && cl["ANTHROPIC_AUTH_TOKEN"] == null && cl["ANTHROPIC_BASE_URL"] == null && !cl.Values.Contains(fake));
        var ak = Providers.CleanEnv(new ProviderSettings { Kind = "anthropic-key" }, "fake-anthropic-key-0001");
        Check("env anthropic-key", ak["ANTHROPIC_API_KEY"] == "fake-anthropic-key-0001" && ak["ANTHROPIC_BASE_URL"] == null && ak["ANTHROPIC_AUTH_TOKEN"] == null);
        var cu = Providers.CleanEnv(new ProviderSettings { Kind = "custom", BaseUrl = "https://api.deepseek.com/anthropic/", Model = "deepseek-v4" }, null);
        Check("env custom: no key -> placeholder (never the Claude login), betas off", cu["ANTHROPIC_BASE_URL"] == "https://api.deepseek.com/anthropic" && cu["ANTHROPIC_AUTH_TOKEN"] == "hivecraft-no-key"
            && cu["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] == "1" && cu["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "deepseek-v4");
        var vx = Providers.CleanEnv(new ProviderSettings { Kind = "vertex", ProjectId = "p1", Model = "claude-sonnet-5-5" }, null);
        Check("env vertex", vx["CLAUDE_CODE_USE_VERTEX"] == "1" && vx["CLOUD_ML_REGION"] == "global" && vx["ANTHROPIC_VERTEX_PROJECT_ID"] == "p1");
        Check("model: per-agent override + OpenRouter id", Providers.ModelFor(new ProviderSettings { Kind = "openrouter" }, "claude-haiku-5-5") == "anthropic/claude-haiku-5.5"
            && Providers.ToOpenRouterModel("claude-fable-5-2[1m]") == "anthropic/claude-fable-5.2[1m]" && Providers.ToOpenRouterModel("openai/gpt-6") == "openai/gpt-6");
        Check("validate: key / url / model", Providers.Validate(new ProviderSettings { Kind = "anthropic-key" }, null) != null
            && Providers.Validate(new ProviderSettings { Kind = "custom", BaseUrl = "api.example.com", Model = "m" }, "k") != null
            && Providers.Validate(new ProviderSettings { Kind = "custom", BaseUrl = "http://localhost:4000", Model = "m" }, null) == null
            && Providers.Validate(new ProviderSettings { Kind = "claude-login" }, null) == null);

        // config round-trip: extras land in provider section, never a key
        var hc = HiveConfig.Parse("{\"provider\":{\"kind\":\"openrouter\",\"futureKey\":1}}");
        new ProviderSettings { Kind = "vertex", Model = "claude-sonnet-5-5", Region = "us-east5", ProjectId = "proj-9" }.ApplyTo(hc.Provider);
        var back = ProviderSettings.FromConfig(HiveConfig.Parse(hc.ToJson()).Provider);
        Check("config: provider round-trip (+unknown keys kept)", back.Kind == "vertex" && back.ProjectId == "proj-9" && back.Region == "us-east5" && hc.ToJson().Contains("futureKey") && !hc.ToJson().Contains(fake), hc.ToJson().Replace("\n", " "));

        // parsers
        const string orJson = "{\"data\":[{\"id\":\"openai/gpt-6\",\"name\":\"OpenAI: GPT-6\",\"context_length\":400000,\"pricing\":{\"prompt\":\"0.000005\",\"completion\":\"0.00004\"},\"supported_parameters\":[\"tools\",\"temperature\"]}," +
            "{\"id\":\"anthropic/claude-sonnet-5.5\",\"name\":\"Anthropic: Claude Sonnet 5.5\",\"context_length\":1000000,\"pricing\":{\"prompt\":\"0.000002\",\"completion\":\"0.00001\"},\"supported_parameters\":[\"tools\"]}," +
            "{\"id\":\"anthropic/claude-sonnet-5.5:batch\",\"supported_parameters\":[\"tools\"]},{\"id\":\"x/no-tools\",\"supported_parameters\":[\"temperature\"]}]}";
        var ms = Providers.ParseOpenRouterModels(orJson);
        Check("openrouter models: tools only, no :batch, Claude first, $/M", ms.Count == 2 && ms[0].Id == "anthropic/claude-sonnet-5.5" && ms[0].PromptPerM == 2 && ms[0].CompletionPerM == 10 && ms[1].IsClaude == false && ms[0].ContextLength == 1000000,
            string.Join(",", ms.Select(m => m.Id + ":" + m.PromptPerM)));
        Check("openrouter models: garbage -> empty", Providers.ParseOpenRouterModels("<html>").Count == 0);
        Check("openrouter key: 401 / ok", !Providers.ParseOpenRouterKey(401, "{}").Ok && Providers.ParseOpenRouterKey(200, "{\"data\":{\"limit_remaining\":4.5,\"is_free_tier\":false}}") is { Ok: true, LimitRemaining: 4.5 });
        var ok = Providers.ParseTestOutput("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"OK\",\"total_cost_usd\":0.0012}", "", 0, "openrouter", "anthropic/claude-sonnet-5.5");
        Check("test parse: success + cost", ok.Ok && ok.CostUsd == 0.0012 && ok.Message.Contains("0.0012"), ok.Message);
        var bad = Providers.ParseTestOutput("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Invalid API key · Please run /login\"}", "", 1, "anthropic-key", "claude-sonnet-5-5");
        Check("test parse: bad key in plain words", !bad.Ok && bad.Message.Contains("rejected the key"), bad.Message);
        var nologin = Providers.ParseTestOutput("{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in · Please run /login\"}", "", 1, "claude-login", "claude-sonnet-5-5");
        Check("test parse: not signed in", !nologin.Ok && nologin.Message.Contains("Sign in"), nologin.Message);
        var credit = Providers.ParseTestOutput("", "API Error: 402 {\"error\":{\"message\":\"Insufficient credits\"}}", 1, "openrouter", "m");
        Check("test parse: no credit", !credit.Ok && credit.Message.Contains("no credit"), credit.Message);
        var nomodel = Providers.ParseTestOutput("{\"type\":\"result\",\"is_error\":true,\"result\":\"API Error: 404 model_not_found\"}", "", 1, "custom", "foo");
        Check("test parse: unknown model", !nomodel.Ok && nomodel.Message.Contains("“foo”"), nomodel.Message);
        Check("test parse: timeout / empty", !Providers.ParseTestOutput("", "", -2, "openrouter", "m").Ok && Providers.ParseTestOutput("", "", 1, "openrouter", "m").Message.Contains("code 1"));
        Check("redact", Providers.Redact($"bad token {fake}!", fake) == "bad token ***!");
        var ls = Providers.ParseLoginStatus("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}", "", 0);
        Check("login status: signed in", ls.Known && ls.LoggedIn && ls.Subscription == "max", ls.Message);
        Check("login status: signed out / garbage", Providers.ParseLoginStatus("{\"loggedIn\":false}", "", 1) is { Known: true, LoggedIn: false } && !Providers.ParseLoginStatus("boom", "", 3).Known);
        Check("catalog: kinds + defaults", Providers.All.Select(p => p.Kind).SequenceEqual(new[] { "claude-login", "anthropic-key", "openrouter", "custom", "bedrock", "vertex" })
            && Providers.NormalizeKind("weird") == "claude-login" && Providers.BuiltInModels("openrouter").Count > 0 && Providers.BuiltInModels("custom").Count == 0);
    }
    static string WithEnvDataDir(string dir)
    {
        Providers.DataDir = null!;
        Environment.SetEnvironmentVariable("HIVECRAFT_DATA_DIR", dir);
        return Providers.SecretsPath;
    }

    // ---- Fabric / overlay mod (offline: pure transforms + file picking on temp folders)
    const string SampleFabric = "{\"id\":\"fabric-loader-0.20.1-1.21.1\",\"inheritsFrom\":\"1.21.1\",\"releaseTime\":\"2026-01-01T00:00:00+0000\",\"time\":\"2026-01-01T00:00:00+0000\",\"type\":\"release\"," +
        "\"mainClass\":\"net.fabricmc.loader.impl.launch.knot.KnotClient\",\"arguments\":{\"game\":[],\"jvm\":[\"-DFabricMcEmu= net.minecraft.client.main.Main \"]}," +
        "\"libraries\":[{\"name\":\"org.ow2.asm:asm:9.10.1\",\"url\":\"https://maven.fabricmc.net/\",\"sha1\":\"ada2141c0cc52ee8f5c48cd5fa4ce0e794f22236\"},{\"name\":\"net.fabricmc:intermediary:1.21.1\",\"url\":\"https://maven.fabricmc.net/\"},{\"name\":\"net.fabricmc:fabric-loader:0.20.1\",\"url\":\"https://maven.fabricmc.net/\"}]}";

    static void FabricChecks(string tmp, string realProfilesJson)
    {
        string v = FileEdits.HivecraftVersionFromFabric(SampleFabric);
        var vj = System.Text.Json.Nodes.JsonNode.Parse(v)!;
        var game = vj["arguments"]!["game"]!.AsArray().Select(n => (string?)n).ToList();
        Check("fabric: version id/inherits/mainClass", (string?)vj["id"] == "hivecraft-1.21.1" && (string?)vj["inheritsFrom"] == "1.21.1" && ((string?)vj["mainClass"])!.Contains("KnotClient"));
        Check("fabric: auto-join args added", game.SequenceEqual(new[] { "--quickPlayMultiplayer", "localhost:25590" }), string.Join(" ", game));
        Check("fabric: jvm args + libraries kept", vj["arguments"]!["jvm"]!.AsArray().Count == 1 && vj["libraries"]!.AsArray().Count == 3);
        var v2 = System.Text.Json.Nodes.JsonNode.Parse(FileEdits.HivecraftVersionFromFabric(v))!;
        Check("fabric: applying twice does not duplicate args", v2["arguments"]!["game"]!.AsArray().Count == 2);
        bool threw = false; try { FileEdits.HivecraftVersionFromFabric(SampleFabric.Replace("\"inheritsFrom\":\"1.21.1\"", "\"inheritsFrom\":\"1.20.4\"")); } catch { threw = true; }
        Check("fabric: wrong MC version refused", threw);
        Check("fabric: IsFabricVersion", FileEdits.IsFabricVersion(v) && !FileEdits.IsFabricVersion(FileEdits.VersionJson()) && !FileEdits.IsFabricVersion("not json"));
        Check("fabric: maven path", FileEdits.MavenPath("net.fabricmc:fabric-loader:0.20.1") == "net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar"
            && FileEdits.MavenPath("a.b:c:1:natives") == "a/b/c/1/c-1-natives.jar");
        threw = false; try { FileEdits.MavenPath("a:..:1"); } catch { threw = true; }
        Check("fabric: maven path traversal refused", threw);
        var loaders = System.Text.Json.Nodes.JsonNode.Parse("[{\"loader\":{\"version\":\"0.21.0-beta\",\"stable\":false}},{\"loader\":{\"version\":\"0.20.1\",\"stable\":true}},{\"loader\":{\"version\":\"0.20.0\",\"stable\":true}}]")!.AsArray();
        Check("fabric: picks newest stable loader", FileEdits.PickStableLoader(loaders) == "0.20.1");
        var mr = System.Text.Json.Nodes.JsonNode.Parse(
            "[{\"version_number\":\"0.117.0-beta\",\"version_type\":\"beta\",\"game_versions\":[\"1.21.1\"],\"loaders\":[\"fabric\"],\"files\":[{\"primary\":true,\"filename\":\"fabric-api-b.jar\",\"url\":\"https://cdn.modrinth.com/b.jar\",\"hashes\":{\"sha512\":\"AA\"}}]}," +
            "{\"version_number\":\"0.116.9\",\"version_type\":\"release\",\"game_versions\":[\"1.21.1\"],\"loaders\":[\"fabric\"],\"files\":[{\"primary\":true,\"filename\":\"../evil.jar\",\"url\":\"https://cdn.modrinth.com/e.jar\",\"hashes\":{\"sha512\":\"BB\"}}]}," +
            "{\"version_number\":\"0.116.8\",\"version_type\":\"release\",\"game_versions\":[\"1.21.1\"],\"loaders\":[\"fabric\"],\"files\":[{\"primary\":true,\"filename\":\"fabric-api-0.116.8+1.21.1.jar\",\"url\":\"https://cdn.modrinth.com/data/x.jar\",\"hashes\":{\"sha512\":\"CC\"}}]}]")!.AsArray();
        var pick = FileEdits.PickFabricApi(mr);
        Check("fabric api: newest safe release picked", pick?.FileName == "fabric-api-0.116.8+1.21.1.jar" && pick.Sha512 == "cc", pick?.FileName ?? "null");
        Check("overlay: aux jars skipped", FileEdits.IsAuxJar("x-1.0-sources.jar") && FileEdits.IsAuxJar("x-dev.jar") && !FileEdits.IsAuxJar("hivecraft-overlay-1.0.0.jar"));

        // jar picking on a temp root
        string root = Path.Combine(tmp, "modroot"), libs = Path.Combine(root, "mod", "build", "libs");
        Check("overlay: no build -> null", Fabric.FindOverlayJar(root) == null);
        Directory.CreateDirectory(libs);
        File.WriteAllText(Path.Combine(libs, "hivecraft-overlay-1.0.0-sources.jar"), "s");
        File.WriteAllText(Path.Combine(libs, "hivecraft-overlay-1.0.0.jar"), "j");
        Check("overlay: picks the real jar", Path.GetFileName(Fabric.FindOverlayJar(root) ?? "") == "hivecraft-overlay-1.0.0.jar");
        var dest = Path.Combine(tmp, "copy.jar");
        Fabric.CopyIfChanged(Path.Combine(libs, "hivecraft-overlay-1.0.0.jar"), dest);
        Fabric.CopyIfChanged(Path.Combine(libs, "hivecraft-overlay-1.0.0.jar"), dest);
        Check("overlay: copy", File.ReadAllText(dest) == "j");
        string mcx = Path.Combine(tmp, "mclibs");
        Check("fabric: missing libraries counted", Fabric.MissingLibraries(mcx, v) == 3);

        // profile with gameDir; every other profile untouched
        var gd = Path.Combine(Orchestrator.McDir, "hivecraft");
        var before = System.Text.Json.Nodes.JsonNode.Parse(realProfilesJson)!.AsObject();
        var after = System.Text.Json.Nodes.JsonNode.Parse(FileEdits.ApplyProfile(realProfilesJson, DateTime.UtcNow, gd))!.AsObject();
        var prof = after["profiles"]!.AsObject();
        var mine = prof.FirstOrDefault(kv => (string?)kv.Value!["name"] == "Hivecraft" && (string?)kv.Value["lastVersionId"] == "hivecraft-1.21.1");
        Check("profile: gameDir set on Hivecraft profile", (string?)mine.Value?["gameDir"] == gd);
        bool same = true;
        foreach (var kv in before["profiles"]!.AsObject())
        {
            if ((string?)kv.Value!["lastVersionId"] == "hivecraft-1.21.1") continue;
            if (prof[kv.Key]?.ToJsonString() != kv.Value!.ToJsonString()) same = false;
            if (prof[kv.Key]?["gameDir"]?.ToString() == gd) same = false;
        }
        Check("profile: other profiles untouched (with gameDir)", same, $"{before["profiles"]!.AsObject().Count} existing");
        Check("fabric: game dir is under .minecraft\\hivecraft", Fabric.GameDir(@"C:\x\.minecraft") == @"C:\x\.minecraft\hivecraft");
    }

    // ---- Fabric install for real, into a temp .minecraft (network: meta.fabricmc.net + Modrinth)
    static void FabricNetChecks(string tmp)
    {
        string mc = Path.Combine(tmp, "net-mc"); Directory.CreateDirectory(mc);
        File.WriteAllText(Path.Combine(mc, "options.txt"), "key_key.chat:key.keyboard.t\n");
        string root = Path.Combine(tmp, "net-root"), libs = Path.Combine(root, "mod", "build", "libs");
        var log = new List<string>();
        // a) no mod built -> vanilla fallback + clear problem
        var r0 = Task.Run(() => Fabric.InstallAsync(mc, root, log.Add)).GetAwaiter().GetResult();
        Check("net: no mod jar -> vanilla fallback with reason", !r0.Fabric && (r0.Problem ?? "").Contains("not built") &&
            !FileEdits.IsFabricVersion(File.ReadAllText(Path.Combine(mc, "versions", "hivecraft-1.21.1", "hivecraft-1.21.1.json"))), r0.Problem ?? "");
        Check("net: log says 'Overlay mod not installed'", log.Any(l => l.StartsWith("Overlay mod not installed:")));
        // b) with a jar -> Fabric
        Directory.CreateDirectory(libs);
        File.WriteAllBytes(Path.Combine(libs, "hivecraft-overlay-1.0.0.jar"), new byte[] { 0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 });
        var r = Task.Run(() => Fabric.InstallAsync(mc, root, log.Add)).GetAwaiter().GetResult();
        var vf = Path.Combine(mc, "versions", "hivecraft-1.21.1", "hivecraft-1.21.1.json");
        Check("net: Fabric installed", r.Fabric && r.Problem == null && FileEdits.IsFabricVersion(File.ReadAllText(vf)), r.Problem ?? r.Loader);
        Check("net: all libraries on disk", Fabric.MissingLibraries(mc, File.ReadAllText(vf)) == 0);
        var mods = Path.Combine(mc, "hivecraft", "mods");
        Check("net: Fabric API in mods", Directory.GetFiles(mods, "fabric-api-*.jar").Length == 1, r.FabricApi);
        Check("net: overlay jar copied", File.Exists(Path.Combine(mods, "hivecraft-overlay.jar")));
        Check("net: options.txt copied once", File.Exists(Path.Combine(mc, "hivecraft", "options.txt")));
        Check("net: plain fabric-loader version also written", Directory.GetDirectories(Path.Combine(mc, "versions"), "fabric-loader-*-1.21.1").Length == 1);
        // c) second run: nothing re-downloaded
        var t0 = DateTime.UtcNow; log.Clear();
        var r2 = Task.Run(() => Fabric.InstallAsync(mc, root, log.Add)).GetAwaiter().GetResult();
        Check("net: second run keeps Fabric, downloads nothing", r2.Fabric && !log.Any(l => l.Contains("downloaded")), string.Join(" | ", log));
        foreach (var l in log) Out.AppendLine("      log: " + l);
        // d) offline start with everything installed: still Fabric, nothing lost
        Fabric.ForceOffline = true;
        try
        {
            log.Clear();
            var r3 = Task.Run(() => Fabric.InstallAsync(mc, root, log.Add)).GetAwaiter().GetResult();
            Check("net: offline start reuses installed Fabric + Fabric API", r3.Fabric && r3.Problem == null && File.Exists(Path.Combine(mods, "hivecraft-overlay.jar")) && Directory.GetFiles(mods, "fabric-api-*.jar").Length == 1, r3.Problem ?? string.Join(" | ", log));
            // e) offline + nothing installed: vanilla auto-join, clear reason
            string mc2 = Path.Combine(tmp, "net-mc2"); Directory.CreateDirectory(mc2);
            log.Clear();
            var r4 = Task.Run(() => Fabric.InstallAsync(mc2, root, log.Add)).GetAwaiter().GetResult();
            Check("net: offline first start -> vanilla auto-join + reason", !r4.Fabric && (r4.Problem ?? "").Contains("Fabric Loader could not be installed") &&
                File.ReadAllText(Path.Combine(mc2, "versions", "hivecraft-1.21.1", "hivecraft-1.21.1.json")) == FileEdits.VersionJson(), r4.Problem ?? "");
        }
        finally { Fabric.ForceOffline = false; }
    }

    static int Finish()
    {
        var s = Out.ToString();
        try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "hivecraft-selftest.txt"), s); } catch { }
        try { Console.Out.Write(s); Console.Out.Flush(); } catch { }
        return _fail == 0 ? 0 : 1;
    }
}
