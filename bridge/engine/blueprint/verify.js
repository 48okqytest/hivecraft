// Compare the world with a blueprint placement: missing / wrong / in-the-way blocks.
import { Vec3 } from 'vec3';
import { classify } from './plan.js';
import { isAutoPart, stateDiff, worldState } from './states.js';

export function verifyTargets(bot, targets) {
  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const by = classify(targets, blockAt);
  const solid = targets.filter((t) => !t.air);
  const missing = by.place.filter((t) => !t.air);
  const wrongState = by.wrong.map((t) => ({ t, why: stateDiff(t, worldState(blockAt(t.x, t.y, t.z))) }));
  const wrongBlock = by.conflict.filter((t) => !t.air);
  const inTheWay = by.conflict.filter((t) => t.air);
  const okCount = by.done.filter((t) => !t.air).length;
  return { solid: solid.length, ok: okCount, missing, wrongState, wrongBlock, inTheWay, unloaded: by.unloaded, autoParts: solid.filter((t) => isAutoPart(t.name, t.props)).length };
}

export function formatVerify(v, { limit = 14 } = {}) {
  const pct = v.solid ? Math.round((v.ok * 100) / v.solid) : 100;
  const lines = [`${v.ok}/${v.solid} blocks correct (${pct}%).`];
  const show = (label, arr, fmt) => { if (!arr.length) return; lines.push(`${label} (${arr.length}): ${arr.slice(0, limit).map(fmt).join('; ')}${arr.length > limit ? '; …' : ''}`); };
  show('MISSING', v.missing, (t) => `${t.state} at ${t.x},${t.y},${t.z}`);
  show('WRONG STATE', v.wrongState, ({ t, why }) => `${t.name} at ${t.x},${t.y},${t.z}: ${why}`);
  show('WRONG BLOCK', v.wrongBlock, (t) => `want ${t.name} at ${t.x},${t.y},${t.z}, found ${t.actual}`);
  show('IN THE WAY (should be empty)', v.inTheWay, (t) => `${t.actual} at ${t.x},${t.y},${t.z}`);
  if (v.unloaded.length) lines.push(`${v.unloaded.length} blocks are in unloaded chunks: go closer and verify again.`);
  return lines.join('\n');
}

export const verifyOk = (v) => !v.missing.length && !v.wrongState.length && !v.wrongBlock.length && !v.inTheWay.length && !v.unloaded.length;
