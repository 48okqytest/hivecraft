package com.hivecraft.overlay.core;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * HiveClient against an in-process mock HTTP endpoint on a random localhost port (no bridge, no Minecraft).
 * The mock does not speak WebSocket, so the socket side stays offline and commands fall back to HTTP.
 */
class HiveClientTest {
    HttpServer server;
    HiveClient client;
    final List<String> seenOrigins = new CopyOnWriteArrayList<>();
    final List<String> seenHosts = new CopyOnWriteArrayList<>();

    @AfterEach
    void tearDown() {
        if (client != null) client.stop();
        if (server != null) server.stop(0);
    }

    static void reply(com.sun.net.httpserver.HttpExchange ex, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(code, b.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(b); }
    }

    private HiveClient clientFor(int port) {
        HiveConfig cfg = new HiveConfig().sanitize();
        cfg.bridgeUrl = "http://127.0.0.1:" + port;
        return new HiveClient(new HiveState(), () -> cfg, "test");
    }

    private void startMock() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/mod/command", ex -> {
            seenOrigins.add(String.valueOf(ex.getRequestHeaders().getFirst("Origin")));
            seenHosts.add(String.valueOf(ex.getRequestHeaders().getFirst("Host")));
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (body.contains("\"text\":\"bad\"")) {
                reply(ex, 400, "{\"ok\":false,\"error\":\"unknown command: bad\"}");
            } else {
                reply(ex, 200, "{\"ok\":true,\"lines\":[[{\"text\":\"echo \",\"color\":\"#AAAAAA\"},{\"text\":\"" + (body.contains("status Ash") ? "Ash" : "?") + "\",\"bold\":true}]]}");
            }
        });
        server.createContext("/mod/ledger/at", ex -> reply(ex, 200,
                "{\"ok\":true,\"x\":11,\"y\":65,\"z\":6,\"dim\":\"overworld\",\"history\":[{\"id\":5,\"ts\":100,\"bot\":\"Ash\",\"op\":\"place\",\"block\":\"oak_stairs\",\"x\":11,\"y\":65,\"z\":6}],\"last\":{\"id\":5,\"ts\":100,\"bot\":\"Ash\",\"op\":\"place\",\"block\":\"oak_stairs\",\"x\":11,\"y\":65,\"z\":6}}"));
        server.createContext("/mod/photos", ex -> reply(ex, 200, "{\"ok\":true,\"photos\":[{\"id\":\"Ash-9\",\"agent\":\"Ash\",\"ts\":9,\"caption\":\"hut\"}]}"));
        server.createContext("/photos/", ex -> {
            byte[] png = {(byte) 0x89, 'P', 'N', 'G'};
            ex.sendResponseHeaders(200, png.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(png); }
        });
        server.start();
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) { return s.getLocalPort(); }
    }

    @Test
    void bridgeDownGoesOfflineAndCommandsReturnErrorsNotExceptions() throws Exception {
        client = clientFor(freePort());
        client.start();
        long deadline = System.currentTimeMillis() + 5000;
        while (client.state().lastError().isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertFalse(client.state().lastError().isEmpty(), "connect failure is recorded");
        assertNotEquals(HiveState.Connection.ONLINE, client.state().connection());
        assertFalse(client.isOpen());
        assertFalse(client.send(new com.google.gson.JsonObject()));
        CommandResult r = client.sendCommand("bots").get(10, TimeUnit.SECONDS);
        assertFalse(r.ok());
        assertTrue(r.plainText().contains("offline"), r.plainText());
    }

    @Test
    void commandsFallBackToHttpWithoutOriginHeader() throws Exception {
        startMock();
        client = clientFor(server.getAddress().getPort());
        client.updatePlayer(new PlayerInfo("Robin", 12, 64, -3, "overworld", 90, new int[]{1, 2, 3}));
        CommandResult r = client.sendCommand("status Ash").get(10, TimeUnit.SECONDS);
        assertTrue(r.ok(), r.plainText());
        assertEquals("echo Ash", r.plainText());
        assertTrue(r.lines().get(0).get(1).bold());
        assertEquals(List.of("null"), seenOrigins); // never send Origin
        assertEquals("127.0.0.1:" + server.getAddress().getPort(), seenHosts.get(0));

        CommandResult bad = client.sendCommand("bad").get(10, TimeUnit.SECONDS);
        assertFalse(bad.ok());
        assertEquals("unknown command: bad", bad.plainText());
    }

    @Test
    void ledgerAtIsNonBlockingAndCaches() throws Exception {
        startMock();
        client = clientFor(server.getAddress().getPort());
        LedgerCache.AtResult first = client.ledgerAt(11, 65, 6, "overworld"); // starts the fetch
        assertNull(first);
        LedgerCache.AtResult got = null;
        long deadline = System.currentTimeMillis() + 5000;
        while (got == null && System.currentTimeMillis() < deadline) { Thread.sleep(20); got = client.ledgerAt(11, 65, 6, "overworld"); }
        assertNotNull(got);
        assertEquals("Ash", got.last().bot());
    }

    @Test
    void photosAndBytes() throws Exception {
        startMock();
        client = clientFor(server.getAddress().getPort());
        List<Photo> p = client.loadPhotos("Ash", 5).get(10, TimeUnit.SECONDS);
        assertEquals("Ash-9", p.get(0).id());
        assertEquals("Ash-9", client.state().photos().get(0).id());
        byte[] png = client.fetchBytes(p.get(0).url()).get(10, TimeUnit.SECONDS);
        assertEquals(4, png.length);
        assertEquals('P', png[1]);
        assertThrows(Exception.class, () -> client.fetchBytes("/nope").get(10, TimeUnit.SECONDS));
    }

    @Test
    void playerNameOverrideAndJson() {
        HiveConfig cfg = new HiveConfig().sanitize();
        cfg.playerName = "Boss";
        HiveClient c = new HiveClient(new HiveState(), () -> cfg, "t");
        c.updatePlayer(new PlayerInfo("Robin", 1.234, 64, -3.5, "overworld", 90.04f, null));
        assertEquals("Boss", c.player().name());
        var o = c.player().toJson();
        assertEquals(1.23, o.get("x").getAsDouble(), 1e-9);
        assertFalse(o.has("look"));
        assertEquals("overworld", o.get("dim").getAsString());
    }
}
