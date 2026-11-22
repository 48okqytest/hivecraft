package com.hivecraft.overlay.world;

import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.util.math.MatrixStack;
import org.joml.Matrix4f;

/** Low-level vertex helpers for {@link HiveLayers} (positions already camera-relative). Colours are 0xRRGGBB + alpha 0..1. */
public final class Draw {
    private Draw() {}

    private static int a8(float a) { return Math.max(0, Math.min(255, Math.round(a * 255))); }

    /** One POSITION_COLOR vertex. */
    public static void v(VertexConsumer vc, Matrix4f m, float x, float y, float z, int rgb, float a) {
        vc.vertex(m, x, y, z).color((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, a8(a));
    }

    /** Quad (4 corners in order). */
    public static void quad(VertexConsumer vc, Matrix4f m,
                            float x1, float y1, float z1, float x2, float y2, float z2,
                            float x3, float y3, float z3, float x4, float y4, float z4, int rgb, float a) {
        v(vc, m, x1, y1, z1, rgb, a); v(vc, m, x2, y2, z2, rgb, a); v(vc, m, x3, y3, z3, rgb, a); v(vc, m, x4, y4, z4, rgb, a);
    }

    /** Filled axis-aligned box (6 faces) into a QUADS layer. */
    public static void box(VertexConsumer vc, Matrix4f m, float x1, float y1, float z1, float x2, float y2, float z2, int rgb, float a) {
        if (a <= 0.003f) return;
        quad(vc, m, x1, y1, z1, x2, y1, z1, x2, y1, z2, x1, y1, z2, rgb, a); // bottom
        quad(vc, m, x1, y2, z1, x1, y2, z2, x2, y2, z2, x2, y2, z1, rgb, a); // top
        quad(vc, m, x1, y1, z1, x1, y2, z1, x2, y2, z1, x2, y1, z1, rgb, a); // north
        quad(vc, m, x1, y1, z2, x2, y1, z2, x2, y2, z2, x1, y2, z2, rgb, a); // south
        quad(vc, m, x1, y1, z1, x1, y1, z2, x1, y2, z2, x1, y2, z1, rgb, a); // west
        quad(vc, m, x2, y1, z1, x2, y2, z1, x2, y2, z2, x2, y1, z2, rgb, a); // east
    }

    /** One line segment into a LINES layer (normal = direction, as vanilla does). */
    public static void line(VertexConsumer vc, MatrixStack.Entry e, float x1, float y1, float z1, float x2, float y2, float z2,
                            int rgb1, float a1, int rgb2, float a2) {
        float dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
        float len = (float) Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-5f) return;
        dx /= len; dy /= len; dz /= len;
        Matrix4f m = e.getPositionMatrix();
        vc.vertex(m, x1, y1, z1).color((rgb1 >> 16) & 255, (rgb1 >> 8) & 255, rgb1 & 255, a8(a1)).normal(e, dx, dy, dz);
        vc.vertex(m, x2, y2, z2).color((rgb2 >> 16) & 255, (rgb2 >> 8) & 255, rgb2 & 255, a8(a2)).normal(e, dx, dy, dz);
    }

    public static void line(VertexConsumer vc, MatrixStack.Entry e, float x1, float y1, float z1, float x2, float y2, float z2, int rgb, float a) {
        line(vc, e, x1, y1, z1, x2, y2, z2, rgb, a, rgb, a);
    }

    /** 12-edge outline of a box into a LINES layer. */
    public static void outline(VertexConsumer vc, MatrixStack.Entry e, float x1, float y1, float z1, float x2, float y2, float z2, int rgb, float a) {
        if (a <= 0.003f) return;
        line(vc, e, x1, y1, z1, x2, y1, z1, rgb, a); line(vc, e, x2, y1, z1, x2, y1, z2, rgb, a);
        line(vc, e, x2, y1, z2, x1, y1, z2, rgb, a); line(vc, e, x1, y1, z2, x1, y1, z1, rgb, a);
        line(vc, e, x1, y2, z1, x2, y2, z1, rgb, a); line(vc, e, x2, y2, z1, x2, y2, z2, rgb, a);
        line(vc, e, x2, y2, z2, x1, y2, z2, rgb, a); line(vc, e, x1, y2, z2, x1, y2, z1, rgb, a);
        line(vc, e, x1, y1, z1, x1, y2, z1, rgb, a); line(vc, e, x2, y1, z1, x2, y2, z1, rgb, a);
        line(vc, e, x2, y1, z2, x2, y2, z2, rgb, a); line(vc, e, x1, y1, z2, x1, y2, z2, rgb, a);
    }

    /** Vertical translucent beam (4 side quads) from y1 to y2 around (cx,cz) with half-width r; fades toward the top. */
    public static void beam(VertexConsumer vc, Matrix4f m, float cx, float y1, float y2, float cz, float r, int rgb, float aBottom, float aTop) {
        float x1 = cx - r, x2 = cx + r, z1 = cz - r, z2 = cz + r;
        side(vc, m, x1, z1, x2, z1, y1, y2, rgb, aBottom, aTop);
        side(vc, m, x2, z1, x2, z2, y1, y2, rgb, aBottom, aTop);
        side(vc, m, x2, z2, x1, z2, y1, y2, rgb, aBottom, aTop);
        side(vc, m, x1, z2, x1, z1, y1, y2, rgb, aBottom, aTop);
    }

    private static void side(VertexConsumer vc, Matrix4f m, float xa, float za, float xb, float zb, float y1, float y2, int rgb, float a1, float a2) {
        v(vc, m, xa, y1, za, rgb, a1); v(vc, m, xb, y1, zb, rgb, a1); v(vc, m, xb, y2, zb, rgb, a2); v(vc, m, xa, y2, za, rgb, a2);
    }

    /** Flat 2D rect in the current (billboard) space, z = 0: x1,y1 top-left. */
    public static void rect(VertexConsumer vc, Matrix4f m, float x1, float y1, float x2, float y2, float z, int rgb, float a) {
        if (a <= 0.003f) return;
        v(vc, m, x1, y1, z, rgb, a); v(vc, m, x1, y2, z, rgb, a); v(vc, m, x2, y2, z, rgb, a); v(vc, m, x2, y1, z, rgb, a);
    }
}
