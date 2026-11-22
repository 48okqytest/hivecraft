package com.hivecraft.overlay.world;

import net.minecraft.client.render.VertexConsumer;

/**
 * Wraps a VertexConsumer and multiplies every vertex alpha by {@link #alpha} (and optionally tints rgb).
 * Used to draw real block models translucently (BlockModelRenderer always emits alpha 1).
 */
public final class AlphaConsumer implements VertexConsumer {
    private VertexConsumer inner;
    private float alpha = 1f;
    private float tr = 1f, tg = 1f, tb = 1f;

    public AlphaConsumer set(VertexConsumer inner, float alpha) {
        this.inner = inner;
        this.alpha = alpha;
        this.tr = this.tg = this.tb = 1f;
        return this;
    }

    /** Multiplies rgb as well (1,1,1 = unchanged). */
    public AlphaConsumer tint(float r, float g, float b) { tr = r; tg = g; tb = b; return this; }

    private int ch(int v, float f) { return Math.max(0, Math.min(255, Math.round(v * f))); }

    @Override public VertexConsumer vertex(float x, float y, float z) { inner.vertex(x, y, z); return this; }
    @Override public VertexConsumer color(int r, int g, int b, int a) { inner.color(ch(r, tr), ch(g, tg), ch(b, tb), ch(a, alpha)); return this; }
    @Override public VertexConsumer texture(float u, float v) { inner.texture(u, v); return this; }
    @Override public VertexConsumer overlay(int u, int v) { inner.overlay(u, v); return this; }
    @Override public VertexConsumer light(int u, int v) { inner.light(u, v); return this; }
    @Override public VertexConsumer normal(float x, float y, float z) { inner.normal(x, y, z); return this; }

    /** Fast path used by quad(): colour is ARGB. */
    @Override
    public void vertex(float x, float y, float z, int color, float u, float v, int overlay, int light, float nx, float ny, float nz) {
        int a = ch((color >>> 24) & 255, alpha), r = ch((color >> 16) & 255, tr), g = ch((color >> 8) & 255, tg), b = ch(color & 255, tb);
        inner.vertex(x, y, z, (a << 24) | (r << 16) | (g << 8) | b, u, v, overlay, light, nx, ny, nz);
    }
}
