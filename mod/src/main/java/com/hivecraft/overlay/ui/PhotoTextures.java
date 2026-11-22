package com.hivecraft.overlay.ui;

import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.Photo;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.NativeImageBackedTexture;
import net.minecraft.util.Identifier;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Loads album photos (PNG from the bridge) into GPU textures on demand and keeps an LRU of them.
 * {@link #get} never blocks: it returns null while loading and kicks off the download once.
 */
public final class PhotoTextures {
    public record Tex(Identifier id, int width, int height) {}

    private static final int MAX = 40;
    private static final Map<String, Tex> loaded = new LinkedHashMap<>(16, 0.75f, true);
    private static final Map<String, Long> failed = new LinkedHashMap<>();
    private static final java.util.Set<String> loading = new java.util.HashSet<>();

    private PhotoTextures() {}

    /** Render thread only. */
    public static Tex get(Photo p) {
        Tex t = loaded.get(p.id());
        if (t != null) return t;
        Long f = failed.get(p.id());
        if (f != null && System.currentTimeMillis() - f < 30_000) return null;
        if (loading.contains(p.id())) return null;
        HiveClient c = Hive.client();
        if (c == null) return null;
        loading.add(p.id());
        c.fetchBytes(p.url()).whenComplete((bytes, err) -> MinecraftClient.getInstance().execute(() -> {
            loading.remove(p.id());
            if (err != null || bytes == null || bytes.length == 0) {
                failed.put(p.id(), System.currentTimeMillis());
                return;
            }
            try {
                NativeImage img = NativeImage.read(bytes);
                NativeImageBackedTexture tex = new NativeImageBackedTexture(img);
                Identifier id = Identifier.of("hivecraft", "photo/" + sanitize(p.id()));
                MinecraftClient.getInstance().getTextureManager().registerTexture(id, tex);
                loaded.put(p.id(), new Tex(id, img.getWidth(), img.getHeight()));
                evict();
            } catch (Exception e) {
                Hive.log("photo " + p.id() + " unreadable: " + e);
                failed.put(p.id(), System.currentTimeMillis());
            }
        }));
        return null;
    }

    public static boolean isLoading(Photo p) {
        return loading.contains(p.id());
    }

    public static boolean hasFailed(Photo p) {
        return failed.containsKey(p.id()) && !loaded.containsKey(p.id());
    }

    private static void evict() {
        Iterator<Map.Entry<String, Tex>> it = loaded.entrySet().iterator();
        while (loaded.size() > MAX && it.hasNext()) {
            Map.Entry<String, Tex> e = it.next();
            MinecraftClient.getInstance().getTextureManager().destroyTexture(e.getValue().id());
            it.remove();
        }
    }

    /** Identifier paths allow [a-z0-9/._-] only. */
    static String sanitize(String s) {
        StringBuilder sb = new StringBuilder();
        for (char ch : s.toLowerCase(java.util.Locale.ROOT).toCharArray()) {
            sb.append((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.' ? ch : '_');
        }
        return sb.toString();
    }
}
