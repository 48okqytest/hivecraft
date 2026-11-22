using System.Diagnostics;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Hivecraft;

/// <summary>"AI provider → Change…": pick the backend, enter / check the key, sign in, pick a model, test, save.
/// Keys go to the DPAPI store (Providers.SaveKey) only when Save is pressed; the caller writes the config.</summary>
public partial class ProviderWindow : Window
{
    static List<ModelOption>? _orCache;          // OpenRouter list, fetched once per app run
    static string? _orError;

    readonly string? _claudeConfigured;
    readonly Dictionary<string, string> _modelByKind = new();
    readonly Dictionary<string, RadioButton> _kindButtons = new();
    string _kind;
    string? _claude;
    bool _busy, _settingModel, _ready;
    CancellationTokenSource? _testCts;

    internal ProviderSettings Result { get; private set; }

    static readonly Brush GreenB = Brush("#4ADE80"), RedB = Brush("#FB5D6D"), AmberB = Brush("#FFB547"), DimB = Brush("#7C8799");
    static SolidColorBrush Brush(string hex) { var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!; b.Freeze(); return b; }

    internal ProviderWindow(ProviderSettings current, string? claudeConfigured)
    {
        InitializeComponent();
        Result = Copy(current);
        _claudeConfigured = claudeConfigured;
        _kind = Providers.NormalizeKind(current.Kind);
        _modelByKind[_kind] = current.Model;
        txtBase.Text = current.BaseUrl; txtRegion.Text = current.Region; txtProject.Text = current.ProjectId; txtProfile.Text = current.Profile;
        txtSmall.Text = current.SmallModel;
        (current.AuthHeader == "x-api-key" ? rbXApiKey : rbBearer).IsChecked = true;

        foreach (var p in Providers.All)
        {
            var content = new StackPanel { Margin = new Thickness(6, 2, 6, 2) };
            content.Children.Add(new TextBlock { Text = p.Name, FontWeight = FontWeights.SemiBold, FontSize = 13, HorizontalAlignment = HorizontalAlignment.Center });
            content.Children.Add(new TextBlock { Text = p.Tagline, FontSize = 11, Opacity = 0.8, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, Margin = new Thickness(0, 2, 0, 0) });
            var rb = new RadioButton { Style = (Style)FindResource("Seg"), GroupName = "kind", Content = content, Tag = p.Kind, MinHeight = 58 };
            rb.Checked += (_, _) => { if (_ready) SwitchKind((string)rb.Tag); };
            _kindButtons[p.Kind] = rb;
            (p.Advanced ? kindGridAdv : kindGrid).Children.Add(rb);
        }
        if (Providers.Get(_kind)!.Advanced) ShowAdvanced();
        _kindButtons[_kind].IsChecked = true;
        _ready = true;
        SwitchKind(_kind, initial: true);
        Loaded += async (_, _) => { scroller.ScrollToTop(); await DetectClaudeAsync(); };
        Closed += (_, _) => _testCts?.Cancel();
    }

    static ProviderSettings Copy(ProviderSettings s) => new()
    {
        Kind = s.Kind, BaseUrl = s.BaseUrl, Model = s.Model, SmallModel = s.SmallModel, AuthHeader = s.AuthHeader, Region = s.Region, ProjectId = s.ProjectId, Profile = s.Profile,
    };

