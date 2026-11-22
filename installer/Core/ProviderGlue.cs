namespace Hivecraft.Setup;

/// <summary>
/// The installer's view of AI providers. Catalog, models, key storage (DPAPI), Claude Code detection/install/login and the
/// connection test all live in launcher/Core/Providers.cs (linked, shared with the launcher); this only adapts it.
/// Every provider runs the agents through Claude Code, so Claude Code is needed for all of them.
/// </summary>
static class ProviderGlue
{
    /// <summary>Kinds shown in the simple wizard (Bedrock/Vertex are "advanced": settable from the command line).</summary>
    public static IReadOnlyList<ProviderInfo> WizardKinds => Providers.All.Where(p => !p.Advanced).ToList();

    public static ProviderInfo Get(string kind) => Providers.Get(kind) ?? Providers.All[0];

    public static ProviderSettings Settings(SetupOptions o) => new()
    {
        Kind = Providers.NormalizeKind(o.ProviderKind),
        BaseUrl = o.BaseUrl.Trim(),
        Model = o.Model.Trim(),
        SmallModel = o.SmallModel.Trim(),
    };

    /// <summary>null = fine, else a plain-words problem (missing key, bad URL…).</summary>
    public static string? Validate(SetupOptions o) => Providers.Validate(Settings(o), string.IsNullOrWhiteSpace(o.ApiKey) ? ExistingKey(o.ProviderKind) : o.ApiKey.Trim());

    public static string? ExistingKey(string kind)
    {
        try { return Providers.GetKey(kind); }
        catch (Exception e) { Log.W("reading saved key failed: " + e.Message); return null; }
    }

    /// <summary>Stores the API key (DPAPI, per Windows user) — never in hivecraft.config.json.</summary>
    public static Task<string> SaveKeyAsync(SetupOptions o, CancellationToken ct)
    {
        var info = Get(o.ProviderKind);
        if (string.IsNullOrWhiteSpace(o.ApiKey))
            return Task.FromResult(info.NeedsKey && ExistingKey(o.ProviderKind) == null ? "No API key saved yet — add it later in Hivecraft." : "");
        var err = Providers.SaveKey(info.Kind, o.ApiKey.Trim());
        if (err != null) throw new InstallException("The API key could not be saved: " + err);
        Log.W($"API key for {info.Kind} saved to {Providers.SecretsPath} ({Providers.MaskKey(o.ApiKey.Trim())})");
        return Task.FromResult("API key saved (encrypted for your Windows account).");
    }

    public static Task DeleteAllKeysAsync(CancellationToken ct)
    {
        var err = Providers.DeleteAllKeys();
        if (err != null) Log.W("deleting saved keys: " + err);
        return Task.CompletedTask;
    }

    public static string? FindClaude(string? configured = null) => Providers.FindClaude(configured);

    public static async Task<ConnectionResult> TestAsync(SetupOptions o, CancellationToken ct)
    {
        var key = string.IsNullOrWhiteSpace(o.ApiKey) ? ExistingKey(o.ProviderKind) : o.ApiKey.Trim();
        Log.W($"connection test: kind={o.ProviderKind} model={o.Model} baseUrl={o.BaseUrl}");
        var r = await Providers.TestConnectionAsync(o.ClaudeExe ?? FindClaude(), Settings(o), key, ct);
        Log.W($"connection test: ok={r.Ok} {r.Message}");
        return r;
    }
}
