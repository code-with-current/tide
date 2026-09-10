"use strict";
// Tide browser-agent page side: the snapshot serializer (__tideSnapshot)
// plus the action surface (__tideAct) and the settle helpers the native
// side chains after actions (__tideSettledFor / __tideSettle).
// Injected verbatim as a webview initialization script (wry /
// AddScriptToExecuteOnDocumentCreatedAsync / WKUserScript) — it MUST stay a
// classic script: no import/export syntax.
(function (window, document) {

  var MAX_NODES = 300;
  var MAX_DEPTH = 12;
  var MAX_NAME = 80;
  // Elements examined (walked or scanned) before the traversal gives up.
  // Bounds wrapper-heavy pages where emitted entries are rare.
  var MAX_VISITS = 3000;
  // Raw-character margin for name collection: collecting a little past
  // MAX_NAME keeps the post-collapse slice honest (whitespace runs shrink
  // raw text) without building 100k-char strings.
  var TEXT_MARGIN = 4 * MAX_NAME;

  window.__tideCaps = {
    MAX_NODES: MAX_NODES,
    MAX_DEPTH: MAX_DEPTH,
    MAX_NAME: MAX_NAME,
    MAX_VISITS: MAX_VISITS
  };
  window.__tideSerial = 0;
  window.__tideRefs = new Map();

  // Fixed role set. Structural roles (list/listitem/navigation) may delegate
  // their text to children instead of carrying a name themselves.
  var TAG_ROLES = {
    BUTTON: "button",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    IMG: "img",
    UL: "list",
    OL: "list",
    LI: "listitem",
    NAV: "navigation",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading"
  };
  var BUTTON_INPUT_TYPES = { submit: 1, reset: 1, button: 1, image: 1 };
  var KNOWN_ROLES = {
    link: 1, button: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1,
    heading: 1, img: 1, list: 1, listitem: 1, navigation: 1, text: 1
  };
  var STRUCTURAL_ROLES = { list: 1, listitem: 1, navigation: 1 };
  // Never rendered (UA-stylesheet hidden or inert metadata): their source
  // text must not leak into names or the tree.
  var NON_RENDERED = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  // ---------------------------------------------------------------------
  // Mutation tracker: the clock every settle helper shares. One observer
  // records when the DOM last mutated; __tideSettledFor reports
  // synchronously (the native side polls it — WKWebView's
  // evaluateJavaScript does not await Promises), __tideSettle wraps the
  // same predicate in a Promise for in-page callers and tests.
  // ---------------------------------------------------------------------
  var lastMutationAt = 0;
  var trackerInstalled = false;
  // Flipped only after a successful observe(): a tracker that could not
  // install must not gate anything.
  var mutationObserverAvailable = false;

  function installTracker() {
    if (trackerInstalled) return;
    trackerInstalled = true;
    var Observer = window.MutationObserver;
    if (typeof Observer !== "function") return;
    try {
      new Observer(function () {
        lastMutationAt = Date.now();
      }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      mutationObserverAvailable = true;
    } catch (e) {
      // Observing is best-effort: without it every settle resolves
      // immediately (quietFor reports true), never hangs.
    }
  }

  function quietFor(ms) {
    if (!mutationObserverAvailable) return true;
    return Date.now() - lastMutationAt >= ms;
  }

  // Install at injection time: user scripts run at document-start, so the
  // observer sees the whole DOM build that follows.
  installTracker();

  // Visibility sniffing works on attributes/inline styles only: webviews give
  // us no computed layout here, and host-side tests run under linkedom, which
  // has no layout engine at all.
  function isHidden(el) {
    if ((el.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return true;
    var style = el.getAttribute("style") || "";
    if (/display\s*:\s*none/i.test(style)) return true;
    if (/(?:^|;)\s*width\s*:\s*0(?:\.0+)?\s*(?:px|%)?\s*(?:;|$)/i.test(style)) return true;
    if (/(?:^|;)\s*height\s*:\s*0(?:\.0+)?\s*(?:px|%)?\s*(?:;|$)/i.test(style)) return true;
    return false;
  }

  function skipped(el) {
    return NON_RENDERED[el.tagName] === 1 || isHidden(el);
  }

  // alt="" is ARIA-presentational: the image is decoration, not content.
  function presentationalImg(el) {
    return el.tagName === "IMG" && el.hasAttribute("alt") &&
      collapse(el.getAttribute("alt")) === "";
  }

  function deriveRole(el) {
    var role = (el.getAttribute("role") || "").trim().toLowerCase();
    if (KNOWN_ROLES[role]) return role;
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : null;
    if (el.tagName === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (BUTTON_INPUT_TYPES[type]) return "button";
      return "textbox";
    }
    return TAG_ROLES[el.tagName] || null;
  }

  function collapse(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }

  function cap(s) {
    s = collapse(s);
    return s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s;
  }

  // innerText approximation: concatenates text nodes, skipping hidden and
  // non-rendered subtrees, stopping once `limit` raw chars are collected.
  function visibleText(el, limit) {
    var out = "";
    (function walk(node) {
      if (limit && out.length >= limit) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || "";
      } else if (node.nodeType === 1 && !skipped(node)) {
        var kids = node.childNodes;
        for (var i = 0; i < kids.length; i++) {
          walk(kids[i]);
          if (limit && out.length >= limit) return;
        }
      }
    })(el);
    return out;
  }

  // Existence check for visible text: early-exits on the first non-space
  // character instead of building a string.
  function hasText(el) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) {
        if (/\S/.test(n.nodeValue || "")) return true;
      } else if (n.nodeType === 1 && !skipped(n) && hasText(n)) {
        return true;
      }
    }
    return false;
  }

  // Name resolution order: aria-label -> alt/placeholder -> innerText (capped).
  function nameFor(el) {
    var label = cap(el.getAttribute("aria-label") || "");
    if (label) return label;
    var attr = attrName(el);
    if (attr) return attr;
    return cap(visibleText(el, TEXT_MARGIN));
  }

  // Structural containers with emitting children forgo the innerText fallback:
  // their children carry the text, so a name here would duplicate it.
  function labelName(el) {
    var label = cap(el.getAttribute("aria-label") || "");
    if (label) return label;
    return attrName(el);
  }

  function attrName(el) {
    if (el.tagName === "IMG") {
      var alt = cap(el.getAttribute("alt") || "");
      if (alt) return alt;
    }
    return cap(el.getAttribute("placeholder") || "");
  }

  function headingLevel(el) {
    var aria = parseInt(el.getAttribute("aria-level"), 10);
    if (aria > 0) return aria;
    var tag = /^H([1-6])$/.exec(el.tagName);
    if (tag) return Number(tag[1]);
    return 2; // ARIA default for role=heading without aria-level
  }

  function inputValue(el) {
    var v = el.value;
    if (v == null) v = el.getAttribute("value");
    if (v == null && el.tagName === "TEXTAREA") v = el.textContent;
    return v == null ? "" : String(v);
  }

  // The name the snapshot would emit for `el` right now — the staleness
  // half of the ref contract. `role` is the role the snapshot recorded:
  // structural roles delegate their name to children exactly the way the
  // walk does, so recomputation cannot disagree with what was stored.
  function snapshotName(el, role) {
    return STRUCTURAL_ROLES[role] && childEmitsUnbudgeted(el)
      ? labelName(el)
      : nameFor(el);
  }

  // The role the snapshot would emit for `el` right now: the semantic
  // role, or "text" for a role-less text leaf, or null for anything the
  // walk would skip or recurse through without an entry of its own.
  function snapshotRole(el) {
    if (skipped(el)) return null;
    var role = deriveRole(el);
    if (role) return presentationalImg(el) ? null : role;
    if (childEmitsUnbudgeted(el)) return null;
    return hasText(el) ? "text" : null;
  }

  // Budget-free twins of the walk's transparency scans: the walk caps its
  // work per snapshot, staleness verification must answer for any element
  // the map holds. They share the predicates (skipped / deriveRole /
  // presentationalImg / hasText) so the answers cannot drift.
  function subtreeEmitsUnbudgeted(el) {
    if (skipped(el)) return false;
    var role = deriveRole(el);
    if (role) return !presentationalImg(el);
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (subtreeEmitsUnbudgeted(kids[i])) return true;
    }
    return hasText(el);
  }

  function childEmitsUnbudgeted(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (subtreeEmitsUnbudgeted(kids[i])) return true;
    }
    return false;
  }

  window.__tideSnapshot = function () {
    // Never throw raw: every __tide* function the native side evaluates
    // answers with what JSON.stringify produces, failures included — the
    // bridge's `finish` only has to parse, never to catch.
    try {
      return JSON.stringify(snapshot());
    } catch (e) {
      return JSON.stringify({ ok: false, error: errorMessage(e) });
    }
  };

  function snapshot() {
    window.__tideSerial += 1;
    var serial = window.__tideSerial;
    var refs = new Map();
    window.__tideRefs = refs;

    var tree = [];
    var counter = 0;
    var truncated = false;
    var stopped = false;
    // Walk visits + existence-scan examinations share one budget; memoizing
    // the scans keeps each element's answer computed at most once per
    // snapshot, so wrapper-heavy DOMs cost O(visits), not O(depth x visits).
    var visited = 0;
    var emits = new Map();

    // Every element the walk visits consumes a number (emitted or not), so
    // refs stay unique and deterministic: s<serial>e<counter>.
    function nextRef() {
      counter += 1;
      return "s" + serial + "e" + counter;
    }

    // The one place node-cap truncation is flagged: an entry that would be
    // pushed cannot fit. Whitespace or hidden content past the cap must not
    // set the flag. The ref map only grows through here, after the cap
    // check, so it is bounded by MAX_NODES entries per snapshot and rebuilt
    // from scratch on the next one — it cannot grow unboundedly.
    function push(ref, el, role, name) {
      if (tree.length >= MAX_NODES) {
        truncated = true;
        stopped = true;
        return;
      }
      var entry = { ref: ref, role: role, name: name };
      if (role === "textbox") entry.value = inputValue(el);
      if (role === "heading") entry.level = headingLevel(el);
      tree.push(entry);
      // The record carries the emitted role+name: __tideAct's staleness
      // verification recomputes both and compares against what the
      // snapshot promised the model.
      refs.set(ref, { el: el, role: role, name: name });
    }

    // Would a walk of this subtree emit anything? Used to decide whether a
    // role-less element is a transparent container or a text leaf. Ignores
    // depth and node caps on purpose: transparency is about structure, not
    // budget. Once the visit budget dies it reports "emits" so every caller
    // unwinds; the walk's stopped flag ends everything.
    function subtreeEmits(el) {
      if (stopped) return true;
      var cached = emits.get(el);
      if (cached !== undefined) return cached;
      if (visited >= MAX_VISITS) {
        truncated = true;
        stopped = true;
        return true;
      }
      visited += 1;
      var result;
      if (skipped(el)) {
        result = false;
      } else if (deriveRole(el)) {
        result = !presentationalImg(el);
      } else {
        result = false;
        var kids = el.children;
        for (var i = 0; i < kids.length && !result; i++) result = subtreeEmits(kids[i]);
        if (!result) result = hasText(el);
      }
      emits.set(el, result);
      return result;
    }

    function childEmits(el) {
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if (subtreeEmits(kids[i])) return true;
      }
      return false;
    }

    // Free-floating text inside a transparent container: addressable via the
    // parent element. Whitespace-only nodes are dropped before any cap logic
    // so they can never be the reason truncation gets flagged.
    function walkText(node) {
      if (stopped) return;
      var text = cap(node.nodeValue || "");
      if (!text) return;
      var ref = nextRef();
      push(ref, node.parentNode || node, "text", text);
    }

    function walkNode(node, depth) {
      if (stopped) return;
      if (node.nodeType === 3) {
        walkText(node);
        return;
      }
      if (node.nodeType !== 1) return;
      walkElement(node, depth);
    }

    function walkChildren(el, depth) {
      var kids = el.childNodes;
      for (var i = 0; i < kids.length && !stopped; i++) {
        walkNode(kids[i], depth);
      }
    }

    function walkElement(el, depth) {
      if (stopped) return;
      if (visited >= MAX_VISITS) {
        truncated = true;
        stopped = true;
        return;
      }
      visited += 1;
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      var ref = nextRef();
      if (skipped(el)) return;
      var role = deriveRole(el);
      if (role) {
        if (presentationalImg(el)) return;
        if (STRUCTURAL_ROLES[role] && childEmits(el)) {
          push(ref, el, role, snapshotName(el, role));
          walkChildren(el, depth + 1);
        } else {
          push(ref, el, role, snapshotName(el, role));
        }
        return;
      }
      // Role-less element: transparent container over semantic descendants,
      // otherwise a text leaf.
      if (childEmits(el)) {
        walkChildren(el, depth + 1);
        return;
      }
      var text = cap(visibleText(el, TEXT_MARGIN));
      if (text) push(ref, el, "text", text);
    }

    var body = document.body;
    if (body && body.nodeType === 1) walkElement(body, 0);

    return {
      url: document.URL || document.documentURI || "",
      title: document.title || "",
      viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
      ready: document.readyState || "complete",
      tree: tree,
      truncated: truncated
    };
  }

  // ---------------------------------------------------------------------
  // Actions — __tideAct(ref, action, payload). The staleness contract:
  // a ref resolves only against the live map, only while the element is
  // still connected AND its role+name still match what the snapshot
  // recorded; anything else answers the one stale shape and the model
  // re-snapshots. Actions answer `{ ok: true, ... }` objects; failures
  // answer `{ ok: false, stale?: true, error? }` — JSON.stringify'ed on
  // the way out, exactly like snapshots.
  // ---------------------------------------------------------------------

  function errorMessage(e) {
    if (e && typeof e.message === "string") return e.message;
    try {
      return String(e);
    } catch (x) {
      return "unknown page error";
    }
  }

  function stale(reason) {
    return {
      ok: false,
      stale: true,
      reason: "the page changed under you - " + reason + "; call browser_get_state for a fresh snapshot"
    };
  }

  function isConnected(el) {
    if (typeof el.isConnected === "boolean") return el.isConnected;
    var doc = el.ownerDocument || document;
    return typeof doc.contains === "function" ? doc.contains(el) : true;
  }

  function resolveRef(ref) {
    if (typeof ref !== "string" || !ref) {
      return stale("the action needs a ref from a browser_get_state snapshot");
    }
    var record = window.__tideRefs.get(ref);
    if (!record || !record.el) {
      return stale("ref " + ref + " is not in the current snapshot");
    }
    var el = record.el;
    if (!isConnected(el)) {
      return stale("ref " + ref + " left the document");
    }
    if (snapshotRole(el) !== record.role) {
      return stale("ref " + ref + " no longer has role " + record.role);
    }
    if (snapshotName(el, record.role) !== record.name) {
      return stale("ref " + ref + " no longer answers to its recorded name");
    }
    return { el: el };
  }

  // --- event synthesis -------------------------------------------------
  // Hosts differ in which DOM constructors they expose (WebKit has them
  // all; linkedom only Event), so every constructor use falls back down
  // the chain and the payload keys are re-applied on the instance when
  // the constructor dropped them. Synthesized events are untrusted:
  // pages filtering on isTrusted ignore them (the design's known limit),
  // and default actions do not run, so click() re-implements the
  // activation behaviors itself.

  function eventCtor(kind) {
    if (kind === "pointer") {
      return window.PointerEvent || window.MouseEvent || window.Event;
    }
    if (kind === "mouse") return window.MouseEvent || window.Event;
    if (kind === "keyboard") return window.KeyboardEvent || window.Event;
    return window.Event;
  }

  function fireEvent(el, type, kind, init) {
    var Ctor = eventCtor(kind);
    var event;
    try {
      event = new Ctor(type, init);
    } catch (e) {
      event = document.createEvent("Event");
      event.initEvent(type, !!init.bubbles, !!init.cancelable);
    }
    for (var key in init) {
      if (init.hasOwnProperty(key) && event[key] === undefined) {
        try {
          event[key] = init[key];
        } catch (x) {
          // Read-only on this host: the constructor already carried it.
        }
      }
    }
    el.dispatchEvent(event);
    return event;
  }

  function rectOf(el) {
    try {
      var rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    } catch (e) {
      return { x: 0, y: 0 };
    }
  }

  function centerOf(el) {
    var rect = rectOf(el);
    var x = rect.x, y = rect.y;
    try {
      var box = el.getBoundingClientRect();
      if (typeof box.width === "number") x += box.width / 2;
      if (typeof box.height === "number") y += box.height / 2;
    } catch (e) {
      /* fall back to the origin */
    }
    return { x: x, y: y };
  }

  // --- click -------------------------------------------------------------

  function formOf(el) {
    if (typeof el.closest === "function") {
      try {
        var form = el.closest("form");
        if (form) return form;
      } catch (e) {
        /* fall through to the property */
      }
    }
    if (el.form) return el.form;
    return null;
  }

  function isSubmitControl(el) {
    if (el.tagName === "BUTTON") {
      return (el.getAttribute("type") || "submit").toLowerCase() === "submit";
    }
    if (el.tagName === "INPUT") {
      var type = (el.getAttribute("type") || "").toLowerCase();
      return type === "submit" || type === "image";
    }
    return false;
  }

  function ancestorTag(el, tag) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.tagName === tag) return node;
      node = node.parentNode;
    }
    return null;
  }

  function submitForm(form) {
    if (!form) return false;
    if (typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
        return true;
      } catch (e) {
        /* fall through */
      }
    }
    if (typeof form.submit === "function") {
      try {
        form.submit();
        return true;
      } catch (e) {
        /* fall through */
      }
    }
    // Hosts without form submission (and the test DOM): the submit event
    // itself, cancelable like the real one.
    fireEvent(form, "submit", "generic", { bubbles: true, cancelable: true });
    return true;
  }

  // The default action a trusted click would have run: toggles checkboxes
  // and radios, submits forms from submit controls, follows links.
  function activate(el) {
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
      el.checked = type === "radio" ? true : !el.checked;
      fireEvent(el, "input", "generic", { bubbles: true });
      fireEvent(el, "change", "generic", { bubbles: true });
      return "toggled";
    }
    var form = formOf(el);
    if (form && isSubmitControl(el)) {
      submitForm(form);
      return "submitted";
    }
    var link = ancestorTag(el, "A");
    if (link) {
      var href = link.getAttribute("href");
      if (href) {
        try {
          window.location.href = href;
          return "navigated";
        } catch (e) {
          /* hosts without a location (test DOMs) stop here */
        }
      }
    }
    return "none";
  }

  function actClick(el) {
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center" });
      } catch (e) {
        /* hosts without layout scroll skip it */
      }
    }
    var at = centerOf(el);
    var base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: at.x,
      clientY: at.y
    };
    var down = {};
    var up = {};
    for (var key in base) {
      down[key] = base[key];
      up[key] = base[key];
    }
    down.buttons = 1;
    up.buttons = 0;
    // The full pointer/mouse sequence, never .click(): frameworks listen
    // for pointerdown/mousedown, and the synthetic click closes the loop
    // for plain listeners.
    var pressed = fireEvent(el, "pointerdown", "pointer", down);
    fireEvent(el, "mousedown", "mouse", down);
    var released = fireEvent(el, "pointerup", "pointer", up);
    fireEvent(el, "mouseup", "mouse", up);
    var click = fireEvent(el, "click", "mouse", up);
    var prevented =
      click.defaultPrevented || pressed.defaultPrevented || released.defaultPrevented;
    var activation = prevented ? "prevented" : activate(el);
    return { ok: true, action: "click", activation: activation };
  }

  // --- type --------------------------------------------------------------

  function isContentEditable(el) {
    if (el.isContentEditable === true) return true;
    if (typeof el.hasAttribute !== "function" || !el.hasAttribute("contenteditable")) {
      return false;
    }
    var attr = (el.getAttribute("contenteditable") || "").toLowerCase();
    return attr === "" || attr === "true" || attr === "plaintext-only";
  }

  function selectAllOf(el) {
    if (isContentEditable(el)) {
      try {
        var selection = document.getSelection();
        if (selection) {
          var range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch (e) {
        /* hosts without a selection API fall through to replace */
      }
      return;
    }
    try {
      if (typeof el.select === "function") {
        el.select();
      } else if (typeof el.setSelectionRange === "function") {
        el.setSelectionRange(0, (el.value || "").length);
      }
    } catch (e) {
      /* replacement below does not need a selection */
    }
  }

  // The prototype's setter, not the instance property: React (and framework
  // value trackers generally) cache the last value they saw on the instance,
  // so only a prototype write reads back as an external change and fires
  // the page's change handlers.
  function prototypeSetter(el, prop) {
    var proto = Object.getPrototypeOf(el);
    while (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (descriptor && descriptor.set) return descriptor.set;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  function replaceValue(el, text) {
    if (isContentEditable(el)) {
      el.textContent = text;
      fireEvent(el, "input", "generic", { bubbles: true });
      return;
    }
    var setter = prototypeSetter(el, "value");
    if (setter) setter.call(el, text);
    else el.value = text;
    fireEvent(el, "input", "generic", { bubbles: true });
    fireEvent(el, "change", "generic", { bubbles: true });
  }

  function pressEnterOn(el) {
    var init = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13
    };
    var keydown = fireEvent(el, "keydown", "keyboard", init);
    fireEvent(el, "keyup", "keyboard", init);
    if (keydown.defaultPrevented) return false;
    var form = formOf(el);
    if (!form) return false;
    submitForm(form);
    return true;
  }

  function actType(el, payload) {
    var text = payload.text == null ? "" : String(payload.text);
    if (typeof el.focus === "function") {
      try {
        el.focus();
      } catch (e) {
        /* focus is best-effort */
      }
    }
    selectAllOf(el);
    // Preferred path: per-char insertText at the caret — the browser fires
    // the input events itself and editing widgets (IME, autocomplete) stay
    // coherent, on inputs and contenteditables alike. Hosts without
    // execCommand (WebKit deprecation windows, linkedom) take the
    // React-safe replacement below with the whole text.
    var typed = false;
    if (typeof document.execCommand === "function") {
      typed = true;
      for (var i = 0; i < text.length; i++) {
        try {
          if (!document.execCommand("insertText", false, text.charAt(i))) {
            typed = false;
            break;
          }
        } catch (e) {
          typed = false;
          break;
        }
      }
    }
    if (!typed) replaceValue(el, text);
    var submitted = payload.submit ? pressEnterOn(el) : false;
    return {
      ok: true,
      action: "type",
      value: isContentEditable(el) ? el.textContent : inputValue(el),
      submitted: submitted
    };
  }

  // --- press_key ---------------------------------------------------------

  var KEY_NAMES = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    return: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    del: { key: "Delete", code: "Delete", keyCode: 46 },
    insert: { key: "Insert", code: "Insert", keyCode: 45 },
    space: { key: " ", code: "Space", keyCode: 32 },
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 }
  };
  for (var fn = 1; fn <= 12; fn++) {
    KEY_NAMES["f" + fn] = { key: "F" + fn, code: "F" + fn, keyCode: 111 + fn };
  }
  var MODIFIERS = {
    ctrl: "ctrlKey",
    control: "ctrlKey",
    alt: "altKey",
    option: "altKey",
    shift: "shiftKey",
    meta: "metaKey",
    super: "metaKey",
    cmd: "metaKey",
    command: "metaKey"
  };

  function parseKeyCombo(spec) {
    var parts = String(spec).split("+");
    var mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    var main = null;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim().toLowerCase();
      if (!part) continue;
      if (MODIFIERS[part]) {
        mods[MODIFIERS[part]] = true;
      } else if (main === null) {
        main = part;
      } else {
        return { error: "press_key takes one key plus modifiers, got " + spec };
      }
    }
    if (main === null) {
      return { error: "press_key needs a key, not just modifiers" };
    }
    var named = KEY_NAMES[main];
    if (named) {
      var combo = { key: named.key, code: named.code, keyCode: named.keyCode, charCode: 0 };
      for (var mod in mods) combo[mod] = mods[mod];
      return combo;
    }
    if (main.length === 1) {
      var upper = main.toUpperCase();
      var single = {
        key: main,
        code: main === " " ? "Space" : upper,
        keyCode: upper.charCodeAt(0),
        charCode: upper.charCodeAt(0)
      };
      for (var mod2 in mods) single[mod2] = mods[mod2];
      return single;
    }
    return { error: "press_key does not know the key name " + main };
  }

  function keyTarget() {
    var active = document.activeElement;
    if (active && active.nodeType === 1) return active;
    return document.body || document.documentElement;
  }

  function actPressKey(payload) {
    var combo = parseKeyCombo(payload.key == null ? "" : payload.key);
    if (combo.error) return { ok: false, error: combo.error };
    var target = keyTarget();
    if (!target) return { ok: false, error: "the page has no element to key into" };
    var init = {
      bubbles: true,
      cancelable: true,
      key: combo.key,
      code: combo.code,
      keyCode: combo.keyCode,
      which: combo.keyCode || combo.charCode,
      charCode: combo.charCode,
      ctrlKey: !!combo.ctrlKey,
      altKey: !!combo.altKey,
      shiftKey: !!combo.shiftKey,
      metaKey: !!combo.metaKey
    };
    var keydown = fireEvent(target, "keydown", "keyboard", init);
    fireEvent(target, "keyup", "keyboard", init);
    return {
      ok: true,
      action: "press_key",
      key: combo.key,
      modifiers: Object.keys(combo)
        .filter(function (mod) {
          return /Key$/.test(mod) && combo[mod];
        })
        .map(function (mod) {
          return mod.slice(0, -3);
        }),
      defaultPrevented: keydown.defaultPrevented
    };
  }

  // --- scroll ------------------------------------------------------------

  var SCROLL_DIRECTIONS = { up: 1, down: 1, left: 1, right: 1 };

  function applyScroll(target, horizontal, delta) {
    if (typeof target.scrollBy === "function") {
      try {
        target.scrollBy(horizontal ? delta : 0, horizontal ? 0 : delta);
        return true;
      } catch (e) {
        /* fall through to the property writes */
      }
    }
    try {
      if (horizontal) target.scrollLeft += delta;
      else target.scrollTop += delta;
      return true;
    } catch (e) {
      return false;
    }
  }

  function actScroll(el, payload) {
    var direction = String(payload.direction || "down").toLowerCase();
    if (!SCROLL_DIRECTIONS[direction]) {
      return { ok: false, error: "scroll direction must be up, down, left or right" };
    }
    var amount = Number(payload.amount);
    if (!isFinite(amount) || amount <= 0) amount = 1;
    // Page-fraction scrolling: one unit is one live viewport of the page
    // (or of the ref'd scrollable), the amount Playwright-style tools call
    // a page and fractional values honor.
    var vertical = direction === "up" || direction === "down";
    var backward = direction === "up" || direction === "left";
    var span = vertical
      ? (el ? el.clientHeight : window.innerHeight) || 0
      : (el ? el.clientWidth : window.innerWidth) || 0;
    var delta = Math.round((backward ? -1 : 1) * amount * span);
    var scrolled;
    if (el) {
      scrolled = applyScroll(el, !vertical, delta);
    } else {
      scrolled = applyScroll(window, !vertical, delta);
      if (!scrolled && document.documentElement) {
        scrolled = applyScroll(document.documentElement, !vertical, delta);
      }
    }
    return {
      ok: true,
      action: "scroll",
      direction: direction,
      amount: amount,
      dx: vertical ? 0 : delta,
      dy: vertical ? delta : 0,
      scrolled: scrolled
    };
  }

  function act(ref, action, payload) {
    if (!payload || typeof payload !== "object") payload = {};
    if (action === "press_key") {
      return actPressKey(payload);
    }
    // Viewport scroll needs no ref; every other action addresses one.
    if (action === "scroll" && (ref == null || ref === "")) {
      return actScroll(null, payload);
    }
    var resolved = resolveRef(ref);
    if (resolved.stale) return resolved;
    var el = resolved.el;
    if (action === "click") return actClick(el);
    if (action === "type") return actType(el, payload);
    if (action === "scroll") return actScroll(el, payload);
    return { ok: false, error: "unknown browser action: " + action };
  }

  window.__tideAct = function (ref, action, payload) {
    try {
      return JSON.stringify(act(ref, action, payload));
    } catch (e) {
      return JSON.stringify({ ok: false, error: errorMessage(e) });
    }
  };

  // Synchronous quiet predicate — the native settle loop polls this,
  // because WKWebView's evaluateJavaScript hands a Promise back as an
  // opaque object instead of awaiting it (WebKit awaits only
  // callAsyncJavaScript). Answers JSON, like everything else that crosses.
  window.__tideSettledFor = function (ms) {
    try {
      return JSON.stringify(quietFor(Math.max(0, Number(ms) || 0)));
    } catch (e) {
      return JSON.stringify(true);
    }
  };

  // The Promise flavor for in-page callers: resolves once the DOM has been
  // quiet for `ms`, re-arming on every mutation that lands first, capped so
  // chatty pages (carousels, animation-driven SPAs) still settle.
  window.__tideSettle = function (ms) {
    ms = Math.max(0, Number(ms) || 0);
    var cap = ms + 1600;
    var start = Date.now();
    return new Promise(function (resolve) {
      (function check() {
        if (quietFor(ms) || Date.now() - start >= cap) return resolve(true);
        setTimeout(check, 40);
      })();
    });
  };
})(window, document);
