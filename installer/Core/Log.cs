namespace Hivecraft.Setup;

/// <summary>Setup log: --log &lt;file&gt; or %TEMP%\hivecraft-setup.log (appended). Never throws.</summary>
static class Log
{
    static readonly object Gate = new();
    public static string PathName { get; set; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hivecraft-setup.log");
    public static event Action<string>? Line;
    /// <summary>also echo to stdout (unattended / selftest)</summary>
    public static bool Echo;

    public static void W(string s)
    {
        var l = DateTime.Now.ToString("HH:mm:ss") + "  " + s;
        lock (Gate)
        {
            try { File.AppendAllText(PathName, l + Environment.NewLine); } catch { /* the log itself must never break setup */ }
            if (Echo) { try { Console.Out.WriteLine(l); Console.Out.Flush(); } catch { /* no console attached */ } }
        }
        try { Line?.Invoke(l); } catch (Exception e) { try { File.AppendAllText(PathName, "log listener failed: " + e.Message + Environment.NewLine); } catch { /* see above */ } }
    }

    public static void Err(string step, Exception e, string? url = null) =>
        W($"ERROR [{step}]{(url != null ? " url=" + url : "")}: {e.GetType().Name}: {e.Message}{(e.InnerException != null ? " <- " + e.InnerException.Message : "")}\n{e.StackTrace}");

    /// <summary>best-effort delete that logs (once) instead of failing</summary>
    public static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception e) { W($"cleanup: could not delete {path}: {e.Message}"); }
    }
}
