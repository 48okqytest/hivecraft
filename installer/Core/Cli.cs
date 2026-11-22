namespace Hivecraft.Setup;

/// <summary>Command line: flags are --name or --name value (see Usage).</summary>
sealed class Cli
{
    readonly List<string> _a;
    public Cli(IEnumerable<string> args) { _a = args.ToList(); }
    public IReadOnlyList<string> Raw => _a;

    public bool Has(string flag) => _a.Any(x => x.Equals(flag, StringComparison.OrdinalIgnoreCase));
    public string? Val(string flag)
    {
        int i = _a.FindIndex(x => x.Equals(flag, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < _a.Count && !_a[i + 1].StartsWith("--") ? _a[i + 1] : null;
    }

    public static readonly string[] Known =
    {
        "--selftest", "--unattended", "--dir", "--accept-eula", "--player", "--display-name", "--provider", "--api-key", "--base-url",
        "--model", "--small-model", "--no-launch", "--no-shortcuts", "--payload", "--mc-dir", "--log", "--uninstall", "--repair",
        "--remove-minecraft-profile", "--keep-user-data", "--no-keep-worlds", "--wait-pid", "--no-reuse-runtimes", "--test-connection",
        "--shots", "--claude",
    };

    public string? Unknown() => _a.FirstOrDefault(x => x.StartsWith("--") && !Known.Contains(x, StringComparer.OrdinalIgnoreCase));

    public const string Usage = @"Hivecraft-Setup.exe                      the setup wizard (repair/uninstall if already installed)
  --selftest                              offline logic tests (temp folder only), exit code = failures
  --unattended --dir <path> --accept-eula --player <mcName> [--display-name <name>]
      --provider claude-login|anthropic-key|openrouter|custom|bedrock|vertex [--api-key <k> | env HIVE_API_KEY]
      [--base-url <url>] --model <id> [--small-model <id>] [--claude <claude.exe>]
      [--no-launch] [--no-shortcuts] [--no-reuse-runtimes] [--test-connection] [--payload <zip>] [--mc-dir <dir>] [--log <file>]
  --repair [--dir <path>]                 rerun setup on an existing install (keeps settings, worlds, memory)
  --uninstall [--unattended] [--dir <path>] [--remove-minecraft-profile] [--keep-user-data] [--no-keep-worlds]
Test isolation: HIVECRAFT_TEST_SANDBOX=<dir> (Desktop, Start menu, uninstall entry, Documents, %APPDATA%\Hivecraft, .minecraft),
HIVECRAFT_DATA_DIR=<dir> (%APPDATA%\Hivecraft), HIVECRAFT_MC_DIR=<dir> (.minecraft).";
}
