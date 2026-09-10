import { describe, test, expect } from "bun:test";
import { parseHTML } from "linkedom";

// Load the serializer as a CLASSIC script: the text of browser_agent.js is run
// via `new Function` with the linkedom window/document bound to the bare
// `window`/`document` identifiers the script uses.
const scriptPath = `${import.meta.dir}/browser_agent.js`;
const fixturePath = (name: string) => `${import.meta.dir}/browser_agent_fixtures/${name}`;

interface TreeEntry {
  ref: string;
  role: string;
  name: string;
  value?: string;
  level?: number;
}

interface Snapshot {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  ready: string;
  tree: TreeEntry[];
  truncated: boolean;
}

interface TideWindow {
  __tideSnapshot(): string;
  __tideAct(ref: string | null, action: string, payload: unknown): string;
  __tideSettle(ms: number): Promise<boolean>;
  __tideSettledFor(ms: number): string;
  __tideSerial: number;
  __tideRefs: Map<string, { el: any; role: string; name: string }>;
  __tideCaps: { MAX_NODES: number; MAX_DEPTH: number; MAX_NAME: number };
  innerWidth: number;
  innerHeight: number;
  scrollBy?(x: number, y: number): void;
}

async function loadFixture(name: string): Promise<TideWindow> {
  const script = await Bun.file(scriptPath).text();
  const html = await Bun.file(fixturePath(name)).text();
  const { window, document } = parseHTML(html);
  // linkedom implements no layout or viewport: approximate a 1280x800 window
  // (the script reads innerWidth/innerHeight at snapshot time).
  (window as unknown as TideWindow).innerWidth = 1280;
  (window as unknown as TideWindow).innerHeight = 800;
  new Function("window", "document", "self", script)(window, document, window);
  return window as unknown as TideWindow;
}

/// The fixture's window AND document — the act tests need element handles.
async function loadPage(name: string): Promise<{ win: TideWindow; document: Document }> {
  const script = await Bun.file(scriptPath).text();
  const html = await Bun.file(fixturePath(name)).text();
  const { window, document } = parseHTML(html);
  (window as unknown as TideWindow).innerWidth = 1280;
  (window as unknown as TideWindow).innerHeight = 800;
  new Function("window", "document", "self", script)(window, document, window);
  return { win: window as unknown as TideWindow, document };
}

function snap(win: TideWindow): Snapshot {
  const raw = win.__tideSnapshot();
  expect(typeof raw).toBe("string");
  return JSON.parse(raw) as Snapshot;
}

const byRole = (s: Snapshot, role: string) => s.tree.filter((e) => e.role === role);
const findEntry = (s: Snapshot, role: string, name: string) =>
  s.tree.find((e) => e.role === role && e.name === name);
const names = (s: Snapshot) => s.tree.map((e) => e.name);

describe("__tideSnapshot golden tree (login fixture)", () => {
  test("produces the design doc's exact tree shape", async () => {
    const s = await loadFixture("login.html").then(snap);
    // linkedom documents have no URL/readyState (both undefined); the script
    // falls back to "" / "complete" for them.
    expect(s).toEqual({
      url: "",
      title: "Sign in",
      viewport: { w: 1280, h: 800 },
      ready: "complete",
      tree: [
        { ref: "s1e2", role: "heading", name: "Sign in", level: 1 },
        { ref: "s1e5", role: "textbox", name: "Email", value: "" },
        { ref: "s1e6", role: "text", name: "Use your work account" },
        { ref: "s1e8", role: "button", name: "Continue" },
      ],
      truncated: false,
    });
  });
});

