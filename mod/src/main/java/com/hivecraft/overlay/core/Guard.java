package com.hivecraft.overlay.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.LongSupplier;

/**
 * Error containment for render layers / HUD parts / ticks: {@code Guard.run("ghosts", () -> ...)}.
 * <ul>
 * <li>Every failure is logged (layer name + exception, stack trace included), rate-limited to once per distinct
 *     message per minute.</li>
 * <li>A layer that fails {@link #DISABLE_AFTER} times within {@link #WINDOW_MS} is disabled: {@link #run} skips it
 *     from then on and {@link #disabledLayers()} lists it (the HUD shows "Hivecraft: &lt;layer&gt; disabled").</li>
 * <li>One broken layer never stops the others: run() never throws.</li>
 * </ul>
 * Thread-safe. HiveUI can use it for HUD/screens too.
 */
public final class Guard {
    public static final int DISABLE_AFTER = 5;
    public static final long WINDOW_MS = 10_000;
    public static final long LOG_EVERY_MS = 60_000;

    private static final class Layer {
        final List<Long> failures = new ArrayList<>();
        boolean disabled;
        String lastError;
    }

    private static final Guard GLOBAL = new Guard(System::currentTimeMillis);

    private final LongSupplier clock;
    private final Map<String, Layer> layers = new LinkedHashMap<>();
    private final Map<String, Long> lastLogged = new LinkedHashMap<>();
    private volatile BiConsumer<String, Throwable> sink = (m, t) -> {};
    private volatile List<String> disabled = List.of();

    public Guard(LongSupplier clock) { this.clock = clock; }

    /** The mod-wide instance. */
    public static Guard get() { return GLOBAL; }

    /** Where logs go (the mod sets LOGGER::warn). */
    public void setSink(BiConsumer<String, Throwable> s) { sink = s == null ? (m, t) -> {} : s; }

    /** Runs the body unless the layer is disabled; contains and records any failure. Returns false if skipped or failed. */
    public boolean run(String layer, Runnable body) {
        if (isDisabled(layer)) return false;
        try {
            body.run();
            return true;
        } catch (Throwable t) {
            fail(layer, t);
            return false;
        }
    }

    /** Records a failure of a layer (use when you caught it yourself). */
    public void fail(String layer, Throwable t) {
        long now = clock.getAsLong();
        boolean justDisabled = false;
        synchronized (this) {
            Layer l = layers.computeIfAbsent(layer, k -> new Layer());
            l.lastError = String.valueOf(t);
            l.failures.add(now);
            l.failures.removeIf(ts -> now - ts > WINDOW_MS);
            if (!l.disabled && l.failures.size() >= DISABLE_AFTER) {
                l.disabled = true;
                justDisabled = true;
                publish();
            }
        }
        warn(layer, layer + " failed: " + t, t);
        if (justDisabled) sink.accept("Hivecraft: layer '" + layer + "' disabled after " + DISABLE_AFTER
                + " errors in " + WINDOW_MS / 1000 + "s (last: " + t + "). Re-enable with Guard.reset or restart.", null);
    }

    /** Rate-limited warning: the same (key + message) at most once per minute. Never throws. */
    public void warn(String key, String message, Throwable t) {
        long now = clock.getAsLong();
        String k = key + "|" + message;
        synchronized (this) {
            Long last = lastLogged.get(k);
            if (last != null && now - last < LOG_EVERY_MS) return;
            lastLogged.put(k, now);
            if (lastLogged.size() > 500) lastLogged.remove(lastLogged.keySet().iterator().next());
        }
        try { sink.accept("[hivecraft/" + key + "] " + message, t); } catch (Throwable ignored) { /* logging must never break rendering */ }
    }

    public synchronized boolean isDisabled(String layer) {
        Layer l = layers.get(layer);
        return l != null && l.disabled;
    }

    /** Layers currently disabled, in order of failure. */
    public List<String> disabledLayers() { return disabled; }

    public synchronized String lastError(String layer) {
        Layer l = layers.get(layer);
        return l == null ? null : l.lastError;
    }

    /** Re-enables one layer (or all when null). */
    public synchronized void reset(String layer) {
        if (layer == null) layers.clear(); else layers.remove(layer);
        publish();
    }

    private void publish() {
        List<String> d = new ArrayList<>();
        for (var e : layers.entrySet()) if (e.getValue().disabled) d.add(e.getKey());
        disabled = Collections.unmodifiableList(d);
    }
}
