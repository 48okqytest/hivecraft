// Offline test of @mention routing: parser, Store routing/visibility, and BotManager interrupt with the mock engine.
//   node test/chat-route-test.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Store, routeMentions } from '../bridge/hub/store.js';
import { BotManager } from '../bridge/hub/botmanager.js';
import * as mock from './hub-mock-engine.mjs';

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fails++; };
const BOTS = ['Stella', 'Colin', 'Flint'];
const canon = (n) => BOTS.find((b) => b.toLowerCase() === String(n).toLowerCase()) || null;

// ---------- 1) parser ----------
const cases = [
  ['@Stella hi', 'Stella', 'hi'],
  ['hi @stella', 'Stella', 'hi @stella'],
  ['@Stella: build a house', 'Stella', 'build a house'],
  ['@stella, come here', 'Stella', 'come here'],
  ['hey @STELLA!', 'Stella', 'hey @STELLA!'],
  ["@Stella's house is nice", 'Stella', "@Stella's house is nice"], // no separator after the name: not a leading address
  ['@Stella @Colin follow me', 'Stella,Colin', 'follow me'],
  ['@Stella, @colin: follow me', 'Stella,Colin', 'follow me'],
  ['ok @Stella and @Colin, meet at base', 'Stella,Colin', 'ok @Stella and @Colin, meet at base'],
  ['@Stella hi @stella again', 'Stella', 'hi @stella again'],
  ['@all hi', 'all', 'hi'],
  ['@Stella @all listen', 'all', 'listen'],
  ['@everyone dinner', 'all', 'dinner'],
  ['hello team', 'all', 'hello team'],
  ['mail me at bob@Stella.com', 'all', 'mail me at bob@Stella.com'], // scrub-ok (fictional address)
  ['@Bob hi', 'all', '@Bob hi'], // not a bot: broadcast, text untouched
  ['@Bob @Stella hi', 'Stella', '@Bob @Stella hi'], // leading run contains a non-bot: don't strip
  ['@Stella', 'Stella', '@Stella'], // nothing after the address: keep text
];
for (const [inp, to, text] of cases) {
  const r = routeMentions(inp, canon);
  ok(r.to === to && r.text === text, `parse ${JSON.stringify(inp)} -> to=${r.to} text=${JSON.stringify(r.text)}`);
}

// ---------- 2) store routing + visibility ----------
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-route-')));
for (const b of BOTS) store.botRoles[b] = 'worker';
const seen = (name, m) => store._forName(name, m.id - 1).some((x) => x.id === m.id);
let m = store.addMessage({ from: 'robin_mc', to: 'all', text: 'hi @stella!' });
ok(m.to === 'Stella' && m.text === 'hi @stella!', `human "hi @stella!" -> to=${m.to}`);
ok(seen('Stella', m) && !seen('Colin', m) && !seen('Flint', m), 'only Stella sees it in check_messages');
ok(store.unread('Colin', m.id - 1) === 0 && store.unread('Stella', m.id - 1) === 1, 'unread counts follow routing');
m = store.addMessage({ from: 'robin_mc', to: 'all', text: '@Stella @Colin go mine' });
ok(m.to === 'Stella,Colin' && seen('Stella', m) && seen('Colin', m) && !seen('Flint', m), 'two mentions -> only those two');
m = store.addMessage({ from: 'Robin', to: 'all', text: 'everyone to base' });
ok(m.to === 'all' && BOTS.every((b) => seen(b, m)), 'no mention -> everyone');
m = store.addMessage({ from: 'Robin', to: 'all', text: '@all to base' });
ok(m.to === 'all' && m.text === 'to base', '@all -> everyone');
m = store.addMessage({ from: 'Flint', to: 'all', text: 'thanks @Stella' });
ok(m.to === 'all', 'bot messages are not re-routed by mentions');
m = store.addMessage({ from: 'Robin', to: 'Flint', text: 'tell @Stella hi' });
ok(m.to === 'Flint', 'explicit recipient from the dashboard is kept');
m = store.addMessage({ from: 'system', to: 'all', text: '@Stella event' });
ok(m.to === 'all', 'system messages untouched');

// ---------- 3) BotManager: MC chat -> routing + interrupt only the addressed bot ----------
const store2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-route2-')));
const bots = new BotManager({ engine: mock, store: store2 });
for (const b of BOTS) await bots.ensure(b, 'worker');
const runs = Object.fromEntries(BOTS.map((b) => [b, bots.act(b, { action: 'wait', args: { seconds: 4 } })]));
await new Promise((r) => setTimeout(r, 300));
const t0 = Date.now();
// every online bot hears the same chat line (dedupe -> one message)
for (const b of BOTS) mock.registry.get(b).say('robin_mc', '@Stella: come here');
const stellaRes = await runs.Stella; const stellaDt = Date.now() - t0;
const res = Object.fromEntries(await Promise.all(BOTS.map(async (b) => [b, await runs[b]])));
const msgs = store2.messages.filter((x) => x.from === 'robin_mc');
ok(msgs.length === 1 && msgs[0].to === 'Stella' && msgs[0].text === 'come here', `chat ingested once, to=${msgs[0]?.to} text=${JSON.stringify(msgs[0]?.text)}`);
ok(!res.Stella.ok && /robin_mc \(human\).*come here/.test(res.Stella.error) && stellaRes === res.Stella && stellaDt < 2000, `Stella interrupted in ${stellaDt}ms: ${res.Stella.error}`);
ok(res.Colin.ok && res.Flint.ok, 'Colin and Flint NOT interrupted (their waits finished)');

// two mentions mid-sentence
const runs2 = Object.fromEntries(BOTS.map((b) => [b, bots.act(b, { action: 'wait', args: { seconds: 3 } })]));
await new Promise((r) => setTimeout(r, 300));
mock.registry.get('Flint').say('robin_mc', 'ok @colin and @FLINT, follow me');
const res2 = Object.fromEntries(await Promise.all(BOTS.map(async (b) => [b, await runs2[b]])));
const last = store2.messages.filter((x) => x.from === 'robin_mc').at(-1);
ok(last.to === 'Colin,Flint' && last.text === 'ok @colin and @FLINT, follow me', `mid-sentence mentions -> to=${last.to}, text intact`);
ok(!res2.Colin.ok && !res2.Flint.ok && res2.Stella.ok, 'only Colin and Flint interrupted');

// no mention -> everyone interrupted (old behaviour)
const runs3 = Object.fromEntries(BOTS.map((b) => [b, bots.act(b, { action: 'wait', args: { seconds: 3 } })]));
await new Promise((r) => setTimeout(r, 300));
mock.registry.get('Colin').say('robin_mc', 'dinner time');
const res3 = await Promise.all(BOTS.map((b) => runs3[b]));
ok(res3.every((r) => !r.ok), 'no mention -> everyone interrupted');

// a bot's own chat line is never ingested
mock.registry.get('Colin').say('Stella', '@Colin hi');
ok(store2.messages.filter((x) => x.from === 'Stella').length === 0, 'bot chat not re-ingested');

await bots.shutdown(); store.close(); store2.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
