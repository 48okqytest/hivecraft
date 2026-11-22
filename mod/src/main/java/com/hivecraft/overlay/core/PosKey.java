package com.hivecraft.overlay.core;

/** Packs block coords into a long (same layout as vanilla BlockPos.asLong: 26 bits x, 26 bits z, 12 bits y). */
public final class PosKey {
    private PosKey() {}

    public static long pack(int x, int y, int z) {
        return ((long) x & 0x3FFFFFFL) << 38 | ((long) z & 0x3FFFFFFL) << 12 | ((long) y & 0xFFFL);
    }

    public static int x(long k) { return (int) (k >> 38); }
    public static int y(long k) { return (int) (k << 52 >> 52); }
    public static int z(long k) { return (int) (k << 26 >> 38); }
}
