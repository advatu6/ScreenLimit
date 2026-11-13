'use strict';
/*
 * End-to-end check with real browsers: two people register, enter the world,
 * meet on the same island, exchange an encrypted private message, one opens a
 * stall that the admin approves, and the admin switches a holiday on.
 * Needs Playwright (not a dependency of the server):  node e2e/world-e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const shots = process.env.SHOTS || '';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-e2e-'));
  const { server, stop } = createApp({ dataDir: dir, worldFile: path.join(__dirname, '..', '..', 'world', 'index.html') });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const step = (s) => console.log('  ✓ ' + s);

  async function join(username) {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 860 } });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.abort());
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(username + ': ' + e));
    await p.goto(base + '/');
    await p.click('#tReg');
    await p.fill('#username', username); await p.fill('#password', 'secret12'); await p.check('#agree');
    await p.click('#go');
    await p.waitForSelector('#codeCard:not([hidden])');
    const code = await p.textContent('#code');
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await p.click('#enter');
    await p.waitForURL('**/world');
    // the world's own rules screen, then the character screen
    await p.click('.check >> nth=0'); await p.click('.check >> nth=1'); await p.click('text=אני מאשר/ת, אפשר להיכנס');
    await p.waitForFunction(() => typeof C !== 'undefined' && C.ready && !!M.uid, null, { timeout: 15000 });
    await p.evaluate(() => closeSheet());
    return { p, ctx, id: await p.evaluate(() => M.uid) };
  }

  try {
    const admin = await join('Maya');
    const ann = await join('ann');
    step('two people registered, got recovery codes, accepted the rules and entered the world');
    assert.equal(await admin.p.evaluate(() => M.owner), true);
    assert.equal(await ann.p.evaluate(() => M.owner), false);
    assert.equal(await ann.p.evaluate(() => !$('bAdmin').hidden), false, 'only the admin sees the admin button');
    step('the first account is the admin, the second is not');

    // they see each other on the plaza, and chat reaches the other side
    await admin.p.waitForFunction(() => peers.size === 1, null, { timeout: 8000 });
    await ann.p.waitForFunction(() => peers.size === 1, null, { timeout: 8000 });
    await ann.p.fill('#chatInput', 'שלום מאיה'); await ann.p.click('#chat button[type=submit]');
    await admin.p.waitForFunction(() => [...peers.values()].some((q) => q.say === 'שלום מאיה'), null, { timeout: 8000 });
    assert.equal(await admin.p.evaluate((id) => [...peers.values()][0].uid === id, ann.id), true, 'the peer carries the real account id');
    step('they see each other on the plaza and a chat message arrives');
    await ann.p.evaluate(() => travel('beach', 'plaza'));
    await admin.p.waitForFunction(() => peers.size === 0, null, { timeout: 8000 });
    await ann.p.evaluate(() => travel('plaza', 'beach'));
    await admin.p.waitForFunction(() => peers.size === 1, null, { timeout: 8000 });
    step('leaving for another island hides you from the first one, coming back shows you again');

    // an encrypted private message, both ways
    await ann.p.evaluate((id) => openDM(id, 'מאיה'), admin.id);
    await ann.p.waitForSelector('.sheet form button:not([disabled])', { timeout: 10000 });
    await ann.p.fill('.sheet form input', 'היי, זו הודעה פרטית'); await ann.p.click('.sheet form button');
    await admin.p.waitForFunction(() => !$('fDot').hidden, null, { timeout: 8000 });
    await admin.p.evaluate((id) => openDM(id, dmName(id)), ann.id);
    await admin.p.waitForFunction(() => [...document.querySelectorAll('.dm.them')].some((e) => e.textContent === 'היי, זו הודעה פרטית'), null, { timeout: 8000 });
    await admin.p.fill('.sheet form input', 'קיבלתי!'); await admin.p.click('.sheet form button');
    await ann.p.waitForFunction(() => [...document.querySelectorAll('.dm.them')].some((e) => e.textContent === 'קיבלתי!'), null, { timeout: 8000 });
    const stored = fs.readFileSync(path.join(dir, 'luma.db')).toString('utf8') + (fs.existsSync(path.join(dir, 'luma.db-wal')) ? fs.readFileSync(path.join(dir, 'luma.db-wal')).toString('utf8') : '');
    assert.ok(!stored.includes('הודעה פרטית') && !stored.includes('קיבלתי'), 'the server never holds the message text');
    step('a private message goes both ways, live, and the server stores only ciphertext');
    await admin.p.evaluate(() => closeSheet()); await ann.p.evaluate(() => closeSheet());

    // a stall: application with a photo, approval by the admin, live for the other
    await ann.p.evaluate(() => openApply());
    await ann.p.fill('.sec >> nth=0 >> input', 'הקרמיקה של אן');
    await ann.p.click('.tabs >> text=אומנות ויצירה');
    await ann.p.fill('.sec >> nth=0 >> textarea', 'כלים בעבודת יד, כל אחד שונה מהשני.');
    await ann.p.setInputFiles('.sec >> nth=1 >> input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await ann.p.waitForSelector('.sec >> nth=1 >> .thumb img', { timeout: 8000 });
    await ann.p.fill('.prow >> nth=0 >> input >> nth=0', 'ספל'); await ann.p.fill('.prow >> nth=0 >> input >> nth=1', '85');
    await ann.p.fill('input[type=url]', 'https://example.com/shop');
    await ann.p.fill('input[autocomplete=name]', 'אן כהן'); await ann.p.fill('input[type=tel]', '050-1234567'); await ann.p.fill('input[type=email]', 'ann@example.com');
    await ann.p.click('text=קראתי את תנאי ההשתתפות'); await ann.p.fill('.sec >> nth=5 >> input.field', 'אן כהן');
    await ann.p.click('text=לשלוח לאישור');
    await admin.p.waitForFunction(() => M.apps.length === 1 && !$('aDot').hidden, null, { timeout: 8000 });
    assert.equal(await ann.p.evaluate(() => M.stalls.length), 0, 'not open before approval');
    await admin.p.evaluate(() => openAdmin());
    await admin.p.click('text=לאשר ולפתוח את הדוכן');
    await ann.p.waitForFunction(() => M.stalls.length === 1 && M.mine && M.mine.status === 'approved', null, { timeout: 8000 });
    const img = await ann.p.evaluate(() => fetch(assetUrl(M.stalls[0].imgs[0])).then((r) => [r.status, r.headers.get('content-type')]));
    assert.deepEqual(img, [200, 'image/jpeg']);
    assert.equal(await ann.p.evaluate(() => M.stalls[0].phone), '', 'private details are not published');
    step('a stall application with a photo, approved by the admin, appears for everyone');
    await admin.p.evaluate(() => closeSheet());

    // a holiday, switched on by the admin, appears live for the other
    await admin.p.evaluate(() => openAdmin()); await admin.p.click('.tabs >> text=אירועים');
    await admin.p.click('.quest:has-text("חנוכה") >> text=להפעיל');
    await ann.p.waitForFunction(() => EV.on && EV.id === 'hanukkah' && !$('evChip').hidden, null, { timeout: 8000 });
    step('the admin switches Hanukkah on and the other player sees it at once');
    if (shots) { await ann.p.evaluate(() => { closeSheet(); me.x = 520; me.y = 640; }); await ann.p.waitForTimeout(600); await ann.p.screenshot({ path: path.join(shots, 'e2e-ann.png') }); }

    // progress is saved to the account and survives a fresh browser
    await ann.p.evaluate(() => { S.coins = 777; S.name = 'אן'; persist(); clearTimeout(cloudTimer); return cloudFlush(); });
    await ann.p.waitForFunction(() => !cloudBusy && !cloudDirty);
    await ann.ctx.close();
    const ctx2 = await browser.newContext({ viewport: { width: 430, height: 860 } });
    await ctx2.route('https://fonts.googleapis.com/**', (r) => r.abort());
    const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push('ann2: ' + e));
    await p2.goto(base + '/'); await p2.fill('#username', 'ANN'); await p2.fill('#password', 'secret12'); await p2.click('#go');
    await p2.waitForURL('**/world');
    await p2.waitForFunction(() => S.coins === 777 && S.name === 'אן' && S.termsV === GT_V, null, { timeout: 10000 });
    step('progress and the accepted rules come back after logging in from a new browser');

    // suspension is real: the socket drops and the account cannot come back
    await admin.p.evaluate((id) => setBan(id, 'אן', true), ann.id);
    await p2.waitForSelector('text=החשבון הזה הושעה', { timeout: 8000 });
    await p2.reload(); await p2.waitForSelector('text=החשבון הזה הושעה', { timeout: 8000 });
    step('a suspended account is disconnected at once and stays out');

    // logging out returns to the login page
    await admin.p.evaluate(() => closeSheet());
    await admin.p.click('#bMenu'); await admin.p.click('#sideItems >> text=התנתקות');
    await admin.p.waitForURL(base + '/');
    await admin.p.goto(base + '/world'); await admin.p.waitForURL(base + '/');
    step('logging out works, and the world is closed without a login');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('\nall end-to-end checks passed');
  } catch (e) {
    const where = ((e && e.stack) || '').split('\n').find((l) => l.includes('world-e2e.js')) || '';
    console.error('\nFAILED:', e && e.message ? e.message.split('\n').slice(0, 6).join('\n') : e, '\n' + where.trim(), '\npage errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close(); await stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
})();