    // ------------------------------------------------------------------ chrome
    void OnDrag(object s, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); }
    void OnCancel(object s, RoutedEventArgs e) { DialogResult = false; }
    void OnMore(object s, RoutedEventArgs e) => ShowAdvanced();
    void ShowAdvanced() { kindGridAdv.Visibility = Visibility.Visible; btnMore.Visibility = Visibility.Collapsed; }

    // ------------------------------------------------------------------ provider kind
    void SwitchKind(string kind, bool initial = false)
    {
        if (!initial) _modelByKind[_kind] = txtModel.Text.Trim();
        _kind = Providers.NormalizeKind(kind);
        var info = Providers.Get(_kind)!;
        txtHelp.Text = info.Help;
        pnlLinks.Children.Clear();
        AddLink("Get a key ↗", info.KeyUrl);
        AddLink(_kind == "claude-login" ? "Plans ↗" : "Sign up ↗", info.SignupUrl);
        AddLink("Setup guide ↗", info.DocsUrl);

        pnlLogin.Visibility = _kind == "claude-login" ? Visibility.Visible : Visibility.Collapsed;
        pnlKey.Visibility = info.NeedsKey || info.KeyOptional ? Visibility.Visible : Visibility.Collapsed;
        lblKey.Text = (info.KeyLabel.Length > 0 ? info.KeyLabel : "API key").ToUpperInvariant();
        btnCheckKey.Visibility = _kind == "openrouter" ? Visibility.Visible : Visibility.Collapsed;
        pwdKey.Password = "";
        UpdateKeyNote();
        pnlBase.Visibility = _kind == "custom" ? Visibility.Visible : Visibility.Collapsed;
        pnlCloud.Visibility = _kind is "bedrock" or "vertex" ? Visibility.Visible : Visibility.Collapsed;
        pnlProject.Visibility = _kind == "vertex" ? Visibility.Visible : Visibility.Collapsed;
        pnlProfile.Visibility = _kind == "bedrock" ? Visibility.Visible : Visibility.Collapsed;
        pnlSmall.Visibility = _kind is "claude-login" or "anthropic-key" ? Visibility.Collapsed : Visibility.Visible;
        pnlFilter.Visibility = _kind == "openrouter" ? Visibility.Visible : Visibility.Collapsed;
        lblModelId.Text = info.FreeTextModel ? (_kind == "bedrock" ? "Bedrock model id (e.g. us.anthropic.claude-sonnet-…)" : _kind == "vertex" ? "Vertex model id (e.g. claude-sonnet-5-5)" : "Model id from the service's docs")
                                             : "Or type any model id";
        cmbModels.Visibility = info.FreeTextModel ? Visibility.Collapsed : Visibility.Visible;

        SetModelText(CarryModel(_kind));
        FillModels();
        if (_kind == "openrouter" && _orCache == null) _ = LoadOpenRouterAsync();
        if (_kind == "claude-login" && !initial) _ = RefreshLoginAsync();
        HideResult();
    }

    /// <summary>The model to show after switching to `kind`: what was there before for that kind, else the current one translated, else the default.</summary>
    string CarryModel(string kind)
    {
        if (_modelByKind.TryGetValue(kind, out var m) && m.Length > 0) return m;
        var cur = txtModel.Text.Trim();
        var info = Providers.Get(kind)!;
        if (kind == "openrouter" && cur.Length > 0) { var or = Providers.ToOpenRouterModel(cur); if (or.Contains('/')) return or; }
        if (kind is "claude-login" or "anthropic-key" && cur.StartsWith("anthropic/claude-", StringComparison.OrdinalIgnoreCase))
        {
            var id = cur["anthropic/".Length..].Replace("[1m]", "").Replace('.', '-');
            if (Providers.ClaudeModels.Any(x => x.Id == id)) return id;
        }
        if (kind is "claude-login" or "anthropic-key" && Providers.ClaudeModels.Any(x => x.Id == cur)) return cur;
        return info.DefaultModel;
    }

    void AddLink(string text, string url)
    {
        if (string.IsNullOrEmpty(url)) return;
        var b = new Button { Style = (Style)FindResource("Link"), Content = text, ToolTip = url };
        b.Click += (_, _) => OpenUrl(url);
        pnlLinks.Children.Add(b);
    }

    void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowResult($"Could not open the browser ({e.Message}). The address is: {url}", RedB); }
    }

    // ------------------------------------------------------------------ key
    void UpdateKeyNote()
    {
        var stored = Providers.GetKey(_kind);
        var info = Providers.Get(_kind)!;
        string note;
        if (pwdKey.Password.Length > 0) note = "Will be saved encrypted on this PC (for your Windows account only) when you press Save.";
        else if (stored != null) note = $"Saved: {Providers.MaskKey(stored)}. Leave empty to keep it, or paste a new one.";
        else if (info.KeyOptional) note = _kind == "bedrock" ? "Optional: leave empty to use your AWS credentials (aws configure / SSO)." : "Optional for services that don't need one (e.g. a local LiteLLM).";
        else note = "Stored encrypted on this PC for your Windows account only — never in a config file.";
        if (Providers.LastSecretError != null && pwdKey.Password.Length == 0) note += "  " + Providers.LastSecretError;
        txtKeyNote.Text = note;
    }
    void OnKeyChanged(object s, RoutedEventArgs e) { UpdateKeyNote(); HideResult(); }
    string? CurrentKey() => pwdKey.Password.Trim() is { Length: > 0 } typed ? typed : Providers.GetKey(_kind);

    async void OnCheckKey(object s, RoutedEventArgs e)
    {
        if (_busy) return;
        SetBusy(true, "Checking the key with OpenRouter (free)…");
        var r = await Providers.CheckOpenRouterKeyAsync(CurrentKey() ?? "");
        SetBusy(false);
        ShowResult(r.Message, r.Ok ? (r.IsFreeTier ? AmberB : GreenB) : RedB);
    }

    // ------------------------------------------------------------------ models
    void FillModels()
    {
        var info = Providers.Get(_kind)!;
        if (info.FreeTextModel) { cmbModels.Items.Clear(); UpdateModelNote(); return; }
        IEnumerable<ModelOption> list = _kind == "openrouter" ? (_orCache ?? Providers.OpenRouterFallback.ToList()) : Providers.BuiltInModels(_kind);
        var f = txtFilter.Text.Trim();
        if (_kind == "openrouter" && f.Length > 0)
            list = list.Where(m => m.Id.Contains(f, StringComparison.OrdinalIgnoreCase) || m.Label.Contains(f, StringComparison.OrdinalIgnoreCase));
        var items = list.Take(250).ToList();
        _settingModel = true;
        cmbModels.Items.Clear();
        var cur = txtModel.Text.Trim();
        foreach (var m in items) cmbModels.Items.Add(Item(m));
        if (cur.Length > 0 && !items.Any(m => m.Id == cur) && f.Length == 0) cmbModels.Items.Insert(0, Item(new ModelOption(cur, cur, "custom id")));
        cmbModels.SelectedItem = cmbModels.Items.Cast<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == cur);
        _settingModel = false;
        UpdateModelNote();
    }

    static ComboBoxItem Item(ModelOption m)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal };
        sp.Children.Add(new TextBlock { Text = m.Label });
        var note = m.Note.Length > 0 ? m.Note : "";
        if (note.Length > 0) sp.Children.Add(new TextBlock { Text = "   " + note, Foreground = DimB, FontSize = 11.5, VerticalAlignment = VerticalAlignment.Center });
        return new ComboBoxItem { Content = sp, Tag = m.Id, ToolTip = m.Id };
    }

    async Task LoadOpenRouterAsync()
    {
        txtModelNote.Text = "Loading OpenRouter's model list…";
        try { _orCache = await Providers.FetchOpenRouterModelsAsync(); _orError = null; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            _orError = "Couldn't load OpenRouter's model list (" + e.Message + "). Showing the Claude models; you can type any model id.";
            Providers.Log?.Invoke("[providers] OpenRouter model list: " + e.Message);
        }
        if (_kind == "openrouter") FillModels();
    }

    void OnFilterChanged(object s, TextChangedEventArgs e)
    {
        filterHint.Visibility = txtFilter.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (_ready) FillModels();
        if (txtFilter.Text.Length > 0 && cmbModels.Items.Count > 0) cmbModels.IsDropDownOpen = true;
    }

    void OnModelPicked(object s, SelectionChangedEventArgs e)
    {
        if (_settingModel || cmbModels.SelectedItem is not ComboBoxItem it) return;
        SetModelText((string)it.Tag);
        UpdateModelNote();
        HideResult();
    }
    void OnModelTyped(object s, TextChangedEventArgs e)
    {
        if (_settingModel) return;
        _settingModel = true;
        cmbModels.SelectedItem = cmbModels.Items.Cast<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == txtModel.Text.Trim());
        _settingModel = false;
        UpdateModelNote();
        HideResult();
    }
    void SetModelText(string id) { _settingModel = true; txtModel.Text = id; _settingModel = false; }

    void UpdateModelNote()
    {
        var id = txtModel.Text.Trim();
        var all = _kind == "openrouter" ? (_orCache ?? Providers.OpenRouterFallback.ToList()) : Providers.BuiltInModels(_kind).ToList();
        var m = all.FirstOrDefault(x => x.Id == id);
        var parts = new List<string>();
        if (m != null && m.Note.Length > 0) parts.Add(m.Note);
        if (m?.ContextLength > 0) parts.Add($"{m.ContextLength / 1000:N0}k context");
        if (_kind == "claude-login") parts.Add("uses your plan's usage limits");
        bool nonClaude = (_kind == "openrouter" && id.Length > 0 && !id.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase) && !id.StartsWith("~anthropic/", StringComparison.OrdinalIgnoreCase))
                         || (_kind == "custom" && id.Length > 0 && !id.Contains("claude", StringComparison.OrdinalIgnoreCase));
        if (nonClaude) parts.Add("⚠ not a Claude model: Claude Code is tuned for Claude, so agents may play worse or fail tool calls");
        if (_kind == "openrouter" && _orError != null) parts.Add(_orError);
        if (_kind == "openrouter" && _orCache != null && id.Length > 0 && m == null) parts.Add("not in OpenRouter's tool-capable list — check the id");
        txtModelNote.Text = string.Join(" · ", parts);
        txtModelNote.Foreground = nonClaude ? AmberB : DimB;
    }

    void OnFieldChanged(object s, RoutedEventArgs e) => HideResult();

    // ------------------------------------------------------------------ Claude Code: detect / install / sign in
    async Task DetectClaudeAsync()
    {
        _claude = Providers.FindClaude(_claudeConfigured);
        if (_claude == null)
        {
            txtClaude.Text = "Not installed. Hivecraft needs Claude Code to run the agents, whichever provider you pick. Click Install (official installer from claude.ai).";
            txtClaude.Foreground = RedB;
            btnInstall.Visibility = Visibility.Visible;
            txtLogin.Text = "Install Claude Code first.";
            return;
        }
        btnInstall.Visibility = Visibility.Collapsed;
        txtClaude.Foreground = DimB;
        txtClaude.Text = "Found: " + _claude;
        var v = await Providers.ClaudeVersionAsync(_claude);
        txtClaude.Text = v != null ? $"Claude Code {v.Replace("(Claude Code)", "").Trim()} · {_claude}" : $"Found {_claude}, but it did not report a version (it may be broken: reinstall).";
        if (v == null) txtClaude.Foreground = AmberB;
        if (_kind == "claude-login") await RefreshLoginAsync();
    }

    async void OnInstall(object s, RoutedEventArgs e)
    {
        if (_busy) return;
        var p = Providers.StartInstallClaude(out var err);
        if (p == null) { ShowResult(err ?? "Could not start the installer.", RedB); return; }
        SetBusy(true, "Installing Claude Code in the PowerShell window… (this can take a minute)");
        await p.WaitForExitAsync();
        int code = p.ExitCode;
        p.Dispose();
        SetBusy(false);
        await DetectClaudeAsync();
        if (_claude != null) ShowResult("Claude Code is installed.", GreenB);
        else ShowResult($"The installer finished (exit code {code}) but claude.exe wasn't found. Restart Hivecraft, or install by hand: open PowerShell and run  {Providers.InstallCommandPowerShell}", RedB);
    }

    async void OnLogin(object s, RoutedEventArgs e)
    {
        if (_busy) return;
        if (_claude == null) { ShowResult("Install Claude Code first.", RedB); return; }
        var p = Providers.StartLogin(_claude, out var err);
        if (p == null) { ShowResult(err ?? "Could not start the sign-in.", RedB); return; }
        SetBusy(true, "Finish signing in in the browser / console window that opened…");
        await p.WaitForExitAsync();
        p.Dispose();
        SetBusy(false);
        await RefreshLoginAsync();
    }
    async void OnLoginRefresh(object s, RoutedEventArgs e) => await RefreshLoginAsync();

    async Task RefreshLoginAsync()
    {
        if (_claude == null) { txtLogin.Text = "Install Claude Code first."; txtLogin.Foreground = RedB; return; }
        txtLogin.Text = "Checking sign-in…"; txtLogin.Foreground = DimB;
        var st = await Providers.LoginStatusAsync(_claude);
        txtLogin.Text = st.Message;
        txtLogin.Foreground = st.LoggedIn ? GreenB : st.Known ? AmberB : RedB;
        btnLogin.Content = st.LoggedIn ? "Sign in again" : "Sign in";
        if (st.LoggedIn && st.Method.Length > 0 && st.Method != "claude.ai")
        {
            txtLogin.Text += $" (signed in via {st.Method}; for a Pro/Max plan sign in with your claude.ai account)";
        }
    }

    // ------------------------------------------------------------------ test / save
    ProviderSettings FromForm() => new()
    {
        Kind = _kind,
        BaseUrl = _kind == "custom" ? txtBase.Text.Trim() : "",
        Model = txtModel.Text.Trim(),
        SmallModel = pnlSmall.Visibility == Visibility.Visible ? txtSmall.Text.Trim() : "",
        AuthHeader = rbXApiKey.IsChecked == true ? "x-api-key" : "bearer",
        Region = _kind is "bedrock" or "vertex" ? txtRegion.Text.Trim() : "",
        ProjectId = _kind == "vertex" ? txtProject.Text.Trim() : "",
        Profile = _kind == "bedrock" ? txtProfile.Text.Trim() : "",
    };

    async void OnTest(object s, RoutedEventArgs e)
    {
        if (_busy) return;
        var set = FromForm();
        var key = CurrentKey();
        var problem = Providers.Validate(set, key);
        if (problem != null) { ShowResult(problem, RedB); return; }
        if (_claude == null) { ShowResult("Install Claude Code first (button above).", RedB); return; }
        SetBusy(true, "Testing: sending one tiny message through Claude Code… (up to 90 s)");
        _testCts = new CancellationTokenSource();
        ConnectionResult r;
        try { r = await Providers.TestConnectionAsync(_claude, set, key, _testCts.Token); }
        catch (OperationCanceledException) { return; }   // window closed mid-test
        finally { SetBusy(false); }
        ShowResult(r.Message + (r.Ok ? "" : "  (details in the tooltip)"), r.Ok ? GreenB : RedB, r.Detail);
    }

    void OnSave(object s, RoutedEventArgs e)
    {
        var set = FromForm();
        var typed = pwdKey.Password.Trim();
        var problem = Providers.Validate(set, typed.Length > 0 ? typed : Providers.GetKey(_kind));
        if (problem != null) { ShowResult(problem, RedB); return; }
        if (typed.Length > 0 && Providers.SaveKey(_kind, typed) is string err) { ShowResult(err, RedB); return; }
        Result = set;
        DialogResult = true;
    }

    // ------------------------------------------------------------------ ui helpers
    void SetBusy(bool busy, string? msg = null)
    {
        _busy = busy;
        btnTest.IsEnabled = btnSave.IsEnabled = btnLogin.IsEnabled = btnInstall.IsEnabled = btnCheckKey.IsEnabled = !busy;
        Cursor = busy ? Cursors.AppStarting : null;
        if (busy && msg != null) ShowResult(msg, DimB);
    }
    void ShowResult(string text, Brush color, string? tooltip = null)
    {
        txtResult.Text = text; txtResult.Foreground = color; txtResult.Visibility = Visibility.Visible;
        txtResult.ToolTip = string.IsNullOrWhiteSpace(tooltip) ? null : tooltip;
        txtResult.BringIntoView();
    }
    void HideResult() { if (!_busy) txtResult.Visibility = Visibility.Collapsed; }
}
