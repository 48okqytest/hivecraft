using System.IO.Compression;

namespace Hivecraft.Setup;

static class Zip
{
    /// <summary>
    /// Extract into dest with zip-slip protection. stripTop = drop a single top-level folder (node-vX-win-x64/, jdk-21…-jre/).
    /// keepExisting(relPath) = true leaves an existing file alone (config, user data). Returns files written.
    /// </summary>
    public static int Extract(Stream zipStream, string dest, bool stripTop, Func<string, bool>? keepExisting, IProgress<Progress>? p, string label, CancellationToken ct = default)
    {
        using var za = new ZipArchive(zipStream, ZipArchiveMode.Read, leaveOpen: true);
        var entries = za.Entries.Where(e => e.FullName.Length > 0).ToList();
        string? top = null;
        if (stripTop)
        {
            var tops = entries.Select(e => e.FullName.Replace('\\', '/').Split('/')[0]).Distinct().ToList();
            if (tops.Count == 1 && entries.Any(e => e.FullName.Replace('\\', '/').Contains('/'))) top = tops[0] + "/";
        }
        var root = Path.GetFullPath(dest).TrimEnd('\\') + "\\";
        Directory.CreateDirectory(root);
        int n = 0, i = 0;
        foreach (var e in entries)
        {
            ct.ThrowIfCancellationRequested();
            i++;
            var rel = e.FullName.Replace('\\', '/');
            if (top != null) { if (!rel.StartsWith(top)) continue; rel = rel[top.Length..]; }
            if (rel.Length == 0) continue;
            var target = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\')));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InstallException($"{label}: the archive contains an unsafe path ({e.FullName}).");
            if (rel.EndsWith('/')) { Directory.CreateDirectory(target); continue; }
            if (File.Exists(target) && keepExisting != null && keepExisting(rel)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var tmp = target + ".new";
            using (var s = e.Open())
            using (var fs = File.Create(tmp)) s.CopyTo(fs);
            File.Move(tmp, target, true);
            n++;
            if (i % 50 == 0) p?.Report(new Progress($"{label}: unpacking {i} of {entries.Count} files…", (double)i / entries.Count));
        }
        p?.Report(new Progress($"{label}: unpacked.", 1));
        return n;
    }

    public static int ExtractFile(string zipPath, string dest, bool stripTop, IProgress<Progress>? p, string label, CancellationToken ct = default)
    {
        using var fs = File.OpenRead(zipPath);
        return Extract(fs, dest, stripTop, null, p, label, ct);
    }
}
