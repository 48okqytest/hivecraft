using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hivecraft;

// AI providers for Hivecraft: catalog, model lists, DPAPI key store, Claude Code detection / install / login,
// child environment (mirror of crew/providers.js — keep the two in sync) and a connection test.
// Pure: no WPF, shared with the installer (linked file). Docs this follows:
//   https://code.claude.com/docs/en/env-vars, /llm-gateway, /authentication, /setup, /amazon-bedrock, /google-vertex-ai
//   https://openrouter.ai/docs/guides/guides/claude-code-integration, https://openrouter.ai/docs/api_reference/models

/// <summary>One choosable backend.</summary>
sealed record ProviderInfo(
    string Kind, string Name, string Tagline, string Help,
    bool NeedsKey, bool KeyOptional, string KeyLabel, string KeyUrl, string SignupUrl, string DocsUrl,
    bool NeedsBaseUrl, bool FreeTextModel, string DefaultModel, string DefaultSmallModel, bool Advanced);

/// <summary>A model in a picker. PromptPerM/CompletionPerM in USD per million tokens (null = unknown).</summary>
sealed record ModelOption(string Id, string Label, string Note = "", double? PromptPerM = null, double? CompletionPerM = null, int ContextLength = 0, bool IsClaude = true)
{
    public override string ToString() => Label;
}

/// <summary>The provider part of hivecraft.config.json, flattened (extras live in ProviderCfg.Extra).</summary>
sealed class ProviderSettings
{
    public string Kind { get; set; } = "claude-login";
    public string BaseUrl { get; set; } = "";
    public string Model { get; set; } = "";
    public string SmallModel { get; set; } = "";
    /// <summary>custom only: "bearer" (ANTHROPIC_AUTH_TOKEN, default) or "x-api-key" (ANTHROPIC_API_KEY)</summary>
    public string AuthHeader { get; set; } = "bearer";
    public string Region { get; set; } = "";      // bedrock / vertex
    public string ProjectId { get; set; } = "";   // vertex
    public string Profile { get; set; } = "";     // bedrock (AWS_PROFILE)

    public string EffectiveModel => !string.IsNullOrWhiteSpace(Model) ? Model.Trim() : (Providers.Get(Kind)?.DefaultModel ?? "");
    public string EffectiveSmallModel => !string.IsNullOrWhiteSpace(SmallModel) ? SmallModel.Trim() : (Providers.Get(Kind)?.DefaultSmallModel ?? "");

    public static ProviderSettings FromConfig(HiveConfig.ProviderCfg p)
    {
        string X(string k) => p.Extra != null && p.Extra.TryGetValue(k, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
        return new ProviderSettings
        {
            Kind = Providers.NormalizeKind(p.Kind), BaseUrl = p.BaseUrl ?? "", Model = p.Model ?? "", SmallModel = p.SmallModel ?? "",
            AuthHeader = X("authHeader") == "x-api-key" ? "x-api-key" : "bearer", Region = X("region"), ProjectId = X("projectId"), Profile = X("profile"),
        };
    }

    /// <summary>Writes these values into a config's provider section (other extra keys are kept).</summary>
    public void ApplyTo(HiveConfig.ProviderCfg p)
    {
        p.Kind = Kind; p.BaseUrl = BaseUrl.Trim(); p.Model = Model.Trim(); p.SmallModel = SmallModel.Trim();
        p.Extra ??= new();
        void S(string k, string v) { if (string.IsNullOrWhiteSpace(v)) p.Extra.Remove(k); else p.Extra[k] = JsonSerializer.SerializeToElement(v.Trim()); }
        S("authHeader", Kind == "custom" && AuthHeader == "x-api-key" ? "x-api-key" : "");
        S("region", Kind is "bedrock" or "vertex" ? Region : "");
        S("projectId", Kind == "vertex" ? ProjectId : "");
        S("profile", Kind == "bedrock" ? Profile : "");
        if (p.Extra.Count == 0) p.Extra = null;
    }
}

sealed record ClaudeLoginStatus(bool Known, bool LoggedIn, string Method, string Subscription, string Email, string Message);

sealed record ConnectionResult(bool Ok, string Message, double? CostUsd = null, string Model = "", long DurationMs = 0, string Detail = "");

sealed record OpenRouterKeyInfo(bool Ok, string Message, string Label = "", double? LimitRemaining = null, bool IsFreeTier = false);

static class Providers
{
    // ------------------------------------------------------------------ catalog
    public const string OpenRouterBase = "https://openrouter.ai/api";
    public const string OpenRouterModelsUrl = "https://openrouter.ai/api/v1/models?supported_parameters=tools";
    public const string OpenRouterKeyUrl = "https://openrouter.ai/api/v1/key";

