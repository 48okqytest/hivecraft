// Doors for walking bots. mineflayer-pathfinder treats every door (even an open one) as a solid wall and its
// built-in canOpenDoors only toggles fence gates blindly. Here:
//  - path planning treats wooden doors and fence gates as walkable cells, straight moves only (a diagonal move
//    through a door frame snags on the panel);
//  - while the bot is pathing, a closed door/gate just ahead is opened before it walks into it;
//  - doors the bot opened are closed again once it is a few blocks past them (keeps mobs out of houses).
// Iron doors/trapdoors need redstone (a button/lever), so they stay walls: use_block the button.
import { Vec3 } from 'vec3';

const PASSABLE = /^(?!iron_).*(_door|_fence_gate)$/;
export const isPassableDoorName = (n) => !!n && PASSABLE.test(n);

const propsOf = (b) => { try { return b.getProperties() || {}; } catch { return {}; } };
const isOpen = (b) => { const o = propsOf(b).open; return o === true || o === 'true'; };

/** Patch a Movements instance so doors/gates are planned through. */
export function patchMovements(bot, m) {
  if (m.__hiveDoors) return m;
  m.__hiveDoors = true;
  const doorAt = (x, y, z) => isPassableDoorName(bot.blockAt(new Vec3(x, y, z), false)?.name);
  const origGetBlock = m.getBlock.bind(m);
  m.getBlock = (pos, dx, dy, dz) => {
    const b = origGetBlock(pos, dx, dy, dz);
    if (b && b.name && isPassableDoorName(b.name)) {
      b.safe = true;        // walk through, never dig/break
      b.physical = false;   // can't stand on it
      b.replaceable = false;
      b.height = (pos?.y ?? 0) + dy;
    }
    return b;
  };
  const origDiag = m.getMoveDiagonal.bind(m);
  m.getMoveDiagonal = (node, dir, neighbors) => {
    const tmp = [];
    origDiag(node, dir, tmp);
    for (const mv of tmp) {
      if (doorAt(mv.x, mv.y, mv.z) || doorAt(mv.x, mv.y + 1, mv.z)) continue;
      // also don't cut a corner past a door in the start cell
      if (doorAt(node.x, node.y, node.z) || doorAt(node.x, node.y + 1, node.z)) continue;
      neighbors.push(mv);
    }
  };
  return m;
}

/** Physics-tick helper that opens doors ahead of a pathing bot and closes them behind it. Install once per bot. */
export function installDoorOpener(bot) {
  if (bot.__hiveDoorOpener) return;
  bot.__hiveDoorOpener = true;
  const opened = new Map(); // "x,y,z" -> { pos, at }
  let busy = false, tick = 0;

  const key = (p) => `${p.x},${p.y},${p.z}`;
  const lowerHalf = (b) => (/_door$/.test(b.name) && String(propsOf(b).half) === 'upper' ? bot.blockAt(b.position.offset(0, -1, 0)) || b : b);

  const use = async (b) => {
    busy = true;
    try { await bot.activateBlock(b); } catch { /* out of reach / server refused: the pathfinder will replan */ }
    finally { busy = false; }
  };

  const onTick = () => {
    if (busy || ++tick % 3) return;
    const me = bot.entity?.position;
    if (!me) return;
    const moving = bot.pathfinder?.isMoving?.();

    // 1. open a closed door/gate right ahead (or the one we're standing in)
    if (moving) {
      const yaw = bot.entity.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // mineflayer yaw: 0 = north (-z)
      const spots = [0, 0.7, 1.3].map((d) => new Vec3(Math.floor(me.x + fx * d), Math.floor(me.y + 0.1), Math.floor(me.z + fz * d)));
      for (const s of spots) for (const dy of [0, 1]) {
        const b = bot.blockAt(s.offset(0, dy, 0));
        if (!b || !isPassableDoorName(b.name) || isOpen(b)) continue;
        const lb = lowerHalf(b);
        opened.set(key(lb.position), { pos: lb.position.clone(), at: Date.now() });
        use(lb);
        return;
      }
    }

    // 2. close doors we opened once we're past them (not while standing in the doorway)
    for (const [k, d] of opened) {
      const dist = me.distanceTo(d.pos.offset(0.5, 0, 0.5));
      if (Date.now() - d.at > 30000 || dist > 6) { opened.delete(k); continue; }
      if (dist < 2.2) continue;
      const b = bot.blockAt(d.pos);
      opened.delete(k);
      if (b && isPassableDoorName(b.name) && isOpen(b)) { use(b); return; }
    }
  };
  bot.on('physicsTick', onTick);
  bot.once('end', () => bot.removeListener('physicsTick', onTick));
}
