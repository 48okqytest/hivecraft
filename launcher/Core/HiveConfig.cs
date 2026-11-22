using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Hivecraft;

/// <summary>
/// &lt;app root&gt;\hivecraft.config.json — written by Hivecraft-Setup.exe, read by the launcher (this file) and by
/// bridge/mcp/crew (bridge/config.js). HIVE_CONFIG env = alternate path. Unknown keys are kept on Save (round-trip).
/// Relative paths (server.dir, runtime.*) resolve against the app root; a bare command name ("node", "java") means PATH.
/// API keys are NEVER stored here (DPAPI, see Providers.cs). Pure: no WPF, shared with the installer.
/// </summary>
sealed class HiveConfig
{
    public const string FileName = "hivecraft.config.json";
    public const string LegacyRconPassword = "hivecraft-local";   // scrub-ok: legacy dev default, installer writes a random pw

    [JsonPropertyName("version")] public int Version { get; set; } = 1;
    [JsonPropertyName("player")] public PlayerCfg Player { get; set; } = new();
    [JsonPropertyName("provider")] public ProviderCfg Provider { get; set; } = new();
    [JsonPropertyName("runtime")] public RuntimeCfg Runtime { get; set; } = new();
    [JsonPropertyName("server")] public ServerCfg Server { get; set; } = new();
    [JsonPropertyName("bridge")] public BridgeCfg Bridge { get; set; } = new();
    [JsonPropertyName("minecraft")] public MinecraftCfg Minecraft { get; set; } = new();
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }

    public sealed class PlayerCfg
    {
        [JsonPropertyName("mcName")] public string McName { get; set; } = "";
        [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }
    public sealed class ProviderCfg
    {
        /// <summary>claude-login | anthropic-key | openrouter | custom</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = "claude-login";
        [JsonPropertyName("baseUrl")] public string BaseUrl { get; set; } = "";
        [JsonPropertyName("model")] public string Model { get; set; } = "claude-sonnet-5-5";
        [JsonPropertyName("smallModel")] public string SmallModel { get; set; } = "";
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }
    public sealed class RuntimeCfg
    {
        [JsonPropertyName("node")] public string Node { get; set; } = "node";
        [JsonPropertyName("java")] public string Java { get; set; } = "java";
        [JsonPropertyName("claude")] public string Claude { get; set; } = "";
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }
    public sealed class ServerCfg
    {
        [JsonPropertyName("dir")] public string Dir { get; set; } = "server";
        [JsonPropertyName("port")] public int Port { get; set; } = 25590;
        [JsonPropertyName("rconPort")] public int RconPort { get; set; } = 25591;
        [JsonPropertyName("rconPassword")] public string RconPassword { get; set; } = LegacyRconPassword;
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }
    public sealed class BridgeCfg
    {
        [JsonPropertyName("port")] public int Port { get; set; } = 47960;
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }
    public sealed class MinecraftCfg
    {
        /// <summary>"" = %APPDATA%\.minecraft</summary>
        [JsonPropertyName("dir")] public string Dir { get; set; } = "";
        [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; }
    }

    // ------------------------------------------------------------------ derived values
    [JsonIgnore] public string Root { get; private set; } = "";
    [JsonIgnore] public string? LoadedFrom { get; private set; }
    [JsonIgnore] public bool FromFile => LoadedFrom != null;
    [JsonIgnore] public string? LoadError { get; private set; }

    /// <summary>Name the agents call the human: displayName, else mcName, else "Player".</summary>
    [JsonIgnore] public string HumanName => !string.IsNullOrWhiteSpace(Player.DisplayName) ? Player.DisplayName.Trim() : !string.IsNullOrWhiteSpace(Player.McName) ? Player.McName.Trim() : "Player";

    [JsonIgnore] public string ServerDir => Resolve(Root, string.IsNullOrWhiteSpace(Server.Dir) ? "server" : Server.Dir);
    [JsonIgnore] public string McDir => string.IsNullOrWhiteSpace(Minecraft.Dir)
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ".minecraft")
        : Resolve(Root, Minecraft.Dir);
    [JsonIgnore] public string BridgeBase => "http://127.0.0.1:" + Bridge.Port;

    /// <summary>Executable for node: configured file if it exists, else "node" from PATH.</summary>
    [JsonIgnore] public string NodeExe => Exe(Runtime.Node, "node");
    /// <summary>Executable for java (console java.exe, used for the server): configured file if it exists, else "java" from PATH.</summary>
    [JsonIgnore] public string JavaExe => Exe(Runtime.Java, "java");

    string Exe(string configured, string fallback)
    {
        if (string.IsNullOrWhiteSpace(configured)) return fallback;
        if (!LooksLikePath(configured)) return configured;           // bare command name -> PATH
        var p = Resolve(Root, configured);
        return File.Exists(p) ? p : fallback;
    }

    public static bool LooksLikePath(string s) => s.Contains('\\') || s.Contains('/') || Path.IsPathRooted(s);

    public static string Resolve(string root, string p) =>
        Path.IsPathRooted(p) ? Path.GetFullPath(p) : Path.GetFullPath(Path.Combine(root, p));

    // ------------------------------------------------------------------ load / save
    static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    /// <summary>The config path for an app root (HIVE_CONFIG env overrides).</summary>
    public static string PathFor(string root)
    {
        var env = Environment.GetEnvironmentVariable("HIVE_CONFIG");
        return !string.IsNullOrWhiteSpace(env) ? Path.GetFullPath(env) : Path.Combine(root, FileName);
    }

    /// <summary>Never throws: a missing or broken file gives defaults (LoadError says why when broken).</summary>
    public static HiveConfig Load(string root)
    {
        var path = PathFor(root);
        HiveConfig c;
        string? err = null;
        try
        {
            c = File.Exists(path) ? Parse(File.ReadAllText(path)) : new HiveConfig();
            if (File.Exists(path)) c.LoadedFrom = path;
        }
        catch (Exception e) { c = new HiveConfig(); err = path + ": " + e.Message; }
        c.Root = Path.GetFullPath(root);
        c.LoadError = err;
        return c;
    }

    public static HiveConfig Parse(string json)
    {
        var c = JsonSerializer.Deserialize<HiveConfig>(json, Opts) ?? new HiveConfig();
        c.Player ??= new(); c.Provider ??= new(); c.Runtime ??= new(); c.Server ??= new(); c.Bridge ??= new(); c.Minecraft ??= new();
        return c;
    }

    public string ToJson() => JsonSerializer.Serialize(this, Opts);

    /// <summary>Atomic write (tmp + move).</summary>
    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, ToJson() + "\n", new System.Text.UTF8Encoding(false));
        File.Move(tmp, path, true);
        LoadedFrom = path;
    }

    public HiveConfig WithRoot(string root) { Root = Path.GetFullPath(root); return this; }

    public static string NewRconPassword()
    {
        const string abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        var b = RandomNumberGenerator.GetBytes(24);
        return new string(b.Select(x => abc[x % abc.Length]).ToArray());
    }

    /// <summary>Minecraft usernames: 3-16 letters, digits, underscore.</summary>
    public static bool ValidMcName(string n) => n.Length is >= 3 and <= 16 && n.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_');
}
