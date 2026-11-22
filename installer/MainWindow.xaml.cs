using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Hivecraft.Setup;

public enum WizardMode { Install, Repair, Maintenance, Uninstall }

public partial class MainWindow : Window
{
    static Brush B(string key) => (Brush)Application.Current.FindResource(key);
    static Brush Hex(string h) => (Brush)new BrushConverter().ConvertFromString(h)!;

    readonly WizardMode _startMode;
    WizardMode _mode;
    readonly string? _installedDir;
    readonly Cli _cli;
    readonly SetupOptions _o = new();
    Setup? _setup;
    List<Step>? _depSteps, _finishSteps;
    readonly ObservableCollection<StepVm> _depVms = new(), _finishVms = new();
    readonly ObservableCollection<string> _unLog = new();
    CancellationTokenSource? _cts;
    bool _busy, _depsDone, _finishDone, _uninstallDone;
    List<(string Key, string Title, FrameworkElement Page)> _flow = new();
    int _idx;

    internal MainWindow(WizardMode mode, string? installedDir, Cli cli)
    {
        InitializeComponent();
        _startMode = _mode = mode;
        _installedDir = installedDir;
        _cli = cli;
        Providers.Log = s => Log.W(s);
        StepList.ItemsSource = _depVms;
        FinishList.ItemTemplate = StepList.ItemTemplate;
        FinishList.ItemsSource = _finishVms;
        UnLog.ItemsSource = _unLog;

        _o.Dir = installedDir ?? cli.Val("--dir") ?? Places.DefaultInstallDir;
        _o.PayloadPath = cli.Val("--payload");
        DirBox.Text = _o.Dir;
        LoadExistingSettings();
        BuildKinds();
        BuildFlow();
        Show(0);
        Closing += OnClosing;
    }

    // ------------------------------------------------------------------ flow
    void BuildFlow()
    {
        _flow = _mode switch
        {
            WizardMode.Maintenance => new() { ("maint", "Choose", pMaint) },
            WizardMode.Uninstall => new() { ("uninstall", "Uninstall", pUninstall) },
            WizardMode.Repair => new()
            {
                ("deps", "Download & install", pDeps), ("ai", "AI", pAI), ("player", "You", pPlayer),
                ("shortcuts", "Shortcuts", pShortcuts), ("finish", "Finish", pFinish),
            },
            _ => new()
            {
                ("welcome", "Welcome", pWelcome), ("folder", "Install folder", pFolder), ("minecraft", "Minecraft", pMinecraft),
                ("deps", "Download & install", pDeps), ("ai", "AI", pAI), ("player", "You", pPlayer),
                ("shortcuts", "Shortcuts", pShortcuts), ("finish", "Finish", pFinish),
            },
        };
        if (_startMode == WizardMode.Maintenance && _mode != WizardMode.Maintenance) _flow.Insert(0, ("maint", "Choose", pMaint));
        TitleMode.Text = _mode switch { WizardMode.Uninstall => "UNINSTALL", WizardMode.Repair => "REPAIR", WizardMode.Maintenance => "SETUP", _ => "SETUP" };
    }

    string Cur => _flow[_idx].Key;

    void Show(int i)
    {
        _idx = Math.Clamp(i, 0, _flow.Count - 1);
        foreach (UIElement c in Pages.Children) c.Visibility = Visibility.Collapsed;
        _flow[_idx].Page.Visibility = Visibility.Visible;
        PageScroll.ScrollToTop();
        ClearError();
        Rail.ItemsSource = _flow.Select((f, n) => new RailVm(f.Title, n < _idx ? "done" : n == _idx ? "current" : "todo", n + 1)).ToList();
        OnEnter(Cur);
        UpdateButtons();
    }

