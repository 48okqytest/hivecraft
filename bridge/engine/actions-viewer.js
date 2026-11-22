// Viewer actions (worker side). Wired into the engine registry by actions.js as VIEWER_ACTIONS.
// The image tools (view, team_map, photo_*) live in mcp/mc-mcp.js + the bridge (rendering needs the main process);
// they fetch world data through the internal `_snapshot` action below.
import { takeSnapshot } from './snapshot.js';

const int = (d) => ({ type: 'integer', description: d });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: true });

const CH = [
  [/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)/, '~'], [/^lava/, 'L'], [/(chest|barrel|shulker_box)$/, 'C'],
  [/^(crafting_table|furnace|blast_furnace|smoker)$/, 'F'], [/_bed$/, 'B'], [/_log$|_wood$|_stem$|hyphae$/, 'T'], [/_leaves$/, '*'],
  [/^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mud|moss_block|farmland|dirt_path|mycelium)$/, '.'], [/^(sand|red_sand|gravel|suspicious_)/, ':'],
  [/(snow|ice)/, 's'], [/_ore$|^ancient_debris$/, 'o'], [/(planks|_stairs|_slab|_fence|_door|_trapdoor|glass|bricks|wool|_wall)/, '+'],
  [/(stone|deepslate|granite|diorite|andesite|tuff|calcite|cobble|basalt|netherrack|blackstone|bedrock|terracotta)/, '#'],
  [/(flower|poppy|dandelion|tulip|orchid|allium|bluet|daisy|cornflower|lily|bush|sapling|wheat|carrots|potatoes|beetroots|sugar_cane|cactus|pumpkin|melon)/, 'f'],
];
const charFor = (k) => { const n = k.split('[')[0]; for (const [re, ch] of CH) if (re.test(n)) return ch; return '%'; };
const hChar = (d) => (d === 0 ? '0' : d > 0 ? (d > 9 ? '^' : String(d)) : (d < -9 ? 'v' : 'abcdefghi'[-d - 1]));

export const VIEWER_ACTIONS = [
  {
    name: '_snapshot',
    internal: true, quick: true, rawResult: true, timeoutMs: 20000,
    description: 'internal: dump blocks/light/entities around a point for the viewer',
    params: obj({}),
    async run(ctx, args = {}) {
      return takeSnapshot(ctx.bot, { ...args, signal: ctx.signal });
    },
  },
  {
    name: 'survey',
    quick: true, timeoutMs: 15000,
    description: 'FREE text map (no image, cheap): a top-down grid around you, north at the top, x grows to the right. Shows what is on top of each column (# stone, . grass/dirt, T log, * leaves, ~ water, L lava, o ore, C chest, F furnace/table, B bed, + built blocks, s snow/ice, : sand/gravel, f plants) plus a height grid relative to your feet (0 same level, 1-9 higher, a-i 1-9 lower, ^/v more). @ = you, P = player, ! = hostile mob, m = animal. Underground it maps the level you stand on. Use it before view() when you just need the layout.',
    params: obj({ radius: int('half-size of the map, 4-20 (default 10)') }),
    async run(ctx, { radius = 10 } = {}) {
      const { bot } = ctx;
      const r = Math.max(4, Math.min(20, Math.round(radius)));
      const p = bot.entity.position.floored();
      // underground? (solid block within 24 above the head) -> map the current level instead of the sky surface
      let roofed = false;
      for (let y = p.y + 2; y < p.y + 26; y++) { const b = bot.blockAt(p.offset(0, y - p.y, 0)); if (b && b.boundingBox === 'block') { roofed = true; break; } }
      const s = await takeSnapshot(bot, { center: p, radius: r, surface: true, top: roofed ? p.y + 1 : p.y + 60, signal: ctx.signal });
      const S = s.size.x;
      const mark = new Map();
      for (const e of s.entities) {
        const k = `${Math.floor(e.pos.x) - s.origin.x},${Math.floor(e.pos.z) - s.origin.z}`;
        const ch = e.kind === 'player' ? 'P' : e.kind === 'hostile' ? '!' : e.kind === 'animal' ? 'm' : null;
        if (ch && (!mark.has(k) || ch === '!')) mark.set(k, ch);
      }
      const rows = [], hrows = [];
      for (let z = 0; z < S; z++) {
        let row = '', hrow = '';
        for (let x = 0; x < S; x++) {
          const i = z * S + x;
          const isMe = x === r && z === r;
          const m = mark.get(`${x},${z}`);
          if (s.height[i] === -32768) { row += isMe ? '@' : '?'; hrow += '?'; continue; }
          row += isMe ? '@' : m || charFor(s.palette[s.top[i]]);
          hrow += hChar(s.height[i] - (p.y - 1));
        }
        rows.push(row); hrows.push(hrow);
      }
      const ents = s.entities.filter((e) => e.kind !== 'item' && e.kind !== 'other').slice(0, 8).map((e) => `${e.kind === 'player' ? e.name : e.name}@${Math.floor(e.pos.x)},${Math.floor(e.pos.y)},${Math.floor(e.pos.z)}`);
      return `Survey ${roofed ? '(underground: your level)' : '(surface)'} x ${s.origin.x}..${s.origin.x + S - 1} (left→right), z ${s.origin.z}..${s.origin.z + S - 1} (top→bottom = north→south), you @ ${p.x},${p.y},${p.z}.\n` +
        `TOP BLOCKS:\n${rows.join('\n')}\nHEIGHT vs your feet (0 same, 1-9 up, a-i down):\n${hrows.join('\n')}` + (ents.length ? `\nNearby: ${ents.join(', ')}` : '');
    },
  },
];

export default VIEWER_ACTIONS;
