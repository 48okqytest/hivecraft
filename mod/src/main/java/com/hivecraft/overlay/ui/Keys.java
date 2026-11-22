package com.hivecraft.overlay.ui;

import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;

/** The UI's key bindings (Options → Controls → Hivecraft). ModWorld registers its own in the same category. */
public final class Keys {
    public static final String CATEGORY = "key.categories.hivecraft";

    public final KeyBinding terminal;
    public final KeyBinding control;
    public final KeyBinding toggleHud;
    public final KeyBinding cycleFocus;
    public final KeyBinding spectate;
    public final KeyBinding economy;

    Keys() {
        terminal = reg("key.hivecraft.terminal", GLFW.GLFW_KEY_GRAVE_ACCENT);
        control = reg("key.hivecraft.control", GLFW.GLFW_KEY_H);
        toggleHud = reg("key.hivecraft.toggle_hud", GLFW.GLFW_KEY_J);
        cycleFocus = reg("key.hivecraft.cycle_focus", GLFW.GLFW_KEY_K);
        spectate = reg("key.hivecraft.spectate", GLFW.GLFW_KEY_UNKNOWN);
        economy = reg("key.hivecraft.economy", GLFW.GLFW_KEY_V);
    }

    private static KeyBinding reg(String id, int key) {
        return KeyBindingHelper.registerKeyBinding(new KeyBinding(id, InputUtil.Type.KEYSYM, key, CATEGORY));
    }
}
