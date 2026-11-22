using System.Net.Sockets;
using System.Text;

namespace Hivecraft;

/// <summary>Minimal Minecraft RCON client (used to stop a server we did not start ourselves).</summary>
static class Rcon
{
    public static byte[] Packet(int id, int type, string body)
    {
        var b = Encoding.UTF8.GetBytes(body);
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(10 + b.Length); w.Write(id); w.Write(type); w.Write(b); w.Write((byte)0); w.Write((byte)0);
        return ms.ToArray();
    }

    static async Task<(int id, int type, string body)> ReadAsync(NetworkStream s, CancellationToken ct)
    {
        var head = new byte[4];
        await ReadFull(s, head, ct);
        int len = BitConverter.ToInt32(head);
        var buf = new byte[len];
        await ReadFull(s, buf, ct);
        return (BitConverter.ToInt32(buf, 0), BitConverter.ToInt32(buf, 4), Encoding.UTF8.GetString(buf, 8, Math.Max(0, len - 10)));
    }

    static async Task ReadFull(NetworkStream s, byte[] buf, CancellationToken ct)
    {
        int n = 0;
        while (n < buf.Length)
        {
            int r = await s.ReadAsync(buf.AsMemory(n), ct);
            if (r <= 0) throw new IOException("rcon closed");
            n += r;
        }
    }

    /// <summary>password/port null = from hivecraft.config.json (Orchestrator.Cfg).</summary>
    public static async Task<string> SendAsync(string cmd, string? password = null, int? port = null, int timeoutMs = 5000)
    {
        password ??= Orchestrator.Cfg.Server.RconPassword;
        port ??= Orchestrator.Cfg.Server.RconPort;
        using var cts = new CancellationTokenSource(timeoutMs);
        using var c = new TcpClient();
        await c.ConnectAsync("127.0.0.1", port.Value, cts.Token);
        var s = c.GetStream();
        await s.WriteAsync(Packet(1, 3, password), cts.Token);
        var auth = await ReadAsync(s, cts.Token);
        if (auth.id == -1) throw new Exception("rcon auth failed");
        await s.WriteAsync(Packet(2, 2, cmd), cts.Token);
        try { var r = await ReadAsync(s, cts.Token); return r.body; } catch { return ""; } // 'stop' may close the socket
    }
}
