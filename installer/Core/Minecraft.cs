using System.Text.Json.Nodes;

namespace Hivecraft.Setup;

/// <summary>Is a Minecraft: Java Edition launcher installed? (We cannot check ownership; the launcher does that at sign-in.)</summary>
static class MinecraftCheck
{
    public const string StorePackage = "Microsoft.4297127D64EC6_8wekyb3d8bbwe";

    public sealed record Result(bool StoreApp, string? LauncherExe, bool McDirExists, bool ProfilesFile, bool Has1211, string McDir)
    {
        public bool AnyLauncher => StoreApp || LauncherExe != null;
        public string Summary =>
            AnyLauncher
                ? (StoreApp ? "Minecraft Launcher (Microsoft Store / Xbox app) found." : "Minecraft Launcher found: " + LauncherExe) +
                  (ProfilesFile ? " It has been started before — good." : " Start it once and sign in before playing.") +
                  (Has1211 ? " Minecraft 1.21.1 is already downloaded." : " Minecraft 1.21.1 will be downloaded by the launcher the first time you press PLAY.")
                : McDirExists ? "A .minecraft folder exists, but no Minecraft Launcher was found." : "Minecraft Java Edition was not found on this PC.";
    }

    public static Result Detect(string mcDir)
    {
        bool store = Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Packages", StorePackage));
        string? exe = null;
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var cands = new List<string>
        {
            Path.Combine(pf86, "Minecraft Launcher", "MinecraftLauncher.exe"),
            Path.Combine(pf, "Minecraft Launcher", "MinecraftLauncher.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Minecraft Launcher", "MinecraftLauncher.exe"),
        };
        foreach (var d in DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady))
            cands.Add(Path.Combine(d.RootDirectory.FullName, "XboxGames", "Minecraft Launcher", "Content", "Minecraft.exe"));
        exe = cands.FirstOrDefault(File.Exists);
        bool dir = Directory.Exists(mcDir);
        bool prof = File.Exists(Path.Combine(mcDir, "launcher_profiles.json"));
        bool has = File.Exists(Path.Combine(mcDir, "versions", "1.21.1", "1.21.1.json"));
        var r = new Result(store, exe, dir, prof, has, mcDir);
        Log.W($"minecraft check: store={store} exe={exe ?? "-"} mcDir={mcDir} exists={dir} profiles={prof} 1.21.1={has}");
        return r;
    }

    /// <summary>Remove only the Hivecraft profile (name Hivecraft + version hivecraft-1.21.1) from launcher_profiles.json.</summary>
    public static string RemoveProfile(string json)
    {
        var root = JsonNode.Parse(json)!.AsObject();
        if (root["profiles"] is JsonObject profiles)
        {
            var mine = profiles.Where(kv => kv.Value is JsonObject o && (string?)o["name"] == FileEdits.ProfileName && (string?)o["lastVersionId"] == FileEdits.VersionId).Select(kv => kv.Key).ToList();
            foreach (var k in mine) profiles.Remove(k);
            foreach (var k in new[] { "selectedProfile", "selectedProfileId" })
                if (root[k] is JsonValue v && v.TryGetValue<string>(out var s) && mine.Contains(s)) root.Remove(k);
        }
        return root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }
}
