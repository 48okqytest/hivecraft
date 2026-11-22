using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Hivecraft;

/// <summary>
/// Makes the "Hivecraft" Minecraft profile run Fabric with the Hivecraft Overlay mod:
///  - versions/hivecraft-1.21.1 = the official Fabric Loader profile json for 1.21.1 (meta.fabricmc.net) with our id and
///    the auto-join args; the Fabric libraries are downloaded into .minecraft/libraries (sha1 checked)
///  - the profile's own game dir %APPDATA%\.minecraft\hivecraft, whose mods/ gets Fabric API (Modrinth, sha512 checked)
///    and the overlay jar built in &lt;root&gt;\mod\build\libs (copied as hivecraft-overlay.jar)
/// Offline / any failure: keeps a Fabric version that is already installed, else falls back to the vanilla auto-join json.
/// Never touches other versions, profiles or the default game dir (except copying options.txt into the new dir once).
/// </summary>
static class Fabric
{
    public const string Mc = "1.21.1";
    public const string Meta = "https://meta.fabricmc.net/v2";
    public const string ModrinthVersions = "https://api.modrinth.com/v2/project/fabric-api/version?loaders=%5B%22fabric%22%5D&game_versions=%5B%221.21.1%22%5D";
    public const string OverlayJarName = "hivecraft-overlay.jar";