    public static readonly IReadOnlyList<ProviderInfo> All = new List<ProviderInfo>
    {
        new("claude-login", "Claude subscription", "Use your Claude Pro / Max / Team plan — no API key",
            "Signs in once with Claude Code (a browser window opens). Agents then use your plan's usage limits instead of paying per token. Several agents running for hours use limits quickly; Max is recommended.",
            false, false, "", "", "https://claude.ai/upgrade", "https://code.claude.com/docs/en/authentication",
            false, false, "claude-sonnet-5-5", "", false),
        new("anthropic-key", "Anthropic API key", "Pay per token with a Claude Console key",
            "Create a key in the Claude Console (Settings → API keys) and add credit. Billed per token; a running agent costs roughly a few dollars per hour on Sonnet.",
            true, false, "Anthropic API key (sk-ant-…)", "https://platform.claude.com/settings/keys", "https://platform.claude.com/", "https://code.claude.com/docs/en/authentication",   // scrub-ok: key-prefix hint, not a key
            false, false, "claude-sonnet-5-5", "", false),
        new("openrouter", "OpenRouter", "One key for Claude and hundreds of other models",
            "Create a key on openrouter.ai (Settings → Keys) and add credit. Claude models work best; other models can be picked but Claude Code is tuned for Claude, so agents may play worse or fail tool calls.",
            true, false, "OpenRouter API key (sk-or-…)", "https://openrouter.ai/settings/keys", "https://openrouter.ai/", "https://openrouter.ai/docs/guides/guides/claude-code-integration",
            false, false, "anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", false),
        new("custom", "Other API (Anthropic-compatible)", "DeepSeek, Kimi, GLM, LiteLLM, your own gateway…",
            "Any service with an Anthropic Messages-compatible endpoint. Enter its base URL, your key and a model id from its docs (examples: https://api.deepseek.com/anthropic, https://api.moonshot.ai/anthropic, https://api.z.ai/api/anthropic, http://localhost:4000 for LiteLLM). Non-Claude models may play worse.",
            true, true, "API key / token", "", "", "https://code.claude.com/docs/en/llm-gateway",
            true, true, "", "", false),
        new("bedrock", "Amazon Bedrock", "Claude through your AWS account",
            "Uses your AWS credentials (aws configure / SSO profile) or a Bedrock API key. Pick a region with Claude enabled and a Bedrock model id such as us.anthropic.claude-sonnet-… .",
            false, true, "Bedrock API key (optional)", "", "", "https://code.claude.com/docs/en/amazon-bedrock",
            false, true, "", "", true),
        new("vertex", "Google Vertex AI", "Claude through your Google Cloud project",
            "Uses Google Cloud application-default credentials (gcloud auth application-default login). Needs your project id; region defaults to global.",
            false, false, "", "", "", "https://code.claude.com/docs/en/google-vertex-ai",
            false, true, "", "", true),
    };

    public static ProviderInfo? Get(string? kind) => All.FirstOrDefault(p => p.Kind == NormalizeKind(kind));
    public static string NormalizeKind(string? kind)
    {
        var k = (kind ?? "").Trim().ToLowerInvariant();
        return All.Any(p => p.Kind == k) ? k : "claude-login";
    }

    /// <summary>Claude models for claude-login / anthropic-key (Anthropic ids).</summary>
    public static readonly IReadOnlyList<ModelOption> ClaudeModels = new List<ModelOption>
    {
        new("claude-sonnet-5-5", "Sonnet 5.5 — recommended", "smart, fast, good value"),
        new("claude-opus-5-5", "Opus 5.5 — smarter", "better planning; costs more / uses limits faster"),
        new("claude-haiku-5-5", "Haiku 5.5 — cheapest", "fast and cheap; weaker at long plans"),
        new("claude-fable-5-2", "Fable 5.2 — most capable", "most expensive"),
    };

    /// <summary>Offline fallback when the OpenRouter list can't be fetched.</summary>
    public static readonly IReadOnlyList<ModelOption> OpenRouterFallback = new List<ModelOption>
    {
        new("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5 — recommended", "", 2, 10),
        new("anthropic/claude-opus-5.5", "Claude Opus 5.5", "", 4, 20),
        new("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", "", 0.1, 0.5),
        new("anthropic/claude-fable-5.2", "Claude Fable 5.2", "", 8, 40),
    };

    /// <summary>Models to offer for a kind without network (OpenRouter: the fallback; custom/bedrock/vertex: empty = free text).</summary>
    public static IReadOnlyList<ModelOption> BuiltInModels(string kind) => NormalizeKind(kind) switch
    {
        "claude-login" or "anthropic-key" => ClaudeModels,
        "openrouter" => OpenRouterFallback,
        _ => Array.Empty<ModelOption>(),
    };

    /// <summary>'claude-sonnet-5-5' -> 'anthropic/claude-sonnet-5.5' (same rule as providers.js); other ids unchanged.</summary>
    public static string ToOpenRouterModel(string id)
    {
        var m = (id ?? "").Trim();
        if (m.Length == 0 || m.Contains('/')) return m;
        var r = System.Text.RegularExpressions.Regex.Match(m, @"^(claude-[a-z]+)-(\d+)(?:-(\d{1,2}))?(\[1m\])?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return r.Success ? $"anthropic/{r.Groups[1].Value.ToLowerInvariant()}-{r.Groups[2].Value}{(r.Groups[3].Success ? "." + r.Groups[3].Value : "")}{r.Groups[4].Value}" : m;
    }

    // ------------------------------------------------------------------ OpenRouter
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    static Providers() { Http.DefaultRequestHeaders.UserAgent.Add(new System.Net.Http.Headers.ProductInfoHeaderValue("Hivecraft", "1.0")); }

    /// <summary>Diagnostics sink (launcher log / installer log). Messages never contain keys.</summary>
    public static Action<string>? Log { get; set; }
    static void Say(string msg)
    {
        try { Log?.Invoke("[providers] " + msg); }
        catch (Exception e) { Debug.WriteLine("providers: log sink failed: " + e.Message + " — " + msg); }
    }

    // JSON helpers that never throw
    static double? Num(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<string>(out var s) && double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
        return null;
    }
    static bool? Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;
    /// <summary>null = not JSON (callers treat that as "no structured answer").</summary>
    static JsonNode? ParseJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonNode.Parse(text); }
        catch (JsonException) { return null; }
    }