    void OnEnter(string key)
    {
        switch (key)
        {
            case "maint":
                MaintLead.Text = $"Found in {_installedDir}. What would you like to do?";
                break;
            case "folder": UpdateDirInfo(); break;
            case "minecraft": RunMinecraftCheck(); break;
            case "deps":
                _o.Dir = DirBox.Text.Trim();
                if (_setup == null || !string.Equals(_setup.Dir, Path.GetFullPath(_o.Dir), StringComparison.OrdinalIgnoreCase)) NewSetup();
                if (_setup!.IsRepair && File.Exists(Path.Combine(_setup.ServerDir, "eula.txt")) && File.ReadAllText(Path.Combine(_setup.ServerDir, "eula.txt")).Contains("eula=true")) EulaCheck.IsChecked = true;
                Status(_depsDone ? "Everything is installed. Press Next." : "Tick the EULA box, then press Install.");
                break;
            case "ai": _ = RefreshClaudeAsync(); break;
            case "player": Player_TextChanged(this, null!); break;
            case "shortcuts": Summary.Text = BuildSummary(); break;
            case "finish": if (!_finishDone && !_busy) _ = RunFinishAsync(); break;
            case "uninstall":
                UnLead.Text = $"This removes Hivecraft from {_installedDir ?? _o.Dir}: the program, its downloaded runtimes, the shortcuts and the Apps & Features entry.";
                Status("Choose what to remove, then press Uninstall.");
                break;
        }
    }

    void NewSetup()
    {
        _setup = new Setup(_o);
        _depSteps = _setup.DependencySteps();
        _finishSteps = _setup.FinishSteps();
        _depVms.Clear(); foreach (var s in _depSteps) _depVms.Add(new StepVm(s));
        _finishVms.Clear(); foreach (var s in _finishSteps) _finishVms.Add(new StepVm(s));
        _depsDone = _finishDone = false;
        DepBar.Value = 0;
    }

    void UpdateButtons()
    {
        BackBtn.IsEnabled = !_busy && _idx > 0 && Cur != "finish" && !_uninstallDone;
        RetryBtn.Visibility = Visibility.Collapsed;
        NextBtn.IsEnabled = !_busy;
        switch (Cur)
        {
            case "maint": NextBtn.Content = "Next"; break;
            case "deps":
                NextBtn.Content = _depsDone ? "Next" : "Install";
                NextBtn.IsEnabled = !_busy && (_depsDone || EulaCheck.IsChecked == true);
                RetryBtn.Visibility = !_busy && _depSteps!.Any(s => s.State == "failed") ? Visibility.Visible : Visibility.Collapsed;
                if (RetryBtn.Visibility == Visibility.Visible) NextBtn.IsEnabled = false;
                EulaCheck.IsEnabled = ReuseCheck.IsEnabled = !_busy && !_depsDone;
                break;
            case "shortcuts": NextBtn.Content = "Install"; break;
            case "finish":
                NextBtn.Content = "Finish";
                NextBtn.IsEnabled = !_busy && _finishDone;
                RetryBtn.Visibility = !_busy && _finishSteps!.Any(s => s.State == "failed") ? Visibility.Visible : Visibility.Collapsed;
                break;
            case "uninstall":
                NextBtn.Content = _uninstallDone ? "Close" : "Uninstall";
                break;
            default: NextBtn.Content = "Next"; break;
        }
    }

    async void Next_Click(object sender, RoutedEventArgs e)
    {
        ClearError();
        switch (Cur)
        {
            case "maint":
                _mode = mUninstall.IsChecked == true ? WizardMode.Uninstall : WizardMode.Repair;
                _o.Dir = _installedDir ?? _o.Dir;
                DirBox.Text = _o.Dir;
                BuildFlow();
                Show(1);
                return;
            case "folder":
                var d = DirBox.Text.Trim();
                if (d.Length == 0) { Error("Pick an install folder."); return; }
                try { d = Path.GetFullPath(d); } catch (Exception ex) { Error("That folder path is not valid: " + ex.Message); return; }
                DirBox.Text = d; _o.Dir = d;
                break;
            case "deps":
                if (!_depsDone) { await RunDepsAsync(); return; }
                break;
            case "ai":
                if (!await ValidateAiAsync()) return;
                break;
            case "player":
                var n = McNameBox.Text.Trim();
                if (!HiveConfig.ValidMcName(n)) { Error("Enter your Minecraft username: 3–16 letters, digits or _ (no spaces)."); return; }
                _o.McName = n; _o.DisplayName = DisplayBox.Text.Trim();
                break;
            case "shortcuts":
                _o.DesktopShortcut = DeskCheck.IsChecked == true;
                _o.StartMenuShortcut = StartCheck.IsChecked == true;
                break;
            case "finish":
                if (LaunchCheck.IsChecked == true)
                {
                    try { _setup!.LaunchHivecraft(); }
                    catch (Exception ex) { Log.Err("launch", ex); MessageBox.Show("Could not start Hivecraft: " + ex.Message, "Hivecraft Setup"); }
                }
                _closeOk = true; Close();
                return;
            case "uninstall":
                if (_uninstallDone) { _closeOk = true; Close(); return; }
                await RunUninstallAsync();
                return;
        }
        Show(_idx + 1);
    }