describe("__tideSnapshot output contract", () => {
  test("parses as JSON with exactly the contract keys", async () => {
    const s = await loadFixture("login.html").then(snap);
    expect(Object.keys(s).sort()).toEqual(
      ["ready", "title", "tree", "truncated", "url", "viewport"].sort(),
    );
    expect(typeof s.url).toBe("string");
    expect(typeof s.title).toBe("string");
    expect(typeof s.ready).toBe("string");
    expect(Array.isArray(s.tree)).toBe(true);
    expect(typeof s.truncated).toBe("boolean");
  });

  test("exposes caps and starts the serial at 0", async () => {
    const win = await loadFixture("login.html");
    expect(win.__tideCaps).toEqual({ MAX_NODES: 300, MAX_DEPTH: 12, MAX_NAME: 80, MAX_VISITS: 3000 });
    // serial is 0 before any snapshot, 1 after the first call
    expect(win.__tideSerial).toBe(0);
    win.__tideSnapshot();
    expect(win.__tideSerial).toBe(1);
  });
});

describe("name resolution order", () => {
  test("aria-label wins over innerText", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    expect(findEntry(s, "button", "Close panel")).toBeDefined();
    expect(findEntry(s, "button", "X")).toBeUndefined();
  });

  test("alt names images", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    expect(findEntry(s, "img", "Company logo")).toBeDefined();
  });

  test("placeholder names inputs; value is carried separately", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    const box = findEntry(s, "textbox", "Search products");
    expect(box).toBeDefined();
    expect(box!.value).toBe("wireless mouse");
  });

  test("innerText fallback is whitespace-collapsed and capped at 80 chars", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    const link = byRole(s, "link").find((e) => e.name.startsWith("Read the full"));
    expect(link).toBeDefined();
    expect(link!.name).toBe(
      "Read the full documentation for every endpoint, including authentication, rate l",
    );
    expect(link!.name.length).toBe(80);
    expect(findEntry(s, "button", "Hello World")).toBeDefined();
  });
});

describe("role derivation", () => {
  test("heading from role + aria-level; textbox from role", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    const h = findEntry(s, "heading", "Custom heading");
    expect(h).toBeDefined();
    expect(h!.level).toBe(3);
    expect(findEntry(s, "textbox", "Notes")).toBeDefined();
  });

  test("checkbox, radio, combobox", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    expect(findEntry(s, "checkbox", "Remember me")).toBeDefined();
    expect(findEntry(s, "radio", "Dark mode")).toBeDefined();
    expect(findEntry(s, "combobox", "Country")).toBeDefined();
  });

  test("list/listitem/navigation; structural containers delegate names to children", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    expect(findEntry(s, "navigation", "Main menu")).toBeDefined();
    const list = findEntry(s, "list", "");
    expect(list).toBeDefined();
    // <li><a>Home</a></li> — listitem defers to the link, not duplicating its text
    expect(findEntry(s, "listitem", "")).toBeDefined();
    expect(findEntry(s, "link", "Home")).toBeDefined();
    // <li>Bulletins</li> — text-only listitem carries its own name
    expect(findEntry(s, "listitem", "Bulletins")).toBeDefined();
    expect(byRole(s, "listitem").some((e) => e.name === "Home")).toBe(false);
  });

  test("a without href is not a link; unknown text becomes role text", async () => {
    const s = await loadFixture("name_order.html").then(snap);
    expect(findEntry(s, "text", "Not a link without href")).toBeDefined();
    expect(byRole(s, "link").some((e) => e.name === "Not a link without href")).toBe(false);
  });
});

describe("hostile fixture: hidden, zero-size, deep, truncated", () => {
  test("skips aria-hidden subtrees, display:none, zero-size, hidden inputs", async () => {
    const s = await loadFixture("hostile.html").then(snap);
    // linkedom has no layout engine, so these tests approximate visibility via
    // inline styles / attributes: display:none, width:0;height:0, `hidden`-style
    // semantics, and aria-hidden — exactly what the serializer sniffs.
    expect(names(s)).not.toContain("Hidden from the a11y tree");
    expect(names(s)).not.toContain("Invisible text");
    expect(names(s)).not.toContain("Tiny tracker");
    expect(s.tree.some((e) => e.value === "abc123")).toBe(false);
    // survivors
    expect(findEntry(s, "heading", "Dashboard")).toBeDefined();
    expect(findEntry(s, "link", "Visible link")).toBeDefined();
    expect(findEntry(s, "heading", "Dashboard")!.level).toBe(2);
  });

  test("caps depth at 12 and flags truncated", async () => {
    const s = await loadFixture("hostile.html").then(snap);
    // the <p> sits at depth 16 inside 15 nested divs — must be cut
    expect(names(s)).not.toContain("Way too deep");
    expect(s.truncated).toBe(true);
  });
});

