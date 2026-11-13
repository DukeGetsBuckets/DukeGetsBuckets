/*
 * Answer Scan bookmarklet.
 * Runs inside whatever page is open: collects the visible text as numbered
 * lines, sends them to the Answer Scan API, then highlights the answer lines
 * and shows a small panel with the answers.
 *
 * __APP__ is replaced by the worker with its own origin when it serves this
 * file, so the bookmarklet always talks to the deployment it came from.
 * Keep this file free of '%' and '#' characters: both break javascript: URLs.
 */
(function () {
  var APP = "__APP__";
  var API = APP + "/api/answer";
  var NS = "__answerScan";
  var GREEN = "rgba(34,197,94,.28)";
  var GREEN_LINE = "rgb(22,163,74)";
  var BLUE = "rgb(37,99,235)";
  var MAX_CHARS = 48000;
  var MAX_LINES = 700;
  /* a literal percent sign would be URL-decoded out of the bookmark; esbuild folds fromCharCode(37), so compute it */
  var PCT = String.fromCharCode(Math.floor(37.5));

  if (window[NS] && window[NS].tap) {
    window[NS].tap();
    return;
  }

  var state = { marks: [], wraps: [], badges: [], panel: null, lines: [], listener: null, gen: 0, hidden: false, keyHandler: null };

  /* ---------- 1. collect the visible text as lines ---------- */

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, SELECT: 1, IFRAME: 1, HEAD: 1, svg: 1, SVG: 1 };
  var BREAK = { LABEL: 1, BUTTON: 1, LI: 1, TD: 1, TH: 1, DT: 1, DD: 1, SUMMARY: 1, LEGEND: 1 };

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function collect() {
    var lines = [];
    var cur = null;
    var block = document.body;
    var total = 0;

    function flush() {
      if (cur && cur.text) lines.push(cur);
      cur = null;
    }

    function walk(node) {
      if (total > MAX_CHARS || lines.length > MAX_LINES) return;
      if (node.nodeType === 3) {
        var t = node.nodeValue.replace(/\s+/g, " ").trim();
        if (!t) return;
        if (!cur) cur = { el: block, nodes: [], text: "" };
        cur.nodes.push(node);
        cur.text += (cur.text ? " " : "") + t;
        total += t.length;
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (SKIP[tag] || node.hasAttribute("data-answerscan")) return;
      if (tag === "BR") { flush(); return; }
      if (!isVisible(node)) return;
      var d = getComputedStyle(node).display;
      var isBlock = (d !== "inline" && d !== "contents") || BREAK[tag];
      var prev = block;
      if (isBlock) { flush(); block = node; }
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (isBlock) { flush(); block = prev; }
      if (tag === "INPUT" && node.value && /^(text|search|number|email)$/.test(node.type) && node.value.trim()) {
        flush();
        lines.push({ el: node, nodes: [], text: "[typed: " + node.value.trim() + "]" });
      }
    }

    walk(document.body);
    flush();
    return lines;
  }

  /* ---------- 2. highlighting ---------- */

  function remember(el) {
    state.marks.push({ el: el, style: el.getAttribute("style") });
  }

  function paint(el, css) {
    remember(el);
    for (var k in css) el.style[k] = css[k];
  }

  function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // Highlight one collected line. If the line is the whole text of its block,
  // style the block; otherwise wrap just this line's text nodes.
  function highlightLine(line, css) {
    if (!line) return null;
    if (line.el && (!line.nodes.length || norm(line.el.textContent) === line.text)) {
      paint(line.el, css);
      return line.el;
    }
    var first = null;
    for (var i = 0; i < line.nodes.length; i++) {
      var n = line.nodes[i];
      if (!n.parentNode) continue;
      var span = document.createElement("span");
      span.setAttribute("data-answerscan", "wrap");
      n.parentNode.insertBefore(span, n);
      span.appendChild(n);
      for (var k in css) span.style[k] = css[k];
      state.wraps.push(span);
      if (!first) first = span;
    }
    return first;
  }

  function badge(target, text, color) {
    if (!target) return;
    var b = document.createElement("span");
    b.setAttribute("data-answerscan", "badge");
    b.textContent = text;
    var s = b.style;
    s.display = "inline-block"; s.marginLeft = "6px"; s.padding = "1px 7px"; s.borderRadius = "999px";
    s.background = color; s.color = "rgb(255,255,255)"; s.font = "600 12px/18px -apple-system,system-ui,sans-serif";
    s.verticalAlign = "middle"; s.whiteSpace = "nowrap"; s.position = "relative"; s.zIndex = "2147483646";
    if (target.tagName === "INPUT") target.parentNode.insertBefore(b, target.nextSibling);
    else target.appendChild(b);
    state.badges.push(b);
  }

  function clearMarks() {
    var i;
    for (i = 0; i < state.badges.length; i++) if (state.badges[i].parentNode) state.badges[i].parentNode.removeChild(state.badges[i]);
    for (i = 0; i < state.wraps.length; i++) {
      var w = state.wraps[i];
      if (!w.parentNode) continue;
      while (w.firstChild) w.parentNode.insertBefore(w.firstChild, w);
      w.parentNode.removeChild(w);
    }
    for (i = state.marks.length - 1; i >= 0; i--) {
      var m = state.marks[i];
      if (m.style === null) m.el.removeAttribute("style"); else m.el.setAttribute("style", m.style);
    }
    state.marks = []; state.wraps = []; state.badges = [];
    state.hidden = false;
  }

  /* ---------- hide / show: the x key toggles everything ---------- */

  function setHidden(hide) {
    hide = !!hide;
    if (hide === state.hidden) return;
    state.hidden = hide;
    var i, m, w;
    if (state.panel) state.panel.style.display = hide ? "none" : "flex";
    if (hide) {
      for (i = state.marks.length - 1; i >= 0; i--) {
        m = state.marks[i];
        m.painted = m.el.getAttribute("style");
        if (m.style === null) m.el.removeAttribute("style"); else m.el.setAttribute("style", m.style);
      }
    } else {
      for (i = 0; i < state.marks.length; i++) {
        m = state.marks[i];
        if (typeof m.painted === "string") m.el.setAttribute("style", m.painted);
      }
    }
    for (i = 0; i < state.wraps.length; i++) {
      w = state.wraps[i];
      if (hide) { w._painted = w.getAttribute("style"); w.removeAttribute("style"); }
      else if (typeof w._painted === "string") w.setAttribute("style", w._painted);
    }
    for (i = 0; i < state.badges.length; i++) state.badges[i].style.display = hide ? "none" : "inline-block";
  }

  function isTyping(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !/^(radio|checkbox|button|submit|reset|range|color|file)$/i.test(t.type || "text");
    return false;
  }

  function onKey(e) {
    if (e.defaultPrevented || e.repeat || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== "x" && e.key !== "X") return;
    if (isTyping(e.target)) return;
    setHidden(!state.hidden);
  }

  function applyAnswers(data) {
    clearMarks();
    var qs = data.questions || [];
    var firstHit = null;
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var qEl = highlightLine(state.lines[q.question_line], { borderLeft: "4px solid " + BLUE, paddingLeft: "6px", borderRadius: "4px" });
      badge(qEl, "Q" + (i + 1), BLUE);
      var hit = false;
      for (var j = 0; j < (q.answer_lines || []).length; j++) {
        var line = state.lines[q.answer_lines[j]];
        if (!line || q.answer_lines[j] === q.question_line) continue;
        var el = highlightLine(line, {
          background: GREEN, outline: "3px solid " + GREEN_LINE, outlineOffset: "2px", borderRadius: "6px",
          boxShadow: "0 0 0 6px rgba(34,197,94,.18)"
        });
        if (el) { hit = true; if (!firstHit) firstHit = el; }
      }
      if (!hit && q.answer) badge(qEl, "Answer: " + q.answer, GREEN_LINE);
    }
    if (firstHit && firstHit.scrollIntoView) {
      try { firstHit.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { }
    }
  }

  /* ---------- 3. panel ---------- */

  function el(tag, css, text) {
    var e = document.createElement(tag);
    e.setAttribute("data-answerscan", "ui");
    if (css) for (var k in css) e.style[k] = css[k];
    if (text) e.textContent = text;
    return e;
  }

  function button(label, onClick, primary) {
    var b = el("button", {
      font: "600 13px/1 -apple-system,system-ui,sans-serif", padding: "9px 12px", borderRadius: "8px",
      border: primary ? "0" : "1px solid rgba(255,255,255,.25)", background: primary ? GREEN_LINE : "transparent",
      color: "rgb(255,255,255)", cursor: "pointer", marginLeft: "6px"
    }, label);
    b.type = "button";
    b.onclick = onClick;
    return b;
  }

  function panel() {
    if (state.panel && state.panel.parentNode) return state.panel;
    var p = el("div", {
      position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647", maxHeight: "46vh",
      display: "flex", flexDirection: "column", background: "rgba(0,0,0,.96)", color: "rgb(249,250,251)",
      font: "14px/1.45 -apple-system,system-ui,sans-serif", borderTop: "1px solid rgba(255,255,255,.18)",
      boxShadow: "0 -8px 30px rgba(0,0,0,.35)", borderRadius: "16px 16px 0 0", textAlign: "left",
      paddingBottom: "env(safe-area-inset-bottom)"
    });
    var head = el("div", { display: "flex", alignItems: "center", padding: "10px 12px", gap: "6px", flex: "0 0 auto" });
    var title = el("div", { fontWeight: "700", flex: "1 1 auto", fontSize: "15px" }, "ejlnab");
    head.appendChild(title);
    head.appendChild(button("Rescan", function () { run(); }, true));
    var close = button("\u2715", function () { setHidden(true); });
    close.setAttribute("aria-label", "Hide the panel and highlights; press x to bring them back");
    close.title = "Hide (press x to show again)";
    close.style.width = "36px"; close.style.height = "36px"; close.style.padding = "0"; close.style.borderRadius = "999px";
    close.style.fontSize = "16px"; close.style.lineHeight = "36px";
    head.appendChild(close);
    var body = el("div", { overflow: "auto", padding: "0 12px 12px", flex: "1 1 auto", WebkitOverflowScrolling: "touch" });
    p.appendChild(head); p.appendChild(body);
    p._title = title; p._body = body;
    document.body.appendChild(p);
    state.panel = p;
    return p;
  }

  function setStatus(text, extra) {
    var p = panel();
    p.style.display = "flex";
    p._body.textContent = "";
    p._body.appendChild(el("div", { padding: "6px 0 10px", opacity: ".9" }, text));
    if (extra) p._body.appendChild(extra);
  }

  function renderPanel(data) {
    var p = panel();
    p.style.display = "flex";
    var qs = data.questions || [];
    p._title.textContent = qs.length + (qs.length === 1 ? " answer" : " answers") + (data.backend ? " · " + data.backend : "");
    p._body.textContent = "";
    if (!qs.length) {
      p._body.appendChild(el("div", { padding: "6px 0" }, "No questions found on this page. Scroll to the questions and tap Rescan."));
      return;
    }
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var row = el("div", { padding: "9px 0", borderTop: i ? "1px solid rgba(255,255,255,.1)" : "0" });
      row.appendChild(el("div", { opacity: ".75", fontSize: "13px", marginBottom: "3px" }, "Q" + (i + 1) + ". " + (q.question || "")));
      var a = el("div", { fontWeight: "700", color: "rgb(134,239,172)", fontSize: "15px" }, (q.answer || "?"));
      if (typeof q.confidence === "number") a.appendChild(el("span", { fontWeight: "400", color: "rgb(156,163,175)", fontSize: "12px", marginLeft: "8px" }, Math.round(q.confidence * 100) + PCT + " sure"));
      row.appendChild(a);
      if (q.explanation) row.appendChild(el("div", { fontSize: "13px", opacity: ".8", marginTop: "2px" }, q.explanation));
      p._body.appendChild(row);
    }
  }

  function showError(msg, payload) {
    var wrap = el("div");
    var b = button("Open results in a new tab", function () { viaPopup(payload, function () { return true; }); }, true);
    b.style.marginLeft = "0";
    wrap.appendChild(b);
    setStatus(msg, payload ? wrap : null);
  }

  function destroy() {
    state.gen++;
    clearMarks();
    if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
    if (state.listener) window.removeEventListener("message", state.listener);
    if (state.keyHandler) document.removeEventListener("keydown", state.keyHandler, true);
    state.panel = null;
    try { delete window[NS]; } catch (e) { window[NS] = null; }
  }

  /* ---------- 4. talking to the API ---------- */

  function payloadFor(lines) {
    var texts = [];
    for (var i = 0; i < lines.length; i++) texts.push(lines[i].text);
    return { lines: texts, url: location.href, title: document.title };
  }

  function finish(data) {
    applyAnswers(data);
    renderPanel(data);
  }

  function popupPreferred() {
    try { return sessionStorage.getItem("answerscan.popup") === "1"; } catch (e) { return false; }
  }

  function viaPopup(payload, live) {
    live = live || function () { return true; };
    try { sessionStorage.setItem("answerscan.popup", "1"); } catch (e) { }
    var w = window.open(APP + "/?relay=1", "answerscan_relay");
    if (!w) { setStatus("Safari blocked the pop-up. Allow pop-ups for this site, then tap the bookmark again."); return; }
    setStatus("Sending the page to the new tab...");
    if (state.listener) window.removeEventListener("message", state.listener);
    state.listener = function (e) {
      if (e.origin !== APP || !e.data || !live()) return;
      if (e.data.type === "answerscan-ready") w.postMessage({ type: "answerscan-scan", payload: payload }, APP);
      else if (e.data.type === "answerscan-result") finish(e.data.data);
      else if (e.data.type === "answerscan-error") setStatus("Error: " + e.data.error);
    };
    window.addEventListener("message", state.listener);
  }

  function run() {
    var gen = ++state.gen;
    var live = function () { return gen === state.gen; };
    setHidden(false);
    clearMarks();
    state.lines = collect();
    var payload = payloadFor(state.lines);
    if (!payload.lines.length) { setStatus("Nothing readable on this page yet. Wait for it to load, then tap Rescan."); return; }
    if (popupPreferred()) { viaPopup(payload, live); return; }
    setStatus("Scanning " + payload.lines.length + " lines...");
    var ok = false;
    try {
      fetch(API, { method: "POST", body: JSON.stringify(payload) })
        .then(function (r) {
          ok = true;
          return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
        })
        .then(function (data) { if (live()) finish(data); })
        .catch(function (err) {
          if (!live()) return;
          if (ok) setStatus("Error: " + (err && err.message ? err.message : err));
          else showError("This site blocks outside requests, so the scan has to run in a new tab.", payload);
        });
    } catch (e) {
      showError("This site blocks outside requests, so the scan has to run in a new tab.", payload);
    }
  }

  function tap() { if (state.hidden) setHidden(false); else run(); }

  state.keyHandler = onKey;
  document.addEventListener("keydown", onKey, true);
  window[NS] = { tap: tap, rescan: run, clear: destroy, hide: function () { setHidden(true); }, show: function () { setHidden(false); } };
  run();
})();