    /// <summary>Public model list (no key needed), tool-capable only. Throws on network errors (caller falls back to OpenRouterFallback).</summary>
    public static async Task<List<ModelOption>> FetchOpenRouterModelsAsync(CancellationToken ct = default)
    {
        var json = await Http.GetStringAsync(OpenRouterModelsUrl, ct);
        return ParseOpenRouterModels(json);
    }

    /// <summary>Parses /api/v1/models: keeps models whose supported_parameters has "tools", drops :batch variants; Claude first.</summary>
    public static List<ModelOption> ParseOpenRouterModels(string json)
    {
        var list = new List<ModelOption>();
        if (ParseJson(json)?["data"] is not JsonArray data) { Say("OpenRouter model list: unexpected answer (no data array)"); return list; }
        static double? PerM(JsonNode? v) => Num(v) is double d && d >= 0 ? Math.Round(d * 1_000_000, 4) : null;
        foreach (var m in data)
        {
            var id = m?["id"]?.ToString();
            if (string.IsNullOrWhiteSpace(id) || id.EndsWith(":batch", StringComparison.OrdinalIgnoreCase)) continue;
            var sp = m!["supported_parameters"] as JsonArray;
            if (sp == null || !sp.Any(x => x?.ToString() == "tools")) continue;
            var name = m["name"]?.ToString() ?? id;
            var p = PerM(m["pricing"]?["prompt"]); var c = PerM(m["pricing"]?["completion"]);
            int ctx = (int)Math.Clamp(Num(m["context_length"]) ?? 0, 0, int.MaxValue);
            bool claude = id.StartsWith("anthropic/claude", StringComparison.OrdinalIgnoreCase);
            var price = p is null || c is null ? "" : p == 0 && c == 0 ? "free" : $"${Fmt(p.Value)} / ${Fmt(c.Value)} per M tokens";
            list.Add(new ModelOption(id, name, price, p, c, ctx, claude));
        }
        return list.OrderByDescending(x => x.IsClaude).ThenBy(x => x.IsClaude ? ClaudeRank(x.Id) : 0).ThenBy(x => x.Label, StringComparer.OrdinalIgnoreCase).ToList();
    }
    static string Fmt(double d) => d.ToString(d < 1 ? "0.###" : "0.##", System.Globalization.CultureInfo.InvariantCulture);
    static int ClaudeRank(string id) => id.Contains("sonnet-5.5") ? 0 : id.Contains("opus-5.5") ? 1 : id.Contains("haiku-5.5") ? 2 : id.Contains("fable-5.2") ? 3 : 10;