describe("non-rendered metadata and presentational images", () => {
  test("script/style/noscript/template source text never leaks into the tree", async () => {
    const s = await loadFixture("nonrendered.html").then(snap);
    const all = names(s).join("|");
    expect(all).not.toContain("secret");
    expect(all).not.toContain("leaky tokens");
    expect(all).not.toContain("color: red");
    expect(all).not.toContain("style body text");
    expect(all).not.toContain("Enable JavaScript to continue");
    expect(all).not.toContain("Template button");
    expect(byRole(s, "button").length).toBe(0);
    expect(s.truncated).toBe(false);
    // survivors
    expect(findEntry(s, "heading", "Real content")).toBeDefined();
    expect(findEntry(s, "text", "After metadata")).toBeDefined();
  });

  test("img with alt=\"\" is ARIA-presentational and skipped", async () => {
    const s = await loadFixture("nonrendered.html").then(snap);
    expect(byRole(s, "img").length).toBe(0);
    expect(names(s)).not.toContain("");
  });
});

describe("depth off-by-one", () => {
  test("element at exactly depth 12 is emitted; depth 13 is cut and flagged", async () => {
    const s = await loadFixture("depth_edge.html").then(snap);
    expect(findEntry(s, "text", "Visible at depth twelve")).toBeDefined();
    expect(names(s)).not.toContain("Cut at depth thirteen");
    expect(s.truncated).toBe(true);
  });
});

describe("truncated flag hygiene", () => {
  test("exactly 300 entries followed by whitespace/hidden content stays unflagged", async () => {
    const s = await loadFixture("exact_cap.html").then(snap);
    // 1 list + 299 listitems = exactly MAX_NODES; the trailing whitespace
    // text node, display:none div, and aria-hidden span are dropped without
    // being emit-able, so they must NOT set truncated.
    expect(s.tree.length).toBe(300);
    expect(s.truncated).toBe(false);
    expect(names(s)).toContain("Item 299");
    expect(names(s)).not.toContain("ghost");
    expect(names(s)).not.toContain("phantom");
  });
});

describe("node cap and ref discipline", () => {
  test("caps at 300 nodes with truncated flag and unique refs", async () => {
    const s = await loadFixture("many.html").then(snap);
    expect(s.tree.length).toBe(300);
    expect(s.truncated).toBe(true);
    expect(names(s)).toContain("Item 1");
    expect(names(s)).toContain("Item 299"); // last emitted li
    expect(names(s)).not.toContain("Item 300");
    const refs = s.tree.map((e) => e.ref);
    expect(new Set(refs).size).toBe(300);
    for (const ref of refs) expect(ref).toMatch(/^s1e\d+$/);
  });

  test("refs are snapshot-scoped: serial increments, map rebuilt, no collisions", async () => {
    const win = await loadFixture("login.html");
    const s1 = snap(win);
    const s2 = snap(win);
    expect(win.__tideSerial).toBe(2);
    const refs1 = s1.tree.map((e) => e.ref);
    const refs2 = s2.tree.map((e) => e.ref);
    for (const ref of refs1) expect(ref).toMatch(/^s1e\d+$/);
    for (const ref of refs2) expect(ref).toMatch(/^s2e\d+$/);
    expect(refs1.filter((r) => refs2.includes(r))).toEqual([]);
    // ref map is rebuilt per snapshot: only the latest refs resolve, to
    // records carrying the element plus the role/name the snapshot promised
    expect(win.__tideRefs.size).toBe(s2.tree.length);
    for (const ref of refs2) {
      const record = win.__tideRefs.get(ref);
      expect(record).toBeDefined();
      expect(typeof record!.el.tagName).toBe("string");
      expect(typeof record!.role).toBe("string");
      expect(typeof record!.name).toBe("string");
    }
    for (const ref of refs1) expect(win.__tideRefs.has(ref)).toBe(false);
  });

  test("ref map stays bounded across repeated snapshots at the node cap", async () => {
    const win = await loadFixture("many.html");
    for (let i = 0; i < 5; i++) {
      const s = snap(win);
      expect(s.tree.length).toBe(300);
      // the map can never outgrow one snapshot's capped tree, however
      // many snapshots run against the same document
      expect(win.__tideRefs.size).toBe(300);
      expect(win.__tideRefs.size).toBeLessThanOrEqual(win.__tideCaps.MAX_NODES);
    }
  });
});

