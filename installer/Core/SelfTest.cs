using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

namespace Hivecraft.Setup;

/// <summary>
/// --selftest: pure logic, offline, everything inside a temp folder (HIVECRAFT_TEST_SANDBOX is forced to a temp dir for
/// the run, so shortcuts, the uninstall entry, saved keys and .minecraft are fake). Exit code = number of failures.
/// </summary>
static class SelfTest
{
    static int _fail, _pass;
    static void Check(string what, bool ok, string detail = "")
    {
        if (ok) _pass++; else _fail++;
        Log.W($"{(ok ? "PASS" : "FAIL")}  {what}{(detail != "" ? "  -> " + detail : "")}");
    }

    public static async Task<int> Run()
    {
        var tmp = Path.Combine(Path.GetTempPath(), "hivecraft-setup-selftest-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(tmp);
        var oldSandbox = Environment.GetEnvironmentVariable("HIVECRAFT_TEST_SANDBOX");
        var oldData = Environment.GetEnvironmentVariable("HIVECRAFT_DATA_DIR");
        var oldMc = Places.McDirOverride;
        var oldMcEnv = Environment.GetEnvironmentVariable("HIVECRAFT_MC_DIR");
        var oldProvDir = Providers.DataDir;
        try
        {
            var sb = Path.Combine(tmp, "sandbox");
            Environment.SetEnvironmentVariable("HIVECRAFT_TEST_SANDBOX", sb);
            Environment.SetEnvironmentVariable("HIVECRAFT_DATA_DIR", null);
            // never a real .minecraft: ignore HIVECRAFT_MC_DIR / --mc-dir, force the sandbox one
            Environment.SetEnvironmentVariable("HIVECRAFT_MC_DIR", null);
            Places.McDirOverride = Path.Combine(sb, ".minecraft");
            Providers.DataDir = Places.DataDir;
            Log.W("selftest in " + tmp);

            Sandbox(sb);
            Config(tmp);
            ServerFiles(tmp);
            await Checksums(tmp);
            ZipTests(tmp);
            Pickers();
            Rules();
            await MiniInstall(tmp);
        }
        catch (Exception e) { Check("selftest crashed", false, e.ToString()); }
        finally
        {
            Environment.SetEnvironmentVariable("HIVECRAFT_TEST_SANDBOX", oldSandbox);
            Environment.SetEnvironmentVariable("HIVECRAFT_DATA_DIR", oldData);
            Places.McDirOverride = oldMc;
            Environment.SetEnvironmentVariable("HIVECRAFT_MC_DIR", oldMcEnv);
            Providers.DataDir = oldProvDir;
            try { Directory.Delete(tmp, true); } catch (Exception e) { Log.W("selftest cleanup: " + e.Message); }
        }
        Log.W($"RESULT: {_pass} passed, {_fail} failed");
        return _fail;
    }

    static void Sandbox(string sb)
    {
        bool under(string p) => Path.GetFullPath(p).StartsWith(sb, StringComparison.OrdinalIgnoreCase);
        Check("sandbox: desktop/start menu/documents/data/.minecraft all inside the sandbox",
            under(Places.Desktop) && under(Places.StartMenuDir) && under(Places.Documents) && under(Places.DataDir) && under(Places.McDir) && under(Providers.DataDir),
            $"{Places.Desktop} | {Places.StartMenuDir} | {Places.DataDir} | {Places.McDir}");
        Check("sandbox: .minecraft counts as custom (written to config)", Places.McDirIsCustom);
    }

    static void Config(string tmp)
    {
        var root = Path.Combine(tmp, "cfgroot");
        Directory.CreateDirectory(root);
        var d = HiveConfig.Load(root);
        Check("config: missing file -> defaults", !d.FromFile && d.Server.Port == 25590 && d.Server.RconPort == 25591 && d.Bridge.Port == 47960 && d.Provider.Kind == "claude-login" && d.NodeExe == "node" && d.JavaExe == "java");
        Check("config: HumanName falls back to Player", d.HumanName == "Player");

        var json = "{\"version\":1,\"player\":{\"mcName\":\"Steve_1\",\"displayName\":\"\",\"futureP\":7},\"provider\":{\"kind\":\"openrouter\",\"baseUrl\":\"\",\"model\":\"anthropic/claude-sonnet-5.5\",\"smallModel\":\"\",\"authHeader\":\"bearer\"}," +
                   "\"runtime\":{\"node\":\"..\\\\runtime\\\\node\\\\node.exe\",\"java\":\"java\",\"claude\":\"\"},\"server\":{\"dir\":\"server\",\"port\":25600,\"rconPort\":25601,\"rconPassword\":\"pw123\"},\"bridge\":{\"port\":47970},\"minecraft\":{\"dir\":\"\"},\"newTop\":{\"a\":[1,2]}}";
        File.WriteAllText(Path.Combine(root, HiveConfig.FileName), json);
        var c = HiveConfig.Load(root);
        Check("config: parsed", c.FromFile && c.LoadError == null && c.Player.McName == "Steve_1" && c.Server.Port == 25600 && c.Bridge.Port == 47970 && c.Provider.Kind == "openrouter", c.LoadError ?? "");
        Check("config: HumanName = mcName when displayName empty", c.HumanName == "Steve_1");
        Check("config: private node path missing -> falls back to PATH node", c.NodeExe == "node");
        var nodeDir = Path.Combine(tmp, "runtime", "node"); Directory.CreateDirectory(nodeDir); File.WriteAllText(Path.Combine(nodeDir, "node.exe"), "x");
        Check("config: relative runtime path resolves against the app root", c.NodeExe.Equals(Path.Combine(nodeDir, "node.exe"), StringComparison.OrdinalIgnoreCase), c.NodeExe);
        Check("config: server dir resolves", c.ServerDir.Equals(Path.Combine(root, "server"), StringComparison.OrdinalIgnoreCase));
        c.Player.DisplayName = "Sam";
        c.Save(Path.Combine(root, HiveConfig.FileName));
        var back = JsonNode.Parse(File.ReadAllText(Path.Combine(root, HiveConfig.FileName)))!;
        Check("config: unknown keys survive Save (top level + nested)", back["newTop"]?["a"]?.AsArray().Count == 2 && (int?)back["player"]?["futureP"] == 7 && (string?)back["provider"]?["authHeader"] == "bearer");
        Check("config: saved values", (string?)back["player"]?["displayName"] == "Sam" && (int?)back["server"]?["port"] == 25600);
        Check("config: key names exactly as agreed", back["player"]?["mcName"] != null && back["provider"]?["smallModel"] != null && back["server"]?["rconPassword"] != null && back["minecraft"]?["dir"] != null && back["runtime"]?["claude"] != null);
        var env = Path.Combine(tmp, "alt.json");
        File.WriteAllText(env, "{\"player\":{\"mcName\":\"EnvUser\"}}");
        Environment.SetEnvironmentVariable("HIVE_CONFIG", env);
        try { Check("config: HIVE_CONFIG env overrides the path", HiveConfig.Load(root).Player.McName == "EnvUser"); }
        finally { Environment.SetEnvironmentVariable("HIVE_CONFIG", null); }
        File.WriteAllText(Path.Combine(root, HiveConfig.FileName), "{ broken");
        var br = HiveConfig.Load(root);
        Check("config: broken file -> defaults + LoadError", br.LoadError != null && br.Server.Port == 25590);
        var pw = HiveConfig.NewRconPassword();
        Check("config: random rcon password", pw.Length == 24 && pw != HiveConfig.NewRconPassword() && pw.All(char.IsAsciiLetterOrDigit));
        Check("names: Minecraft name rules", HiveConfig.ValidMcName("Steve_1") && !HiveConfig.ValidMcName("ab") && !HiveConfig.ValidMcName("has space") && !HiveConfig.ValidMcName("seventeen_chars_x"));
    }

    static void ServerFiles(string tmp)
    {
        var dir = Path.Combine(tmp, "srv");
        var cfg = new HiveConfig();
        cfg.Server.Port = 25610; cfg.Server.RconPort = 25611; cfg.Server.RconPassword = "Secret42";
        Setup.WriteServerFiles(dir, cfg, new DateTime(2026, 1, 2, 3, 4, 5));
        var props = File.ReadAllText(Path.Combine(dir, "server.properties"));
        Check("server: eula.txt says eula=true", File.ReadAllText(Path.Combine(dir, "eula.txt")).Contains("\neula=true\n"));
        Check("server: ports + rcon from config", FileEdits.GetProp(props, "server-port") == "25610" && FileEdits.GetProp(props, "rcon.port") == "25611" && FileEdits.GetProp(props, "rcon.password") == "Secret42" && FileEdits.GetProp(props, "enable-rcon") == "true");
        Check("server: offline mode", FileEdits.GetProp(props, "online-mode") == "false");
        Check("server: template level-name=world", FileEdits.GetProp(props, "level-name") == "world");
        Check("server: listens on this PC only", FileEdits.GetProp(props, "server-ip") == "127.0.0.1");
        // repair: user's own settings and world name stay
        File.WriteAllText(Path.Combine(dir, "server.properties"), props.Replace("difficulty=easy", "difficulty=hard").Replace("level-name=world", "level-name=worlds/mine").Replace("server-ip=127.0.0.1", "server-ip="));
        cfg.Server.RconPassword = "Other99";
        Setup.WriteServerFiles(dir, cfg, DateTime.Now);
        var p2 = File.ReadAllText(Path.Combine(dir, "server.properties"));
        Check("server: repair turns an empty server-ip into 127.0.0.1", FileEdits.GetProp(p2, "server-ip") == "127.0.0.1");
        Check("server: repair keeps level-name + user settings, updates password", FileEdits.GetProp(p2, "difficulty") == "hard" && FileEdits.GetProp(p2, "level-name") == "worlds/mine" && FileEdits.GetProp(p2, "rcon.password") == "Other99");
        var legacy = FileEdits.ApplyServerProps("", false, "", "");
        Check("server: no config -> legacy defaults (dev setups)", FileEdits.GetProp(legacy, "server-port") == "25590" && FileEdits.GetProp(legacy, "rcon.password") == HiveConfig.LegacyRconPassword);
    }

    static async Task Checksums(string tmp)
    {
        var f = Path.Combine(tmp, "abc.txt");
        File.WriteAllBytes(f, Encoding.ASCII.GetBytes("abc"));
        Check("sha256(abc)", await Net.HashFileAsync(f, "sha256") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        Check("sha1(abc)", await Net.HashFileAsync(f, "sha1") == "a9993e364706816aba3e25717850c26c9cd0d89d");
        var sums = "aaaa1111  node-v24.1.0-win-x86.zip\nBBBB2222  node-v24.1.0-win-x64.zip\ncccc  node-v24.1.0-win-x64.7z\n";
        Check("SHASUMS256 parse", Net.HashFromSumsFile(sums, "node-v24.1.0-win-x64.zip") == "bbbb2222" && Net.HashFromSumsFile(sums, "missing.zip") == null);
        // a cached file with the right hash is reused without network (DownloadAsync returns before any request)
        var hit = await Task.Run(async () =>
        {
            try { await Net.DownloadAsync("https://invalid.invalid/abc.txt", f, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256", null, "cache", CancellationToken.None, 1); return true; }
            catch (Exception e) { Log.W("cache test: " + e.Message); return false; }
        });
        Check("download: existing file with matching checksum is reused (no network)", hit);
    }

    static byte[] MakeZip(params (string Name, string Text)[] files)
    {
        using var ms = new MemoryStream();
        using (var za = new ZipArchive(ms, ZipArchiveMode.Create, true))
            foreach (var (n, t) in files)
            {
                var e = za.CreateEntry(n);
                using var w = new StreamWriter(e.Open());
                w.Write(t);
            }
        return ms.ToArray();
    }

    static void ZipTests(string tmp)
    {
        var z = MakeZip(("node-v1-win-x64/node.exe", "N"), ("node-v1-win-x64/node_modules/npm/bin/npm-cli.js", "npm"));
        var d1 = Path.Combine(tmp, "z1");
        Zip.Extract(new MemoryStream(z), d1, true, null, null, "t");
        Check("zip: top folder stripped", File.ReadAllText(Path.Combine(d1, "node.exe")) == "N" && File.Exists(Path.Combine(d1, "node_modules", "npm", "bin", "npm-cli.js")));
        var evil = MakeZip(("ok.txt", "1"), ("../../evil.txt", "x"));
        bool blocked = false;
        try { Zip.Extract(new MemoryStream(evil), Path.Combine(tmp, "z2"), false, null, null, "t"); }
        catch (InstallException) { blocked = true; }
        Check("zip: zip-slip path rejected", blocked && !File.Exists(Path.Combine(tmp, "evil.txt")));
        var d3 = Path.Combine(tmp, "z3");
        Directory.CreateDirectory(Path.Combine(d3, "data"));
        File.WriteAllText(Path.Combine(d3, "data", "econ-catalog.json"), "USER EDIT");
        File.WriteAllText(Path.Combine(d3, "bridge.js"), "old");
        var upd = MakeZip(("data/econ-catalog.json", "SHIPPED"), ("data/new.json", "new"), ("bridge.js", "new"));
        Zip.Extract(new MemoryStream(upd), d3, false, Setup.KeepOnUpdate, null, "t");
        Check("zip: update keeps user data, adds missing data, replaces program files",
            File.ReadAllText(Path.Combine(d3, "data", "econ-catalog.json")) == "USER EDIT" && File.ReadAllText(Path.Combine(d3, "data", "new.json")) == "new" && File.ReadAllText(Path.Combine(d3, "bridge.js")) == "new");
    }

    static void Pickers()
    {
        var idx = JsonNode.Parse("[{\"version\":\"v27.0.0\",\"lts\":false,\"files\":[\"win-x64-zip\"]},{\"version\":\"v26.1.0\",\"lts\":\"Kiwi\",\"files\":[\"win-x64-msi\"]},{\"version\":\"v24.11.1\",\"lts\":\"Krypton\",\"files\":[\"win-x64-zip\",\"win-arm64-zip\"]}]")!.AsArray();
        var n = Deps.PickNode(idx, "win-x64");
        Check("node: newest LTS with a Windows zip", n?.Version == "v24.11.1" && n.Url == "https://nodejs.org/dist/v24.11.1/node-v24.11.1-win-x64.zip" && n.SumsUrl.EndsWith("/v24.11.1/SHASUMS256.txt"), n?.Url ?? "null");
        var ad = JsonNode.Parse("[{\"binary\":{\"package\":{\"name\":\"OpenJDK21U-jre_x64_windows_hotspot_21.0.9_10.msi\",\"link\":\"https://x/a.msi\",\"checksum\":\"aa\"}}},{\"binary\":{\"package\":{\"name\":\"OpenJDK21U-jre_x64_windows_hotspot_21.0.9_10.zip\",\"link\":\"https://github.com/adoptium/x.zip\",\"checksum\":\"ABCD\"}},\"release_name\":\"jdk-21.0.9+10\"}]")!.AsArray();
        var j = Deps.PickJava(ad);
        Check("java: zip asset (not msi) + checksum", j?.Name.EndsWith(".zip") == true && j.Sha256 == "abcd" && j.Release == "jdk-21.0.9+10");
        var man = JsonNode.Parse("{\"versions\":[{\"id\":\"1.21.2\",\"url\":\"https://piston-meta.mojang.com/v/2.json\"},{\"id\":\"1.21.1\",\"url\":\"https://piston-meta.mojang.com/v/1.json\"}]}")!;
        Check("mojang: version url for 1.21.1", Deps.VersionUrl(man, "1.21.1") == "https://piston-meta.mojang.com/v/1.json");
        var vj = JsonNode.Parse("{\"downloads\":{\"server\":{\"sha1\":\"59353FB40C36D304F2035D51E7D6E6BAA98DC05C\",\"size\":51627615,\"url\":\"https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar\"}}}")!;
        var sp = Deps.PickServer(vj);
        Check("mojang: server jar url + sha1", sp?.Sha1 == "59353fb40c36d304f2035d51e7d6e6baa98dc05c" && sp.Url.StartsWith("https://piston-data.mojang.com/"));
        Check("versions: node/java parsing", Deps.ParseNodeMajor("v22.11.0\n") == 22 && Deps.ParseJavaMajor("openjdk version \"21.0.5\" 2024-10-15") == 21 && Deps.ParseJavaMajor("java version \"1.8.0_381\"") == 8 && Deps.ParseJavaMajor("garbage") == 0);
    }

    static void Rules()
    {
        Check("update rules: keep config/data/server/roster, replace code",
            Setup.KeepOnUpdate("hivecraft.config.json") && Setup.KeepOnUpdate("data/econ-catalog.json") && Setup.KeepOnUpdate("server/server.properties") && Setup.KeepOnUpdate("crew/roster.json")
            && !Setup.KeepOnUpdate("bridge/server.js") && !Setup.KeepOnUpdate("Hivecraft.exe") && !Setup.KeepOnUpdate("crew/crew.js"));
        var lp = "{\"profiles\":{\"a\":{\"name\":\"Latest\",\"lastVersionId\":\"latest-release\"},\"b\":{\"name\":\"Hivecraft\",\"lastVersionId\":\"hivecraft-1.21.1\"},\"c\":{\"name\":\"Hivecraft\",\"lastVersionId\":\"1.20\"}},\"selectedProfile\":\"b\",\"settings\":{\"x\":1}}";
        var r = JsonNode.Parse(MinecraftCheck.RemoveProfile(lp))!;
        Check("uninstall: removes only our profile", r["profiles"]!.AsObject().Count == 2 && r["profiles"]!["b"] == null && r["profiles"]!["a"] != null && r["profiles"]!["c"] != null && r["selectedProfile"] == null && (int?)r["settings"]?["x"] == 1);
        Check("uninstall: refuses a folder that is not a Hivecraft install", Uninstaller.ValidateDir(Path.GetTempPath()) != null && Uninstaller.ValidateDir("C:\\") != null);
    }

    /// <summary>Offline install into temp: folder check, payload, config, API key, shortcuts, uninstall entry; then uninstall.
    /// The download steps (Node/Java/server/npm) need the network and are covered by --unattended.</summary>
    static async Task MiniInstall(string tmp)
    {
        var payload = Path.Combine(tmp, "payload.zip");
        File.WriteAllBytes(payload, MakeZip(("manifest.json", "{\"name\":\"Hivecraft\",\"version\":\"9.9.9\",\"hasNodeModules\":false}"),
            ("Hivecraft.exe", "MZ fake launcher"), ("bridge/server.js", "//"), ("crew/crew.js", "//"), ("package.json", "{}"),
            ("data/econ-catalog.json", "{}"), ("mod/hivecraft-overlay.jar", "PK")));
        var pi = PayloadInfo.Open(payload);
        Check("payload: manifest read", pi?.Version == "9.9.9" && pi.HasNodeModules == false);

        var dir = Path.Combine(tmp, "inst", "Hivecraft");
        var o = new SetupOptions { Dir = dir, AcceptEula = true, McName = "Tester_1", DisplayName = "Tess", ProviderKind = "anthropic-key", Model = "claude-sonnet-5-5", ApiKey = "sk-ant-selftest-0000000000", PayloadPath = payload }; // scrub-ok: fake test key
        var s = new Setup(o);
        var steps = s.DependencySteps().Where(x => x.Key is "check" or "payload").Concat(s.FinishSteps()).ToList();
        bool ok = await Setup.RunStepsAsync(steps, _ => { }, new Progress<Progress>(_ => { }), CancellationToken.None);
        Check("mini install: steps ran", ok, string.Join(" | ", steps.Select(x => x.Key + ":" + x.State + " " + x.Detail)));
        var app = Path.Combine(dir, "app");
        Check("mini install: payload unpacked + folders made", File.Exists(Path.Combine(app, "Hivecraft.exe")) && Directory.Exists(Path.Combine(app, "server")) && Directory.Exists(Path.Combine(app, "data")));
        var cfgText = File.Exists(Path.Combine(app, HiveConfig.FileName)) ? File.ReadAllText(Path.Combine(app, HiveConfig.FileName)) : "";
        var cfg = HiveConfig.Load(app);
        Check("mini install: config written", cfg.FromFile && cfg.Player.McName == "Tester_1" && cfg.Player.DisplayName == "Tess" && cfg.Provider.Kind == "anthropic-key" && cfg.Provider.Model == "claude-sonnet-5-5");
        Check("mini install: random rcon password", cfg.Server.RconPassword.Length == 24 && cfg.Server.RconPassword != HiveConfig.LegacyRconPassword);
        Check("mini install: API key NOT in the config", !cfgText.Contains("sk-ant-selftest")); // scrub-ok: fake test key
        Check("mini install: API key stored (DPAPI) in the sandbox", Providers.GetKey("anthropic-key") == "sk-ant-selftest-0000000000" && File.Exists(Providers.SecretsPath) && !File.ReadAllText(Providers.SecretsPath).Contains("sk-ant-selftest")); // scrub-ok: fake test key
        Check("mini install: sandbox .minecraft recorded in config", cfg.Minecraft.Dir.Equals(Places.McDir, StringComparison.OrdinalIgnoreCase));
        Check("mini install: shortcuts point at Hivecraft.exe", File.Exists(Places.DesktopLink) && string.Equals(Shortcut.Target(Places.DesktopLink), Path.Combine(app, "Hivecraft.exe"), StringComparison.OrdinalIgnoreCase) && File.Exists(Places.StartLink), Shortcut.Target(Places.DesktopLink) ?? "");
        Check("mini install: uninstall entry (sandbox json)", string.Equals(UninstallEntry.InstalledDir(), Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase));
        Check("mini install: setup copied into the folder for repair/uninstall", File.Exists(Path.Combine(dir, Setup.SetupExeName)));

        // repair keeps config (password) and a user edit in data/
        var pw = cfg.Server.RconPassword;
        File.WriteAllText(Path.Combine(app, "data", "econ-catalog.json"), "{\"edited\":true}");
        var s2 = new Setup(new SetupOptions { Dir = dir, AcceptEula = true, McName = "Tester_1", ProviderKind = "anthropic-key", Model = "claude-opus-5-5", PayloadPath = payload });
        Check("repair: detected", s2.IsRepair);
        var st2 = s2.DependencySteps().Where(x => x.Key is "check" or "payload").Concat(s2.FinishSteps()).ToList();
        bool ok2 = await Setup.RunStepsAsync(st2, _ => { }, new Progress<Progress>(_ => { }), CancellationToken.None);
        var c2 = HiveConfig.Load(app);
        Check("repair: ok, password + display name kept, model updated, user data kept",
            ok2 && c2.Server.RconPassword == pw && c2.Player.DisplayName == "Tess" && c2.Provider.Model == "claude-opus-5-5" && File.ReadAllText(Path.Combine(app, "data", "econ-catalog.json")).Contains("edited"),
            string.Join(" | ", st2.Where(x => x.State != "done").Select(x => x.Key + ": " + x.Detail)));

        // a fake .minecraft with our profile, then uninstall with every option
        var mc = Places.McDir;
        Directory.CreateDirectory(Path.Combine(mc, "versions", FileEdits.VersionId)); Directory.CreateDirectory(Path.Combine(mc, "hivecraft", "mods"));
        Directory.CreateDirectory(Path.Combine(mc, "versions", "1.21.1"));
        File.WriteAllText(Path.Combine(mc, "launcher_profiles.json"), FileEdits.ApplyProfile("{\"profiles\":{\"x\":{\"name\":\"Mine\",\"lastVersionId\":\"1.21.1\"}}}", DateTime.UtcNow, Path.Combine(mc, "hivecraft")));
        Directory.CreateDirectory(Path.Combine(app, "server", "worlds", "world-1")); File.WriteAllText(Path.Combine(app, "server", "worlds", "world-1", "level.dat"), "L");
        var done = await Uninstaller.RunAsync(new UninstallOptions { Dir = dir, KeepWorlds = true, RemoveUserData = true, RemoveMinecraftProfile = true }, new Progress<Progress>(_ => { }));
        var lp = JsonNode.Parse(File.ReadAllText(Path.Combine(mc, "launcher_profiles.json")))!["profiles"]!.AsObject();
        Check("uninstall: folder, shortcuts, entry, keys gone", !Directory.Exists(dir) && !File.Exists(Places.DesktopLink) && !File.Exists(Places.StartLink) && UninstallEntry.InstalledDir() == null && Providers.GetKey("anthropic-key") == null);
        Check("uninstall: Minecraft profile/version/game dir removed, other profile + 1.21.1 kept",
            lp.Count == 1 && lp["x"] != null && !Directory.Exists(Path.Combine(mc, "versions", FileEdits.VersionId)) && !Directory.Exists(Path.Combine(mc, "hivecraft")) && Directory.Exists(Path.Combine(mc, "versions", "1.21.1")));
        Check("uninstall: worlds backed up to Documents", Directory.GetDirectories(Places.Documents, "Hivecraft worlds backup*").Any(d => File.Exists(Path.Combine(d, "worlds", "world-1", "level.dat"))), string.Join("; ", done));
    }
}