    /// <summary>Checks an OpenRouter key for free (GET /api/v1/key, no tokens spent).</summary>
    public static async Task<OpenRouterKeyInfo> CheckOpenRouterKeyAsync(string key, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(key)) return new(false, "Enter your OpenRouter key first.");
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, OpenRouterKeyUrl);
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key.Trim());
            using var res = await Http.SendAsync(req, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            return ParseOpenRouterKey((int)res.StatusCode, body);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { Say("OpenRouter key check: timeout"); return new(false, "OpenRouter did not answer (timeout). Check your internet connection."); }
        catch (HttpRequestException e) { Say("OpenRouter key check: " + e.Message); return new(false, "Could not reach openrouter.ai: " + e.Message); }
    }
    public static OpenRouterKeyInfo ParseOpenRouterKey(int status, string body)
    {
        if (status == 401 || status == 403) return new(false, "OpenRouter rejected this key. Copy it again from openrouter.ai → Settings → Keys.");
        if (status < 200 || status >= 300) return new(false, $"OpenRouter answered HTTP {status}.");
        var d = ParseJson(body)?["data"];
        var rem = Num(d?["limit_remaining"]);
        bool free = Bool(d?["is_free_tier"]) ?? false;
        var msg = "Key works." + (rem is double r ? $" Credit left on this key: ${r:0.00}." : "") + (free ? " This account has no credit yet (free tier): add credit for Claude models." : "");
        return new(true, msg, d?["label"]?.ToString() ?? "", rem, free);
    }

    // ------------------------------------------------------------------ secrets (DPAPI, current user)
    /// <summary>Folder of secrets.dat: HIVECRAFT_DATA_DIR env, else %APPDATA%\Hivecraft. Settable (tests, installer).</summary>
    public static string DataDir
    {
        get => _dataDir ?? (Environment.GetEnvironmentVariable("HIVECRAFT_DATA_DIR") is { Length: > 0 } e ? e
               : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Hivecraft"));
        set => _dataDir = value;
    }
    static string? _dataDir;
    public static string SecretsPath => Path.Combine(DataDir, "secrets.dat");
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Hivecraft.providers.v1");
    static readonly object SecretLock = new();

    /// <summary>Why the last read of secrets.dat failed (null = fine). Show it so a lost key isn't a mystery.</summary>
    public static string? LastSecretError { get; private set; }

    /// <summary>Stores (or with an empty key, removes) the key for a provider kind, encrypted for the current Windows user.</summary>
    /// <returns>null = saved; otherwise why it could not be saved (plain words, never the key).</returns>
    public static string? SaveKey(string kind, string? key)
    {
        lock (SecretLock)
        {
            var all = LoadAll();
            kind = NormalizeKind(kind);
            if (string.IsNullOrWhiteSpace(key)) all.Remove(kind); else all[kind] = key.Trim();
            var tmp = SecretsPath + ".tmp";
            try
            {
                Directory.CreateDirectory(DataDir);
                File.WriteAllBytes(tmp, Dpapi.Protect(JsonSerializer.SerializeToUtf8Bytes(all), Entropy));
                File.Move(tmp, SecretsPath, true);
                return null;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
            {
                Say($"could not save key for {kind} to {SecretsPath}: {e.Message}");
                return $"Could not save the key to {SecretsPath}: {e.Message}";
            }
        }
    }
    public static string? GetKey(string kind) { lock (SecretLock) return LoadAll().TryGetValue(NormalizeKind(kind), out var k) && k.Length > 0 ? k : null; }
    public static bool HasKey(string kind) => GetKey(kind) != null;
    public static string? DeleteKey(string kind) => SaveKey(kind, null);
    /// <summary>Uninstall: removes secrets.dat (all stored keys). null = done, else why not.</summary>
    public static string? DeleteAllKeys()
    {
        lock (SecretLock)
        {
            try { File.Delete(SecretsPath); File.Delete(SecretsPath + ".tmp"); return null; }   // missing files are fine
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Say($"could not delete {SecretsPath}: {e.Message}");
                return $"Could not delete {SecretsPath}: {e.Message}";
            }
        }
    }
    /// <summary>"sk-or-v1-…cdef" for display; never the full key.</summary>
    public static string MaskKey(string? key) => string.IsNullOrEmpty(key) ? "" : key.Length <= 10 ? new string('•', key.Length) : key[..Math.Min(6, key.Length / 3)] + "…" + key[^4..];

    static Dictionary<string, string> LoadAll()
    {
        LastSecretError = null;
        if (!File.Exists(SecretsPath)) return new();
        try
        {
            var plain = Dpapi.Unprotect(File.ReadAllBytes(SecretsPath), Entropy);
            return JsonSerializer.Deserialize<Dictionary<string, string>>(plain) ?? new();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or JsonException)
        {
            // another Windows user's file, or corrupt: behave as empty and say why (the user re-enters the key)
            LastSecretError = $"Saved keys could not be read ({e.Message}). Enter your key again.";
            Say($"{SecretsPath} unreadable: {e.Message}");
            return new();
        }
    }

    static class Dpapi
    {
        [StructLayout(LayoutKind.Sequential)] struct Blob { public int Size; public IntPtr Data; }
        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CryptProtectData(ref Blob dataIn, string? descr, ref Blob entropy, IntPtr reserved, IntPtr prompt, int flags, ref Blob dataOut);
        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CryptUnprotectData(ref Blob dataIn, IntPtr descr, ref Blob entropy, IntPtr reserved, IntPtr prompt, int flags, ref Blob dataOut);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);
        const int UiForbidden = 0x1;

        public static byte[] Protect(byte[] data, byte[] entropy) => Run(data, entropy, true);
        public static byte[] Unprotect(byte[] data, byte[] entropy) => Run(data, entropy, false);
        static byte[] Run(byte[] data, byte[] entropy, bool protect)
        {
            var inB = new Blob { Size = data.Length, Data = Marshal.AllocHGlobal(Math.Max(1, data.Length)) };
            var enB = new Blob { Size = entropy.Length, Data = Marshal.AllocHGlobal(Math.Max(1, entropy.Length)) };
            var outB = new Blob();
            try
            {
                Marshal.Copy(data, 0, inB.Data, data.Length);
                Marshal.Copy(entropy, 0, enB.Data, entropy.Length);
                bool ok = protect ? CryptProtectData(ref inB, "Hivecraft", ref enB, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref outB)
                                  : CryptUnprotectData(ref inB, IntPtr.Zero, ref enB, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref outB);
                if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                var res = new byte[outB.Size];
                Marshal.Copy(outB.Data, res, 0, outB.Size);
                return res;
            }
            finally
            {
                if (inB.Data != IntPtr.Zero) { Marshal.Copy(new byte[data.Length], 0, inB.Data, data.Length); Marshal.FreeHGlobal(inB.Data); }
                if (enB.Data != IntPtr.Zero) Marshal.FreeHGlobal(enB.Data);
                if (outB.Data != IntPtr.Zero) LocalFree(outB.Data);
            }
        }
    }

    // ------------------------------------------------------------------ Claude Code: find / install / login
    /// <summary>Official Windows installer (https://code.claude.com/docs/en/setup). Run only when the user clicks.</summary>
    public const string InstallCommandPowerShell = "irm https://claude.ai/install.ps1 | iex";
    public const string InstallCommandCmd = "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd";
    public const string InstallCommandWinget = "winget install Anthropic.ClaudeCode";
    public const string InstallCommandNpm = "npm install -g @anthropic-ai/claude-code@latest";
    public const string InstallDocsUrl = "https://code.claude.com/docs/en/setup";

    /// <summary>
    /// claude.exe: configured path (config runtime.claude) > CLAUDE_BIN > %USERPROFILE%\.local\bin\claude.exe (native installer)
    /// > PATH > WinGet links > npm global (%APPDATA%\npm\claude.cmd). null = not installed.
    /// </summary>
    public static string? FindClaude(string? configured = null)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var cands = new List<string>();
        void Add(string? p) { if (!string.IsNullOrWhiteSpace(p)) cands.Add(Environment.ExpandEnvironmentVariables(p.Trim().Trim('"'))); }
        Add(configured);
        Add(Environment.GetEnvironmentVariable("CLAUDE_BIN"));
        Add(Path.Combine(home, ".local", "bin", "claude.exe"));
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (var n in new[] { "claude.exe", "claude.cmd" })
                if (dir.Trim('"').IndexOfAny(Path.GetInvalidPathChars()) < 0) Add(Path.Combine(dir.Trim('"'), n));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", "claude.exe"));
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "claude.cmd"));
        foreach (var c in cands) if (File.Exists(c)) return c;   // File.Exists never throws: bad paths are just false
        Say($"Claude Code not found; looked in {cands.Count} places, e.g. {string.Join("; ", cands.Take(3))}");
        return null;
    }

    /// <summary>"2.1.326 (Claude Code)" or null (reason logged).</summary>
    public static async Task<string?> ClaudeVersionAsync(string claude, CancellationToken ct = default)
    {
        var r = await RunAsync(claude, new[] { "--version" }, CleanEnv(new ProviderSettings { Kind = "claude-login" }, null), TimeSpan.FromSeconds(20), ct);
        if (r.Exit == 0 && r.Out.Trim().Length > 0) return r.Out.Trim().Split('\n')[0].Trim();
        Say($"`claude --version` failed (exit {r.Exit}): {Short(r.Err + " " + r.Out, 200)}");
        return null;
    }

    /// <summary>Opens a visible PowerShell window running the official installer. Returns the process (WaitForExitAsync it,
    /// then FindClaude()); null with `error` set (plain words) when it could not start.</summary>
    public static Process? StartInstallClaude(out string? error)
    {
        error = null;
        var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = true };
        foreach (var a in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            $"Write-Host 'Installing Claude Code (official installer from claude.ai)...'; {InstallCommandPowerShell}; Write-Host ''; Write-Host 'Done. You can close this window.'; Start-Sleep -Seconds 4" })
            psi.ArgumentList.Add(a);
        try { return Process.Start(psi) ?? throw new InvalidOperationException("PowerShell did not start"); }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            error = $"Could not open PowerShell to install Claude Code ({e.Message}). Install it by hand: open PowerShell and run  {InstallCommandPowerShell}";
            Say(error);
            return null;
        }
    }

    /// <summary>Opens a console window running `claude auth login` (browser sign-in to the Claude subscription).
    /// null with `error` set when it could not start.</summary>
    public static Process? StartLogin(string claude, out string? error)
    {
        error = null;
        var psi = new ProcessStartInfo(claude) { UseShellExecute = false, CreateNoWindow = false };
        psi.ArgumentList.Add("auth"); psi.ArgumentList.Add("login");
        foreach (var kv in CleanEnv(new ProviderSettings { Kind = "claude-login" }, null)) { if (kv.Value == null) psi.Environment.Remove(kv.Key); else psi.Environment[kv.Key] = kv.Value; }
        try { return Process.Start(psi) ?? throw new InvalidOperationException("claude did not start"); }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            error = $"Could not start the Claude sign-in ({e.Message}). Open a terminal and run:  claude auth login";
            Say(error);
            return null;
        }
    }

    /// <summary>`claude auth status --json` with API variables removed (so it reports the subscription login).</summary>
    public static async Task<ClaudeLoginStatus> LoginStatusAsync(string claude, CancellationToken ct = default)
    {
        var r = await RunAsync(claude, new[] { "auth", "status", "--json" }, CleanEnv(new ProviderSettings { Kind = "claude-login" }, null), TimeSpan.FromSeconds(30), ct);
        return ParseLoginStatus(r.Out, r.Err, r.Exit);
    }
    public static ClaudeLoginStatus ParseLoginStatus(string stdout, string stderr, int exit)
    {
        if (ParseJson(stdout.Trim()) is JsonObject o && Bool(o["loggedIn"]) is bool yes)
        {
            string S(string k) => o[k]?.ToString() ?? "";
            var sub = S("subscriptionType");
            var msg = yes ? $"Signed in{(S("email").Length > 0 ? " as " + S("email") : "")}{(sub.Length > 0 ? $" ({sub})" : "")}." : "Not signed in to Claude yet. Click Sign in.";
            return new(true, yes, S("authMethod"), sub, S("email"), msg);
        }
        if (exit == -2) return new(false, false, "", "", "", "Claude Code did not answer in time.");
        var t = (stderr + " " + stdout).Trim();
        if (t.Contains("not logged in", StringComparison.OrdinalIgnoreCase) || t.Contains("/login", StringComparison.OrdinalIgnoreCase))
            return new(true, false, "", "", "", "Not signed in to Claude yet. Click Sign in.");
        return new(false, false, "", "", "", "Could not read the sign-in status" + (t.Length > 0 ? ": " + Short(t, 160) : "."));
    }

    // ------------------------------------------------------------------ environment (mirror of crew/providers.js)
    static readonly string[] Tiers = { "OPUS", "SONNET", "HAIKU", "FABLE" };
    public static readonly IReadOnlyList<string> ConflictingVars = new[]
    {
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_PROFILE",
    }.Concat(Tiers.SelectMany(t => new[] { $"ANTHROPIC_DEFAULT_{t}_MODEL", $"ANTHROPIC_DEFAULT_{t}_MODEL_NAME", $"ANTHROPIC_DEFAULT_{t}_MODEL_DESCRIPTION", $"ANTHROPIC_DEFAULT_{t}_MODEL_SUPPORTED_CAPABILITIES" }))
     .Concat(new[] { "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
        "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY", "HIVE_PROVIDER_KEY" }).ToArray();

    /// <summary>
    /// Changes to apply on top of the inherited environment for a claude process using this provider:
    /// value null = remove the variable, "" = set empty. `model` overrides s.Model (per agent).
    /// </summary>
    public static Dictionary<string, string?> CleanEnv(ProviderSettings s, string? key, string? model = null)
    {
        var env = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var kind = NormalizeKind(s.Kind);
        foreach (var v in ConflictingVars) env[v] = null;
        if (kind == "claude-login" && Environment.GetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN") is { Length: > 0 } oauth) env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth;
        var m = (model ?? "").Trim(); if (m.Length == 0) m = s.EffectiveModel;
        if (kind == "openrouter") m = ToOpenRouterModel(m);
        var small = kind == "openrouter" ? ToOpenRouterModel(s.EffectiveSmallModel) : s.EffectiveSmallModel;
        key = string.IsNullOrWhiteSpace(key) ? null : key.Trim();
        void Pin()
        {
            if (m.Length > 0) { env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = m; env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = m; env["CLAUDE_CODE_SUBAGENT_MODEL"] = m; }
            if (small.Length > 0 || m.Length > 0) env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = small.Length > 0 ? small : m;
        }
        switch (kind)
        {
            case "claude-login":
                if (small.Length > 0) env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = small;
                break;
            case "anthropic-key":
                if (key != null) env["ANTHROPIC_API_KEY"] = key;
                if (small.Length > 0) env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = small;
                break;
            case "openrouter":
                env["ANTHROPIC_BASE_URL"] = s.BaseUrl.Trim().TrimEnd('/') is { Length: > 0 } b ? b : OpenRouterBase;
                if (key != null) env["ANTHROPIC_AUTH_TOKEN"] = key;
                env["ANTHROPIC_API_KEY"] = "";
                Pin();
                break;
            case "custom":
                env["ANTHROPIC_BASE_URL"] = s.BaseUrl.Trim().TrimEnd('/');
                if (s.AuthHeader == "x-api-key") env["ANTHROPIC_API_KEY"] = key ?? "hivecraft-no-key";
                else { env["ANTHROPIC_AUTH_TOKEN"] = key ?? "hivecraft-no-key"; env["ANTHROPIC_API_KEY"] = ""; }   // placeholder: never fall back to the Claude login
                env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1";
                Pin();
                break;
            case "bedrock":
                env["CLAUDE_CODE_USE_BEDROCK"] = "1";
                if (s.Region.Trim().Length > 0) env["AWS_REGION"] = s.Region.Trim();
                if (s.Profile.Trim().Length > 0) env["AWS_PROFILE"] = s.Profile.Trim();
                if (key != null) env["AWS_BEARER_TOKEN_BEDROCK"] = key;
                if (m.Length > 0) Pin();
                break;
            case "vertex":
                env["CLAUDE_CODE_USE_VERTEX"] = "1";
                env["CLOUD_ML_REGION"] = s.Region.Trim() is { Length: > 0 } r ? r : "global";
                if (s.ProjectId.Trim().Length > 0) env["ANTHROPIC_VERTEX_PROJECT_ID"] = s.ProjectId.Trim();
                if (m.Length > 0) Pin();
                break;
        }
        return env;
    }

    /// <summary>The model id claude gets for this provider (OpenRouter ids normalized).</summary>
    public static string ModelFor(ProviderSettings s, string? model = null)
    {
        var m = string.IsNullOrWhiteSpace(model) ? s.EffectiveModel : model.Trim();
        return NormalizeKind(s.Kind) == "openrouter" ? ToOpenRouterModel(m) : m;
    }

    /// <summary>null = OK; otherwise what's missing, in plain words.</summary>
    public static string? Validate(ProviderSettings s, string? key)
    {
        var kind = NormalizeKind(s.Kind);
        var info = Get(kind)!;
        if (info.NeedsKey && !info.KeyOptional && string.IsNullOrWhiteSpace(key)) return $"Add your {info.Name} key first.";
        if (kind == "custom")
        {
            if (!Uri.TryCreate(s.BaseUrl.Trim(), UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http")) return "Enter the service's base URL, e.g. https://api.example.com/anthropic";
            if (string.IsNullOrWhiteSpace(s.Model)) return "Enter a model id from the service's docs.";
        }
        if (kind == "vertex" && string.IsNullOrWhiteSpace(s.ProjectId)) return "Enter your Google Cloud project id.";
        if ((kind is "bedrock") && string.IsNullOrWhiteSpace(s.Model)) return "Enter a Bedrock model id (e.g. us.anthropic.claude-sonnet-…).";
        if (ModelFor(s).Any(char.IsWhiteSpace)) return "The model id must not contain spaces.";
        return null;
    }

    /// <summary>Env for Crew.Start: the crew builds each agent's environment itself (crew/providers.js) from
    /// hivecraft.config.json; the launcher only hands over the key. Empty when the provider has no key.</summary>
    public static Dictionary<string, string> CrewEnv(ProviderSettings s)
    {
        var d = new Dictionary<string, string>();
        var info = Get(s.Kind);
        if (info != null && (info.NeedsKey || info.KeyOptional) && GetKey(s.Kind) is string k) d["HIVE_PROVIDER_KEY"] = k;
        return d;
    }

    // ------------------------------------------------------------------ connection test
    public const string TestPrompt = "Reply with exactly the word OK and nothing else.";

    /// <summary>
    /// Runs `claude -p "<TestPrompt>" --model m --output-format json` with the provider's environment, no tools, no MCP,
    /// no saved session, budget cap $0.05. Costs a fraction of a cent on paid providers. Never throws.
    /// </summary>
    public static async Task<ConnectionResult> TestConnectionAsync(string? claude, ProviderSettings s, string? key, CancellationToken ct = default, TimeSpan? timeout = null)
    {
        if (claude == null || !File.Exists(claude)) return new(false, "Claude Code is not installed yet. Click Install Claude Code first.");
        var problem = Validate(s, key);
        if (problem != null) return new(false, problem);
        var model = ModelFor(s);
        var args = new List<string> { "-p", TestPrompt, "--output-format", "json", "--tools", "", "--strict-mcp-config",
            "--no-session-persistence", "--max-budget-usd", "0.05", "--permission-mode", "dontAsk", "--disable-slash-commands" };
        if (model.Length > 0) { args.Add("--model"); args.Add(model); }
        var cwd = Path.Combine(Path.GetTempPath(), "hivecraft-conntest");
        try { Directory.CreateDirectory(cwd); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { Say($"connection test: using %TEMP% ({e.Message})"); cwd = Path.GetTempPath(); }
        var sw = Stopwatch.StartNew();
        var r = await RunAsync(claude, args, CleanEnv(s, key), timeout ?? TimeSpan.FromSeconds(90), ct, cwd);
        var res = ParseTestOutput(r.Out, r.Err, r.Exit, s.Kind, model);
        Say($"connection test {NormalizeKind(s.Kind)} {model}: {(res.Ok ? "ok" : "FAILED")} (exit {r.Exit}, {sw.ElapsedMilliseconds} ms) {Redact(res.Ok ? res.Message : res.Detail, key)}");
        return res with { DurationMs = sw.ElapsedMilliseconds, Message = Redact(res.Message, key), Detail = Redact(res.Detail, key) };
    }

    /// <summary>Turns claude's JSON result (or error text) into plain words. Pure; used by the selftest.</summary>
    public static ConnectionResult ParseTestOutput(string stdout, string stderr, int exit, string kind, string model)
    {
        kind = NormalizeKind(kind);
        if (exit == -2) return new(false, "No answer within the time limit. The service may be slow or unreachable.", Model: model);
        JsonObject? res = null;
        foreach (var line in stdout.Split('\n').Select(l => l.Trim()).Where(l => l.StartsWith('{')).Reverse())
            if (ParseJson(line) is JsonObject o && (o["type"]?.ToString() == "result" || o.ContainsKey("is_error"))) { res = o; break; }
        res ??= ParseJson(stdout.Trim()) as JsonObject;
        var cost = Num(res?["total_cost_usd"]);
        var text = res?["result"]?.ToString() ?? "";
        bool isErr = Bool(res?["is_error"]) ?? false;
        var subtype = res?["subtype"]?.ToString();
        if (res != null && !isErr && (subtype is null or "success") && text.Trim().Length > 0)
        {
            var costTxt = kind == "claude-login" ? " (uses your plan's limits)" : cost is double c ? $" Test cost: ${c:0.0000}." : "";
            var said = text.Trim().TrimEnd('.').Equals("OK", StringComparison.OrdinalIgnoreCase) ? "" : $" (it answered: “{Short(text.Trim(), 60)}”)";
            return new(true, $"Connected — {(model.Length > 0 ? model : "the model")} answered{said}.{costTxt}", cost, model, Detail: Short(text, 300));
        }
        var all = (text + "\n" + stderr + "\n" + (res == null ? stdout : "")).Trim();
        if (all.Length == 0) all = $"claude exited with code {exit} and printed nothing";
        return new(false, Explain(all, kind, model, subtype), cost, model, Detail: Short(all, 600));
    }

    /// <summary>Common failures, in plain words.</summary>
    public static string Explain(string t, string kind, string model, string? subtype = null)
    {
        bool Has(params string[] s) => s.Any(x => t.Contains(x, StringComparison.OrdinalIgnoreCase));
        var who = kind switch { "anthropic-key" => "Anthropic", "openrouter" => "OpenRouter", "bedrock" => "AWS Bedrock", "vertex" => "Google Cloud", _ => "The service" };
        if (Has("not logged in", "please run /login", "run claude auth login", "OAuth token has expired", "authentication_error") && kind == "claude-login")
            return "Claude Code is not signed in (or the sign-in expired). Click Sign in and finish in the browser.";
        if (Has("invalid x-api-key", "invalid api key", "invalid_api_key", "401", "unauthorized", "authentication_error", "No auth credentials", "User not found"))
            return $"{who} rejected the key. Copy it again (no spaces) and save it.";
        if (Has("402", "insufficient", "credit balance", "credits", "payment required", "billing"))
            return $"{who} says the account has no credit left. Add credit on their website, then test again.";
        if (Has("429", "rate limit", "rate_limit", "overloaded", "usage limit", "limit reached"))
            return "The service is busy or you hit a usage limit. Wait a minute and try again.";
        if (Has("model_not_found", "not_found_error", "404", "does not exist", "no endpoints found", "invalid model", "model not found", "is not a valid model"))
            return $"The model “{model}” isn't available here. Pick another model{(kind == "openrouter" ? " (it must support tool use)" : "")}.";
        if (Has("tool", "tools") && Has("not support", "unsupported"))
            return $"The model “{model}” doesn't support tool use, which the agents need. Pick another model.";
        if (Has("ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "getaddrinfo", "Unable to connect", "fetch failed", "network", "certificate"))
            return kind == "custom" ? "Could not reach that base URL. Check the address (and that the server is running)." : "Could not reach the service. Check your internet connection.";
        if (Has("Unexpected value", "Extra inputs are not permitted", "anthropic-beta"))
            return "The endpoint rejected Claude Code's request format. It may not be fully Anthropic-compatible.";
        if (subtype == "error_max_budget_usd") return "The test hit its $0.05 safety cap before finishing (unusually expensive model?).";
        var first = t.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "";
        return first.Length > 0 ? "Test failed: " + Short(first, 220) : "Test failed: Claude Code gave no answer.";
    }

    // ------------------------------------------------------------------ helpers
    public static string Redact(string text, params string?[] secrets)
    {
        foreach (var s in secrets) if (!string.IsNullOrEmpty(s) && s.Length >= 6) text = text.Replace(s, "***");
        return text;
    }
    static string Short(string s, int n) { s = s.Replace("\r", " ").Replace("\n", " ").Trim(); return s.Length > n ? s[..n] + "…" : s; }

    sealed record RunResult(int Exit, string Out, string Err);

    /// <summary>Runs a process hidden; exit -2 = timeout (killed), -1 = could not start. `.cmd` files go through cmd.exe.</summary>
    static async Task<RunResult> RunAsync(string file, IEnumerable<string> args, IDictionary<string, string?> envChanges, TimeSpan timeout, CancellationToken ct, string? cwd = null)
    {
        var psi = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = cwd ?? Path.GetTempPath() };
        if (file.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || file.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            psi.ArgumentList.Add("/d"); psi.ArgumentList.Add("/s"); psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add(file);
        }
        else psi.FileName = file;
        foreach (var a in args) psi.ArgumentList.Add(a);
        foreach (var kv in envChanges) { if (kv.Value == null) psi.Environment.Remove(kv.Key); else psi.Environment[kv.Key] = kv.Value; }
        try
        {
            using var p = Process.Start(psi);
            if (p == null) { Say("could not start " + file); return new(-1, "", "Could not start " + file); }
            p.StandardInput.Close();   // claude -p must not wait for stdin
            var o = p.StandardOutput.ReadToEndAsync(); var e = p.StandardError.ReadToEndAsync();
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException)
            {
                try { p.Kill(true); }
                catch (Exception ke) when (ke is InvalidOperationException or System.ComponentModel.Win32Exception) { Say($"could not stop {Path.GetFileName(file)}: {ke.Message}"); }
                if (ct.IsCancellationRequested) throw;   // the caller cancelled: let them know
                Say($"{Path.GetFileName(file)} {string.Join(' ', args.Take(2))} timed out after {timeout.TotalSeconds:0} s");
                return new(-2, await PartialOutput(o), await PartialOutput(e));
            }
            return new(p.ExitCode, await o, await e);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            Say($"could not run {file}: {ex.Message}");
            return new(-1, "", $"Could not run {file}: {ex.Message}");
        }
    }
    /// <summary>Output of a killed process: whatever arrived within 2 s, else a note saying why there is none.</summary>
    static async Task<string> PartialOutput(Task<string> t)
    {
        try { return await t.WaitAsync(TimeSpan.FromSeconds(2)); }
        catch (Exception e) when (e is TimeoutException or IOException or ObjectDisposedException) { return $"(output unavailable: {e.Message})"; }
    }
}
