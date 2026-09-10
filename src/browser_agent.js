"use strict";
// Tide browser-agent snapshot serializer.
// Injected verbatim as a webview initialization script (wry /
// AddScriptToExecuteOnDocumentCreatedAsync / WKUserScript) — it MUST stay a
// classic script: no import/export syntax.
(function (window, document) {

  var MAX_NODES = 300;
  var MAX_DEPTH = 12;
  var MAX_NAME = 80;

  window.__tideCaps = { MAX_NODES: MAX_NODES, MAX_DEPTH: MAX_DEPTH, MAX_NAME: MAX_NAME };
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

  // innerText approximation: concatenates text nodes, skipping hidden subtrees.
  function visibleText(el) {
    var out = "";
    (function walk(node) {
      if (node.nodeType === 3) {
        out += node.nodeValue || "";
      } else if (node.nodeType === 1 && !isHidden(node)) {
        var kids = node.childNodes;
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
      }
    })(el);
    return out;
  }

  // Name resolution order: aria-label -> alt/placeholder -> innerText (capped).
  function nameFor(el) {
    var label = cap(el.getAttribute("aria-label") || "");
    if (label) return label;
    var attr = attrName(el);
    if (attr) return attr;
    return cap(visibleText(el));
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

  // Would a walk of this subtree emit anything? Used to decide whether a
  // role-less element is a transparent container or a text leaf. Ignores depth
  // and node caps on purpose: transparency is about structure, not budget.
  function subtreeEmits(el) {
    if (isHidden(el)) return false;
    if (deriveRole(el)) return true;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (subtreeEmits(kids[i])) return true;
    }
    return collapse(visibleText(el)) !== "";
  }

  window.__tideSnapshot = function () {
    window.__tideSerial += 1;
    var serial = window.__tideSerial;
    var refs = new Map();
    window.__tideRefs = refs;

    var tree = [];
    var counter = 0;
    var truncated = false;
    var stopped = false;

    // Every element the walk visits consumes a number (emitted or not), so
    // refs stay unique and deterministic: s<serial>e<counter>.
    function nextRef() {
      counter += 1;
      return "s" + serial + "e" + counter;
    }

    function atCap() {
      if (tree.length >= MAX_NODES) {
        truncated = true;
        stopped = true;
        return true;
      }
      return false;
    }

    function push(ref, el, role, name) {
      if (atCap()) return;
      var entry = { ref: ref, role: role, name: name };
      if (role === "textbox") entry.value = inputValue(el);
      if (role === "heading") entry.level = headingLevel(el);
      tree.push(entry);
      refs.set(ref, el);
    }

    function childEmits(el) {
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if (subtreeEmits(kids[i])) return true;
      }
      return false;
    }

    // Free-floating text inside a transparent container: addressable via the
    // parent element.
    function walkText(node) {
      if (atCap()) return;
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
      if (atCap()) return;
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      var ref = nextRef();
      if (isHidden(el)) return;
      var role = deriveRole(el);
      if (role) {
        if (STRUCTURAL_ROLES[role] && childEmits(el)) {
          push(ref, el, role, labelName(el));
          walkChildren(el, depth + 1);
        } else {
          push(ref, el, role, nameFor(el));
        }
        return;
      }
      // Role-less element: transparent container over semantic descendants,
      // otherwise a text leaf.
      if (childEmits(el)) {
        walkChildren(el, depth + 1);
        return;
      }
      var text = cap(visibleText(el));
      if (text) push(ref, el, "text", text);
    }

    var body = document.body;
    if (body && body.nodeType === 1) walkElement(body, 0);

    return JSON.stringify({
      url: document.URL || document.documentURI || "",
      title: document.title || "",
      viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
      ready: document.readyState || "complete",
      tree: tree,
      truncated: truncated
    });
  };
})(window, document);