describe("snapshot failures", () => {
  test("serialize as JSON error objects, never throw raw", async () => {
    const win = await loadFixture("login.html");
    // something the walk reads turns hostile mid-flight. linkedom's window
    // shares globals across parseHTML calls, so the poisoned accessor is
    // restored afterwards or every later fixture window inherits it.
    const original = Object.getOwnPropertyDescriptor(win, "innerWidth");
    Object.defineProperty(win, "innerWidth", {
      configurable: true,
      get() {
        throw new Error("viewport exploded");
      },
    });
    try {
      const raw = win.__tideSnapshot();
      expect(typeof raw).toBe("string");
      const parsed = JSON.parse(raw);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toContain("viewport exploded");
    } finally {
      Object.defineProperty(win, "innerWidth", original ?? { value: 1280, writable: true, configurable: true });
    }
  });
});

describe("__tideAct click", () => {
  test("fires pointerdown, mousedown, pointerup, mouseup, click in order on the element", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "button", "Continue")!.ref;
    const button = document.getElementById("continue")!;
    const order: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.addEventListener(type, (e) => order.push(`${(e.target as HTMLElement).id}:${e.type}`));
    }
    // the click must bubble off the button onto the document, targeted at it
    const bubbled: string[] = [];
    document.addEventListener("click", (e) => {
      bubbled.push(`${(e.target as HTMLElement).id}:${e.type}`);
    }, true);
    const result = JSON.parse(win.__tideAct(ref, "click", null));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("click");
    expect(order).toEqual([
      "continue:pointerdown",
      "continue:mousedown",
      "continue:pointerup",
      "continue:mouseup",
      "continue:click",
    ]);
    expect(bubbled).toEqual(["continue:click"]);
  });

  test("clicking a submit button submits its form (activation behavior)", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "button", "Continue")!.ref;
    const submits: string[] = [];
    document.querySelector("form")!.addEventListener("submit", () => submits.push("submit"));
    const result = JSON.parse(win.__tideAct(ref, "click", {}));
    expect(result.ok).toBe(true);
    expect(result.activation).toBe("submitted");
    expect(submits).toEqual(["submit"]);
  });

  test("clicking a checkbox toggles it and fires input + change", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    // the checkbox carries no accessible name here (label text is not
    // associated — Task 2's name-resolution scope), so address it by role
    const ref = byRole(s, "checkbox")[0].ref;
    const box = document.getElementById("remember") as HTMLInputElement;
    const fired: string[] = [];
    box.addEventListener("input", () => fired.push("input"));
    box.addEventListener("change", () => fired.push("change"));
    const result = JSON.parse(win.__tideAct(ref, "click", {}));
    expect(result.ok).toBe(true);
    expect(result.activation).toBe("toggled");
    expect(box.checked).toBe(true);
    expect(fired).toEqual(["input", "change"]);
  });
});

