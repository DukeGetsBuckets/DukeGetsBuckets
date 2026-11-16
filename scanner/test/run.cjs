// End-to-end test: loads the built bookmarklet into the sample quiz page in a
// Chromium tablet viewport, checks what it detects, and exercises the AI path
// against a mocked api.anthropic.com. Run `npm run build` first.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const here = __dirname;
const outDir = process.env.QSCAN_OUT || path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

function assert(cond, msg) { if (!cond) { throw new Error('ASSERT: ' + msg); } console.log('  ok  ' + msg); }

async function main() {
  const bm = fs.readFileSync(path.join(here, '..', 'bookmarklet.txt'), 'utf8').trim();
  assert(bm.startsWith('javascript:'), 'bookmarklet starts with javascript:');
  const code = decodeURIComponent(bm.slice('javascript:'.length));

  // serve the sample page over http so localStorage / fetch behave like a real site
  const html = fs.readFileSync(path.join(here, 'sample-quiz.html'));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/quiz`;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 834, height: 1194 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Mock Claude: return one structured answer per question number found in the prompt.
  let apiCalls = 0, lastBody = null;
  await page.route('https://api.anthropic.com/**', async route => {
    apiCalls++;
    const req = route.request();
    lastBody = JSON.parse(req.postData());
    const headers = req.headers();
    if (headers['anthropic-dangerous-direct-browser-access'] !== 'true' || !headers['x-api-key']) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing headers' } }) });
    }
    const prompt = lastBody.messages[0].content.slice(lastBody.messages[0].content.indexOf('QUESTIONS ('));
    const nums = [...prompt.matchAll(/^(\d+)\. /gm)].map(m => +m[1]);
    const answers = nums.map(n => ({ n, answer: 'mock answer ' + n, option: n === 1 ? 'B' : (n === 6 ? 'B, C' : ''), confidence: n % 2 ? 'high' : 'medium', why: 'because mock ' + n }));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: lastBody.model, stop_reason: 'end_turn', stop_details: null,
      content: [{ type: 'text', text: JSON.stringify({ answers }) }], usage: { input_tokens: 1, output_tokens: 1 }
    }) });
  });

  await page.goto(url);
  await page.evaluate(code);                 // run the bookmarklet exactly as Safari would
  await page.waitForSelector('#qscan-root', { state: 'attached' });

  const qs = await page.evaluate(() => window.__qscan.state.questions.map(q => ({
    n: q.n, stem: q.stem, options: q.options.map(o => o.clean), correct: q.options.filter(o => o.correct).map(o => o.clean),
    pageAnswer: q.pageAnswer && q.pageAnswer.text, evidence: q.pageAnswer && q.pageAnswer.evidence
  })));
  console.log(JSON.stringify(qs, null, 1));

  const byStem = s => qs.find(q => q.stem.toLowerCase().includes(s.toLowerCase()));
  assert(qs.length === 8, `detected 8 questions (got ${qs.length})`);
  assert(!qs.some(q => /need help|contact us/i.test(q.stem)), 'nav/footer text ignored');
  assert(!qs.some(q => /mitochondrion is a double/i.test(q.stem)), 'reading passage ignored');

  const q1 = byStem('capital of France');
  assert(q1 && q1.options.length === 4 && q1.pageAnswer === 'Paris' && /data-correct/.test(q1.evidence), 'Q1 radios -> Paris via data-correct');
  const q2 = byStem('photosynthesis');
  assert(q2 && q2.options.length === 4 && q2.pageAnswer === 'Carbon dioxide', 'Q2 lettered list -> Carbon dioxide via JSON script');
  const q3 = byStem('largest in the Solar System');
  assert(q3 && q3.options.includes('Jupiter') && q3.pageAnswer === 'Jupiter' && /hidden input/.test(q3.evidence), 'Q3 select -> Jupiter via hidden input');
  const q4 = byStem('Solve for x');
  assert(q4 && q4.options.length === 0, 'Q4 open-answer question detected without options');
  const q5 = byStem('chemical formula for water');
  assert(q5 && q5.options.length === 4 && q5.options[1] === 'H2O' && !/A\. NaCl/.test(q5.stem), 'Q5 inline A./B./C./D. options split from stem');
  const q6 = byStem('prime numbers');
  assert(q6 && q6.correct.join(',') === '5,7', 'Q6 checkboxes -> 5 and 7 via class "correct"');
  const q7 = byStem('Great Wall');
  assert(q7 && q7.options.join(',') === 'True,False' && q7.pageAnswer === 'False', 'Q7 true/false buttons -> False via data-answer');
  const q8 = byStem('powerhouse');
  assert(q8 && q8.pageAnswer === 'Mitochondrion' && /page data/.test(q8.evidence), 'Q8 div options -> Mitochondrion via window.quizState');

  await page.screenshot({ path: path.join(outDir, 'panel-scan.png') });

  // Without a key, Ask AI opens settings.
  await page.getByRole('button', { name: 'Ask AI' }).click();
  assert(await page.getByText('Claude API key', { exact: true }).isVisible(), 'Ask AI without a key opens settings');
  await page.getByPlaceholder('sk-ant-…').fill('sk-ant-test-key');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert((await page.evaluate(() => localStorage.getItem('qscan.apiKey'))) === 'sk-ant-test-key', 'key saved to localStorage');

  // With a key, Ask AI calls the (mocked) API and renders answers.
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await page.waitForFunction(() => window.__qscan.state.questions.every(q => q.ai), null, { timeout: 15000 });
  assert(apiCalls === 1, `one API call for 8 questions (got ${apiCalls})`);
  assert(lastBody.model === 'claude-opus-5-5', 'default model is claude-opus-5-5');
  assert(lastBody.fallbacks === 'default', 'server-side fallbacks enabled');
  assert(lastBody.output_config.format.type === 'json_schema', 'structured output requested');
  assert(lastBody.output_config.effort === 'high', 'default effort is high');
  assert(/PAGE TEXT/.test(lastBody.messages[0].content) && /mitochondrion/i.test(lastBody.messages[0].content), 'page text sent as context');
  const aiState = await page.evaluate(() => window.__qscan.state.questions.map(q => ({ n: q.n, ai: q.ai && q.ai.answer, opt: q.options.filter(o => o.ai).map(o => o.clean) })));
  assert(aiState[0].ai === 'mock answer 1' && aiState[0].opt.join() === 'Paris', 'AI option letter B maps to Paris');
  assert(aiState.find(x => x.n === 6).opt.join() === '5,7', 'multi-letter option "B, C" maps to two options');
  assert(await page.getByText('mock answer 8').isVisible(), 'AI answer rendered in panel');
  await page.screenshot({ path: path.join(outDir, 'panel-ai.png') });

  // Rescan keeps AI answers (cache) and a second bookmarklet tap re-runs instead of duplicating.
  await page.evaluate(code);
  const hosts = await page.evaluate(() => document.querySelectorAll('#qscan-root').length);
  assert(hosts === 1, 'second tap reuses the panel');
  const keep = await page.evaluate(() => window.__qscan.state.questions.filter(q => q.ai).length);
  assert(keep === 8, 'AI answers survive a rescan');

  // Close removes everything.
  await page.getByRole('button', { name: 'Close' }).click();
  assert((await page.evaluate(() => document.querySelectorAll('#qscan-root').length)) === 0, 'close removes the panel');

  // A page with no questions shows the empty state and no errors.
  await page.setContent('<html><body><h1>Hello</h1><p>Just a plain page with nothing to answer.</p></body></html>');
  await page.evaluate(code);
  assert(await page.getByText('No questions found').isVisible(), 'empty state on a plain page');

  assert(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
  await browser.close();
  server.close();
  console.log('\nALL TESTS PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