    void Back_Click(object sender, RoutedEventArgs e)
    {
        if (_busy || _idx == 0) return;
        if (_flow[_idx - 1].Key == "maint") { _mode = WizardMode.Maintenance; BuildFlow(); Show(0); return; }
        Show(_idx - 1);
    }

    async void Retry_Click(object sender, RoutedEventArgs e)
    {
        if (Cur == "deps") await RunDepsAsync();
        else if (Cur == "finish") await RunFinishAsync();
    }

    // ------------------------------------------------------------------ folder
    void DirBox_TextChanged(object sender, TextChangedEventArgs e) { if (IsLoaded) UpdateDirInfo(); }
    void DefaultDir_Click(object sender, RoutedEventArgs e) => DirBox.Text = Places.DefaultInstallDir;

    void Browse_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "Choose where to install Hivecraft" };
        try { var parent = Path.GetDirectoryName(DirBox.Text.Trim()); if (Directory.Exists(parent)) dlg.InitialDirectory = parent; }
        catch (Exception ex) { Log.W("browse: " + ex.Message); }
        if (dlg.ShowDialog(this) == true)
        {
            var pick = dlg.FolderName;
            // an existing non-empty folder gets a Hivecraft subfolder (we never install into e.g. Documents itself)
            if (Directory.Exists(pick) && Directory.EnumerateFileSystemEntries(pick).Any() && !File.Exists(Path.Combine(pick, "app", "Hivecraft.exe")))
                pick = Path.Combine(pick, "Hivecraft");
            DirBox.Text = pick;
        }
    }

    void UpdateDirInfo()
    {
        try
        {
            var d = Path.GetFullPath(DirBox.Text.Trim());
            var drive = new DriveInfo(Path.GetPathRoot(d)!);
            var free = drive.IsReady ? drive.AvailableFreeSpace / 1073741824.0 : 0;
            DirInfo.Foreground = free < 2.5 ? B("Red") : B("Dim");
            DirInfo.Text = $"{free:0.0} GB free on {drive.Name} — Hivecraft needs about 2.5 GB." +
                (File.Exists(Path.Combine(d, "app", "Hivecraft.exe")) ? "  Hivecraft is already installed here: setup updates it and keeps your worlds and settings." : "");
        }
        catch (Exception ex) { DirInfo.Foreground = B("Red"); DirInfo.Text = "Not a valid folder: " + ex.Message; }
    }

    // ------------------------------------------------------------------ minecraft
    async void RunMinecraftCheck()
    {
        McTitle.Text = "Checking…"; McDot.Fill = B("Faint"); McDetail.Text = "";
        var r = await Task.Run(() => MinecraftCheck.Detect(Places.McDir));
        McDot.Fill = r.AnyLauncher ? B("Green") : B("Amber");
        McTitle.Text = r.AnyLauncher ? "Minecraft Launcher found" : "Minecraft Launcher not found";
        McDetail.Text = r.Summary + (r.AnyLauncher ? "" : "\nInstall it from minecraft.net (or the Microsoft Store / Xbox app), sign in once with your Microsoft account, then press Check again.");
        Status(r.AnyLauncher ? "Minecraft looks good." : "You can continue and install Minecraft later.");
    }
    void McRecheck_Click(object sender, RoutedEventArgs e) => RunMinecraftCheck();
    void McGet_Click(object sender, RoutedEventArgs e) => Open("https://www.minecraft.net/download");

    // ------------------------------------------------------------------ deps
    void Eula_Click(object sender, RoutedEventArgs e) => Open("https://aka.ms/MinecraftEULA");
    void Eula_Changed(object sender, RoutedEventArgs e) { if (IsLoaded) UpdateButtons(); }

    async Task RunDepsAsync()
    {
        if (EulaCheck.IsChecked != true) { Error("Please accept the Minecraft EULA first."); return; }
        _o.AcceptEula = true;
        _o.ReuseSystemRuntimes = ReuseCheck.IsChecked == true;
        foreach (var s in _depSteps!.Where(s => s.State == "failed")) s.State = "waiting";
        _busy = true; UpdateButtons(); ClearError();
        _cts = new CancellationTokenSource();
        int total = _depSteps!.Count;
        var prog = new Progress<Progress>(p =>
        {
            Status(p.Text);
            int done = _depSteps.Count(s => s.State is "done" or "skipped");
            DepBar.Value = (done + (p.Fraction >= 0 ? Math.Min(p.Fraction, 1) : 0)) / total;
        });
        bool ok = await Task.Run(() => Setup.RunStepsAsync(_depSteps, s => Dispatcher.BeginInvoke(() => Refresh(_depVms, s)), prog, _cts.Token));
        _busy = false;
        foreach (var vm in _depVms) vm.Update();
        DepBar.Value = _depSteps.Count(s => s.State == "done") / (double)total;
        if (ok) { _depsDone = true; Status("Everything is installed. Press Next to connect an AI."); }
        else
        {
            var f = _depSteps.FirstOrDefault(s => s.State == "failed");
            Error((f?.Detail ?? "Setup stopped.") + "\nDetails are in the log.");
        }
        UpdateButtons();
    }

    static void Refresh(ObservableCollection<StepVm> vms, Step s) => vms.FirstOrDefault(v => v.S == s)?.Update();

    // ------------------------------------------------------------------ AI
    sealed class KindVm
    {
        public string Kind { get; init; } = "";
        public string Name { get; init; } = "";
        public string Tagline { get; init; } = "";
        public bool Selected { get; set; }
    }
    List<KindVm> _kinds = new();
    string? _savedKeyKind;

    void BuildKinds()
    {
        _kinds = ProviderGlue.WizardKinds.Select(p => new KindVm { Kind = p.Kind, Name = p.Name, Tagline = p.Tagline, Selected = p.Kind == _o.ProviderKind }).ToList();
        if (!_kinds.Any(k => k.Selected)) _kinds[0].Selected = true;
        KindList.ItemsSource = _kinds;
        ApplyKind(_kinds.First(k => k.Selected).Kind, keepModel: true);
    }

    void Kind_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton rb && rb.Tag is string k && k != _o.ProviderKind) ApplyKind(k, keepModel: false);
    }

    async void ApplyKind(string kind, bool keepModel)
    {
        _o.ProviderKind = kind;
        var info = ProviderGlue.Get(kind);
        KindHelp.Text = info.Help;
        var link = !string.IsNullOrEmpty(info.KeyUrl) ? info.KeyUrl : !string.IsNullOrEmpty(info.SignupUrl) ? info.SignupUrl : info.DocsUrl;
        KindLink.Content = string.IsNullOrEmpty(link) ? "" : (!string.IsNullOrEmpty(info.KeyUrl) ? "Get a key: " : "More: ") + link;
        KindLink.Tag = link;
        KindLink.Visibility = string.IsNullOrEmpty(link) ? Visibility.Collapsed : Visibility.Visible;
        KeyPanel.Visibility = info.NeedsKey || info.KeyOptional ? Visibility.Visible : Visibility.Collapsed;
        KeyLabel.Text = (string.IsNullOrEmpty(info.KeyLabel) ? "API key" : info.KeyLabel).ToUpperInvariant() + (info.KeyOptional ? " (OPTIONAL)" : "");
        bool saved = ProviderGlue.ExistingKey(kind) != null;
        KeyNote.Text = saved ? "A key is already saved for this provider — leave this empty to keep it." : "Stored encrypted for your Windows account only — never in a plain file.";
        BaseUrlPanel.Visibility = info.NeedsBaseUrl ? Visibility.Visible : Visibility.Collapsed;
        if (_savedKeyKind != kind) KeyBox.Password = "";
        _savedKeyKind = kind;
        ClaudeLoginBtn.Visibility = kind == "claude-login" ? Visibility.Visible : Visibility.Collapsed;
        var models = Providers.BuiltInModels(kind).ToList();
        FillModels(models, keepModel ? _o.Model : info.DefaultModel);
        ModelNote.Text = info.FreeTextModel || models.Count == 0 ? "Type the model id from your provider's docs." : "Sonnet 5.5 is a good balance of smarts and cost for most teams.";
        TestResult.Text = "Test connection sends one tiny request (costs a fraction of a cent on paid APIs).";
        TestResult.Foreground = B("Dim");
        if (kind == "openrouter")
        {
            try
            {
                var live = await Providers.FetchOpenRouterModelsAsync();
                if (_o.ProviderKind == "openrouter" && live.Count > 0) FillModels(live, ModelBox.Text);
            }
            catch (Exception ex) { Log.W("OpenRouter model list: " + ex.Message + " (using the built-in list)"); }
        }
        if (IsLoaded && Cur == "ai") _ = RefreshClaudeAsync();
    }

    void FillModels(List<ModelOption> models, string want)
    {
        ModelCombo.ItemsSource = models;
        ModelCombo.Visibility = models.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        ModelBox.Text = want ?? "";
        ModelCombo.SelectedItem = models.FirstOrDefault(m => m.Id == want);
        Grid.SetColumn(ModelBox, models.Count > 0 ? 2 : 0);
        Grid.SetColumnSpan(ModelBox, models.Count > 0 ? 1 : 3);
    }

    void ModelCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ModelCombo.SelectedItem is ModelOption m) { ModelBox.Text = m.Id; ModelNote.Text = m.Note.Length > 0 ? m.Note : ModelNote.Text; }
    }

    void KindLink_Click(object sender, RoutedEventArgs e) { if (KindLink.Tag is string u && u.Length > 0) Open(u); }

    void ReadAiFields()
    {
        _o.BaseUrl = BaseUrlBox.Text.Trim();
        _o.Model = ModelBox.Text.Trim();
        _o.ApiKey = string.IsNullOrWhiteSpace(KeyBox.Password) ? null : KeyBox.Password.Trim();
    }

    string? _claudeVersion;
    ClaudeLoginStatus? _login;

    async Task RefreshClaudeAsync()
    {
        ClaudeStatus.Text = "Checking for Claude Code…";
        var exe = await Task.Run(() => ProviderGlue.FindClaude());
        _o.ClaudeExe = exe;
        if (exe == null)
        {
            _claudeVersion = null; _login = null;
            ClaudeStatus.Text = "Claude Code is not installed yet. Press “Install Claude Code”.";
            ClaudeStatus.Foreground = B("Amber");
            ClaudeInstallBtn.Visibility = Visibility.Visible;
            ClaudeLoginBtn.IsEnabled = TestBtn.IsEnabled = false;
            return;
        }
        ClaudeInstallBtn.Visibility = Visibility.Collapsed;
        ClaudeLoginBtn.IsEnabled = TestBtn.IsEnabled = true;
        if (_shooting) { ClaudeStatus.Text = $"Claude Code found ({exe})."; ClaudeStatus.Foreground = B("Green"); return; }   // --shots never runs claude
        _claudeVersion = await Providers.ClaudeVersionAsync(exe);
        string text = $"Claude Code {_claudeVersion ?? "(version unknown)"} found.";
        ClaudeStatus.Foreground = B("Green");
        if (_o.ProviderKind == "claude-login")
        {
            _login = await Providers.LoginStatusAsync(exe);
            if (_login.Known && _login.LoggedIn) text += " Signed in" + (_login.Subscription.Length > 0 ? $" ({_login.Subscription} plan)." : ".");
            else { text += " Not signed in yet — press “Sign in to Claude”. " + _login.Message; ClaudeStatus.Foreground = B("Amber"); }
        }
        ClaudeStatus.Text = text.Trim();
    }

    async void ClaudeInstall_Click(object sender, RoutedEventArgs e)
    {
        var ok = MessageBox.Show("Setup will open a PowerShell window that runs Anthropic's official Claude Code installer:\n\n    " + Providers.InstallCommandPowerShell +
            "\n\nIt installs for your Windows user only (no admin). Continue?", "Install Claude Code", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (ok != MessageBoxResult.Yes) return;
        var p = Providers.StartInstallClaude(out var err);
        if (p == null) { Error("Could not start the Claude Code installer: " + err); return; }
        Log.W("claude install started");
        _busy = true; UpdateButtons(); ClaudeStatus.Text = "Installing Claude Code (see the PowerShell window)…";
        try { await p.WaitForExitAsync(); Log.W($"claude installer exited {p.ExitCode}"); }
        catch (Exception ex) { Log.W("claude installer wait: " + ex.Message); }
        _busy = false; UpdateButtons();
        await RefreshClaudeAsync();
        if (_o.ClaudeExe == null) Error("Claude Code was not found after the installer finished. See " + Providers.InstallDocsUrl + " for other ways to install it, then press Check again.");
    }

    async void ClaudeLogin_Click(object sender, RoutedEventArgs e)
    {
        if (_o.ClaudeExe == null) { Error("Install Claude Code first."); return; }
        var p = Providers.StartLogin(_o.ClaudeExe, out var err);
        if (p == null) { Error("Could not start the Claude sign-in: " + err); return; }
        Status("Sign in in the window that opened (a browser page opens too). Come back here when it says you are logged in.");
        try { await p.WaitForExitAsync(); } catch (Exception ex) { Log.W("login wait: " + ex.Message); }
        await RefreshClaudeAsync();
    }

    async void ClaudeRecheck_Click(object sender, RoutedEventArgs e) => await RefreshClaudeAsync();

    async void Test_Click(object sender, RoutedEventArgs e)
    {
        ReadAiFields();
        var problem = ProviderGlue.Validate(_o);
        if (problem != null) { TestResult.Foreground = B("Red"); TestResult.Text = problem; return; }
        TestBtn.IsEnabled = false; TestResult.Foreground = B("Dim"); TestResult.Text = "Testing… (up to a minute)";
        var r = await ProviderGlue.TestAsync(_o, CancellationToken.None);
        TestBtn.IsEnabled = true;
        TestResult.Foreground = r.Ok ? B("Green") : B("Red");
        TestResult.Text = (r.Ok ? "✓ " : "✗ ") + r.Message + (r.Ok && r.CostUsd is double c ? $"  (cost ${c:0.0000})" : "");
    }

    async Task<bool> ValidateAiAsync()
    {
        ReadAiFields();
        if (_o.Model.Length == 0 && !ProviderGlue.Get(_o.ProviderKind).FreeTextModel) _o.Model = ProviderGlue.Get(_o.ProviderKind).DefaultModel;
        var problem = ProviderGlue.Validate(_o);
        if (problem != null) { Error(problem); return false; }
        if (_o.ClaudeExe == null)
        {
            var a = MessageBox.Show("Claude Code is not installed yet. The agents cannot run without it.\n\nContinue anyway and install it later?", "Hivecraft Setup", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (a != MessageBoxResult.Yes) return false;
        }
        else if (_o.ProviderKind == "claude-login" && _login is { Known: true, LoggedIn: false })
        {
            var a = MessageBox.Show("You are not signed in to Claude yet. The agents need that to use your subscription.\n\nContinue anyway and sign in later?", "Hivecraft Setup", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (a != MessageBoxResult.Yes) return false;
        }
        await Task.CompletedTask;
        return true;
    }

    // ------------------------------------------------------------------ player / summary
    void Player_TextChanged(object sender, TextChangedEventArgs e)
    {
        var n = McNameBox.Text.Trim();
        McNameNote.Foreground = n.Length == 0 || HiveConfig.ValidMcName(n) ? B("Dim") : B("Red");
    }

    string BuildSummary()
    {
        var info = ProviderGlue.Get(_o.ProviderKind);
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"Folder:  {_o.Dir}");
        sb.AppendLine($"AI:  {info.Name} — model {(_o.Model.Length > 0 ? _o.Model : info.DefaultModel)}");
        sb.AppendLine($"You:  {_o.McName}{(_o.DisplayName.Length > 0 && _o.DisplayName != _o.McName ? $" (the agents call you {_o.DisplayName})" : "")}");
        if (_setup != null && _setup.NodeExe.Length > 0 && _setup.JavaExe.Length > 0)
            sb.Append($"Runtimes:  Node.js {(_setup.NodeIsPrivate ? "(Hivecraft's own copy)" : _setup.NodeExe)}, Java {(_setup.JavaIsPrivate ? "(Hivecraft's own copy)" : _setup.JavaExe)}");
        return sb.ToString().TrimEnd();
    }

    // ------------------------------------------------------------------ finish
    async Task RunFinishAsync()
    {
        foreach (var s in _finishSteps!.Where(s => s.State == "failed")) s.State = "waiting";
        _busy = true; UpdateButtons(); ClearError();
        FinishTitle.Text = "Finishing…";
        var prog = new Progress<Progress>(p => Status(p.Text));
        bool ok = await Task.Run(() => Setup.RunStepsAsync(_finishSteps!, s => Dispatcher.BeginInvoke(() => Refresh(_finishVms, s)), prog, CancellationToken.None));
        _busy = false;
        foreach (var vm in _finishVms) vm.Update();
        if (ok)
        {
            _finishDone = true;
            FinishTitle.Text = "Hivecraft is ready";
            FinishLead.Text = $"Installed in {_setup!.Dir}.";
            NextStepsCard.Visibility = Visibility.Visible;
            Status("All done.");
        }
        else Error((_finishSteps!.FirstOrDefault(s => s.State == "failed")?.Detail ?? "Setup stopped.") + "\nDetails are in the log.");
        UpdateButtons();
    }

    // ------------------------------------------------------------------ uninstall
    async Task RunUninstallAsync()
    {
        var o = new UninstallOptions
        {
            Dir = _installedDir ?? _o.Dir,
            KeepWorlds = UnKeepWorlds.IsChecked == true,
            RemoveUserData = UnUserData.IsChecked == true,
            RemoveMinecraftProfile = UnMcProfile.IsChecked == true,
        };
        if (MessageBox.Show($"Remove Hivecraft from {o.Dir}?" + (o.KeepWorlds ? "" : "\n\nYour worlds will be deleted too."), "Uninstall Hivecraft", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        _busy = true; UpdateButtons(); ClearError();
        UnKeepWorlds.IsEnabled = UnUserData.IsEnabled = UnMcProfile.IsEnabled = false;
        try
        {
            var done = await Task.Run(() => Uninstaller.RunAsync(o, new Progress<Progress>(p => Dispatcher.BeginInvoke(() => Status(p.Text)))));
            foreach (var d in done) _unLog.Add("✓  " + d);
            _uninstallDone = true;
            Status("Hivecraft has been removed.");
            Uninstaller.ScheduleSelfDelete();
        }
        catch (Exception ex)
        {
            Log.Err("uninstall", ex);
            Error(ex is InstallException ? ex.Message : "Uninstall failed: " + ex.Message);
            UnKeepWorlds.IsEnabled = UnUserData.IsEnabled = UnMcProfile.IsEnabled = true;
        }
        _busy = false; UpdateButtons();
    }

    // ------------------------------------------------------------------ existing install -> prefill
    void LoadExistingSettings()
    {
        var app = Path.Combine(_o.Dir, "app");
        if (!File.Exists(Path.Combine(app, HiveConfig.FileName))) { _o.Model = Providers.All[0].DefaultModel; return; }
        var c = HiveConfig.Load(app);
        _o.McName = c.Player.McName; _o.DisplayName = c.Player.DisplayName;
        _o.ProviderKind = Providers.NormalizeKind(c.Provider.Kind);
        _o.Model = c.Provider.Model; _o.BaseUrl = c.Provider.BaseUrl; _o.SmallModel = c.Provider.SmallModel;
        McNameBox.Text = _o.McName;
        DisplayBox.Text = _o.DisplayName == _o.McName ? "" : _o.DisplayName;
        BaseUrlBox.Text = _o.BaseUrl;
    }

    // ------------------------------------------------------------------ misc
    void Status(string s) { StatusText.Text = s; }
    void Error(string s) { ErrorText.Text = s; ErrorText.Visibility = Visibility.Visible; Log.W("shown error: " + s.Replace("\n", " | ")); }
    void ClearError() { ErrorText.Text = ""; ErrorText.Visibility = Visibility.Collapsed; }

    static void Open(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception e) { Log.W("open " + url + ": " + e.Message); }
    }

    void Log_Click(object sender, RoutedEventArgs e)
    {
        try { if (!File.Exists(Log.PathName)) Log.W("log opened"); Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Log.PathName + "\"") { UseShellExecute = true }); }
        catch (Exception ex) { Error("Could not open the log: " + ex.Message); }
    }

    void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    void Close_Click(object sender, RoutedEventArgs e) => Close();

    bool _closeOk;
    void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_closeOk || _shooting) return;
        if (_busy)
        {
            if (MessageBox.Show("Setup is still working. Stop and close? You can run setup again later; finished downloads are kept.", "Hivecraft Setup", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) { e.Cancel = true; return; }
            _cts?.Cancel();
        }
        else if (Cur != "finish" && Cur != "uninstall" && Cur != "maint" && _idx > 0)
        {
            if (MessageBox.Show("Quit Hivecraft setup? You can run it again any time.", "Hivecraft Setup", MessageBoxButton.YesNo) != MessageBoxResult.Yes) e.Cancel = true;
        }
    }

    // ------------------------------------------------------------------ --shots <dir>: render every page to PNG (dev aid, no desktop capture)
    bool _shooting;
    internal async void RenderAllPagesAsync(string dir)
    {
        _shooting = true;
        Directory.CreateDirectory(dir);
        await Task.Delay(800);
        var all = new (string Key, string Title, FrameworkElement Page)[]
        {
            ("welcome", "Welcome", pWelcome), ("folder", "Install folder", pFolder), ("minecraft", "Minecraft", pMinecraft),
            ("deps", "Download & install", pDeps), ("ai", "AI", pAI), ("player", "You", pPlayer),
            ("shortcuts", "Shortcuts", pShortcuts), ("finish", "Finish", pFinish), ("maint", "Choose", pMaint), ("uninstall", "Uninstall", pUninstall),
        };
        int n = 0;
        foreach (var pg in all)
        {
            _flow = all.Take(8).ToList();
            if (pg.Key is "maint" or "uninstall") { _flow = new() { pg }; MaintLead.Text = $"Found in {_o.Dir}. What would you like to do?"; }
            _idx = Math.Max(0, _flow.FindIndex(f => f.Key == pg.Key));
            foreach (UIElement c in Pages.Children) c.Visibility = Visibility.Collapsed;
            pg.Page.Visibility = Visibility.Visible;
            Rail.ItemsSource = _flow.Select((f, i) => new RailVm(f.Title, i < _idx ? "done" : i == _idx ? "current" : "todo", i + 1)).ToList();
            if (pg.Key is "minecraft") RunMinecraftCheck();
            if (pg.Key is "ai") _ = RefreshClaudeAsync();
            if (pg.Key is "deps" && _setup == null) { _o.Dir = DirBox.Text; NewSetup(); }
            if (pg.Key is "shortcuts") Summary.Text = BuildSummary();
            if (pg.Key is "uninstall") UnLead.Text = $"This removes Hivecraft from {_o.Dir}: the program, its downloaded runtimes, the shortcuts and the Apps & Features entry.";
            UpdateButtons();
            await Task.Delay(pg.Key is "ai" or "minecraft" ? 2500 : 600);
            // full scroll height so long pages are captured completely
            var el = (FrameworkElement)Content;
            double extra = Math.Max(0, PageScroll.ExtentHeight - PageScroll.ViewportHeight);
            Height += extra; UpdateLayout(); await Task.Delay(200);
            var rtb = new RenderTargetBitmap((int)el.ActualWidth, (int)el.ActualHeight, 96, 96, PixelFormats.Pbgra32);
            rtb.Render(el);
            var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(rtb));
            var file = Path.Combine(dir, $"{++n:00}-{pg.Key}.png");
            using (var fs = File.Create(file)) enc.Save(fs);
            Height -= extra; UpdateLayout();
            Log.W("shot " + file);
        }
        Environment.Exit(0);
    }
}