describe("__tideAct type", () => {
  test("sets the value and dispatches input + change with the full text (native-setter path)", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "textbox", "Email")!.ref;
    const input = document.getElementById("email") as HTMLInputElement;
    const fired: string[] = [];
    input.addEventListener("input", () => fired.push("input"));
    input.addEventListener("change", () => fired.push("change"));
    const result = JSON.parse(win.__tideAct(ref, "type", { text: "ada@example.com" }));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("type");
    expect(input.value).toBe("ada@example.com");
    expect(result.value).toBe("ada@example.com");
    expect(fired).toEqual(["input", "change"]);
  });

  test("typing replaces the previous content", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "textbox", "Email")!.ref;
    const input = document.getElementById("email") as HTMLInputElement;
    input.value = "stale@example.com";
    // a re-snapshot is needed: the recorded value went stale with the edit
    const fresh = snap(win);
    const freshRef = findEntry(fresh, "textbox", "Email")!.ref;
    JSON.parse(win.__tideAct(freshRef, "type", { text: "new@example.com" }));
    expect(input.value).toBe("new@example.com");
    expect(ref).not.toBe(freshRef);
  });

  test("typing into a contenteditable replaces its text and dispatches input", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    // the editable div is a role-less text leaf: name is its own text
    const ref = findEntry(s, "text", "old text")!.ref;
    const notes = document.getElementById("notes")!;
    const fired: string[] = [];
    notes.addEventListener("input", () => fired.push("input"));
    const result = JSON.parse(win.__tideAct(ref, "type", { text: "new notes" }));
    expect(result.ok).toBe(true);
    expect(notes.textContent).toBe("new notes");
    expect(fired).toEqual(["input"]);
  });

  test("submit:true presses Enter (keydown) and submits the form", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "textbox", "Email")!.ref;
    const input = document.getElementById("email")!;
    const form = document.querySelector("form")!;
    const events: string[] = [];
    input.addEventListener("keydown", (e) => events.push(`keydown:${(e as KeyboardEvent).key}`));
    form.addEventListener("submit", () => events.push("submit"));
    const result = JSON.parse(win.__tideAct(ref, "type", { text: "ada@example.com", submit: true }));
    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    expect(events).toEqual(["keydown:Enter", "submit"]);
  });
});

describe("__tideAct staleness contract", () => {
  test("removed element answers the stale shape", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "button", "Continue")!.ref;
    document.getElementById("continue")!.remove();
    const result = JSON.parse(win.__tideAct(ref, "click", {}));
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("browser_get_state");
  });

  test("renamed element (role matches, name differs) is stale", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const ref = findEntry(s, "button", "Continue")!.ref;
    document.getElementById("continue")!.textContent = "Something else entirely";
    const result = JSON.parse(win.__tideAct(ref, "click", {}));
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
  });

  test("an unknown ref is stale, not an error", async () => {
    const { win } = await loadPage("actions.html");
    snap(win);
    const result = JSON.parse(win.__tideAct("s99e42", "click", {}));
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
  });

  test("acting without any snapshot answers the stale shape", async () => {
    const { win } = await loadPage("actions.html");
    const result = JSON.parse(win.__tideAct("s1e1", "click", {}));
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
  });
});

describe("__tideAct press_key", () => {
  test("synthesizes keydown + keyup with xdt-style names and modifiers", async () => {
    const { win, document } = await loadPage("actions.html");
    const seen: Array<Record<string, unknown>> = [];
    document.body.addEventListener("keydown", (e) => seen.push(e as unknown as Record<string, unknown>));
    document.body.addEventListener("keyup", (e) => seen.push(e as unknown as Record<string, unknown>));

    const enter = JSON.parse(win.__tideAct(null, "press_key", { key: "Enter" }));
    expect(enter.ok).toBe(true);
    expect(enter.key).toBe("Enter");
    expect(seen[0].key).toBe("Enter");
    expect(seen[0].keyCode).toBe(13);
    expect(seen[1].type).toBe("keyup");

    const combo = JSON.parse(win.__tideAct(null, "press_key", { key: "ctrl+a" }));
    expect(combo.ok).toBe(true);
    expect(combo.modifiers).toEqual(["ctrl"]);
    expect(seen[2].key).toBe("a");
    expect(seen[2].ctrlKey).toBe(true);
    expect(seen[2].keyCode).toBe(65);

    const arrow = JSON.parse(win.__tideAct(null, "press_key", { key: "Up" }));
    expect(arrow.ok).toBe(true);
    expect(seen[4].key).toBe("ArrowUp");
    expect(seen[4].keyCode).toBe(38);
  });

  test("unknown key names and bare modifiers fail cleanly", async () => {
    const { win } = await loadPage("actions.html");
    const bad = JSON.parse(win.__tideAct(null, "press_key", { key: "notakey" }));
    expect(bad.ok).toBe(false);
    expect(bad.stale).toBeUndefined();
    expect(String(bad.error)).toContain("notakey");
    const bare = JSON.parse(win.__tideAct(null, "press_key", { key: "ctrl" }));
    expect(bare.ok).toBe(false);
    expect(String(bare.error)).toContain("key");
  });
});

