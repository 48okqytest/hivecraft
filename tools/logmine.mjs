// Mine crew logs: tool use counts, error results grouped by normalized pattern, run_code snippets.
import fs from 'node:fs'; import path from 'node:path';
const dirs = ['crew/logs', 'crew/logs-archive'];
const uses = new Map(), errs = new Map(), rc = [], idTool = new Map();
const norm = (s) => s.replace(/-?\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').slice(0, 140);
for (const d of dirs) for (const f of fs.readdirSync(d)) {
  for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const c = j.message?.content; if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p.type === 'tool_use') { const n = p.name.replace('mcp__mc__', ''); uses.set(n, (uses.get(n) || 0) + 1); idTool.set(p.id, n); if (n === 'run_code') rc.push(p.input.code); }
      if (p.type === 'tool_result') {
        const t = (Array.isArray(p.content) ? p.content.map((x) => x.text || '').join(' ') : String(p.content || ''));
        const tool = idTool.get(p.tool_use_id) || '?';
        if (p.is_error || /^Error:/.test(t)) { const k = tool + ' | ' + norm(t.replace(/^Error: /, '')); errs.set(k, (errs.get(k) || 0) + 1); }
      }
    }
  }
}
const mode = process.argv[2] || 'all';
if (mode === 'uses' || mode === 'all') console.log([...uses].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('\n'));
if (mode === 'errs' || mode === 'all') console.log('\n--- errors ---\n' + [...errs].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3]) || 80).map(([k, v]) => `${v} ${k}`).join('\n'));
if (mode === 'rc') { const cnt = new Map(); for (const c of rc) { const keys = (c.match(/bot\.[a-zA-Z_]+(\.[a-zA-Z_]+)?/g) || []); for (const k of new Set(keys)) cnt.set(k, (cnt.get(k) || 0) + 1); } console.log([...cnt].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => `${v} ${k}`).join('\n')); }
if (mode === 'rcsample') { for (const c of rc.filter((_, i) => i % 25 === 0)) console.log('-----\n' + c.slice(0, 400)); }
