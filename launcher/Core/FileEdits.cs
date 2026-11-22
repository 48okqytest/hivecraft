using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hivecraft;

/// <summary>Pure file transforms (also exercised by --selftest on temp copies).</summary>
static class FileEdits
{
    static readonly UTF8Encoding Utf8 = new(false);

    // ---------- server.properties ----------
    /// <summary>cfg (optional) gives server-port / rcon.port / rcon.password (hivecraft.config.json); null = defaults.</summary>
    public static string ApplyServerProps(string text, bool newWorld, string levelName, string seed, HiveConfig? cfg = null)
    {
        cfg ??= new HiveConfig();
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count > 0 && lines[^1] == "") lines.RemoveAt(lines.Count - 1);
        void Set(string key, string val)
        {
            for (int i = 0; i < lines.Count; i++)
            {
                var l = lines[i];
                if (l.StartsWith('#') || l.StartsWith('!')) continue;
                int eq = l.IndexOf('=');
                if (eq > 0 && l[..eq].Trim() == key) { lines[i] = key + "=" + val; return; }
            }
            lines.Add(key + "=" + val);
        }
        if (newWorld)
        {
            Set("level-name", levelName);
            Set("level-seed", SanitizeSeed(seed));
        }
        Set("online-mode", "false");
        Set("server-port", cfg.Server.Port.ToString());
        Set("enable-rcon", "true");
        Set("rcon.port", cfg.Server.RconPort.ToString());
        Set("rcon.password", string.IsNullOrEmpty(cfg.Server.RconPassword) ? HiveConfig.LegacyRconPassword : cfg.Server.RconPassword);
        return string.Join("\n", lines) + "\n";
    }

    public static string SanitizeSeed(string seed)
    {
        var sb = new StringBuilder();
        foreach (var ch in seed.Trim()) if (!char.IsControl(ch) && ch != '\\') sb.Append(ch);
        return sb.ToString();
    }

    public static string? GetProp(string text, string key)
    {
        foreach (var l in text.Replace("\r\n", "\n").Split('\n'))
        {
            if (l.StartsWith('#')) continue;
            int eq = l.IndexOf('=');
            if (eq > 0 && l[..eq].Trim() == key) return l[(eq + 1)..];
        }
        return null;
    }

    public static void WriteServerProps(string path, bool newWorld, string levelName, string seed, HiveConfig? cfg = null)
    {
        var text = File.Exists(path) ? File.ReadAllText(path) : "";
        File.WriteAllText(path, ApplyServerProps(text, newWorld, levelName, seed, cfg), Utf8);
    }

    // ---------- launcher_profiles.json ----------
    public const string VersionId = "hivecraft-1.21.1";
    public const string ProfileName = "Hivecraft";

    /// <summary>Server port the auto-join args point at (set from hivecraft.config.json by the launcher).</summary>
    public static int JoinPort { get; set; } = 25590;

    public static string VersionJson() =>
        "{\"id\":\"" + VersionId + "\",\"inheritsFrom\":\"1.21.1\",\"type\":\"release\",\"mainClass\":\"net.minecraft.client.main.Main\"," +
        "\"arguments\":{\"game\":[\"--quickPlayMultiplayer\",\"localhost:" + JoinPort + "\"],\"jvm\":[]}}";

    public static void EnsureVersion(string mcDir)
    {
        var dir = Path.Combine(mcDir, "versions", VersionId);
        Directory.CreateDirectory(dir);
        var f = Path.Combine(dir, VersionId + ".json");
        var want = VersionJson();
        if (!File.Exists(f) || File.ReadAllText(f) != want) File.WriteAllText(f, want, Utf8);
    }

    // ---------- Fabric (pure parts of Core/Fabric.cs, exercised by --selftest) ----------
    public static string[] AutoJoinArgs => new[] { "--quickPlayMultiplayer", "localhost:" + JoinPort };

    /// <summary>Fabric meta profile json (id fabric-loader-X-1.21.1, inheritsFrom 1.21.1) -> our version json:
    /// same libraries/mainClass/jvm args, id hivecraft-1.21.1, auto-join game args appended once.</summary>
    public static string HivecraftVersionFromFabric(string fabricProfileJson)
    {
        var j = JsonNode.Parse(fabricProfileJson)!.AsObject();
        if ((string?)j["inheritsFrom"] != "1.21.1") throw new Exception("Fabric profile is not for 1.21.1 (inheritsFrom " + (string?)j["inheritsFrom"] + ")");
        if (string.IsNullOrEmpty((string?)j["mainClass"]) || j["libraries"] is not JsonArray libs || libs.Count == 0) throw new Exception("Fabric profile json has no mainClass/libraries");
        j["id"] = VersionId;
        var args = j["arguments"] as JsonObject ?? new JsonObject();
        j["arguments"] = args;
        var game = args["game"] as JsonArray ?? new JsonArray();
        args["game"] = game;
        if (args["jvm"] is not JsonArray) args["jvm"] = new JsonArray();
        if (!game.Any(n => n is JsonValue v && v.TryGetValue<string>(out var s) && s == AutoJoinArgs[0]))
            foreach (var a in AutoJoinArgs) game.Add(a);
        return j.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    public static bool IsFabricVersion(string versionJson)
    {
        try
        {
            var j = JsonNode.Parse(versionJson)!;
            return ((string?)j["mainClass"] ?? "").Contains("fabricmc") && j["libraries"] is JsonArray a && a.Any(l => ((string?)l?["name"] ?? "").StartsWith("net.fabricmc:fabric-loader:"));
        }
        catch { return false; }   // unreadable json = not a usable Fabric version (the caller reinstalls or falls back)
    }

    public static bool SafeId(string id) => id.Length is > 0 and < 80 && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_');

    /// <summary>"group:artifact:version[:classifier]" -> "group/path/artifact/version/artifact-version[-classifier].jar"</summary>
    public static string MavenPath(string name)
    {
        var p = name.Split(':');
        if (p.Length < 3 || p.Any(s => s.Length == 0 || s.Contains("..") || s.Contains('/') || s.Contains('\\'))) throw new Exception("bad maven name " + name);
        string file = p[1] + "-" + p[2] + (p.Length > 3 ? "-" + p[3] : "") + ".jar";
        return p[0].Replace('.', '/') + "/" + p[1] + "/" + p[2] + "/" + file;
    }

    /// <summary>meta /v2/versions/loader/1.21.1 array -> first stable loader version (list is newest first)</summary>
    public static string? PickStableLoader(JsonArray list)
    {
        foreach (var e in list)
        {
            var l = e?["loader"];
            if (l != null && (bool?)l["stable"] == true && (string?)l["version"] is string v && SafeId(v)) return v;
        }
        return null;
    }

    public sealed record FabricApiPick(string Version, string FileName, string Url, string Sha512);

    /// <summary>Modrinth version list (newest first) -> newest release for 1.21.1 + fabric with a primary jar.</summary>
    public static FabricApiPick? PickFabricApi(JsonArray list)
    {
        foreach (var v in list)
        {
            if (v == null || (string?)v["version_type"] != "release") continue;
            if (v["game_versions"] is not JsonArray gv || !gv.Any(g => (string?)g == "1.21.1")) continue;
            if (v["loaders"] is not JsonArray lo || !lo.Any(g => (string?)g == "fabric")) continue;
            var files = v["files"] as JsonArray;
            var f = files?.FirstOrDefault(x => (bool?)x?["primary"] == true) ?? files?.FirstOrDefault();
            var fn = (string?)f?["filename"]; var url = (string?)f?["url"]; var sha = (string?)f?["hashes"]?["sha512"];
            if (fn == null || url == null || sha == null || !fn.EndsWith(".jar") || fn.Contains('/') || fn.Contains('\\') || fn.Contains("..")) continue;
            if (!url.StartsWith("https://cdn.modrinth.com/")) continue;
            return new FabricApiPick((string?)v["version_number"] ?? "?", fn, url, sha.ToLowerInvariant());
        }
        return null;
    }

    public static bool IsAuxJar(string fileName) =>
        fileName.EndsWith("-sources.jar", StringComparison.OrdinalIgnoreCase) || fileName.EndsWith("-dev.jar", StringComparison.OrdinalIgnoreCase) ||
        fileName.EndsWith("-javadoc.jar", StringComparison.OrdinalIgnoreCase) || fileName.EndsWith("-all-dev.jar", StringComparison.OrdinalIgnoreCase);

    /// <summary>Adds/updates the Hivecraft profile; everything else in the JSON is left as parsed.
    /// gameDir (optional) = the profile's own game folder (mods/config/saves stay out of the default .minecraft).</summary>
    public static string ApplyProfile(string json, DateTime nowUtc, string? gameDir = null)
    {
        var root = JsonNode.Parse(json)!.AsObject();
        var profiles = root["profiles"] as JsonObject;
        if (profiles == null) { profiles = new JsonObject(); root["profiles"] = profiles; }
        JsonObject? mine = null;
        string? mineKey = null;
        foreach (var kv in profiles)
            if (kv.Value is JsonObject o && (string?)o["name"] == ProfileName && (string?)o["lastVersionId"] == VersionId) { mine = o; mineKey = kv.Key; break; }
        string iso = nowUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        if (mine == null)
        {
            mine = new JsonObject { ["created"] = iso };
            mineKey = Guid.NewGuid().ToString("N");
            profiles[mineKey] = mine;
        }
        // some launcher versions keep a top-level selected-profile pointer; point it at ours if present
        foreach (var k in new[] { "selectedProfile", "selectedProfileId" })
            if (root.ContainsKey(k)) root[k] = mineKey;
        mine["icon"] = "Grass";
        mine["lastUsed"] = iso;
        mine["lastVersionId"] = VersionId;
        mine["name"] = ProfileName;
        mine["type"] = "custom";
        if (gameDir != null) mine["gameDir"] = gameDir;
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    public static void WriteProfile(string mcDir, string? gameDir = null)
    {
        var f = Path.Combine(mcDir, "launcher_profiles.json");
        if (!File.Exists(f)) return;
        var bak = f + ".bak-hivecraft";
        if (!File.Exists(bak)) File.Copy(f, bak);   // keep the very first (pristine) backup
        File.WriteAllText(f, ApplyProfile(File.ReadAllText(f), DateTime.UtcNow, gameDir), Utf8);
    }

    // ---------- fresh team state ----------
    public static string ArchiveState(string root, string stamp)
    {
        var data = Path.Combine(root, "data");
        var dest = Path.Combine(data, "archive", stamp);
        foreach (var n in new[] { "hub.json", "logs", "memory" })
        {
            var src = Path.Combine(data, n);
            if (File.Exists(src)) { Directory.CreateDirectory(dest); File.Move(src, Path.Combine(dest, n)); }
            else if (Directory.Exists(src)) { Directory.CreateDirectory(dest); Directory.Move(src, Path.Combine(dest, n)); }
        }
        // A new world also forgets old builds / locations: built structures, the economy ledger and photos are archived too.
        // Saved blueprint designs (data/blueprints/*.json) stay; only the placed-builds folder moves.
        foreach (var (rel, name) in new[] { (Path.Combine("blueprints", "builds"), "builds"), ("ledger", "ledger"), ("photos", "photos") })
        {
            var src = Path.Combine(data, rel);
            if (Directory.Exists(src)) { Directory.CreateDirectory(dest); Directory.Move(src, Path.Combine(dest, name)); }
        }
        var work = Path.Combine(root, "crew", "work");
        if (Directory.Exists(work))
            foreach (var d in Directory.GetDirectories(work))
            {
                foreach (var f in new[] { "cursor.json", "session.json" })   // new world = fresh conversations
                {
                    var c = Path.Combine(d, f);
                    if (File.Exists(c)) File.Delete(c);
                }
            }
        return dest;
    }
}
