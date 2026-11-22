// print the tool_use input + result text for results matching a regex, plus the previous status/inventory seen
import fs from 'node:fs'; import path from 'node:path';
const re = new RegExp(process.argv[2]); const max = Number(process.argv[3] || 4);
let shown = 0;
for (const d of ['crew/logs', 'crew/logs-archive']) for (const f of fs.readdirSync(d)) {
  const idIn = new Map(); let lastInv = '';
  for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    for (const p of j.message?.content || []) {
      if (p.type === 'tool_use') idIn.set(p.id, p.name.replace('mcp__mc__', '') + ' ' + JSON.stringify(p.input).slice(0, 300));
      if (p.type === 'tool_result') {
        const t = Array.isArray(p.content) ? p.content.map((x) => x.text || '').join(' ') : String(p.content || '');
        const m = t.match(/"inventory":\[[^\]]*\]/); if (m) lastInv = m[0].slice(0, 600);
        if (re.test(t) && shown < max) { shown++; console.log(`== ${f}\n> ${idIn.get(p.tool_use_id)}\n< ${t.slice(0, 700)}\n  lastInv: ${lastInv}\n`); }
      }
    }
  }
}
