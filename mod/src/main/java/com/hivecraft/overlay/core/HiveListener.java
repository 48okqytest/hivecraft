package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

import java.util.List;

/**
 * Callbacks from {@link HiveState}. Called on the network thread, AFTER the state was updated:
 * do not touch Minecraft/GL objects here; queue work for the client thread (e.g. MinecraftClient.execute).
 * Keep them fast and never throw (exceptions are caught and logged).
 */
public interface HiveListener {
    /** Every server message, after it was applied. type = the "t" field. */
    default void onMessage(String type, JsonObject msg) {}
    default void onChat(ChatLine line) {}
    default void onEvent(BotEvent event) {}
    default void onLog(LogLine line) {}
    default void onPhoto(Photo photo) {}
    /** Only newly added (deduplicated) events. */
    default void onLedger(List<LedgerEvent> added) {}
    default void onGoal(Goal goal) {}
    default void onTask(TaskInfo task, boolean deleted) {}
    /** A bot's actionName() changed (null = became idle). */
    default void onBotAction(BotState bot, String previousAction) {}
    default void onConnection(HiveState.Connection status) {}
}
