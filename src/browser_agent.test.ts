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
  __tideSerial: number;
  __tideRefs: Map<string, { tagName?: string }>;
  __tideCaps: { MAX_NODES: number; MAX_DEPTH: number; MAX_NAME: number };
  innerWidth: number;
  innerHeight: number;
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
    expect(win.__tideCaps).toEqual({ MAX_NODES: 300, MAX_DEPTH: 12, MAX_NAME: 80 });
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
    // ref map is rebuilt per snapshot: only the latest refs resolve, to elements
    expect(win.__tideRefs.size).toBe(s2.tree.length);
    for (const ref of refs2) {
      const el = win.__tideRefs.get(ref);
      expect(el).toBeDefined();
      expect(typeof el!.tagName).toBe("string");
    }
    for (const ref of refs1) expect(win.__tideRefs.has(ref)).toBe(false);
  });
});
