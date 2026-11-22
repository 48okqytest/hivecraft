package com.hivecraft.overlay.ui.layout;

/**
 * Top-down map maths: world (x,z) ↔ screen (px,py) with north (-Z) up, zoom in pixels per block,
 * pan in blocks, zoom-around-cursor. Pure logic (unit tested).
 */
public final class MapProjection {
    public static final double MIN_ZOOM = 0.125, MAX_ZOOM = 8;

    private double centerX, centerZ;   // world point at the view centre
    private double zoom = 1.5;         // px per block
    private int vx, vy, vw, vh;        // viewport

    public void setViewport(int x, int y, int w, int h) {
        vx = x; vy = y; vw = w; vh = h;
    }

    public void setCenter(double x, double z) {
        centerX = x;
        centerZ = z;
    }

    public double centerX() { return centerX; }
    public double centerZ() { return centerZ; }
    public double zoom() { return zoom; }

    public void setZoom(double z) {
        zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    }

    public double toScreenX(double wx) { return vx + vw / 2.0 + (wx - centerX) * zoom; }
    public double toScreenY(double wz) { return vy + vh / 2.0 + (wz - centerZ) * zoom; }
    public double toWorldX(double sx) { return centerX + (sx - vx - vw / 2.0) / zoom; }
    public double toWorldZ(double sy) { return centerZ + (sy - vy - vh / 2.0) / zoom; }

    public boolean visible(double sx, double sy, int margin) {
        return sx >= vx - margin && sx < vx + vw + margin && sy >= vy - margin && sy < vy + vh + margin;
    }

    /** Pan by a mouse drag of (dx,dy) pixels (content follows the mouse). */
    public void dragBy(double dx, double dy) {
        centerX -= dx / zoom;
        centerZ -= dy / zoom;
    }

    /** Zoom by {@code factor} keeping the world point under (sx,sy) fixed. */
    public void zoomAt(double sx, double sy, double factor) {
        double wx = toWorldX(sx), wz = toWorldZ(sy);
        setZoom(zoom * factor);
        centerX = wx - (sx - vx - vw / 2.0) / zoom;
        centerZ = wz - (sy - vy - vh / 2.0) / zoom;
    }

    /** Grid spacing (blocks) that keeps lines at least {@code minPx} apart: 16, 32, 64, ... */
    public int gridStep(int minPx) {
        int step = 16;
        while (step * zoom < minPx && step < 1 << 16) step *= 2;
        return step;
    }
}
