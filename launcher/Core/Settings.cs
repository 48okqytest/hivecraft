using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hivecraft;

class Settings
{
    public List<string> Agents { get; set; } = new() { "Ash", "Flint", "Wren" };
    public List<string> Personalities { get; set; } = new();   // parallel to Agents
    public string Model { get; set; } = "claude-sonnet-5-5";
    public bool NewWorld { get; set; } = true;
    public string Seed { get; set; } = "";
    public string GameMode { get; set; } = "survival";
    public bool Economy { get; set; } = true;
    public bool OverlayMod { get; set; } = true;
    public bool LogOpen { get; set; }

    static string PathFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Hivecraft", "settings.json");

    public static Settings Load()
    {
        try { if (File.Exists(PathFile)) return JsonSerializer.Deserialize<Settings>(File.ReadAllText(PathFile)) ?? new(); } catch { }
        return new();
    }
    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(PathFile)!);
            File.WriteAllText(PathFile, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    public const int MaxPersonaLen = 300;

    /// <summary>JSON for data\personalities.json: only non-empty, trimmed, capped personalities.</summary>
    public static string PersonasJson(IReadOnlyList<string> names, IReadOnlyList<string> personas)
    {
        var d = new Dictionary<string, string>();
        for (int i = 0; i < names.Count && i < personas.Count; i++)
        {
            var t = (personas[i] ?? "").Trim();
            if (t.Length == 0) continue;
            if (t.Length > MaxPersonaLen) t = t[..MaxPersonaLen];
            d[names[i]] = t;
        }
        return JsonSerializer.Serialize(d, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    static readonly Regex NameRx = new("^[A-Za-z0-9_]{3,16}$");
    /// <summary>The human's name (hivecraft.config.json player.displayName/mcName); agents may not use it.</summary>
    public static string HumanName => Orchestrator.Cfg.HumanName;

    /// <summary>null = fine, otherwise a readable problem.</summary>
    public static string? Validate(IReadOnlyList<string> names)
    {
        if (names.Count < 1) return "Add at least one agent.";
        if (names.Count > 8) return "At most 8 agents.";
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in names)
        {
            var e = ValidateOne(n);
            if (e != null) return e;
            if (!seen.Add(n)) return $"“{n}” is used twice.";
        }
        return null;
    }
    public static string? ValidateOne(string n)
    {
        if (!NameRx.IsMatch(n)) return string.IsNullOrWhiteSpace(n) ? "A name is empty." : $"“{n}”: use 3–16 letters, digits or _.";
        if (n.Equals(HumanName, StringComparison.OrdinalIgnoreCase) || n.Equals(Orchestrator.Cfg.Player.McName, StringComparison.OrdinalIgnoreCase)) return $"“{n}” is your own name — pick another.";
        return null;
    }
}
