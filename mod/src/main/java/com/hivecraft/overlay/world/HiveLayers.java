package com.hivecraft.overlay.world;

import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.render.RenderPhase;
import net.minecraft.client.render.VertexFormat;
import net.minecraft.client.render.VertexFormats;

import java.util.List;
import java.util.OptionalDouble;

/**
 * Custom render layers. Extends RenderLayer only to reach RenderPhase's protected phase constants;
 * layers are plain RenderLayer instances whose setup/teardown run a list of phases (like MultiPhase does).
 */
public abstract class HiveLayers extends RenderLayer {
    private HiveLayers() { super("hivecraft_dummy", VertexFormats.POSITION, VertexFormat.DrawMode.QUADS, 256, false, false, () -> {}, () -> {}); }

    private static RenderLayer layer(String name, VertexFormat fmt, VertexFormat.DrawMode mode, int size, List<RenderPhase> phases) {
        // quads are translucent (sorted back-to-front on upload); lines are not (vanilla's lines layer isn't either)
        boolean sort = mode == VertexFormat.DrawMode.QUADS;
        return new RenderLayer("hivecraft_" + name, fmt, mode, size, false, sort,
                () -> phases.forEach(RenderPhase::startDrawing),
                () -> { for (int i = phases.size() - 1; i >= 0; i--) phases.get(i).endDrawing(); }) {};
    }

    private static List<RenderPhase> quadPhases(boolean xray) {
        return List.of(COLOR_PROGRAM, NO_TEXTURE, TRANSLUCENT_TRANSPARENCY, xray ? ALWAYS_DEPTH_TEST : LEQUAL_DEPTH_TEST,
                DISABLE_CULLING, VIEW_OFFSET_Z_LAYERING, MAIN_TARGET, COLOR_MASK);
    }

    private static List<RenderPhase> linePhases(boolean xray, double width) {
        return List.of(LINES_PROGRAM, NO_TEXTURE, TRANSLUCENT_TRANSPARENCY, xray ? ALWAYS_DEPTH_TEST : LEQUAL_DEPTH_TEST,
                DISABLE_CULLING, VIEW_OFFSET_Z_LAYERING, MAIN_TARGET, COLOR_MASK, new LineWidth(OptionalDouble.of(width)));
    }

    /** Translucent coloured quads (POSITION_COLOR), depth-tested, no depth write. */
    public static final RenderLayer QUADS = layer("quads", VertexFormats.POSITION_COLOR, VertexFormat.DrawMode.QUADS, 1 << 18, quadPhases(false));
    /** Same, visible through walls. */
    public static final RenderLayer QUADS_XRAY = layer("quads_xray", VertexFormats.POSITION_COLOR, VertexFormat.DrawMode.QUADS, 1 << 16, quadPhases(true));
    /** Lines (LINES format: position, color, normal), 2.5 px, depth-tested. */
    public static final RenderLayer LINES = layer("lines", VertexFormats.LINES, VertexFormat.DrawMode.LINES, 1 << 18, linePhases(false, 2.5));
    /** Lines through walls. */
    public static final RenderLayer LINES_XRAY = layer("lines_xray", VertexFormats.LINES, VertexFormat.DrawMode.LINES, 1 << 16, linePhases(true, 2.0));
    /** Thick lines (focused bot / highlights). */
    public static final RenderLayer LINES_THICK = layer("lines_thick", VertexFormats.LINES, VertexFormat.DrawMode.LINES, 1 << 15, linePhases(false, 4.5));
}