describe("__tideAct scroll", () => {
  test("viewport scroll computes page-fraction deltas off the live viewport", async () => {
    const { win } = await loadPage("actions.html");
    const calls: Array<[number, number]> = [];
    (win as unknown as TideWindow).scrollBy = (x: number, y: number) => calls.push([x, y]);
    const down = JSON.parse(win.__tideAct(null, "scroll", { direction: "down" }));
    expect(down.ok).toBe(true);
    expect(down).toMatchObject({ direction: "down", amount: 1, dx: 0, dy: 800 });
    const up = JSON.parse(win.__tideAct(null, "scroll", { direction: "up", amount: 0.5 }));
    expect(up).toMatchObject({ direction: "up", amount: 0.5, dx: 0, dy: -400 });
    const right = JSON.parse(win.__tideAct(null, "scroll", { direction: "right", amount: 2 }));
    expect(right).toMatchObject({ dx: 2560, dy: 0 });
    expect(calls).toEqual([[0, 800], [0, -400], [2560, 0]]);
  });

  test("bad directions fail; ref'd scrollables address the element", async () => {
    const { win, document } = await loadPage("actions.html");
    const s = snap(win);
    const bad = JSON.parse(win.__tideAct(null, "scroll", { direction: "sideways" }));
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("direction");
    const ref = findEntry(s, "text", "old text")!.ref;
    const notes = document.getElementById("notes") as unknown as { scrollTop: number };
    const el = JSON.parse(win.__tideAct(ref, "scroll", { direction: "down", amount: 1 }));
    expect(el.ok).toBe(true);
    expect(notes.scrollTop !== undefined || el.scrolled === true).toBe(true);
  });
});

describe("__tideSettle", () => {
  test("resolves after a MutationObserver-quiet window even when mutations precede it", async () => {
    const { win, document } = await loadPage("actions.html");
    // dirty the tracker first: a page quiet since injection settles
    // instantly (quiet-for-forever), and the mid-wait mutation below must
    // be what the window re-arms against
    document.body.appendChild(document.createElement("span"));
    await new Promise((r) => setTimeout(r, 10));
    const start = Date.now();
    let resolvedAt = 0;
    const settled = win.__tideSettle(150).then(() => {
      resolvedAt = Date.now();
    });
    // a mutation lands mid-wait: the quiet window must re-arm from it
    await new Promise((r) => setTimeout(r, 40));
    const mutatedAt = Date.now();
    document.body.appendChild(document.createElement("span"));
    await settled;
    expect(resolvedAt).toBeGreaterThanOrEqual(mutatedAt + 140);
    expect(resolvedAt - start).toBeGreaterThanOrEqual(180);
  });

  test("resolves promptly on an already-quiet page", async () => {
    const { win } = await loadPage("actions.html");
    const start = Date.now();
    await win.__tideSettle(100);
    expect(Date.now() - start).toBeLessThan(900);
  });

  test("__tideSettledFor is the synchronous flavor the native side polls", async () => {
    const { win, document } = await loadPage("actions.html");
    snap(win);
    expect(JSON.parse(win.__tideSettledFor(0))).toBe(true);
    document.body.appendChild(document.createElement("span"));
    // linkedom's MutationObserver delivers on a microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(win.__tideSettledFor(400))).toBe(false);
    expect(JSON.parse(win.__tideSettledFor(0))).toBe(true);
  });
});
