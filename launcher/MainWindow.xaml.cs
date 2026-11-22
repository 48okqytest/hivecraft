using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace Hivecraft;

public partial class MainWindow : Window
{
    enum Phase { Idle, Starting, Running, Stopping }

    readonly Orchestrator _orch;
    readonly Settings _set;
    readonly ObservableCollection<AgentEntry> _agents = new();
    readonly ObservableCollection<BotRow> _bots = new();
    readonly ObservableCollection<ChatMsg> _chat = new();
    readonly ConcurrentQueue<string> _logQ = new();
    readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(2) };
    readonly DispatcherTimer _logFlush = new() { Interval = TimeSpan.FromMilliseconds(300) };
    Phase _phase = Phase.Idle;
    bool _closing, _polling, _loaded;
    long _lastMsgId = -1;
    int _lastMsgCount = -1;
    int _expectedAgents;
    int _logLines;
    HiveConfig _hc = new();
    ProviderSettings _prov = new();
    bool _settingModel;

    static readonly Brush Green = Br("#4ADE80"), Grey = Br("#4B5567"), Red = Br("#FB5D6D"), Amber = Br("#FFB547"), Text = Br("#D7DEE9"), Dim = Br("#7C8799");
    static SolidColorBrush Br(string hex) { var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!; b.Freeze(); return b; }

    public MainWindow()
    {
        InitializeComponent();
        _set = Settings.Load();
        _orch = new Orchestrator(Orchestrator.FindRoot());
        _orch.OnLog += (src, line) => _logQ.Enqueue($"{DateTime.Now:HH:mm:ss} [{src}] {line}");
        _orch.OnStatus += s => Dispatcher.BeginInvoke(() => txtStatus.Text = s);
        _orch.OnHint += s => Dispatcher.BeginInvoke(() => ShowBanner(s, false));
        _orch.OnProcessChange += () => Dispatcher.BeginInvoke(() => { RefreshChips(); });

        for (int i = 0; i < Math.Min(8, _set.Agents.Count); i++)
            _agents.Add(new AgentEntry { Name = _set.Agents[i], Persona = i < _set.Personalities.Count ? _set.Personalities[i] : "" });
        if (_agents.Count == 0) foreach (var n in new[] { "Ash", "Flint", "Wren" }) _agents.Add(new AgentEntry { Name = n });
        agentList.ItemsSource = _agents;
        botList.ItemsSource = _bots;
        chatList.ItemsSource = _chat;
        Providers.Log = line => _logQ.Enqueue($"{DateTime.Now:HH:mm:ss} {line}");
        LoadProvider();
        (_set.NewWorld ? rbNew : rbContinue).IsChecked = true;
        txtSeed.Text = _set.Seed;
        (_set.GameMode switch { "spectator" => rbSpectator, "creative" => rbCreative, _ => rbSurvival }).IsChecked = true;
        (_set.Economy ? rbEconOn : rbEconOff).IsChecked = true;
        (_set.OverlayMod ? rbModOn : rbModOff).IsChecked = true;
        _orch.OverlayMod = _set.OverlayMod;
        SetLogOpen(_set.LogOpen);
        _loaded = true;
        OnWorldChanged(null, null!);
        UpdateAgentUi();
        RefreshChips();

        _poll.Tick += async (_, _) => await PollAsync();
        _poll.Start();
        _logFlush.Tick += (_, _) => FlushLog();
        _logFlush.Start();
        StateChanged += (_, _) => Frame.Margin = WindowState == WindowState.Maximized ? new Thickness(7) : new Thickness(0);
        Closing += OnClosing;
        _ = PollAsync();
    }

    // ------------------------------------------------------------------ title bar
    void OnMinimize(object s, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    void OnCloseClick(object s, RoutedEventArgs e) => Close();

    async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closing) return;
        SaveSettings();
        bool active = _phase != Phase.Idle || _orch.Server.Alive || _orch.Bridge.Alive || _orch.Crew.Alive;
        if (!active) return;
        e.Cancel = true;
        var r = MessageBox.Show(this, "Closing Hivecraft stops the agents, the bridge and the Minecraft server.\n\nStop everything and close?",
            "Hivecraft", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (r != MessageBoxResult.Yes) return;
        _closing = true;
        SetPhase(Phase.Stopping);
        try { await _orch.TerminateAsync(); } catch { }
        Close();
    }

    // ------------------------------------------------------------------ settings / form
    void SaveSettings()
    {
        _set.Agents = _agents.Select(a => a.Name.Trim()).ToList();
        _set.Personalities = _agents.Select(a => a.Persona.Trim()).ToList();
        _set.Model = Providers.ModelFor(_prov);   // kept for older settings.json readers; the provider model lives in hivecraft.config.json
        _set.NewWorld = rbNew.IsChecked == true;
        _set.Seed = txtSeed.Text;
        _set.GameMode = rbSpectator.IsChecked == true ? "spectator" : rbCreative.IsChecked == true ? "creative" : "survival";
        _set.Economy = rbEconOn.IsChecked == true;
        _set.OverlayMod = rbModOn.IsChecked == true;
        _set.LogOpen = txtLog.Visibility == Visibility.Visible;
        _set.Save();
    }

    void OnWorldChanged(object? s, RoutedEventArgs e)
    {
        if (!_loaded) return;
        bool nw = rbNew.IsChecked == true;
        txtSeed.IsEnabled = nw && _phase == Phase.Idle;
        seedHint.Text = nw ? "Seed (blank = random)" : "Seed is kept from the last world";
    }
    void OnSeedChanged(object s, TextChangedEventArgs e) => seedHint.Visibility = string.IsNullOrEmpty(txtSeed.Text) ? Visibility.Visible : Visibility.Collapsed;
    void OnSendTextChanged(object s, TextChangedEventArgs e) => sendHint.Visibility = string.IsNullOrEmpty(txtSend.Text) ? Visibility.Visible : Visibility.Collapsed;

    void OnAddAgent(object s, RoutedEventArgs e)
    {
        if (_agents.Count >= 8) return;
        string[] pool = { "Moss", "Lark", "Ember", "Reed", "Sage", "Birch", "Quill", "Pike", "Nova", "Tern" };
        var name = pool.FirstOrDefault(p => !_agents.Any(a => a.Name.Equals(p, StringComparison.OrdinalIgnoreCase))) ?? "Agent" + (_agents.Count + 1);
        _agents.Add(new AgentEntry { Name = name });
        UpdateAgentUi();
    }
    void OnRemoveAgent(object s, RoutedEventArgs e)
    {
        if (_agents.Count <= 1) return;
        if (((Button)s).Tag is AgentEntry a) _agents.Remove(a);
        UpdateAgentUi();
    }
    void OnAgentNameChanged(object s, TextChangedEventArgs e) { if (_loaded) UpdateAgentUi(); }

    string? UpdateAgentUi()
    {
        txtAgentCount.Text = $"{_agents.Count} / 8";
        btnAddAgent.IsEnabled = _agents.Count < 8 && _phase == Phase.Idle;
        var err = Settings.Validate(_agents.Select(a => a.Name.Trim()).ToList());
        txtAgentError.Text = err ?? "";
        txtAgentError.Visibility = err == null ? Visibility.Collapsed : Visibility.Visible;
        return err;
    }

    // ------------------------------------------------------------------ AI provider (hivecraft.config.json provider + DPAPI key)
    static string ConfigPath => HiveConfig.PathFor(Orchestrator.FindRoot());
    string? ClaudeConfigured => string.IsNullOrWhiteSpace(_hc.Runtime.Claude) ? null
        : HiveConfig.LooksLikePath(_hc.Runtime.Claude) ? HiveConfig.Resolve(_hc.Root, _hc.Runtime.Claude) : _hc.Runtime.Claude;

    void LoadProvider()
    {
        _hc = HiveConfig.Load(Orchestrator.FindRoot());
        if (_hc.LoadError != null) _logQ.Enqueue($"{DateTime.Now:HH:mm:ss} [config] {_hc.LoadError}");
        _prov = ProviderSettings.FromConfig(_hc.Provider);
        // first run without a config file: keep the model picked in older versions (settings.json)
        if (!_hc.FromFile && Providers.ClaudeModels.Any(m => m.Id == _set.Model)) _prov.Model = _set.Model;
        sendHint.Text = $"Message the team as {_hc.HumanName}…";
        ShowProvider();
    }

    /// <summary>Writes the provider into hivecraft.config.json (re-read first so other sections stay current). null = ok.</summary>
    string? SaveProvider()
    {
        var path = ConfigPath;
        var fresh = HiveConfig.Load(Orchestrator.FindRoot());
        if (fresh.LoadError != null) return $"Not saving the AI provider: {fresh.LoadError}. Fix or delete that file first.";
        _prov.ApplyTo(fresh.Provider);
        try { fresh.Save(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return $"Could not save {path}: {e.Message}"; }
        _hc = fresh;
        return null;
    }

    void ShowProvider()
    {
        var info = Providers.Get(_prov.Kind)!;
        txtProvName.Text = info.Name;
        var model = Providers.ModelFor(_prov);
        var list = Providers.BuiltInModels(_prov.Kind).ToList();
        _settingModel = true;
        cmbModel.Items.Clear();
        if (info.FreeTextModel)
        {
            cmbModel.Visibility = Visibility.Collapsed;
            txtModelFixed.Visibility = Visibility.Visible;
            txtModelFixed.Text = model.Length > 0 ? model : "(no model set — click Change…)";
        }
        else
        {
            cmbModel.Visibility = Visibility.Visible;
            txtModelFixed.Visibility = Visibility.Collapsed;
            if (model.Length > 0 && !list.Any(m => m.Id == model)) list.Insert(0, new ModelOption(model, model, ""));
            foreach (var m in list) cmbModel.Items.Add(new ComboBoxItem { Content = m.Label, Tag = m.Id, ToolTip = m.Note.Length > 0 ? $"{m.Id} — {m.Note}" : m.Id });
            cmbModel.SelectedItem = cmbModel.Items.Cast<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == model);
        }
        _settingModel = false;
        bool nonClaude = model.Length > 0 && ((_prov.Kind == "openrouter" && !model.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase) && !model.StartsWith("~anthropic/", StringComparison.OrdinalIgnoreCase))
                         || (_prov.Kind == "custom" && !model.Contains("claude", StringComparison.OrdinalIgnoreCase)));
        txtProvNote.Text = nonClaude ? "Not a Claude model: agents may play worse or fail tool calls." : "";
        txtProvNote.Visibility = nonClaude ? Visibility.Visible : Visibility.Collapsed;
        txtProvResult.Visibility = Visibility.Collapsed;
        _ = RefreshProviderStateAsync();
    }

    async Task RefreshProviderStateAsync()
    {
        var kind = _prov.Kind;
        var info = Providers.Get(kind)!;
        void State(Brush b, string t) { dotProv.Fill = b; txtProvState.Text = t; txtProvState.ToolTip = t; }
        var problem = Providers.Validate(_prov, Providers.GetKey(kind));
        if (problem != null) { State(Red, problem); return; }
        var claude = Providers.FindClaude(ClaudeConfigured);
        if (claude == null) { State(Red, "Claude Code not installed — click Change…"); return; }
        if (kind == "claude-login")
        {
            State(Grey, "checking sign-in…");
            var st = await Providers.LoginStatusAsync(claude);
            if (_prov.Kind != kind) return;   // changed meanwhile
            State(st.LoggedIn ? Green : st.Known ? Amber : Red, st.LoggedIn ? (st.Subscription.Length > 0 ? $"signed in ({st.Subscription})" : "signed in") : st.Message);
        }
        else if (info.NeedsKey || info.KeyOptional)
        {
            var k = Providers.GetKey(kind);
            State(Green, k != null ? "key saved " + Providers.MaskKey(k) : "no key (optional)");
        }
        else State(Green, "uses your cloud credentials");
    }

    void OnModelChanged(object s, SelectionChangedEventArgs e)
    {
        if (_settingModel || !_loaded || cmbModel.SelectedItem is not ComboBoxItem it) return;
        _prov.Model = (string)it.Tag;
        if (SaveProvider() is string err) ShowBanner(err, true);
        txtProvResult.Visibility = Visibility.Collapsed;
    }

    void OnChangeProvider(object s, RoutedEventArgs e)
    {
        var w = new ProviderWindow(_prov, ClaudeConfigured) { Owner = this };
        if (w.ShowDialog() != true) { _ = RefreshProviderStateAsync(); return; }   // sign-in / install may have changed the state
        _prov = w.Result;
        if (SaveProvider() is string err) ShowBanner(err, true);
        ShowProvider();
    }

    async void OnTestProvider(object s, RoutedEventArgs e)
    {
        btnTestProv.IsEnabled = false;
        txtProvResult.Visibility = Visibility.Visible;
        txtProvResult.Foreground = Dim;
        txtProvResult.Text = "Testing… (one tiny message, up to 90 s)";
        try
        {
            var r = await Providers.TestConnectionAsync(Providers.FindClaude(ClaudeConfigured), _prov, Providers.GetKey(_prov.Kind));
            txtProvResult.Text = r.Message;
            txtProvResult.ToolTip = string.IsNullOrWhiteSpace(r.Detail) ? null : r.Detail;
            txtProvResult.Foreground = r.Ok ? Green : Red;
        }
        finally { btnTestProv.IsEnabled = true; }
    }

    // ------------------------------------------------------------------ phases
    void SetPhase(Phase p)
    {
        _phase = p;
        bool idle = p == Phase.Idle;
        setupPanel.IsEnabled = idle;
        setupPanel.Opacity = idle ? 1 : 0.55;
        OnWorldChanged(null, null!);
        btnAddAgent.IsEnabled = idle && _agents.Count < 8;
        switch (p)
        {
            case Phase.Idle: btnStart.Style = (Style)FindResource("Primary"); btnStart.Content = "START"; btnStart.IsEnabled = true; break;
            case Phase.Starting:
            case Phase.Running: btnStart.Style = (Style)FindResource("Danger"); btnStart.Content = "TERMINATE"; btnStart.IsEnabled = true; break;
            case Phase.Stopping: btnStart.Style = (Style)FindResource("Danger"); btnStart.Content = "STOPPING…"; btnStart.IsEnabled = false; break;
        }
        RefreshChips();
    }

    async void OnStartStop(object s, RoutedEventArgs e)
    {
        if (_phase == Phase.Idle) await DoStart();
        else if (_phase is Phase.Starting or Phase.Running) await DoTerminate();
    }

    async Task DoStart()
    {
        var names = _agents.Select(a => a.Name.Trim()).ToList();
        var err = UpdateAgentUi();
        if (err != null) { txtStatus.Text = err; return; }
        var perr = Providers.Validate(_prov, Providers.GetKey(_prov.Kind));
        if (perr != null) { txtStatus.Text = "AI provider: " + perr; ShowBanner("AI provider not ready: " + perr + " Click Change… under AI PROVIDER.", true); return; }
        if (SaveProvider() is string serr) { ShowBanner(serr, true); return; }
        SaveSettings();
        HideBanner();
        _expectedAgents = names.Count;
        _bots.Clear(); _chat.Clear(); _lastMsgId = -1;
        var cfg = new StartConfig
        {
            Names = names, Personas = _agents.Select(a => a.Persona.Trim()).ToList(), Model = Providers.ModelFor(_prov), ProviderEnv = Providers.CrewEnv(_prov), NewWorld = _set.NewWorld, Seed = _set.Seed, GameMode = _set.GameMode,
            Economy = _set.Economy, OverlayMod = _set.OverlayMod,
        };
        SetPhase(Phase.Starting);
        try
        {
            await _orch.StartAsync(cfg);
            if (_phase == Phase.Starting) SetPhase(_orch.Running ? Phase.Running : Phase.Idle);
        }
        catch (Exception ex)
        {
            ShowBanner("Could not start: " + ex.Message, true);
            txtStatus.Text = "Failed — everything was stopped cleanly.";
            _orch.Running = false;
            if (_phase != Phase.Stopping) SetPhase(Phase.Idle);
        }
    }

    async Task DoTerminate()
    {
        SetPhase(Phase.Stopping);
        try { await _orch.TerminateAsync(); } catch (Exception ex) { ShowBanner("Stop problem: " + ex.Message, true); }
        txtStatus.Text = "Stopped";
        _bots.Clear();
        SetPhase(Phase.Idle);
    }

    // ------------------------------------------------------------------ chips + polling
    void SetChip(System.Windows.Shapes.Ellipse dot, TextBlock val, Brush color, string text) { dot.Fill = color; val.Text = text; val.Foreground = color == Grey ? Dim : Text; }

    bool _bridgeOk;
    void RefreshChips()
    {
        // server
        if (_orch.ServerReady && _orch.Server.Alive) SetChip(dotServer, valServer, Green, "online");
        else if (_orch.Server.Alive) SetChip(dotServer, valServer, Amber, "starting…");
        else if (_phase == Phase.Idle && IsPortUp(Orchestrator.ServerPort)) SetChip(dotServer, valServer, Green, "online (external)");
        else if (_orch.Running) SetChip(dotServer, valServer, Red, "exited");
        else SetChip(dotServer, valServer, Grey, "off");
        // bridge
        if (_bridgeOk) SetChip(dotBridge, valBridge, Green, "online");
        else if (_orch.Bridge.Alive) SetChip(dotBridge, valBridge, Amber, "starting…");
        else if (_orch.Running) SetChip(dotBridge, valBridge, Red, "exited");
        else SetChip(dotBridge, valBridge, Grey, "off");
        // agents
        int online = _bots.Count(b => b.Online);
        int total = _phase is Phase.Starting or Phase.Running ? _expectedAgents : _bots.Count;
        string txt = total > 0 ? $"{online} / {total} online" : $"{online} online";
        if (_orch.Running && !_orch.Crew.Alive) SetChip(dotAgents, valAgents, Red, "crew exited");
        else if (online > 0 && online >= total) SetChip(dotAgents, valAgents, Green, txt);
        else if (online > 0 || _orch.Crew.Alive) SetChip(dotAgents, valAgents, Amber, txt);
        else SetChip(dotAgents, valAgents, Grey, txt);
    }

    static bool IsPortUp(int port)
    {
        try { return System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port); } catch { return false; }
    }

    async Task PollAsync()
    {
        if (_polling || _closing) return;
        _polling = true;
        try
        {
            string? botsJson = null, msgJson = null;
            try
            {
                botsJson = await Orchestrator.Http.GetStringAsync(Orchestrator.Base + "/bots");
                msgJson = await Orchestrator.Http.GetStringAsync(Orchestrator.Base + "/messages?limit=60");
                _bridgeOk = true;
            }
            catch { _bridgeOk = false; }

            if (botsJson != null && JsonNode.Parse(botsJson) is JsonArray arr)
            {
                var seen = new HashSet<string>();
                foreach (var n in arr)
                {
                    if (n is not JsonObject o) continue;
                    string name = (string?)o["name"] ?? "?";
                    seen.Add(name);
                    var row = _bots.FirstOrDefault(b => b.Name == name);
                    if (row == null) { row = new BotRow { Name = name }; _bots.Add(row); }
                    bool online = (bool?)o["online"] ?? false;
                    row.Update(online, Num(o["health"]), Num(o["food"]), (string?)o["currentAction"], (string?)o["lastThought"]);
                }
                for (int i = _bots.Count - 1; i >= 0; i--) if (!seen.Contains(_bots[i].Name)) _bots.RemoveAt(i);
            }
            else if (!_bridgeOk && _phase == Phase.Idle) { _bots.Clear(); }
            txtNoBots.Visibility = _bots.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            if (msgJson != null) UpdateChat(msgJson);
            RefreshChips();
        }
        catch { }
        finally { _polling = false; }
    }

    static double Num(JsonNode? n) { try { return n == null ? 0 : (double)n; } catch { return 0; } }

    void UpdateChat(string json)
    {
        if (JsonNode.Parse(json)?["messages"] is not JsonArray msgs) return;
        long last = msgs.Count == 0 ? -1 : (long?)msgs[^1]?["id"] ?? -1;
        if (last == _lastMsgId && _lastMsgCount == msgs.Count) return;
        _lastMsgCount = msgs.Count;
        bool atBottom = chatScroll.VerticalOffset >= chatScroll.ScrollableHeight - 24;
        _lastMsgId = last;
        _chat.Clear();
        foreach (var m in msgs)
        {
            if (m is not JsonObject o) continue;
            if ((string?)o["from"] == "system") continue;   // per-bot event noise; the dashboard hides it by default too
            long ts = (long?)o["ts"] ?? 0;
            _chat.Add(new ChatMsg
            {
                Id = (long?)o["id"] ?? 0, From = (string?)o["from"] ?? "?", To = (string?)o["to"] ?? "",
                Text = (string?)o["text"] ?? "",
                Time = ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("HH:mm:ss") : "",
            });
        }
        if (atBottom) chatScroll.Dispatcher.BeginInvoke(() => chatScroll.ScrollToEnd(), DispatcherPriority.Loaded);
    }

    // ------------------------------------------------------------------ chat send
    void OnSendKey(object s, KeyEventArgs e) { if (e.Key == Key.Enter) { OnSend(s, e); e.Handled = true; } }
    async void OnSend(object s, RoutedEventArgs e)
    {
        var text = txtSend.Text.Trim();
        if (text.Length == 0) return;
        txtSend.Clear();
        try
        {
            var body = JsonSerializer.Serialize(new { from = _hc.HumanName, to = "all", text });
            using var r = await Orchestrator.Http.PostAsync(Orchestrator.Base + "/msg", new StringContent(body, Encoding.UTF8, "application/json"));
            if (!r.IsSuccessStatusCode) ShowBanner($"Message not sent (bridge said {(int)r.StatusCode}).", true);
            else { chatScroll.ScrollToEnd(); await PollAsync(); chatScroll.ScrollToEnd(); }
        }
        catch { ShowBanner("Message not sent — the bridge is not running. Press START first.", true); }
    }

    // ------------------------------------------------------------------ buttons
    void OnOpenDashboard(object s, RoutedEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo(Orchestrator.Base + "/") { UseShellExecute = true }); } catch { }
    }
    async void OnOpenMinecraft(object s, RoutedEventArgs e)
    {
        _orch.OverlayMod = rbModOn.IsChecked == true;
        try { await _orch.OpenMinecraftAsync(); } catch (Exception ex) { ShowBanner("Could not open Minecraft: " + ex.Message, true); }
    }

    void ShowBanner(string text, bool error)
    {
        bannerText.Text = text;
        banner.Background = error ? Br("#2A1217") : Br("#2B2112");
        banner.BorderBrush = error ? Br("#7A2A35") : Br("#6B4A14");
        bannerText.Foreground = error ? Br("#FF9AA5") : Br("#FFC970");
        banner.Visibility = Visibility.Visible;
    }
    void HideBanner() => banner.Visibility = Visibility.Collapsed;
    void OnDismissBanner(object s, RoutedEventArgs e) => HideBanner();

    // ------------------------------------------------------------------ log pane
    void OnToggleLog(object s, RoutedEventArgs e) => SetLogOpen(txtLog.Visibility != Visibility.Visible);
    void SetLogOpen(bool open)
    {
        txtLog.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        logHeader.Text = (open ? "▾  LOG" : "▸  LOG");
        if (open) txtLog.ScrollToEnd();
    }

    void FlushLog()
    {
        if (_logQ.IsEmpty) return;
        var sb = new StringBuilder();
        int n = 0;
        while (n < 400 && _logQ.TryDequeue(out var l)) { sb.AppendLine(l); n++; }
        _logLines += n;
        txtLog.AppendText(sb.ToString());
        if (_logLines > 3000)
        {
            var lines = txtLog.Text.Split('\n');
            txtLog.Text = string.Join("\n", lines.Skip(lines.Length - 2000));
            _logLines = 2000;
        }
        if (txtLog.Visibility == Visibility.Visible) txtLog.ScrollToEnd();
    }
}
