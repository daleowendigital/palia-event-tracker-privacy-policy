// Execute the actual requester with a virtual clock; never contact the Wiki.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../pull-fish.mjs'), 'utf8');
const workflow = fs.readFileSync(require.resolve('../.github/workflows/update-fish.yml'), 'utf8');
const runner = fs.readFileSync(require.resolve('../tools/buildFishCandidate.mjs'), 'utf8');
assert.match(workflow, /contents: read/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /node-version: "20"/);
assert.match(workflow, /schedule:/); assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /contents: write|git (?:commit|push)|gh pr|deploy-pages/);
assert.ok(runner.indexOf('if (!report.validation.valid) throw') < runner.indexOf('const review ='));
assert.match(runner, /Candidate directory must be outside the working repository/);
assert.match(runner, /\['fish.json', 'docs\/fish.json', 'src\/fishVersion.ts'\]/);
console.log('PASS: workflow read-only permissions, runtime, isolation and review gate');
const start = source.indexOf('function createWikiRequester(');
const end = source.indexOf('\nconst requestWiki =', start);
assert.ok(start >= 0 && end > start);
const factory = vm.runInNewContext(source.slice(start, end) + '\ncreateWikiRequester', {
  AbortSignal, USER_AGENT: 'offline-test',
});
const success = () => ({ ok: true, json: async () => ({ complete: true }) });
const failure = (header, status = 429) => ({
  ok: false, status, statusText: 'Mock failure',
  headers: { get: () => header }, text: async () => 'Mock reason',
});
function fixture(respond) {
  let time = Date.UTC(2026, 10, 7), active = 0, maxActive = 0;
  const calls = [], waits = [], warnings = [];
  const request = factory({
    now: () => time, random: () => 0, warn: message => warnings.push(message),
    pause: async ms => { waits.push(ms); time += ms; },
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      active++; maxActive = Math.max(maxActive, active);
      calls.push({ url, time });
      try { return await respond(calls.length, url, time); }
      finally { active--; }
    },
  });
  return { request, calls, waits, warnings, maxActive: () => maxActive, advance: ms => { time += ms; } };
}
async function check(name, test) { await test(); console.log('PASS:', name); }
(async () => {
  await check('26-second header and successful recovery', async () => {
    const f = fixture(n => n === 1 ? failure('26') : success());
    assert.equal((await f.request('fish-a')).complete, true);
    assert.deepEqual(f.waits, [26000]); assert.equal(f.calls.length, 2);
  });
  await check('HTTP-date and past date', async () => {
    for (const seconds of [26, -26]) {
      const f = fixture((n, url, time) => n === 1 ? failure(new Date(time + seconds * 1000).toUTCString()) : success());
      await f.request('date'); assert.deepEqual(f.waits, [seconds > 0 ? 26000 : 1000]);
    }
  });
  await check('missing and invalid headers use finite exponential fallback', async () => {
    for (const header of [null, '', 'invalid', '-26', '1.5']) {
      const f = fixture(() => failure(header));
      await assert.rejects(f.request('fallback'), /API 429/);
      assert.equal(f.calls.length, 6);
      assert.deepEqual(f.waits, [1000, 1600, 3200, 6400, 12800]);
    }
  });
  await check('excessive server delays fail explicitly and stop queued work', async () => {
    for (const header of ['121', '9'.repeat(400), new Date(Date.UTC(2026, 10, 8)).toUTCString()]) {
      const f = fixture(() => failure(header));
      const results = await Promise.allSettled([f.request('first'), f.request('second')]);
      for (const result of results) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /120-second server-delay budget/); }
      assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
    }
  });
  await check('multiple callers share cooldown and never overlap', async () => {
    const seen = new Set();
    const f = fixture((n, url) => {
      if (!seen.has(url)) { seen.add(url); return failure('26'); }
      return success();
    });
    await Promise.all([f.request('a'), f.request('b'), f.request('c')]);
    assert.deepEqual(f.calls.map(call => call.url), ['a', 'a', 'b', 'b', 'c', 'c']);
    assert.deepEqual(f.waits, [26000, 1000, 26000, 1000, 26000]);
    assert.equal(f.maxActive(), 1);
  });
  await check('exhausted cooldown also applies to next queued caller', async () => {
    const f = fixture((n, url) => url === 'limited' ? failure('26') : success());
    const results = await Promise.allSettled([f.request('limited'), f.request('next')]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
    assert.equal(f.calls[6].time - f.calls[5].time, 26000);
  });
  await check('non-429 HTTP and network failures recover', async () => {
    for (const network of [false, true]) {
      const f = fixture(n => {
        if (n === 1) { if (network) throw new Error('network failure'); return failure('26', 503); }
        return success();
      });
      await f.request('transient'); assert.deepEqual(f.waits, [1000]);
    }
  });
  await check('aggregate sleeping and elapsed budgets stop requests', async () => {
    const f = fixture(() => failure('120'));
    await assert.rejects(f.request('first'), /API 429/);
    await assert.rejects(f.request('second'), /execution budget exceeded/);
    assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 600000);
    assert.equal(f.calls.length, 6);
    const elapsed = fixture(success); elapsed.advance(1200000);
    await assert.rejects(elapsed.request('late'), /execution budget exceeded/);
    assert.equal(elapsed.calls.length, 0);
  });
  console.log('All Wiki pacing checks passed; no live HTTP or real retry waits.');
})().catch(error => { console.error(error); process.exitCode = 1; });
