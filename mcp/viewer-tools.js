// Viewer tools for mc-mcp.js: view, team_map, photo_share, photo_view + helpers for image results.
// Tools return a string or { text, images:[{ data(base64 png), mimeType }] }; mc-mcp turns images into MCP image content.

export function makeViewerTools({ BOT, URL_BASE, get, post, enc, trunc, PLAYER = 'the player' }) {
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
  const str = (description) => ({ type: 'string', description });
  const num = (description) => ({ type: 'number', description });
  const bool = (description) => ({ type: 'boolean', description });
  const xyzOk = (a) => a.x != null && a.z != null;

  function fmtViewMeta(r) {
    const m = r.meta || {};
    const ents = (m.entities || []).filter((e) => e.kind !== 'other').slice(0, 8).map((e) => `${e.name}@${e.x},${e.y},${e.z}`);
    const g = m.ghosts;
    return [`📷 ${r.id ? `photo ${r.id}` : 'view'} — ${r.caption || m.view || ''}`,
      m.origin && m.size ? `area x ${m.origin.x}..${m.origin.x + m.size.x - 1}, y ${m.origin.y}..${m.origin.y + m.size.y - 1}, z ${m.origin.z}..${m.origin.z + m.size.z - 1}` : '',
      ents.length ? `in view: ${ents.join(', ')}` : '', m.chests ? `${m.chests} containers nearby` : '',
      g ? `ghost blocks: ${g.total} (to place ${g.ok}, already placed ${g.done}, CONFLICT ${g.conflict}${g.clipped ? `, outside view ${g.clipped}` : ''})${g.conflicts && g.conflicts.length ? ' — in the way: ' + g.conflicts.slice(0, 8).map((c) => `${c.actual}@${c.x},${c.y},${c.z}`).join(' ') : ''}` : '',
    ].filter(Boolean).join('\n');
  }

  /** POST /bots/:BOT/view (counts against this agent's render rate limit) -> {text, images} */
  async function renderReq(body) {
    const r = await post(`/bots/${enc(BOT)}/view`, { agent: BOT, ...body }, 90000);
    return { id: r.id, text: fmtViewMeta(r), images: r.png ? [{ data: r.png, mimeType: 'image/png' }] : [] };
  }

  /** Auto picture of the bot's surroundings (used when an action fails because the bot is stuck). */
  async function lookHere(caption) {
    return renderReq({ camera: { mode: 'orbit', distance: 9, elevation: 50 }, toggles: { highlight: true }, radius: 16, caption });
  }

  function viewBody(a) {
    const mode = a.mode || 'first_person';
    const has = (k) => a[k] != null && a[k] !== '';
    const pt = xyzOk(a) ? { x: Number(a.x), y: has('y') ? Number(a.y) : undefined, z: Number(a.z) } : undefined;
    const look = has('look_x') && has('look_z') ? { x: Number(a.look_x), y: has('look_y') ? Number(a.look_y) : undefined, z: Number(a.look_z) } : undefined;
    const camera = { mode };
    let center;
    if (has('yaw')) camera.yaw = Number(a.yaw);
    if (has('pitch')) camera.pitch = Number(a.pitch);
    if (has('fov')) camera.fov = Number(a.fov);
    if (has('zoom')) camera.zoom = Number(a.zoom);
    if (mode === 'first_person') {
      // your own eyes; yaw/pitch turn the head (pitch alone keeps your facing)
    } else if (mode === 'free') {
      // camera at x,y,z aimed at look_x/y/z, else yaw/pitch (default: facing north, 20 degrees down)
      if (!pt) throw new Error('free camera needs x,y,z (the camera position) plus look_x/look_y/look_z or yaw/pitch');
      camera.pos = { ...pt, y: pt.y ?? 80 };
      if (look) camera.look_at = { ...look, y: look.y ?? camera.pos.y };
      else { camera.yaw ??= 180; camera.pitch ??= 20; }
      center = look || camera.pos;
    } else {
      // orbit / map / slice: target = look_x/y/z if given, else x,y,z, else you
      const tp = look || pt;
      if (tp) { center = tp; camera.target = { x: tp.x + 0.5, y: tp.y != null ? tp.y + 0.5 : undefined, z: tp.z + 0.5 }; }
      if (has('angle')) camera.angle = Number(a.angle);
      else if (a.from != null) { if (/^-?\d+(\.\d+)?$/.test(String(a.from))) camera.angle = Number(a.from); else camera.from = String(a.from).toLowerCase().replace(/[\s_-]/g, ''); }
      if (has('distance')) camera.distance = Number(a.distance);
      if (has('elevation')) camera.elevation = Number(a.elevation);
      if (mode === 'slice' && has('slice_y')) camera.y = Number(a.slice_y);
      if (mode === 'map' && has('slice_y')) camera.slice_y = Number(a.slice_y);
    }
    const toggles = {};
    for (const k of ['grid', 'xray', 'labels', 'highlight', 'night_vision', 'waypoints']) if (a[k] != null) toggles[k] = a[k] === true || a[k] === 'true';
    return { camera, toggles, center, radius: a.radius != null ? Number(a.radius) : undefined, caption: a.caption };
  }

  async function getPng(p) {
    const res = await fetch(URL_BASE + p, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`photo not found (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  }

  /** a teammate shared a photo -> {text, image} to attach to this tool result (one per result), else null */
  async function sharedPhoto() {
    try {
      const r = await get(`/photos/inbox/${enc(BOT)}`, 5000);
      if (!r || !r.item || !r.png) return null;
      const it = r.item;
      return { text: `📷 ${it.from} shared photo ${it.id}${it.note ? `: "${trunc(it.note, 200)}"` : ''}${it.photo?.caption ? ` (${trunc(it.photo.caption, 120)})` : ''}${r.pending ? ` — ${r.pending} more waiting` : ''}`, image: { data: r.png, mimeType: 'image/png' } };
    } catch { return null; }
  }

  /** engine action result {text, view:{...}} -> {text, images} (renders the view); other results unchanged */
  async function expandActionResult(res) {
    if (typeof res === 'string' && res.startsWith('{') && res.includes('"view"')) { try { res = JSON.parse(res); } catch { return res; } }
    if (!res || typeof res !== 'object' || (typeof res.text !== 'string' && !res.view)) return res;
    if (!res.view || typeof res.view !== 'object') return res.text;
    try {
      const v = await renderReq(res.view);
      let extra = '';
      // {share:{to, note}}: e.g. a finished build is sent to the player automatically
      if (res.share && v.id) {
        try { const s = await post('/photos/share', { from: BOT, to: res.share.to || PLAYER, id: v.id, note: res.share.note || '' }); extra = `\n(photo ${v.id} shared with ${(s.to || [res.share.to]).join(', ')})`; } catch { /* sharing is best-effort */ }
      }
      return { text: `${res.text || ''}\n${v.text}${extra}`.trim(), images: v.images };
    } catch (e) {
      return `${res.text || ''}\n(preview image unavailable: ${e.message})`.trim();
    }
  }

  const tools = [
    {
      name: 'view',
      description: 'LOOK at the world: a real Minecraft-textured 3D picture returned as an IMAGE. ANY ANGLE: mode "orbit" = camera circling any point x,y,z with angle (0-360: 0 = camera south of it, 90 = west, 180 = north, 270 = east) + elevation (-89 = from BELOW looking up at a cave ceiling/bridge underside, 0 = level, 38 = default, 89 = straight down) + distance; or mode "free" = camera ANYWHERE at x,y,z aimed at look_x/look_y/look_z, or with yaw (F3: 0 south, 90 west, 180 north, 270/-90 east) + pitch (-90 = up .. 90 = down). Other modes: first_person (your eyes; default; yaw/pitch turn the head), map (top-down, north up; slice_y cuts at a height to see inside buildings/caves), slice (cutaway hiding everything above slice_y). orbit/map/slice look at look_x/y/z (or x,y,z; default: you). zoom (2 = twice as close) or fov (20-110) shows details. Toggles: grid (coordinates), xray (see through stone: ores, caves, chests), highlight (label mobs, teammates, chests), night_vision, waypoints. radius = area half-size (default 24-32, max 48). Every picture goes into the team album ' + PLAYER + ' watches (photo_share to send one). Use it freely (up to ~20/min): look on arrival, before/after building, when stuck or lost, instead of inspecting blocks with run_code.',
      inputSchema: obj({
        mode: { type: 'string', enum: ['first_person', 'orbit', 'map', 'slice', 'free'], description: 'camera mode (default first_person). orbit = around a point from any angle; free = camera anywhere' },
        x: num('orbit/map/slice: point to look at. free: camera position'), y: num('y of that point'), z: num('z of that point'),
        look_x: num('target x: free = what the camera aims at; orbit/map/slice = the point to look at (overrides x,y,z)'), look_y: num('target y'), look_z: num('target z'),
        angle: num('orbit: where the camera stands around the target, degrees, any value: 0 = south of it, 90 = west, 180 = north, 270 = east (clockwise seen from above)'),
        elevation: num('orbit: camera height angle -89..89 (-89 = below the target looking UP, 0 = level, 89 = straight down; default 38)'),
        distance: num('orbit: camera distance from the target in blocks (default ~25-40)'),
        yaw: num('F3 yaw degrees, any value (0 south, 90 west, 180 north, 270/-90 east): direction the camera looks (free/first_person; orbit: angle = yaw-180; map: rotates the map so that heading is up)'),
        pitch: num('F3 pitch -90..90 (-90 = straight UP, 0 level, 90 = straight DOWN) for free/first_person; orbit: same as elevation'),
        zoom: num('zoom factor 0.5-8 (2 = twice as close, narrower view; map: smaller area)'), fov: num('field of view degrees 20-110 (default 70; smaller = zoom in)'),
        from: str('orbit: shortcut for angle: south, north, east, west, southeast, ... or degrees'),
        slice_y: num('slice/map: hide blocks above this y'), radius: num('area half-size, 8-48'),
        grid: bool('coordinate grid + labels'), xray: bool('see ores/caves/chests through stone'), highlight: bool('outline + label mobs, teammates, chests, items'),
        night_vision: bool('full brightness'), waypoints: bool('show team waypoints'), labels: bool('name labels (default on)'),
        caption: str('optional caption saved with the photo'),
      }),
      run: async (a) => renderReq(viewBody(a)),
    },
    {
      name: 'team_map',
      description: 'IMAGE of the whole team area from above: terrain around every bot, explored chunks (grey), all waypoints (pink stars) and every teammate\'s position and facing. Use it to plan routes, split up exploration and find each other. Shares the view rate limit (~20 images/min).',
      inputSchema: obj({ radius: num('terrain radius around each bot, 16-160 (default 96)') }),
      run: async (a) => {
        const r = await post('/team_map', { agent: BOT, radius: a.radius }, 90000);
        const b = r.meta?.bounds || {};
        return { text: `🗺 team map ${r.id || ''} — x ${b.minX}..${b.maxX}, z ${b.minZ}..${b.maxZ} (north up); bots: ${(r.meta?.bots || []).join(', ')}; ${r.meta?.waypoints ?? 0} waypoints`, images: r.png ? [{ data: r.png, mimeType: 'image/png' }] : [] };
      },
    },
    {
      name: 'photo_share',
      description: 'Send a photo to teammate(s) or "all": they get the image with their next tool result, and ' + PLAYER + ' sees it on the dashboard. id defaults to your latest photo. Add a short note ("iron left of the lava pool").',
      inputSchema: obj({ to: str('"Flint", "Flint,Wren" or "all"'), id: str('photo id (default: your latest)'), note: str('one short line') }, ['to']),
      run: async (a) => { const r = await post('/photos/share', { from: BOT, to: a.to, id: a.id, note: a.note }); return `Shared photo ${r.id} with ${r.to.join(', ')}.`; },
    },
    {
      name: 'photo_view',
      description: 'Look at a saved photo by id (returns the IMAGE), e.g. one a teammate mentioned. Without id: lists the latest team photos (id, mode, time, caption) as text.',
      inputSchema: obj({ id: str('photo id like "Ash-1763700000000"'), agent: str('without id: only list this teammate\'s photos') }),
      run: async (a) => {
        if (!a.id) {
          const l = await get(`/photos?limit=12${a.agent ? `&agent=${enc(a.agent)}` : ''}`);
          return (l || []).length ? l.map((p) => `${p.id} [${p.mode || '?'}] ${new Date(p.ts).toISOString().slice(11, 19)} ${p.caption || ''}`).join('\n') : 'No photos yet.';
        }
        const meta = await get(`/photos/${enc(a.id)}`);
        const png = await getPng(`/photos/${enc(a.id)}.png`);
        return { text: `📷 ${meta.id} by ${meta.agent}: ${meta.caption || meta.mode || ''}`, images: [{ data: png, mimeType: 'image/png' }] };
      },
    },
  ];

  return { tools, renderReq, sharedPhoto, expandActionResult, viewBody, lookHere };
}