sealed class RailVm(string title, string state, int n)
{
    public string Title { get; } = title;
    public string Mark => state == "done" ? "✓" : n.ToString();
    static Brush H(string h) => (Brush)new BrushConverter().ConvertFromString(h)!;
    public Brush Bg => state == "current" ? H("#1A1608") : Brushes.Transparent;
    public Brush Fg => state == "todo" ? H("#7C8799") : H("#D7DEE9");
    public Brush DotBg => state == "done" ? H("#FFB547") : state == "current" ? H("#2B2112") : H("#131822");
    public Brush DotLine => state == "todo" ? H("#283241") : H("#FFB547");
    public Brush DotFg => state == "done" ? H("#1A1205") : state == "current" ? H("#FFB547") : H("#7C8799");
}

sealed class StepVm : INotifyPropertyChanged
{
    public readonly Step S;
    public StepVm(Step s) { S = s; }
    public string Title => S.Title;
    public string Detail => S.Detail.Length > 0 ? S.Detail : S.State == "waiting" ? "Waiting" : "";
    public string Icon => S.State switch { "done" => "✓", "failed" => "!", "running" => "…", "skipped" => "–", _ => "○" };
    static Brush H(string h) => (Brush)new BrushConverter().ConvertFromString(h)!;
    public Brush IconFg => S.State switch { "done" => H("#4ADE80"), "failed" => H("#FB5D6D"), "running" => H("#FFB547"), _ => H("#4B5567") };
    public Brush DetailFg => S.State == "failed" ? H("#FB5D6D") : H("#7C8799");
    public Brush Line => S.State switch { "failed" => H("#5A2630"), "running" => H("#5A4520"), _ => H("#1D2531") };
    public event PropertyChangedEventHandler? PropertyChanged;
    public void Update() { foreach (var p in new[] { nameof(Detail), nameof(Icon), nameof(IconFg), nameof(DetailFg), nameof(Line) }) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(p)); }
}