    static readonly HttpClient Net = MakeClient();
    static HttpClient MakeClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Hivecraft-Launcher/1.1");   // Modrinth asks for a UA; nothing personal in it
        return c;
    }

    /// <summary>selftest only: behave as if the network were down</summary>
    public static bool ForceOffline;

    public static string GameDir(string mcDir) => Path.Combine(mcDir, "hivecraft");

    public sealed class Result
    {
        public bool Fabric;              // version json is the Fabric one, overlay + Fabric API in mods/
        public string Loader = "";
        public string FabricApi = "";
        public string Overlay = "";      // jar copied into mods/
        public string? Problem;          // why the overlay is NOT installed (then the profile is vanilla auto-join)
    }

    /// <summary>
    /// Install/refresh everything; never throws. If anything needed for the overlay is missing, the version json is set
    /// to the plain vanilla auto-join one (PLAY always works) and Result.Problem says why; log() gets every step.
    /// Offline: reuses what is installed (cached Fabric json + libraries, the Fabric API jar in mods/).
    /// </summary>
    public static async Task<Result> InstallAsync(string mcDir, string root, Action<string> log, CancellationToken ct = default)
    {
        var r = new Result();
        string verDir = Path.Combine(mcDir, "versions", FileEdits.VersionId);
        string verFile = Path.Combine(verDir, FileEdits.VersionId + ".json");
        string gameDir = GameDir(mcDir), mods = Path.Combine(gameDir, "mods");
        string cache = Path.Combine(gameDir, "hivecraft-fabric-version.json");   // last good Fabric json, for offline starts
        string? fabricJson = null;
        string? problem = null;

        // ---- 1. game dir (options.txt is copied once so keybinds/video settings come along; never overwritten later)
        try
        {
            Directory.CreateDirectory(mods);
            var opt = Path.Combine(mcDir, "options.txt");
            var myOpt = Path.Combine(gameDir, "options.txt");
            if (File.Exists(opt) && !File.Exists(myOpt)) File.Copy(opt, myOpt);
        }
        catch (Exception e) { problem = "cannot create the game folder " + gameDir + ": " + e.Message; }

        // ---- 2. Fabric Loader version json + libraries
        if (problem == null)
        {
            try
            {
                string loader = await LatestStableLoader(ct);
                string profile = await GetString($"{Meta}/versions/loader/{Mc}/{loader}/profile/json", ct);
                fabricJson = FileEdits.HivecraftVersionFromFabric(profile);
                int got = await EnsureLibraries(mcDir, fabricJson, ct);
                var fid = (string?)JsonNode.Parse(profile)!["id"] ?? "";
                if (FileEdits.SafeId(fid))   // also the plain fabric-loader version, like the official installer
                {
                    var fdir = Path.Combine(mcDir, "versions", fid);
                    Directory.CreateDirectory(fdir);
                    WriteIfChanged(Path.Combine(fdir, fid + ".json"), profile);
                }
                WriteIfChanged(cache, fabricJson);
                r.Loader = loader;
                log($"Fabric Loader {loader} for {Mc} ready{(got > 0 ? $" ({got} libraries downloaded)" : "")}.");
            }
            catch (Exception e)
            {
                // offline or meta down: the last good Fabric json works if its libraries are all on disk
                var old = File.Exists(cache) ? File.ReadAllText(cache) : File.Exists(verFile) ? File.ReadAllText(verFile) : null;
                if (old != null && FileEdits.IsFabricVersion(old) && MissingLibraries(mcDir, old) == 0)
                {
                    fabricJson = old; r.Loader = "installed";
                    log("Fabric update check failed (" + e.Message + "); using the Fabric Loader already installed.");
                }
                else problem = "Fabric Loader could not be installed: " + e.Message;
            }
        }

        // ---- 3. Fabric API (Modrinth)
        if (problem == null)
        {
            try { r.FabricApi = await EnsureFabricApi(mods, log, ct); }
            catch (Exception e)
            {
                var have = Directory.GetFiles(mods, "fabric-api-*.jar").OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (have != null) { r.FabricApi = Path.GetFileName(have); log("Fabric API update check failed (" + e.Message + "); keeping " + r.FabricApi + "."); }
                else problem = "Fabric API could not be downloaded: " + e.Message;
            }
        }

        // ---- 4. the overlay jar from mod/build/libs
        if (problem == null)
        {
            try
            {
                var src = FindOverlayJar(root);
                var dest = Path.Combine(mods, OverlayJarName);
                if (src != null) { CopyIfChanged(src, dest); r.Overlay = src; log("Hivecraft Overlay mod: " + Path.GetFileName(src) + " -> mods\\" + OverlayJarName); }
                else if (File.Exists(dest)) { r.Overlay = dest; log(@"No overlay jar found next to Hivecraft; using the copy already in mods\."); }
                else problem = @"the overlay mod is not built / missing (no " + Path.Combine(root, "mod", OverlayJarName) + " and no build in " + Path.Combine(root, "mod", "build", "libs") + "); run Hivecraft-Setup again (Repair)";
            }
            catch (Exception e) { problem = "copying the mod jar failed: " + e.Message; }
        }

        // ---- 5. version json: Fabric when everything is there, else vanilla auto-join
        try
        {
            if (problem == null && fabricJson != null)
            {
                Directory.CreateDirectory(verDir);
                WriteIfChanged(verFile, fabricJson);
                r.Fabric = true;
            }
            else
            {
                FileEdits.EnsureVersion(mcDir);
                r.Problem = problem ?? "unknown";
                log("Overlay mod not installed: " + r.Problem + ". The Hivecraft profile starts plain Minecraft (auto-join still works).");
            }
        }
        catch (Exception e)
        {
            r.Fabric = false;
            r.Problem = (problem != null ? problem + "; " : "") + "writing the version file failed: " + e.Message;
            log("Overlay mod not installed: " + r.Problem);
        }
        return r;
    }

    /// <summary>how many libraries of a version json are not on disk</summary>
    public static int MissingLibraries(string mcDir, string versionJson)
    {
        int n = 0;
        foreach (var lib in JsonNode.Parse(versionJson)!["libraries"]!.AsArray())
        {
            var name = (string?)lib?["name"];
            if (name != null && !File.Exists(Path.Combine(mcDir, "libraries", FileEdits.MavenPath(name).Replace('/', Path.DirectorySeparatorChar)))) n++;
        }
        return n;
    }


    // ---------------------------------------------------------------- pieces

    static async Task<string> GetString(string url, CancellationToken ct)
    {
        if (ForceOffline) throw new HttpRequestException("no network (offline test)");
        using var resp = await Net.GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode) throw new Exception($"{new Uri(url).Host} answered {(int)resp.StatusCode}");
        return await resp.Content.ReadAsStringAsync(ct);
    }

    static async Task<byte[]> GetBytes(string url, CancellationToken ct)
    {
        if (ForceOffline) throw new HttpRequestException("no network (offline test)");
        using var resp = await Net.GetAsync(url, ct);
        if (!resp.IsSuccessStatusCode) throw new Exception($"{new Uri(url).Host} answered {(int)resp.StatusCode} for {Path.GetFileName(new Uri(url).LocalPath)}");
        return await resp.Content.ReadAsByteArrayAsync(ct);
    }

    public static async Task<string> LatestStableLoader(CancellationToken ct = default)
    {
        var list = JsonNode.Parse(await GetString($"{Meta}/versions/loader/{Mc}", ct))!.AsArray();
        var v = FileEdits.PickStableLoader(list);
        return v ?? throw new Exception("no stable Fabric Loader listed for " + Mc);
    }

    /// <summary>Download missing/corrupt libraries of a version json into mcDir/libraries. Returns how many were fetched.</summary>
    public static async Task<int> EnsureLibraries(string mcDir, string versionJson, CancellationToken ct = default)
    {
        int n = 0;
        foreach (var lib in JsonNode.Parse(versionJson)!["libraries"]!.AsArray())
        {
            var name = (string?)lib?["name"];
            var baseUrl = (string?)lib?["url"] ?? "https://maven.fabricmc.net/";
            if (name == null) continue;
            var rel = FileEdits.MavenPath(name);
            var dest = Path.Combine(mcDir, "libraries", rel.Replace('/', Path.DirectorySeparatorChar));
            var sha1 = (string?)lib?["sha1"];
            if (File.Exists(dest) && (sha1 == null || Hex(SHA1.HashData(File.ReadAllBytes(dest))) == sha1.ToLowerInvariant())) continue;
            var bytes = await GetBytes(baseUrl.TrimEnd('/') + "/" + rel, ct);
            if (sha1 != null && Hex(SHA1.HashData(bytes)) != sha1.ToLowerInvariant()) throw new Exception("checksum mismatch for " + name);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            AtomicWrite(dest, bytes);
            n++;
        }
        return n;
    }

    /// <summary>Newest Fabric API release for 1.21.1 into mods/ (sha512 checked); removes older fabric-api jars. Returns its file name.</summary>
    public static async Task<string> EnsureFabricApi(string modsDir, Action<string>? log, CancellationToken ct = default)
    {
        var list = JsonNode.Parse(await GetString(ModrinthVersions, ct))!.AsArray();
        var pick = FileEdits.PickFabricApi(list) ?? throw new Exception("Modrinth lists no Fabric API release for " + Mc);
        var dest = Path.Combine(modsDir, pick.FileName);
        if (!(File.Exists(dest) && Hex(SHA512.HashData(File.ReadAllBytes(dest))) == pick.Sha512))
        {
            var bytes = await GetBytes(pick.Url, ct);
            if (Hex(SHA512.HashData(bytes)) != pick.Sha512) throw new Exception("Fabric API download checksum mismatch");
            Directory.CreateDirectory(modsDir);
            AtomicWrite(dest, bytes);
            log?.Invoke("Fabric API " + pick.Version + " downloaded.");
        }
        foreach (var f in Directory.GetFiles(modsDir, "fabric-api-*.jar"))
            if (!string.Equals(Path.GetFileName(f), pick.FileName, StringComparison.OrdinalIgnoreCase))
            {
                // two Fabric API jars make Fabric refuse to start, so a stale one we cannot delete is an error
                try { File.Delete(f); } catch (Exception e) { throw new Exception("cannot remove the old " + Path.GetFileName(f) + " from mods (" + e.Message + ")"); }
            }
        return pick.FileName;
    }

    /// <summary>The overlay jar: root/mod/hivecraft-overlay.jar (installed by setup), else the newest built jar in
    /// root/mod/build/libs (dev; not -sources/-dev/-javadoc), or null.</summary>
    public static string? FindOverlayJar(string root)
    {
        var shipped = Path.Combine(root, "mod", OverlayJarName);
        var dir = Path.Combine(root, "mod", "build", "libs");
        var built = BuiltJar(dir);
        // a dev build newer than the shipped jar wins (developers rebuild the mod in place)
        if (File.Exists(shipped) && (built == null || File.GetLastWriteTimeUtc(shipped) >= File.GetLastWriteTimeUtc(built))) return shipped;
        return built;
    }

    static string? BuiltJar(string dir)
    {
        if (!Directory.Exists(dir)) return null;
        return Directory.GetFiles(dir, "*.jar")
            .Where(f => !FileEdits.IsAuxJar(Path.GetFileName(f)))
            .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
    }

    // ---------------------------------------------------------------- io helpers
    static string Hex(byte[] h) => Convert.ToHexString(h).ToLowerInvariant();

    static void AtomicWrite(string dest, byte[] bytes)
    {
        var tmp = dest + ".part";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, dest, true);
    }

    static void WriteIfChanged(string f, string text)
    {
        if (File.Exists(f) && File.ReadAllText(f) == text) return;
        File.WriteAllText(f, text, new System.Text.UTF8Encoding(false));
    }

    public static void CopyIfChanged(string src, string dest)
    {
        if (File.Exists(dest))
        {
            var a = new FileInfo(src); var b = new FileInfo(dest);
            if (a.Length == b.Length && SHA256.HashData(File.ReadAllBytes(src)).AsSpan().SequenceEqual(SHA256.HashData(File.ReadAllBytes(dest)))) return;
        }
        File.Copy(src, dest + ".part", true);
        File.Move(dest + ".part", dest, true);
    }
}
