package com.hivecraft.overlay.mixin;

import com.hivecraft.overlay.world.BotIndex;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Outline colour of bot players = their team colour from the bridge. */
@Mixin(Entity.class)
public abstract class EntityMixin {
    @Inject(method = "getTeamColorValue", at = @At("HEAD"), cancellable = true)
    private void hivecraft$botColor(CallbackInfoReturnable<Integer> cir) {
        Entity self = (Entity) (Object) this;
        if (BotIndex.glows(self)) cir.setReturnValue(BotIndex.colorOf(self));
    }
}
