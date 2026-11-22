using System.Net.Http;
using System.Security.Cryptography;

namespace Hivecraft.Setup;

/// <summary>Progress of one step: text for the status line and 0..1 (or -1 = unknown).</summary>
public readonly record struct Progress(string Text, double Fraction = -1);

/// <summary>HTTP downloads with resume (.part + Range), retries and checksum checks.</summary>
static class Net
{
    public static readonly HttpClient Http = Make();
    static HttpClient Make()
    {
        var c = new HttpClient(new SocketsHttpHandler { AutomaticDecompression = System.Net.DecompressionMethods.All, ConnectTimeout = TimeSpan.FromSeconds(20) })
        { Timeout = Timeout.InfiniteTimeSpan };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Hivecraft-Setup/1.0");   // generic, nothing personal
        return c;
    }

    public static async Task<string> GetStringAsync(string url, CancellationToken ct, int tries = 3)
    {
        for (int i = 1; ; i++)
        {
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(30));
                using var r = await Http.GetAsync(url, cts.Token);
                if (!r.IsSuccessStatusCode) throw new HttpRequestException($"{new Uri(url).Host} answered {(int)r.StatusCode} {r.ReasonPhrase}");
                return await r.Content.ReadAsStringAsync(cts.Token);
            }
            catch (Exception e) when (i < tries && !ct.IsCancellationRequested)
            {
                Log.W($"GET {url} failed (try {i}/{tries}): {e.GetType().Name}: {e.Message}");
                await Task.Delay(1500 * i, ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                Log.Err("GET", e, url);
                throw new InstallException($"Could not reach {new Uri(url).Host} ({e.Message}). Check your internet connection and press Retry.", e);
            }
        }
    }

    /// <summary>
    /// Download url to dest (atomically, via dest.part which is resumed on retry). expectedHash (hex) is checked with algo
    /// ("sha256" | "sha1" | "sha512"); a mismatch deletes the file and throws. An existing dest with the right hash is reused.
    /// </summary>
    public static async Task DownloadAsync(string url, string dest, string? expectedHash, string algo, IProgress<Progress>? p, string label, CancellationToken ct, int tries = 3)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        Log.W($"{label}: download {url} -> {dest}");
        if (File.Exists(dest) && expectedHash != null && await HashFileAsync(dest, algo, ct) == expectedHash.ToLowerInvariant())
        {
            p?.Report(new Progress($"{label}: already downloaded (checksum OK)", 1));
            return;
        }
        var part = dest + ".part";
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                await DownloadOnce(url, part, p, label, ct);
                break;
            }
            catch (Exception e) when (attempt >= tries && !ct.IsCancellationRequested && e is HttpRequestException or IOException or TaskCanceledException)
            {
                Log.Err(label, e, url);
                throw new InstallException($"{label}: download failed after {tries} tries ({e.Message}). Check your internet connection and press Retry — it continues where it stopped.", e);
            }
            catch (Exception e) when (attempt < tries && !ct.IsCancellationRequested && e is HttpRequestException or IOException or TaskCanceledException)
            {
                Log.W($"{label}: download {url} failed (try {attempt}/{tries}): {e.GetType().Name}: {e.Message}");
                p?.Report(new Progress($"{label}: connection problem ({e.Message}), retrying ({attempt + 1}/{tries})…"));
                await Task.Delay(2000 * attempt, ct);
            }
        }
        if (expectedHash != null)
        {
            p?.Report(new Progress($"{label}: checking file integrity…", 1));
            var got = await HashFileAsync(part, algo, ct);
            if (got != expectedHash.ToLowerInvariant())
            {
                Log.W($"{label}: {algo} mismatch for {url}: expected {expectedHash}, got {got}");
                Log.TryDelete(part);
                throw new InstallException($"{label}: the downloaded file is damaged ({algo} checksum does not match). Press Retry to download it again.");
            }
        }
        File.Move(part, dest, true);
        Log.W($"{label}: saved {dest} ({Mb(new FileInfo(dest).Length)}{(expectedHash != null ? ", " + algo + " OK" : "")})");
    }

    static async Task DownloadOnce(string url, string part, IProgress<Progress>? p, string label, CancellationToken ct)
    {
        long have = File.Exists(part) ? new FileInfo(part).Length : 0;
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (have > 0) req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(have, null);
        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (resp.StatusCode == System.Net.HttpStatusCode.RequestedRangeNotSatisfiable) { Log.TryDelete(part); throw new IOException("restart download"); }
        if (!resp.IsSuccessStatusCode) throw new HttpRequestException($"{new Uri(url).Host} answered {(int)resp.StatusCode} {resp.ReasonPhrase}");
        bool resumed = have > 0 && resp.StatusCode == System.Net.HttpStatusCode.PartialContent;
        if (!resumed) have = 0;
        long? total = resp.Content.Headers.ContentLength + have;
        await using var src = await resp.Content.ReadAsStreamAsync(ct);
        await using var fs = new FileStream(part, resumed ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, true);
        var buf = new byte[1 << 16];
        long done = have;
        var last = DateTime.MinValue;
        while (true)
        {
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
            idle.CancelAfter(TimeSpan.FromSeconds(45));   // stalled connection -> retry (resumes)
            int n;
            try { n = await src.ReadAsync(buf, idle.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new IOException("download stalled"); }
            if (n == 0) break;
            await fs.WriteAsync(buf.AsMemory(0, n), ct);
            done += n;
            if ((DateTime.UtcNow - last).TotalMilliseconds > 150)
            {
                last = DateTime.UtcNow;
                p?.Report(new Progress(total > 0 ? $"{label}: {Mb(done)} of {Mb(total.Value)}" : $"{label}: {Mb(done)}", total > 0 ? (double)done / total.Value : -1));
            }
        }
        if (total > 0 && done < total) throw new IOException("connection closed early");
    }

    public static string Mb(long b) => b >= 1 << 20 ? $"{b / 1048576.0:0.0} MB" : $"{b / 1024.0:0} KB";

    public static async Task<string> HashFileAsync(string path, string algo, CancellationToken ct = default)
    {
        await using var fs = File.OpenRead(path);
        byte[] h = algo switch
        {
            "sha1" => await SHA1.HashDataAsync(fs, ct),
            "sha512" => await SHA512.HashDataAsync(fs, ct),
            _ => await SHA256.HashDataAsync(fs, ct),
        };
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    /// <summary>"&lt;hash&gt;  &lt;file&gt;" lines (SHASUMS256.txt) -> hash for fileName, or null.</summary>
    public static string? HashFromSumsFile(string sums, string fileName)
    {
        foreach (var raw in sums.Split('\n'))
        {
            var l = raw.Trim();
            var sp = l.IndexOfAny(new[] { ' ', '\t' });
            if (sp <= 0) continue;
            var name = l[sp..].Trim().TrimStart('*');
            if (name == fileName) return l[..sp].ToLowerInvariant();
        }
        return null;
    }
}

/// <summary>An error with a message meant for the user (shown as-is).</summary>
public sealed class InstallException(string message, Exception? inner = null) : Exception(message, inner);
