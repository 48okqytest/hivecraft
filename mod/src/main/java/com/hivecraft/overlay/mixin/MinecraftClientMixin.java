package com.hivecraft.overlay.mixin;

import com.hivecraft.overlay.world.BotIndex;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Forces the vanilla outline (glow) shader on bot players, so they glow in their colour through walls. */
@Mixin(MinecraftClient.class)
public abstract class MinecraftClientMixin {
    @Inject(method = "hasOutline", at = @At("HEAD"), cancellable = true)
    private void hivecraft$botOutline(Entity entity, CallbackInfoReturnable<Boolean> cir) {
        if (BotIndex.glows(entity)) cir.setReturnValue(true);
    }
}
