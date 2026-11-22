package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;

/**
 * HiveClient's WebSocket path against a tiny in-test WebSocket server (RFC 6455 handshake + text frames) on a
 * random localhost port: init/merge, hello, command round-trip, fragmented messages, reconnect after drop.
 */
class HiveClientWsTest {
    MiniWs ws;
    HiveClient client;

    @AfterEach
    void tearDown() throws IOException {
        if (client != null) client.stop();
        if (ws != null) ws.close();
    }

    static void await(BooleanSupplier cond, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 8000;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) fail("timed out waiting for " + what);
            Thread.sleep(15);
        }
    }

    @Test
    void connectsReceivesInitAnswersCommandsAndReconnects() throws Exception {
        ws = new MiniWs();
        HiveConfig cfg = new HiveConfig().sanitize();
        cfg.bridgeUrl = "http://127.0.0.1:" + ws.port();
        client = new HiveClient(new HiveState(), () -> cfg, "9.9");
        client.updatePlayer(new PlayerInfo("Robin", 0, 64, 0, "overworld", 0, null));
        client.start();

        MiniWs.Conn c1 = ws.next();
        // client says hello first
        JsonObject hello = JsonParser.parseString(c1.inbox.poll(5, TimeUnit.SECONDS)).getAsJsonObject();
        assertEquals("hello", hello.get("t").getAsString());
        assertEquals("Robin", hello.get("player").getAsString());
        assertEquals("9.9", hello.get("version").getAsString());
        assertNull(c1.origin, "no Origin header");

        c1.send("{\"t\":\"init\",\"protocol\":1,\"serverTime\":1,\"bots\":[{\"name\":\"Ash\",\"online\":true,\"pos\":{\"x\":1,\"y\":64,\"z\":2}}],"
                + "\"chat\":[],\"board\":[],\"goal\":{\"text\":\"Castle\"},\"waypoints\":[],\"ghosts\":[],\"ledgerRecent\":[],\"photos\":[],\"commands\":[\"help\"]}");
        await(() -> client.state().bot("Ash") != null, "init applied");
        await(client::isOpen, "socket open");
        assertEquals("Castle", client.state().goal().text());

        // a message split across 3 fragments
        c1.sendFragmented("{\"t\":\"goal\",\"goal\":{\"text\":\"Build a big farm with fences\"}}", 3);
        await(() -> client.state().goal().text().startsWith("Build a big"), "fragmented message");

        // command round-trip over the socket
        var fut = client.sendCommand("status Ash");
        JsonObject cmd = null;
        for (int i = 0; i < 5 && cmd == null; i++) {
            String m = c1.inbox.poll(5, TimeUnit.SECONDS);
            assertNotNull(m);
            JsonObject o = JsonParser.parseString(m).getAsJsonObject();
            if ("command".equals(o.get("t").getAsString())) cmd = o; // skip player updates
        }
        assertNotNull(cmd);
        assertEquals("status Ash", cmd.get("text").getAsString());
        assertEquals("Robin", cmd.getAsJsonObject("player").get("name").getAsString());
        c1.send("{\"t\":\"command_result\",\"id\":\"" + cmd.get("id").getAsString() + "\",\"ok\":true,\"lines\":[[{\"text\":\"Ash ok\"}]]}");
        CommandResult r = fut.get(5, TimeUnit.SECONDS);
        assertTrue(r.ok());
        assertEquals("Ash ok", r.plainText());

        // ghost summary without blocks we never had -> client asks for a resend
        c1.send("{\"t\":\"ghosts\",\"ghosts\":[{\"id\":\"g1\",\"total\":5,\"rev\":2}]}");
        String req = null;
        for (int i = 0; i < 5; i++) {
            String m = c1.inbox.poll(5, TimeUnit.SECONDS);
            assertNotNull(m, "expected a ghosts request");
            if (m.contains("\"t\":\"ghosts\"")) { req = m; break; }
        }
        assertNotNull(req);

        // server drops the connection: client goes offline, pending commands fail, then reconnects by itself
        var pending = client.sendCommand("bots");
        c1.socket.close();
        CommandResult dropped = pending.get(8, TimeUnit.SECONDS);
        assertFalse(dropped.ok());
        MiniWs.Conn c2 = ws.next();
        String hello2 = c2.inbox.poll(8, TimeUnit.SECONDS);
        assertNotNull(hello2);
        assertTrue(hello2.contains("\"hello\""));
        c2.send("{\"t\":\"init\",\"protocol\":1,\"bots\":[],\"chat\":[],\"board\":[],\"waypoints\":[],\"ghosts\":[],\"ledgerRecent\":[],\"photos\":[],\"commands\":[]}");
        await(client::isOpen, "reconnected");
        await(() -> client.state().bots().isEmpty(), "second init applied");
    }

    // ---------------------------------------------------------------- mini server

    static final class MiniWs implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 10, java.net.InetAddress.getLoopbackAddress());
        final BlockingQueue<Conn> conns = new LinkedBlockingQueue<>();
        final List<Conn> all = new CopyOnWriteArrayList<>();
        final Thread acceptor;

        MiniWs() throws IOException {
            acceptor = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket s = server.accept();
                        Conn c = new Conn(s);
                        if (!c.websocket) continue; // plain HTTP (e.g. GET /mod/trails) got a 404
                        all.add(c);
                        conns.add(c);
                    } catch (Exception e) { return; }
                }
            }, "miniws-accept");
            acceptor.setDaemon(true);
            acceptor.start();
        }

        int port() { return server.getLocalPort(); }

        Conn next() throws InterruptedException {
            Conn c = conns.poll(8, TimeUnit.SECONDS);
            assertNotNull(c, "client connected");
            return c;
        }

        @Override public void close() throws IOException {
            server.close();
            for (Conn c : all) try { c.socket.close(); } catch (IOException ignored) { /* test teardown */ }
        }

        static final class Conn {
            final Socket socket;
            final InputStream in;
            final OutputStream out;
            final BlockingQueue<String> inbox = new LinkedBlockingQueue<>();
            String origin;
            boolean websocket;

            Conn(Socket s) throws Exception {
                socket = s;
                in = s.getInputStream();
                out = s.getOutputStream();
                String key = null;
                for (String line : readHeaders().split("\r\n")) {
                    int i = line.indexOf(':');
                    if (i < 0) continue;
                    String h = line.substring(0, i).trim().toLowerCase(), v = line.substring(i + 1).trim();
                    if (h.equals("sec-websocket-key")) key = v;
                    if (h.equals("origin")) origin = v;
                }
                if (key == null) {
                    byte[] body = "{\"ok\":false,\"error\":\"not here\"}".getBytes(StandardCharsets.UTF_8);
                    out.write(("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.write(body);
                    out.flush();
                    s.close();
                    return;
                }
                websocket = true;
                String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                        .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
                out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                        + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                Thread t = new Thread(this::readLoop, "miniws-read");
                t.setDaemon(true);
                t.start();
            }

            private String readHeaders() throws IOException {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                int state = 0;
                while (state < 4) {
                    int c = in.read();
                    if (c < 0) throw new IOException("eof in headers");
                    b.write(c);
                    state = (c == '\r' && (state == 0 || state == 2)) || (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
                }
                return b.toString(StandardCharsets.US_ASCII);
            }

            private void readLoop() {
                try {
                    ByteArrayOutputStream msg = new ByteArrayOutputStream();
                    while (true) {
                        int b0 = in.read(), b1 = in.read();
                        if (b0 < 0 || b1 < 0) return;
                        int op = b0 & 0x0F;
                        long len = b1 & 0x7F;
                        if (len == 126) len = (in.read() << 8) | in.read();
                        else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | in.read(); }
                        byte[] mask = (b1 & 0x80) != 0 ? in.readNBytes(4) : new byte[4];
                        byte[] data = in.readNBytes((int) len);
                        for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
                        if (op == 0x8) return;            // close
                        if (op == 0x9 || op == 0xA) continue; // ping/pong
                        msg.write(data);
                        if ((b0 & 0x80) != 0) { inbox.add(msg.toString(StandardCharsets.UTF_8)); msg.reset(); }
                    }
                } catch (IOException e) { /* socket closed by the test */ }
            }

            synchronized void frame(int b0, byte[] p) throws IOException {
                out.write(b0);
                if (p.length < 126) out.write(p.length);
                else { out.write(126); out.write(p.length >> 8); out.write(p.length & 255); }
                out.write(p);
                out.flush();
            }

            void send(String text) throws IOException { frame(0x81, text.getBytes(StandardCharsets.UTF_8)); }

            void sendFragmented(String text, int parts) throws IOException {
                byte[] all = text.getBytes(StandardCharsets.UTF_8);
                int step = (all.length + parts - 1) / parts;
                for (int i = 0, off = 0; off < all.length; i++, off += step) {
                    byte[] p = java.util.Arrays.copyOfRange(all, off, Math.min(all.length, off + step));
                    boolean first = off == 0, last = off + step >= all.length;
                    frame((last ? 0x80 : 0) | (first ? 0x1 : 0x0), p);
                }
            }
        }
    }
}
