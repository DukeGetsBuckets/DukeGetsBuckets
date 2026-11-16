/*
 * Question Scanner — a bookmarklet for iPad Safari (also works on desktop browsers).
 *
 * What it does when you tap it on any page:
 *   1. Scans the page (and same-origin iframes) for things that look like questions.
 *   2. Pairs each question with its answer options (radios, checkboxes, selects, lists,
 *      buttons, "A. / B. / C." text, etc.).
 *   3. Looks for answers that are already hidden in the page: data-correct attributes,
 *      "correct" classes, hidden inputs, "Answer:" text, JSON in <script> tags, and
 *      global JavaScript quiz data.
 *   4. Optionally asks Claude (with your own API key) to answer every question, using
 *      the page text as context so reading-passage questions work too.
 *
 * Everything lives in a floating panel drawn in a Shadow DOM so page CSS can't break it.
 * This file is the readable source. `node build.mjs` turns it into bookmarklet.txt and
 * install.html (see README.md).
 *
 * Configuration can be injected by the installer as a variable named __qscanCfg, e.g.
 *   var __qscanCfg = { key: "sk-ant-...", model: "claude-opus-5-5", effort: "high" };
 */
(function (cfg) {
  'use strict';

  var VERSION = '1.0.0';
  var ROOT_ID = 'qscan-root';
  var API_URL = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2026-10-21';
  var LS = { key: 'qscan.apiKey', model: 'qscan.model', effort: 'qscan.effort', ctx: 'qscan.context' };
  var MODELS = [
    ['claude-opus-5-5', 'Claude Opus 5.5 (most accurate)'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster)'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']
  ];
  var EFFORTS = [['medium', 'Medium (quick)'], ['high', 'High (recommended)'], ['xhigh', 'Extra high (slow, careful)']];
  var LIMITS = {
    maxQuestions: 60, minLen: 8, maxLen: 700, maxCandidates: 25000,
    contextChars: 16000, batch: 12, walkNodes: 200000, walkDepth: 10, maxScript: 3000000
  };

  // Second tap on the bookmarklet: rescan instead of loading twice.
  if (window.__qscan && typeof window.__qscan.run === 'function') { window.__qscan.run(); return; }

  /* ------------------------------------------------------------------ helpers */

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function norm(s) { return clean(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(function (w) { return w.length > 2; }); }
  function sim(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var A = {}, B = {}, inter = 0;
    ta.forEach(function (w) { A[w] = 1; });
    tb.forEach(function (w) { if (!B[w]) { B[w] = 1; if (A[w]) inter++; } });
    var union = Object.keys(A).length + Object.keys(B).length - inter;
    return union ? inter / union : 0;
  }
  function textMatch(a, b) {
    var na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 15 && nb.length >= 15 && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0)) return true;
    return sim(na, nb) >= 0.6;
  }
  function textOf(el) { return clean(el.textContent); }
  function isVisible(el) {
    try {
      if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (e) { return true; }
  }
  function truthy(v) {
    if (v === true || v === 1) return true;
    if (v == null) return false;
    return /^(1|true|yes|y|correct|right|t)$/i.test(String(v).trim());
  }
  function stripMarker(s) { return clean(s).replace(/^\(?([A-Ha-h]|[1-9])[.):]\s*/, '').replace(/^[A-Ha-h]\)\s*/, ''); }
  function letter(i) { return String.fromCharCode(65 + i); }
  function cssEscape(id) { return window.CSS && window.CSS.escape ? window.CSS.escape(id) : id.replace(/[^\w-]/g, '\\$&'); }

  /* ------------------------------------------------------------------ settings */

  cfg = cfg || {};
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function getKey() { return (cfg.key && String(cfg.key).trim()) || lsGet(LS.key) || ''; }
  function keySource() { return cfg.key ? 'bookmarklet' : (lsGet(LS.key) ? 'this site' : ''); }
  function getSettings() {
    return {
      model: lsGet(LS.model) || cfg.model || MODELS[0][0],
      effort: lsGet(LS.effort) || cfg.effort || 'high',
      context: (lsGet(LS.ctx) || (cfg.context === false ? 'off' : 'on')) !== 'off'
    };
  }

  /* ------------------------------------------------------------------ document scan */

  function docsToScan() {
    var docs = [document];
    var frames = document.querySelectorAll('iframe, frame');
    for (var i = 0; i < frames.length; i++) {
      try {
        var d = frames[i].contentDocument;
        if (d && d.body && d !== document) docs.push(d);
      } catch (e) { /* cross-origin frame: cannot read */ }
    }
    return docs;
  }

  function inPanel(el) { return !!(el.closest && el.closest('#' + ROOT_ID)); }

  var CAND_SEL = 'p,li,h1,h2,h3,h4,h5,h6,legend,label,td,th,dt,dd,div,span,blockquote,summary,figcaption,caption,strong,b,em,font,[role="heading"]';
  var STRIP_SEL = 'ul,ol,select,input,button,textarea,[role="radiogroup"],[role="group"],[role="listbox"],[class*="option" i],[class*="choice" i],[class*="answers" i],[class*="alternative" i]';
  var QWORDS = /^(which|what|who|whom|whose|when|where|why|how|select|choose|identify|calculate|solve|find|determine|explain|describe|name|list|define|complete|fill|true or false|match|compare|evaluate|simplify|convert|order|arrange|label|state|give|write|estimate|round|is|are|does|do|did|can|could|should|would|will|has|have|was|were)\b/i;
  var NUMBERED = /^(?:q(?:uestion)?\s*#?\s*\d+|#\s*\d+|\d{1,3})\s*[.):\]-]?\s+(?=\S)/i;
  var INLINE_OPT = /(?:^|\s)\(?([A-Ea-e])[.)]\s+(?=\S)/g;

  function stemText(el) {
    var c = el.cloneNode(true);
    try {
      var junk = c.querySelectorAll(STRIP_SEL);
      for (var i = 0; i < junk.length; i++) if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    } catch (e) {}
    var t = clean(c.textContent);
    return t || textOf(el);
  }

  function scoreText(t) {
    var s = 0;
    if (/\?\s*$/.test(t)) s += 3; else if (t.indexOf('?') >= 0) s += 2;
    if (NUMBERED.test(t)) s += 2;
    if (QWORDS.test(t.replace(NUMBERED, ''))) s += 1;
    if (/_{3,}|\.{4,}|\[\s*\]|\(\s*\)|\bblank\b/i.test(t)) s += 1;
    return s;
  }

  function contextScore(el) {
    var s = 0;
    if (el.closest('[class*="question" i],[id*="question" i],[class*="quiz" i],[class*="stem" i],[class*="prompt" i],[class*="problem" i],[data-question]')) s += 1;
    if (el.closest('nav,footer,aside,[role="navigation"],[role="contentinfo"]')) s -= 2;
    if (el.closest('header,[role="banner"]')) s -= 1;
    if (el.tagName === 'H1') s -= 1;
    if (el.closest('a')) s -= 1;
    return s;
  }

  function collectCandidates(doc) {
    var out = [];
    if (!doc.body) return out;
    var all = doc.body.querySelectorAll(CAND_SEL);
    var n = Math.min(all.length, LIMITS.maxCandidates);
    for (var i = 0; i < n; i++) {
      var el = all[i];
      if (inPanel(el)) continue;
      if (el.childElementCount > 40) continue;
      var raw = el.textContent;
      if (!raw || raw.length < LIMITS.minLen) continue;
      if (raw.length > LIMITS.maxLen * 3) continue;
      var t = clean(raw);
      if (t.length < LIMITS.minLen || t.length > LIMITS.maxLen) continue;
      var base = scoreText(t);
      if (base < 2) continue;
      if (!isVisible(el)) continue;
      base += contextScore(el);
      if (base < 2) continue;
      // keep innermost: drop earlier candidates that contain this one
      for (var j = out.length - 1; j >= 0; j--) {
        if (out[j].el.contains(el)) out.splice(j, 1);
      }
      out.push({ el: el, doc: doc, text: t, base: base });
    }
    return out;
  }

  /* ------------------------------------------------------------------ options */

  var OPT_SEL = 'input[type="radio"],input[type="checkbox"],select,[role="radio"],[role="checkbox"],[role="option"],[role="menuitemradio"],li,button,[class*="option" i],[class*="choice" i],[class*="answer" i],[class*="alternative" i],[class*="distractor" i]';
  var SKIP_BUTTON = /^(submit|next|previous|prev|back|skip|check|continue|finish|done|save|close|cancel|retry|hint|show|hide|reset|start|begin|menu|login|log in|sign|ok|yes|no|got it|dismiss|more|less|search|go|home|help|share|print|download|upload|edit|delete|remove|add|new|open|play|pause|stop|mute|settings|report|flag|review|clear|copy|paste|cut|undo|redo|refresh|reload|scan|ask ai|rescan)\b/i;

  function labelFor(input) {
    var doc = input.ownerDocument, t = '';
    try {
      if (input.id) { var l = doc.querySelector('label[for="' + cssEscape(input.id) + '"]'); if (l) t = textOf(l); }
    } catch (e) {}
    if (!t) { var cl = input.closest('label'); if (cl) t = textOf(cl); }
    if (!t) t = input.getAttribute('aria-label') || '';
    if (!t) {
      var lb = input.getAttribute('aria-labelledby');
      if (lb) t = lb.split(/\s+/).map(function (id) { var e = doc.getElementById(id); return e ? textOf(e) : ''; }).join(' ');
    }
    if (!t) {
      var s = input.nextSibling;
      while (s && !t) { if (s.nodeType === 3) t = clean(s.textContent); else if (s.nodeType === 1 && !/^(input|select|textarea|button|br)$/i.test(s.tagName)) t = textOf(s); s = s.nextSibling; }
    }
    if (!t && input.parentElement) t = textOf(input.parentElement);
    if (!t) t = input.value || '';
    return clean(t);
  }

  function collectOptions(doc) {
    var out = [];
    if (!doc.body) return out;
    var all = doc.body.querySelectorAll(OPT_SEL);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (inPanel(el)) continue;
      var tag = el.tagName.toLowerCase();
      var rec = null;
      if (tag === 'input') {
        var txt = labelFor(el);
        if (!txt) continue;
        var anchor = (el.id && doc.querySelector('label[for="' + cssEscape(el.id) + '"]')) || el.closest('label') || el.closest('li') || el.parentElement || el;
        rec = { el: el, anchor: anchor, text: txt, kind: 'input', group: 'name:' + (el.name || el.id || i), parent: el.parentElement };
        out.push(rec);
        continue;
      }
      if (tag === 'select') {
        var opts = el.options;
        for (var k = 0; k < opts.length; k++) {
          var ot = clean(opts[k].textContent);
          if (!ot || /^(select|choose|pick|--|please)/i.test(ot) || opts[k].disabled) continue;
          out.push({ el: opts[k], anchor: opts[k], text: ot, kind: 'select', group: 'select:' + i, parent: el, selectEl: el });
        }
        continue;
      }
      if (el.querySelector('input[type="radio"],input[type="checkbox"],select')) continue; // covered by the input records
      var t = textOf(el);
      if (!t || t.length > 200) continue;
      if (tag === 'button' && (t.length > 150 || SKIP_BUTTON.test(t))) continue;
      if (tag === 'li' && el.closest('nav,footer,[role="navigation"],[role="menu"],[role="menubar"]')) continue;
      if (tag === 'li' && el.querySelector('ul,ol')) continue;
      if (el.closest('a') && tag !== 'li') continue;
      if (!isVisible(el)) continue;
      rec = { el: el, anchor: el, text: t, kind: tag === 'li' ? 'li' : (el.getAttribute('role') ? 'role' : (tag === 'button' ? 'button' : 'class')), group: null, parent: el.parentElement };
      // innermost wins
      var dup = false;
      for (var j = out.length - 1; j >= 0; j--) {
        var p = out[j];
        if (p.kind === 'input' || p.kind === 'select') continue;
        if (p.el === el) { dup = true; break; }
        if (p.el.contains(el)) out.splice(j, 1);
      }
      if (!dup) out.push(rec);
    }
    return out;
  }

  function follows(a, b) { // true if b comes after a in document order (descendants count as after)
    return !!(a.compareDocumentPosition(b) & 4);
  }
  function stepsToCommonAncestor(a, b) {
    var n = 0, cur = a;
    while (cur && !cur.contains(b)) { cur = cur.parentElement; n++; if (n > 12) return n; }
    return cur ? n : 99;
  }

  function assignOptions(cand, nextCand, optionRecs) {
    var pool = [];
    for (var i = 0; i < optionRecs.length; i++) {
      var r = optionRecs[i];
      if (r.el === cand.el || r.el.contains(cand.el)) continue;
      if (!follows(cand.el, r.el)) continue;
      if (nextCand && nextCand.el !== r.el && !nextCand.el.contains(r.el) && follows(nextCand.el, r.el)) break;
      if (nextCand && (nextCand.el === r.el || nextCand.el.contains(r.el))) break;
      if (stepsToCommonAncestor(cand.el, r.el) > 7) continue;
      pool.push(r);
    }
    if (!pool.length) return [];
    var first = pool[0], fam = [];
    for (var k = 0; k < pool.length; k++) {
      var o = pool[k];
      var same = first.group ? o.group === first.group : (o.kind === first.kind && o.parent === first.parent);
      if (same) fam.push(o);
    }
    if (fam.length < 2) {
      // try the next family in the pool (e.g. a stray label before the real options)
      for (var m = 1; m < pool.length && fam.length < 2; m++) {
        var f2 = pool[m], fam2 = [];
        for (var q = m; q < pool.length; q++) {
          var o2 = pool[q];
          var same2 = f2.group ? o2.group === f2.group : (o2.kind === f2.kind && o2.parent === f2.parent);
          if (same2) fam2.push(o2);
        }
        if (fam2.length >= 2) fam = fam2;
      }
    }
    if (fam.length < 2) return [];
    return fam.slice(0, 12).map(function (o) {
      return { el: o.el, anchor: o.anchor, kind: o.kind, text: o.text, clean: stripMarker(o.text), correct: false, evidence: '' };
    });
  }

  function splitInlineOptions(stem) {
    var marks = [], m;
    INLINE_OPT.lastIndex = 0;
    while ((m = INLINE_OPT.exec(stem))) marks.push({ idx: m.index + (m[0].charAt(0) === ' ' ? 1 : 0), letter: m[1].toUpperCase() });
    if (marks.length < 2) return null;
    // letters must start at A and be in order
    for (var i = 0; i < marks.length; i++) if (marks[i].letter !== letter(i)) return null;
    var opts = [];
    for (var j = 0; j < marks.length; j++) {
      var end = j + 1 < marks.length ? marks[j + 1].idx : stem.length;
      var piece = clean(stem.slice(marks[j].idx, end));
      opts.push({ el: null, anchor: null, kind: 'inline', text: piece, clean: stripMarker(piece), correct: false, evidence: '' });
    }
    return { stem: clean(stem.slice(0, marks[0].idx)), options: opts };
  }

  /* ------------------------------------------------------------------ answers hidden in the page */

  var CORRECT_ATTR = /^(data-)?(is-?)?(correct|right|answer|is-?answer|key|solution|iscorrect|is_correct|is_answer|correctanswer|correct-answer|correct_answer)$/i;
  var CORRECT_CLASS = /(^|[\s_-])(correct|right-answer|is-correct|answer-correct|correct-answer|true|key|solution)([\s_-]|$)/i;
  var WRONG_CLASS = /incorrect|wrong|false|not-correct/i;

  function markedCorrect(el) {
    var cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      var attrs = cur.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        if (CORRECT_ATTR.test(a.name)) {
          if (a.value === '' || truthy(a.value)) return a.name + (a.value ? '="' + a.value + '"' : '');
        }
      }
      if (cur.tagName === 'INPUT' && /^(true|correct|right)$/i.test(cur.value || '')) return 'value="' + cur.value + '"';
      var cls = typeof cur.className === 'string' ? cur.className : '';
      if (cls && CORRECT_CLASS.test(cls) && !WRONG_CLASS.test(cls)) return 'class "' + cls.trim() + '"';
      var al = (cur.getAttribute('aria-label') || '') + ' ' + (cur.getAttribute('title') || '');
      if (/\bcorrect\b/i.test(al) && !/incorrect/i.test(al)) return 'label says correct';
      cur = cur.parentElement; depth++;
    }
    return '';
  }

  function containerOf(q) {
    var el = q.el, n = 0;
    if (q.options.length && q.options[0].el) {
      while (el && !el.contains(q.options[q.options.length - 1].el || q.options[0].el) && n < 8) { el = el.parentElement; n++; }
    }
    if (el === q.el) el = (q.el.closest('li,fieldset,form,[class*="question" i],[class*="quiz" i],[id*="question" i],article,section') || q.el.parentElement || q.el);
    return el || q.el;
  }

  var ANSWER_TEXT = /(?:correct|right)?\s*answer\s*(?:is|:|=|-)\s*["“']?\s*([^\n"”']{1,160})/i;

  function scanNearby(q) {
    if (!q.el) return;
    var c = containerOf(q);
    var stem = norm(q.stem);
    // hidden inputs that look like answer keys
    var hid = c.querySelectorAll('input[type="hidden"]');
    for (var i = 0; i < hid.length; i++) {
      var h = hid[i], nm = (h.name || '') + ' ' + (h.id || '') + ' ' + (h.className || '');
      if (/answer|correct|key|solution/i.test(nm) && h.value && h.value.length < 200 && !/^\d{5,}$/.test(h.value)) {
        setPageAnswer(q, h.value, 'hidden input ' + (h.name || h.id));
        return;
      }
    }
    // "Answer: X" text inside the container (hidden feedback / solution blocks included)
    var full = clean(c.textContent).replace(q.text, ' ');
    var m = ANSWER_TEXT.exec(full);
    if (m && norm(m[1]) && norm(m[1]) !== stem) {
      var a = clean(m[1]).split(/\s(?:explanation|because|feedback)\b/i)[0];
      setPageAnswer(q, a, '"Answer:" text on the page');
    }
  }

  function setPageAnswer(q, text, evidence) {
    text = clean(text);
    if (!text) return;
    if (q.pageAnswer && q.pageAnswer.text === text) return;
    q.pageAnswer = { text: text, evidence: evidence };
    // mark matching option(s)
    var parts = text.split(/\s*(?:\||,|;|\band\b)\s*/i);
    q.options.forEach(function (o, idx) {
      var hit = textMatch(o.clean, text) || parts.some(function (p) { return p && (norm(p) === norm(o.clean) || (p.length === 1 && p.toUpperCase() === letter(idx))); });
      if (!hit && /^[A-H]$/i.test(text) && text.toUpperCase() === letter(idx)) hit = true;
      if (hit) { o.correct = true; o.evidence = o.evidence || evidence; }
    });
  }

  /* ---- JSON / global data mining */

  var QKEYS = ['question', 'questionText', 'question_text', 'questiontext', 'text', 'title', 'prompt', 'stem', 'body', 'label', 'name', 'q', 'content', 'statement', 'description'];
  var AKEY = /^(correct_?answers?|correct_?answer_?text|correct_?responses?|correct|is_?correct|right_?answers?|solution|answer_?key|correct_?options?|correct_?choices?|correct_?index(es)?|correct_?indices|correct_?idx|answer_?index|answer|answers|key)$/i;
  var OKEY = /^(options|choices|answers|alternatives|distractors|responses|answer_?options|answer_?choices|items|candidates)$/i;
  var TKEYS = ['text', 'label', 'title', 'value', 'option', 'choice', 'answer', 'content', 'body', 'name', 'html'];
  var OFLAG = /^(is_?)?(correct|right|answer|is_?answer|key|true|selected_?correct)$/i;

  function firstString(o, keys, min, max) {
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (typeof v === 'string') { var c = clean(v.replace(/<[^>]+>/g, ' ')); if (c.length >= min && c.length <= max) return c; }
    }
    return '';
  }
  function optFromItem(it) {
    if (typeof it === 'string' || typeof it === 'number') return { t: clean(String(it)), correct: false };
    if (!it || typeof it !== 'object') return null;
    var t = firstString(it, TKEYS, 1, 300);
    if (!t) return null;
    var correct = false;
    for (var k in it) if (OFLAG.test(k) && truthy(it[k])) { correct = true; break; }
    return { t: t, correct: correct };
  }

  function recordFromObject(o, recs) {
    var qText = firstString(o, QKEYS, 5, LIMITS.maxLen);
    var opts = null, answer = null, answerKey = '';
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (!opts && OKEY.test(k) && Array.isArray(v) && v.length >= 2 && v.length <= 20) {
        var mapped = v.map(optFromItem).filter(Boolean);
        if (mapped.length >= 2) opts = mapped;
      }
      if (!answer && AKEY.test(k) && !OKEY.test(k)) {
        if (typeof v === 'string' && v.length && v.length <= 300) { answer = [clean(v.replace(/<[^>]+>/g, ' '))]; answerKey = k; }
        else if (typeof v === 'number' || typeof v === 'boolean') { answer = [v]; answerKey = k; }
        else if (Array.isArray(v) && v.length && v.length <= 10 && v.every(function (x) { return typeof x === 'string' || typeof x === 'number'; })) { answer = v.slice(); answerKey = k; }
        else if (v && typeof v === 'object') { var at = firstString(v, TKEYS, 1, 300); if (at) { answer = [at]; answerKey = k; } }
      }
    }
    if (opts && answer) {
      answer.forEach(function (a) {
        if (typeof a === 'number' && /index|idx/i.test(answerKey) && opts[a]) opts[a].correct = true;
        else if (typeof a === 'number' && opts[a] && !opts.some(function (x) { return x.correct; }) && /index|idx/i.test(answerKey)) opts[a].correct = true;
        else if (typeof a === 'string') {
          var hit = false;
          opts.forEach(function (x, i) { if (norm(x.t) === norm(a) || (a.length === 1 && a.toUpperCase() === letter(i))) { x.correct = true; hit = true; } });
          if (!hit && /^\d+$/.test(a) && opts[+a]) opts[+a].correct = true;
        }
      });
    }
    var hasCorrect = opts && opts.some(function (x) { return x.correct; });
    if (!qText && !hasCorrect) return;
    if (!answer && !hasCorrect) return;
    var ansText = null;
    if (answer && !(answer.length === 1 && typeof answer[0] === 'number' && /index|idx/i.test(answerKey))) {
      ansText = answer.map(function (a) { return typeof a === 'boolean' ? (a ? 'True' : 'False') : String(a); }).join(' | ');
    }
    if (!ansText && hasCorrect) ansText = opts.filter(function (x) { return x.correct; }).map(function (x) { return x.t; }).join(' | ');
    recs.push({ q: qText, a: ansText, opts: opts, src: 'page data' });
  }

  function walkData(root, recs, budget) {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var stack = [{ v: root, d: 0 }];
    while (stack.length && budget.n > 0) {
      var cur = stack.pop(), v = cur.v;
      if (!v || typeof v !== 'object') continue;
      if (seen) { if (seen.has(v)) continue; seen.add(v); }
      if (typeof Node !== 'undefined' && v instanceof Node) continue;
      if (v === window || (typeof Window !== 'undefined' && v instanceof Window)) continue;
      budget.n--;
      if (cur.d > LIMITS.walkDepth) continue;
      if (Array.isArray(v)) {
        // flat option arrays: [{text, correct}, ...]
        if (v.length >= 2 && v.length <= 20) {
          var mapped = v.map(function (it) { return it && typeof it === 'object' ? optFromItem(it) : null; });
          if (mapped.every(Boolean) && mapped.some(function (x) { return x.correct; })) recs.push({ q: '', a: mapped.filter(function (x) { return x.correct; }).map(function (x) { return x.t; }).join(' | '), opts: mapped, src: 'page data' });
        }
        for (var i = 0; i < v.length && i < 500; i++) if (v[i] && typeof v[i] === 'object') stack.push({ v: v[i], d: cur.d + 1 });
        continue;
      }
      try { recordFromObject(v, recs); } catch (e) {}
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length && k < 300; k++) {
        var child;
        try { child = v[keys[k]]; } catch (e) { continue; }
        if (child && typeof child === 'object') stack.push({ v: child, d: cur.d + 1 });
      }
    }
  }

  function findBalanced(s, start) {
    var open = s.charAt(start), close = open === '{' ? '}' : ']', depth = 0, inStr = false, q = '', i;
    for (i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) { if (ch === '\\') { i++; continue; } if (ch === q) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return ch === close ? i : -1; }
      if (i - start > 2000000) return -1;
    }
    return -1;
  }

  function parseLoose(s) {
    try { return JSON.parse(s); } catch (e) {}
    if (s.length > 300000) return null;
    try {
      var t = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'((?:[^'\\]|\\.)*)'/g, function (_, inner) { return '"' + inner.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"'; })
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(t);
    } catch (e2) { return null; }
  }

  function mineScripts(docs, recs) {
    var budget = { n: LIMITS.walkNodes };
    docs.forEach(function (d) {
      var scripts = d.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var s = scripts[i], txt = s.textContent;
        if (!txt || txt.length > LIMITS.maxScript) continue;
        if (!/correct|answer|solution|key/i.test(txt)) continue;
        if (/json/i.test(s.type || '')) { var pj = parseLoose(txt); if (pj) walkData(pj, recs, budget); continue; }
        var tries = 0, re = /(^|[=(:,\[]|return)\s*([{\[])/g, m;
        while ((m = re.exec(txt)) && tries < 300) {
          var start = m.index + m[0].length - 1;
          var end = findBalanced(txt, start);
          if (end < 0 || end - start < 20) continue;
          var sub = txt.slice(start, end + 1);
          if (!/correct|answer|solution|key/i.test(sub)) { continue; }
          tries++;
          var val = parseLoose(sub);
          if (val) { walkData(val, recs, budget); re.lastIndex = end + 1; }
        }
      }
    });
    return budget;
  }

  function mineGlobals(recs, budget) {
    var std = null;
    try {
      var f = document.createElement('iframe');
      f.style.display = 'none';
      document.documentElement.appendChild(f);
      std = {};
      Object.getOwnPropertyNames(f.contentWindow).forEach(function (k) { std[k] = 1; });
      f.parentNode.removeChild(f);
    } catch (e) { std = null; }
    var names = Object.getOwnPropertyNames(window);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (std && std[k]) continue;
      if (!std && /^(on|webkit)/.test(k)) continue;
      if (k === '__qscan') continue;
      var v;
      try { v = window[k]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (typeof Node !== 'undefined' && v instanceof Node) continue;
      try { walkData(v, recs, budget); } catch (e) {}
      if (budget.n <= 0) break;
    }
  }

  function applyRecords(questions, recs) {
    if (!recs.length) return;
    questions.forEach(function (q) {
      if (q.pageAnswer) return;
      var best = null, bestScore = 0;
      recs.forEach(function (r) {
        if (!r.q) return;
        var s = textMatch(r.q, q.stem) ? Math.max(0.6, sim(r.q, q.stem)) : 0;
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (!best && q.options.length >= 2) {
        recs.forEach(function (r) {
          if (!r.opts) return;
          var hits = 0;
          q.options.forEach(function (o) { if (r.opts.some(function (x) { return norm(x.t) === norm(o.clean); })) hits++; });
          var s = hits / q.options.length;
          if (hits >= 2 && s > bestScore && s >= 0.5) { bestScore = s; best = r; }
        });
      }
      if (best && best.a) {
        setPageAnswer(q, best.a, best.src + (best.q ? ' (question text matched)' : ' (options matched)'));
        if (best.opts) {
          q.options.forEach(function (o) {
            best.opts.forEach(function (x) { if (x.correct && norm(x.t) === norm(o.clean)) { o.correct = true; o.evidence = o.evidence || best.src; } });
          });
        }
      }
    });
  }

  /* ------------------------------------------------------------------ main scan */

  function scan() {
    var docs = docsToScan();
    var questions = [];
    docs.forEach(function (doc, di) {
      var cands = collectCandidates(doc);
      if (!cands.length) return;
      var optionRecs = collectOptions(doc);
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var options = assignOptions(c, cands[i + 1], optionRecs);
        var stem = options.length && options[0].el && c.el.contains(options[0].el) ? stemText(c.el) : c.text;
        if (!options.length) {
          var split = splitInlineOptions(stem);
          if (split) { stem = split.stem; options = split.options; }
        }
        var score = c.base + (options.length ? 2 : 0);
        if (score < 3) continue;
        if (stem.length < LIMITS.minLen) continue;
        questions.push({ el: c.el, doc: doc, frame: di, text: c.text, stem: stem, options: options, score: score, pageAnswer: null, ai: null });
      }
    });
    // de-duplicate by stem text
    var seen = {};
    questions = questions.filter(function (q) { var k = norm(q.stem); if (!k || seen[k]) return false; seen[k] = 1; return true; });
    questions = questions.slice(0, LIMITS.maxQuestions);
    questions.forEach(function (q, i) { q.n = i + 1; });

    // answers already on the page
    questions.forEach(function (q) {
      q.options.forEach(function (o) {
        if (!o.anchor) return;
        var ev = markedCorrect(o.anchor) || (o.el && o.el !== o.anchor ? markedCorrect(o.el) : '');
        if (ev) { o.correct = true; o.evidence = ev; }
      });
      var marked = q.options.filter(function (o) { return o.correct; });
      if (marked.length && (marked.length < q.options.length)) {
        q.pageAnswer = { text: marked.map(function (o) { return o.clean; }).join(' | '), evidence: marked[0].evidence };
      } else if (marked.length) {
        q.options.forEach(function (o) { o.correct = false; o.evidence = ''; }); // every option "correct" = noise
      }
      if (!q.pageAnswer) scanNearby(q);
    });
    if (questions.some(function (q) { return !q.pageAnswer; })) {
      var recs = [];
      try { var budget = mineScripts(docs, recs); mineGlobals(recs, budget); } catch (e) {}
      applyRecords(questions, recs);
    }
    return questions;
  }

  /* ------------------------------------------------------------------ AI */

  var SYSTEM = 'You are a careful tutor helping a student check their work on a web page. ' +
    'Answer each question accurately and concisely. For multiple choice, pick the option that best answers the question and give its letter; ' +
    'if several options are correct (select all that apply), list every correct letter separated by commas in "option" and the texts separated by " | " in "answer". ' +
    'Use the PAGE TEXT when the question refers to a passage, image description, table or data on the page. ' +
    'If a question cannot be answered from the information available, say so in "answer" and set confidence to "low".';

  var SCHEMA = {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            answer: { type: 'string' },
            option: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            why: { type: 'string' }
          },
          required: ['n', 'answer', 'option', 'confidence', 'why'],
          additionalProperties: false
        }
      }
    },
    required: ['answers'],
    additionalProperties: false
  };

  function pageContext() {
    var root = document.querySelector('main,article,[role="main"]') || document.body;
    var panel = document.getElementById(ROOT_ID);
    var t = '';
    try {
      if (panel) panel.style.display = 'none';
      t = root.innerText || root.textContent || '';
    } finally { if (panel) panel.style.display = ''; }
    t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (t.length > LIMITS.contextChars) t = t.slice(0, LIMITS.contextChars) + '\n[... page text truncated ...]';
    return t;
  }

  function formatQuestions(qs) {
    return qs.map(function (q) {
      var s = q.n + '. ' + q.stem;
      if (q.options.length) s += '\n' + q.options.map(function (o, i) { return '   (' + letter(i) + ') ' + o.clean; }).join('\n');
      if (q.pageAnswer) s += '\n   [hint found on page: ' + q.pageAnswer.text + ']';
      return s;
    }).join('\n\n');
  }

  function buildPrompt(qs, settings) {
    var p = 'Page title: ' + clean(document.title) + '\nURL: ' + location.href + '\n\n';
    if (settings.context) p += 'PAGE TEXT (context; may contain the reading passage and the questions themselves):\n<<<\n' + pageContext() + '\n>>>\n\n';
    p += 'QUESTIONS (' + qs.length + '):\n\n' + formatQuestions(qs) + '\n\n';
    p += 'Return one entry per question number listed above. "option" is the letter of the chosen option (or letters separated by commas), or an empty string for open-ended questions. "answer" is the exact option text for multiple choice, otherwise a short direct answer. "why" is one short sentence.';
    return p;
  }

  function apiErrorMessage(status, data, raw) {
    var msg = data && data.error && data.error.message ? data.error.message : (raw || '').slice(0, 200);
    if (status === 401 && /CORS/i.test(msg)) return 'Your Claude organization does not allow browser requests (401 CORS). Use "Copy for Claude" and paste into the Claude app instead.';
    if (status === 401) return 'API key rejected (401). Check the key in Settings.';
    if (status === 403) return 'Permission denied (403): ' + msg;
    if (status === 429) return 'Rate limited (429). Wait a moment and try again.';
    if (status === 529 || status === 503) return 'Claude is overloaded right now (' + status + '). Try again in a minute.';
    if (status === 400) return 'Request rejected (400): ' + msg;
    return 'API error ' + status + ': ' + msg;
  }

  function callClaude(key, settings, qs, retry) {
    var body = {
      model: settings.model,
      max_tokens: 16000,
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(qs, settings) }],
      output_config: { effort: settings.effort, format: { type: 'json_schema', schema: SCHEMA } }
    };
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 240000) : null;
    return fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.text().then(function (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) {}
        if (r.status === 429 && !retry) {
          var wait = Math.min(20, parseInt(r.headers.get('retry-after') || '5', 10) || 5);
          setStatus('Rate limited, retrying in ' + wait + 's…');
          return new Promise(function (res) { setTimeout(res, wait * 1000); }).then(function () { return callClaude(key, settings, qs, true); });
        }
        if (!r.ok) throw new Error(apiErrorMessage(r.status, data, raw));
        if (!data) throw new Error('Unexpected response from the API.');
        if (data.stop_reason === 'refusal') {
          var why = data.stop_details && data.stop_details.explanation ? ' ' + data.stop_details.explanation : '';
          throw new Error('Claude declined to answer this batch.' + why);
        }
        var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
        if (data.stop_reason === 'max_tokens') throw new Error('The answer was cut off (max_tokens). Try fewer questions.');
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new Error('Could not read the AI answer.'); }
        return { answers: parsed.answers || [], model: data.model || settings.model };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('The request timed out.');
      throw new Error('Could not reach api.anthropic.com. This site may block outside requests, or you are offline. Use "Copy for Claude" instead.');
    });
  }

  function askAI() {
    var key = getKey();
    if (!key) { openSettings('Add a Claude API key to get AI answers (or use "Copy for Claude").'); return; }
    var todo = state.questions.filter(function (q) { return !q.ai; });
    if (!todo.length) { setStatus('Every question already has an AI answer. Tap Rescan to start over.'); return; }
    if (state.busy) return;
    state.busy = true;
    var settings = getSettings();
    var chunks = [];
    for (var i = 0; i < todo.length; i += LIMITS.batch) chunks.push(todo.slice(i, i + LIMITS.batch));
    var done = 0;
    var p = Promise.resolve();
    chunks.forEach(function (chunk) {
      p = p.then(function () {
        setStatus('Asking ' + settings.model + ' about questions ' + chunk[0].n + '–' + chunk[chunk.length - 1].n + ' of ' + state.questions.length + '…');
        return callClaude(key, settings, chunk, false).then(function (res) {
          res.answers.forEach(function (a) {
            var q = state.questions.filter(function (x) { return x.n === a.n; })[0];
            if (!q) return;
            q.ai = { answer: a.answer, option: a.option, confidence: a.confidence, why: a.why, model: res.model };
            state.cache[norm(q.stem)] = q.ai;
            if (a.option) {
              a.option.split(/[,\s]+/).forEach(function (L) {
                var idx = L.trim().toUpperCase().charCodeAt(0) - 65;
                if (q.options[idx]) q.options[idx].ai = true;
              });
            }
          });
          done += chunk.length;
          render();
        });
      });
    });
    p.then(function () {
      state.busy = false;
      setStatus('AI answered ' + done + ' question' + (done === 1 ? '' : 's') + ' with ' + settings.model + '.');
      render();
    }, function (err) {
      state.busy = false;
      setStatus('AI error: ' + (err && err.message ? err.message : err), true);
      render();
    });
  }

  function copyForClaude() {
    var txt = 'Please answer these questions from the page "' + clean(document.title) + '" (' + location.href + '). For multiple choice give the letter and the option text.\n\n' + formatQuestions(state.questions);
    copyText(txt, 'Copied ' + state.questions.length + ' question(s). Paste into the Claude app or any chat.');
  }

  function copyResults() {
    var lines = state.questions.map(function (q) {
      var s = q.n + '. ' + q.stem;
      if (q.pageAnswer) s += '\n   Page answer: ' + q.pageAnswer.text;
      if (q.ai) s += '\n   AI answer' + (q.ai.option ? ' (' + q.ai.option + ')' : '') + ': ' + q.ai.answer + ' [' + q.ai.confidence + ']';
      return s;
    });
    copyText(lines.join('\n\n'), 'Copied all answers.');
  }

  function copyText(txt, okMsg) {
    var done = function () { setStatus(okMsg); };
    var fail = function () {
      // fallback: textarea + execCommand
      try {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else setStatus('Copy failed. Long-press the text instead.', true);
      } catch (e) { setStatus('Copy failed. Long-press the text instead.', true); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fail); else fail();
  }

  /* ------------------------------------------------------------------ UI */

  var STYLE = ':host{all:initial}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
    '.panel{position:fixed;right:10px;bottom:10px;width:min(470px,calc(100vw - 20px));max-height:min(80vh,780px);display:flex;flex-direction:column;background:#fff;color:#111;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;z-index:2147483647;overflow:hidden}' +
    '.panel.min{max-height:none}.panel.min .body,.panel.min .ftr{display:none}' +
    '.hdr{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #e5e5ea;background:#f7f7f9}' +
    '.hdr .t{font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.hdr .t small{font-weight:400;color:#6e6e73;margin-left:6px}' +
    'button{font:inherit;font-size:14px;border:0;border-radius:10px;padding:0 12px;background:#e9e9ee;color:#111;min-height:40px;cursor:pointer;white-space:nowrap}' +
    'button:active{opacity:.7}button.p{background:#0a84ff;color:#fff}button.i{min-width:40px;padding:0;font-size:18px}button[disabled]{opacity:.5}' +
    '.body{overflow:auto;-webkit-overflow-scrolling:touch;padding:10px;flex:1;min-height:0}' +
    '.q{border:1px solid #e5e5ea;border-radius:12px;padding:10px;margin-bottom:10px}' +
    '.q .n{font-size:12px;color:#6e6e73;margin-bottom:3px}.q .n .f{margin-left:6px}' +
    '.q .s{font-weight:600;margin-bottom:6px;word-break:break-word}' +
    '.o{padding:5px 8px;border-radius:8px;margin:2px 0;word-break:break-word}.o .L{display:inline-block;min-width:1.6em;color:#6e6e73}' +
    '.o.ok{background:#d9f5e0;font-weight:600}.o.ai{box-shadow:inset 0 0 0 2px #0a84ff}' +
    '.ans{margin-top:8px;padding:8px 10px;border-radius:10px;background:#fff4cc;word-break:break-word}.ans.ai{background:#e6efff}' +
    '.ans b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#6e6e73;margin-bottom:2px}' +
    '.ev{font-size:12px;color:#6e6e73;margin-top:3px}' +
    '.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}' +
    '.ftr{padding:8px 10px;border-top:1px solid #e5e5ea;font-size:13px;color:#3a3a3c;background:#f7f7f9;word-break:break-word}.ftr.err{color:#c0392b;font-weight:600}' +
    '.set{display:flex;flex-direction:column;gap:10px;padding:4px 0}.set label{font-size:13px;color:#6e6e73;display:block;margin-bottom:3px}' +
    '.set p{margin:0;font-size:13px;color:#3a3a3c}' +
    'input,select{font:inherit;padding:9px;border:1px solid #c7c7cc;border-radius:8px;width:100%;background:#fff;color:#111;min-height:40px}' +
    '.empty{padding:20px 6px;color:#6e6e73;text-align:center}' +
    '.conf{display:inline-block;font-size:11px;padding:1px 6px;border-radius:6px;background:#e9e9ee;margin-left:6px;vertical-align:middle}.conf.high{background:#d9f5e0}.conf.low{background:#ffe0dc}' +
    '@media (prefers-color-scheme:dark){.panel{background:#1c1c1e;color:#f2f2f7}.hdr,.ftr{background:#2c2c2e;border-color:#3a3a3c;color:#d1d1d6}.q{border-color:#3a3a3c}button{background:#3a3a3c;color:#f2f2f7}button.p{background:#0a84ff;color:#fff}.o.ok{background:#1f4d2b}.ans{background:#4a3f12}.ans.ai{background:#1e3a5f}input,select{background:#2c2c2e;color:#f2f2f7;border-color:#48484a}.conf{background:#3a3a3c}.conf.high{background:#1f4d2b}.conf.low{background:#5a2420}.set p,.q .n,.ev,.ans b,.o .L{color:#a1a1a6}}';

  var state = { questions: [], cache: {}, busy: false, view: 'list', min: false, status: '' };
  var ui = null;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'onclick') el.addEventListener('click', attrs[k]);
      else if (k === 'html') el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c == null) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function mount() {
    var host = document.getElementById(ROOT_ID);
    if (host && ui) return;
    if (host) host.parentNode.removeChild(host);
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('style', 'all:initial;position:static;display:block;');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    var panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Question Scanner' });
    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);
    ui = { host: host, root: root, panel: panel };
  }

  function setStatus(msg, isErr) {
    state.status = msg; state.statusErr = !!isErr;
    if (ui) { var f = ui.panel.querySelector('.ftr'); if (f) { f.textContent = msg; f.className = 'ftr' + (isErr ? ' err' : ''); } }
  }

  function highlight(q) {
    if (!q.el) return;
    try {
      q.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var old = q.el.style.outline, oldOff = q.el.style.outlineOffset;
      q.el.style.outline = '3px solid #0a84ff'; q.el.style.outlineOffset = '3px';
      setTimeout(function () { q.el.style.outline = old; q.el.style.outlineOffset = oldOff; }, 2500);
    } catch (e) {}
  }

  function searchWeb(q) {
    var query = q.stem + (q.options.length ? ' ' + q.options.map(function (o) { return o.clean; }).join(' ') : '');
    window.open('https://www.google.com/search?q=' + encodeURIComponent(query.slice(0, 300)), '_blank');
  }

  function openSettings(msg) { state.view = 'settings'; render(); if (msg) setStatus(msg); }

  function renderHeader() {
    var count = state.questions.length;
    var title = h('div', { class: 't' }, [
      'Question Scanner',
      h('small', { text: state.view === 'settings' ? 'settings' : (count + ' found') })
    ]);
    var btns = [];
    if (state.view === 'settings') {
      btns.push(h('button', { text: 'Back', onclick: function () { state.view = 'list'; render(); } }));
    } else {
      btns.push(h('button', { text: 'Rescan', onclick: function () { run(); } }));
      btns.push(h('button', { class: 'p', text: state.busy ? 'Asking…' : 'Ask AI', disabled: state.busy ? 'disabled' : null, onclick: askAI }));
      btns.push(h('button', { class: 'i', text: '⚙︎', title: 'Settings', 'aria-label': 'Settings', onclick: function () { openSettings(); } }));
    }
    btns.push(h('button', { class: 'i', text: state.min ? '▴' : '▾', title: 'Minimize', 'aria-label': 'Minimize', onclick: function () { state.min = !state.min; render(); } }));
    btns.push(h('button', { class: 'i', text: '✕', title: 'Close', 'aria-label': 'Close', onclick: close }));
    var hdr = h('div', { class: 'hdr' }, [title]);
    btns.forEach(function (b) { hdr.appendChild(b); });
    return hdr;
  }

  function renderQuestion(q) {
    var card = h('div', { class: 'q' });
    var meta = h('div', { class: 'n', text: 'Q' + q.n + (q.options.length ? ' · ' + q.options.length + ' options' : ' · open answer') });
    if (q.frame) meta.appendChild(h('span', { class: 'f', text: '(in frame)' }));
    card.appendChild(meta);
    card.appendChild(h('div', { class: 's', text: q.stem }));
    q.options.forEach(function (o, i) {
      var cls = 'o' + (o.correct ? ' ok' : '') + (o.ai ? ' ai' : '');
      card.appendChild(h('div', { class: cls }, [h('span', { class: 'L', text: letter(i) + '.' }), o.clean + (o.correct ? ' ✓' : '')]));
    });
    if (q.pageAnswer) {
      card.appendChild(h('div', { class: 'ans' }, [h('b', { text: 'Found on page' }), q.pageAnswer.text, h('div', { class: 'ev', text: 'Evidence: ' + q.pageAnswer.evidence })]));
    }
    if (q.ai) {
      var conf = h('span', { class: 'conf ' + q.ai.confidence, text: q.ai.confidence });
      card.appendChild(h('div', { class: 'ans ai' }, [
        h('b', { text: 'AI answer' }),
        (q.ai.option ? '(' + q.ai.option + ') ' : '') + q.ai.answer, conf,
        q.ai.why ? h('div', { class: 'ev', text: q.ai.why }) : null
      ]));
    }
    var row = h('div', { class: 'row' }, [
      q.el ? h('button', { text: 'Show', onclick: function () { highlight(q); } }) : null,
      h('button', { text: 'Search', onclick: function () { searchWeb(q); } }),
      h('button', { text: 'Copy', onclick: function () { copyText(q.stem + (q.options.length ? '\n' + q.options.map(function (o, i) { return letter(i) + '. ' + o.clean; }).join('\n') : ''), 'Copied question ' + q.n + '.'); } })
    ]);
    card.appendChild(row);
    return card;
  }

  function renderList() {
    var body = h('div', { class: 'body' });
    if (!state.questions.length) {
      body.appendChild(h('div', { class: 'empty', text: 'No questions found on this page. If the quiz is inside a frame from another site, open that frame directly, then tap the bookmarklet again.' }));
      return body;
    }
    var found = state.questions.filter(function (q) { return q.pageAnswer; }).length;
    var tools = h('div', { class: 'row', style: 'margin:0 0 10px' }, [
      h('button', { text: 'Copy for Claude', onclick: copyForClaude }),
      h('button', { text: 'Copy answers', onclick: copyResults })
    ]);
    body.appendChild(tools);
    if (found) body.appendChild(h('div', { class: 'ev', style: 'margin:0 0 8px', text: found + ' answer' + (found === 1 ? '' : 's') + ' found in the page itself; the rest need AI or a search.' }));
    state.questions.forEach(function (q) { body.appendChild(renderQuestion(q)); });
    return body;
  }

  function renderSettings() {
    var s = getSettings();
    var body = h('div', { class: 'body' });
    var keyInput = h('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    keyInput.value = lsGet(LS.key) || '';
    var modelSel = h('select');
    MODELS.forEach(function (m) { var o = h('option', { value: m[0], text: m[1] }); if (m[0] === s.model) o.selected = true; modelSel.appendChild(o); });
    if (!MODELS.some(function (m) { return m[0] === s.model; })) { var oc = h('option', { value: s.model, text: s.model }); oc.selected = true; modelSel.appendChild(oc); }
    var effortSel = h('select');
    EFFORTS.forEach(function (e) { var o = h('option', { value: e[0], text: e[1] }); if (e[0] === s.effort) o.selected = true; effortSel.appendChild(o); });
    var ctxSel = h('select');
    [['on', 'Yes — send page text as context (better for reading questions)'], ['off', 'No — send only the questions (cheaper)']].forEach(function (e) { var o = h('option', { value: e[0], text: e[1] }); if ((s.context ? 'on' : 'off') === e[0]) o.selected = true; ctxSel.appendChild(o); });
    var src = keySource();
    var set = h('div', { class: 'set' }, [
      h('div', {}, [h('label', { text: 'Claude API key' }), keyInput,
        h('p', { text: src === 'bookmarklet' ? 'A key is already built into this bookmarklet. A key saved here overrides it on this website only.' : 'Saved in this browser for this website only. To use one key everywhere, build the bookmarklet with your key on the install page.' })]),
      h('div', {}, [h('label', { text: 'Model' }), modelSel]),
      h('div', {}, [h('label', { text: 'Effort' }), effortSel]),
      h('div', {}, [h('label', { text: 'Page context' }), ctxSel]),
      h('div', { class: 'row' }, [
        h('button', { class: 'p', text: 'Save', onclick: function () {
          lsSet(LS.key, keyInput.value.trim());
          lsSet(LS.model, modelSel.value); lsSet(LS.effort, effortSel.value); lsSet(LS.ctx, ctxSel.value);
          state.view = 'list'; render(); setStatus('Settings saved' + (keyInput.value.trim() ? ' (key stored for ' + location.hostname + ').' : '.'));
        } }),
        h('button', { text: 'Clear key', onclick: function () { lsSet(LS.key, ''); keyInput.value = ''; setStatus('Key removed from this website.'); } })
      ]),
      h('p', { text: 'Question Scanner v' + VERSION + '. Keys are only ever sent to api.anthropic.com.' })
    ]);
    body.appendChild(set);
    return body;
  }

  function render() {
    mount();
    var panel = ui.panel;
    panel.className = 'panel' + (state.min ? ' min' : '');
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.appendChild(renderHeader());
    panel.appendChild(state.view === 'settings' ? renderSettings() : renderList());
    panel.appendChild(h('div', { class: 'ftr' + (state.statusErr ? ' err' : ''), text: state.status }));
  }

  function close() {
    var host = document.getElementById(ROOT_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    ui = null;
  }

  function run() {
    var t0 = Date.now();
    var qs = [];
    try { qs = scan(); } catch (e) { setStatus('Scan error: ' + (e && e.message ? e.message : e), true); }
    qs.forEach(function (q) {
      var cached = state.cache[norm(q.stem)];
      if (cached) {
        q.ai = cached;
        if (cached.option) cached.option.split(/[,\s]+/).forEach(function (L) { var idx = L.trim().toUpperCase().charCodeAt(0) - 65; if (q.options[idx]) q.options[idx].ai = true; });
      }
    });
    state.questions = qs;
    state.view = 'list';
    state.min = false;
    render();
    var found = qs.filter(function (q) { return q.pageAnswer; }).length;
    setStatus('Found ' + qs.length + ' question' + (qs.length === 1 ? '' : 's') + (found ? ', ' + found + ' with an answer on the page' : '') + ' in ' + (Date.now() - t0) + ' ms.' + (qs.length && !getKey() ? ' Add an API key (⚙︎) for AI answers.' : ''));
  }

  window.__qscan = { run: run, close: close, state: state, version: VERSION };
  run();
})(typeof __qscanCfg !== 'undefined' ? __qscanCfg : {});
