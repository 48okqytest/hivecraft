using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hivecraft.Setup;

/// <summary>Node.js, Java and the Minecraft server: find a suitable installed one, else download a private copy.</summary>
static class Deps
{
    public const int MinNodeMajor = 20, MinJavaMajor = 21;
    public const string McVersion = "1.21.1";
    public const string NodeDist = "https://nodejs.org/dist";
    public const string AdoptiumApi = "https://api.adoptium.net/v3";
    public const string MojangManifest = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

    static bool Arm64 => RuntimeInformation.OSArchitecture == Architecture.Arm64;
    static string NodeArch => Arm64 ? "win-arm64" : "win-x64";
    static string JavaArch => Arm64 ? "aarch64" : "x64";

    // ------------------------------------------------------------------ probing
    public sealed record Found(string Exe, string Version, int Major, string Source);

    /// <summary>Run exe with args, return stdout+stderr (5 s), or null if it cannot start.</summary>
    public static string? Run(string exe, string args, int timeoutMs = 8000)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var o = p.StandardOutput.ReadToEndAsync();
            var e = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(true); } catch (Exception k) { Log.W($"probe: could not stop {exe}: {k.Message}"); } return null; }
            return o.Result + "\n" + e.Result;
        }
        catch (Exception ex) { Log.W($"probe: {exe} {args} -> {ex.Message}"); return null; }
    }

    public static IEnumerable<string> OnPath(string file)
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string f;
            try { f = Path.Combine(d.Trim('"'), file); } catch { continue; }   // malformed PATH entry: skip it
            if (File.Exists(f)) yield return f;
        }
    }

    public static int ParseNodeMajor(string? v)
    {
        var m = Regex.Match(v ?? "", @"v(\d+)\.(\d+)\.(\d+)");
        return m.Success ? int.Parse(m.Groups[1].Value) : 0;
    }

    /// <summary>`java -version` output -> major (8 for "1.8.0_x", 21 for "21.0.5")</summary>
    public static int ParseJavaMajor(string? v)
    {
        var m = Regex.Match(v ?? "", @"version ""(\d+)(?:\.(\d+))?");
        if (!m.Success) return 0;
        int a = int.Parse(m.Groups[1].Value);
        return a == 1 && m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : a;
    }

    public static string NpmCli(string nodeExe) => Path.Combine(Path.GetDirectoryName(nodeExe)!, "node_modules", "npm", "bin", "npm-cli.js");

    public static Found? FindSystemNode(bool needNpm)
    {
        foreach (var exe in OnPath("node.exe").Concat(new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe") }).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(exe)) continue;
            var o = Run(exe, "--version");
            int maj = ParseNodeMajor(o);
            Log.W($"node candidate {exe}: {o?.Trim()} (major {maj})");
            if (maj >= MinNodeMajor && (!needNpm || File.Exists(NpmCli(exe)))) return new Found(exe, o!.Trim(), maj, "installed on this PC");
        }
        return null;
    }

    public static Found? FindSystemJava()
    {
        var cands = new List<string>();
        var jh = Environment.GetEnvironmentVariable("JAVA_HOME");
        if (!string.IsNullOrWhiteSpace(jh)) cands.Add(Path.Combine(jh.Trim('"'), "bin", "java.exe"));
        cands.AddRange(OnPath("java.exe"));
        foreach (var exe in cands.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(exe)) continue;
            var o = Run(exe, "-version");
            int maj = ParseJavaMajor(o);
            Log.W($"java candidate {exe}: major {maj}");
            if (maj >= MinJavaMajor) return new Found(exe, (o ?? "").Trim().Split('\n')[0].Trim(), maj, "installed on this PC");
        }
        return null;
    }

    public static Found? CheckPrivate(string exe, bool java)
    {
        if (!File.Exists(exe)) return null;
        var o = Run(exe, java ? "-version" : "--version");
        int maj = java ? ParseJavaMajor(o) : ParseNodeMajor(o);
        return maj >= (java ? MinJavaMajor : MinNodeMajor) ? new Found(exe, (o ?? "").Trim().Split('\n')[0].Trim(), maj, "downloaded by Hivecraft") : null;
    }

    // ------------------------------------------------------------------ Node.js
    public sealed record NodePick(string Version, string ZipName, string Url, string SumsUrl);

    /// <summary>nodejs.org/dist/index.json (newest first) -> newest LTS with a Windows zip for this arch.</summary>
    public static NodePick? PickNode(JsonArray index, string arch)
    {
        foreach (var v in index)
        {
            var ver = (string?)v?["version"];
            var lts = v?["lts"];
            bool isLts = lts is JsonValue jv && (jv.TryGetValue<string>(out var s) ? !string.IsNullOrEmpty(s) : jv.TryGetValue<bool>(out var b) && b);
            if (ver == null || !isLts || ParseNodeMajor(ver) < MinNodeMajor) continue;
            if (v?["files"] is not JsonArray files || !files.Any(f => (string?)f == arch + "-zip")) continue;
            if (!Regex.IsMatch(ver, @"^v\d+\.\d+\.\d+$")) continue;
            var zip = $"node-{ver}-{arch}.zip";
            return new NodePick(ver, zip, $"{NodeDist}/{ver}/{zip}", $"{NodeDist}/{ver}/SHASUMS256.txt");
        }
        return null;
    }

    public static async Task<string> InstallNodeAsync(string runtimeDir, string cacheDir, IProgress<Progress> p, CancellationToken ct)
    {
        const string L = "Node.js";
        p.Report(new Progress("Node.js: finding the current LTS version…"));
        var index = JsonNode.Parse(await Net.GetStringAsync(NodeDist + "/index.json", ct))!.AsArray();
        var pick = PickNode(index, NodeArch) ?? throw new InstallException("Node.js: nodejs.org lists no LTS build for Windows right now. Press Retry later.");
        var sums = await Net.GetStringAsync(pick.SumsUrl, ct);
        var sha = Net.HashFromSumsFile(sums, pick.ZipName) ?? throw new InstallException($"Node.js: {pick.ZipName} is missing from SHASUMS256.txt, so it cannot be verified. Press Retry later.");
        var zip = Path.Combine(cacheDir, pick.ZipName);
        await Net.DownloadAsync(pick.Url, zip, sha, "sha256", p, $"{L} {pick.Version}", ct);
        var dest = Path.Combine(runtimeDir, "node");
        ReplaceDir(dest, tmp => Zip.ExtractFile(zip, tmp, true, p, L, ct));
        var exe = Path.Combine(dest, "node.exe");
        if (CheckPrivate(exe, false) == null) throw new InstallException("Node.js was unpacked but node.exe does not run. Press Retry; if it keeps failing, your antivirus may be blocking it.");
        Log.TryDelete(zip);
        return exe;
    }

    // ------------------------------------------------------------------ Java (Eclipse Temurin JRE 21)
    public sealed record JavaPick(string Release, string Name, string Url, string Sha256);

    public static JavaPick? PickJava(JsonArray assets)
    {
        foreach (var a in assets)
        {
            var pkg = a?["binary"]?["package"];
            var name = (string?)pkg?["name"]; var link = (string?)pkg?["link"]; var sum = (string?)pkg?["checksum"];
            if (name == null || link == null || sum == null || !name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) continue;
            if (!link.StartsWith("https://")) continue;
            return new JavaPick((string?)a?["release_name"] ?? "21", name, link, sum.ToLowerInvariant());
        }
        return null;
    }

    public static async Task<string> InstallJavaAsync(string runtimeDir, string cacheDir, IProgress<Progress> p, CancellationToken ct)
    {
        const string L = "Java 21";
        p.Report(new Progress("Java: asking Adoptium for the latest Temurin 21 JRE…"));
        var url = $"{AdoptiumApi}/assets/latest/{MinJavaMajor}/hotspot?architecture={JavaArch}&image_type=jre&os=windows&vendor=eclipse";
        var pick = PickJava(JsonNode.Parse(await Net.GetStringAsync(url, ct))!.AsArray())
                   ?? throw new InstallException("Java: Adoptium lists no Java 21 JRE zip for Windows right now. Press Retry later.");
        var zip = Path.Combine(cacheDir, pick.Name);
        await Net.DownloadAsync(pick.Url, zip, pick.Sha256, "sha256", p, $"{L} ({pick.Release})", ct);
        var dest = Path.Combine(runtimeDir, "java");
        ReplaceDir(dest, tmp => Zip.ExtractFile(zip, tmp, true, p, L, ct));
        var exe = Path.Combine(dest, "bin", "java.exe");
        if (CheckPrivate(exe, true) == null) throw new InstallException("Java was unpacked but java.exe does not run. Press Retry; if it keeps failing, your antivirus may be blocking it.");
        Log.TryDelete(zip);
        return exe;
    }

    // ------------------------------------------------------------------ Minecraft server
    public sealed record ServerPick(string Url, string Sha1, long Size);

    public static string? VersionUrl(JsonNode manifest, string id) =>
        manifest["versions"]?.AsArray().FirstOrDefault(v => (string?)v?["id"] == id)?["url"]?.ToString();

    public static ServerPick? PickServer(JsonNode versionJson)
    {
        var s = versionJson["downloads"]?["server"];
        var url = (string?)s?["url"]; var sha = (string?)s?["sha1"];
        if (url == null || sha == null || !url.StartsWith("https://")) return null;
        return new ServerPick(url, sha.ToLowerInvariant(), (long?)s?["size"] ?? 0);
    }

    public static async Task InstallServerJarAsync(string serverDir, IProgress<Progress> p, CancellationToken ct)
    {
        p.Report(new Progress($"Minecraft server: reading Mojang's version list…"));
        var manifest = JsonNode.Parse(await Net.GetStringAsync(MojangManifest, ct))!;
        var vurl = VersionUrl(manifest, McVersion) ?? throw new InstallException($"Mojang's version list has no {McVersion}. Press Retry later.");
        var pick = PickServer(JsonNode.Parse(await Net.GetStringAsync(vurl, ct))!) ?? throw new InstallException($"Mojang lists no server download for {McVersion}.");
        await Net.DownloadAsync(pick.Url, Path.Combine(serverDir, "server.jar"), pick.Sha1, "sha1", p, $"Minecraft server {McVersion}", ct);
    }

    public static bool ServerJarLooksOk(string serverDir) =>
        File.Exists(Path.Combine(serverDir, "server.jar")) && new FileInfo(Path.Combine(serverDir, "server.jar")).Length > 1_000_000;

    // ------------------------------------------------------------------ helpers
    /// <summary>Fill a fresh temp dir, then swap it in (a failed unpack never leaves half a runtime behind).</summary>
    static void ReplaceDir(string dest, Action<string> fill)
    {
        var tmp = dest + ".new";
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        fill(tmp);
        if (Directory.Exists(dest))
        {
            var old = dest + ".old";
            if (Directory.Exists(old)) Directory.Delete(old, true);
            Directory.Move(dest, old);
            Directory.Move(tmp, dest);
            try { Directory.Delete(old, true); } catch (Exception e) { Log.W($"cleanup: could not delete {old}: {e.Message}"); }
        }
        else Directory.Move(tmp, dest);
    }
}
