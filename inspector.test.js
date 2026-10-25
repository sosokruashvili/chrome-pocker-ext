// Runs inspector.js in a fake page: a stub DOM, socket, fetch, timers and clock, enough for the
// recording, tournament and HUD paths. Covers several tables in one tab (the client's table
// switcher), where one socket carries every open table's GameStates and the URL names the shown one.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error("FAIL " + name);
    console.error("  got " + JSON.stringify(actual));
    console.error("  exp " + JSON.stringify(expected));
  } else {
    console.log("ok " + name);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.textContent = "";
    this.id = "";
    this.className = "";
    this.isConnected = false;
    this.rect = null;
  }
  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    child.setConnected(this.isConnected);
    return child;
  }
  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
    this.setConnected(false);
  }
  setConnected(value) {
    this.isConnected = value;
    this.children.forEach((child) => child.setConnected(value));
  }
  replaceChildren(...nodes) {
    this.children.slice().forEach((child) => child.remove());
    nodes.forEach((node) => this.appendChild(node));
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, event) {
    const ev = Object.assign({ preventDefault() {}, stopPropagation() {} }, event || {});
    (this.listeners[type] || []).forEach((fn) => fn.call(this, ev));
  }
  find(test) {
    for (const child of this.children) {
      if (test(child)) return child;
      const deeper = child.find(test);
      if (deeper) return deeper;
    }
    return null;
  }
  querySelector(selector) {
    if (selector[0] === "#") return this.find((el) => el.id === selector.slice(1));
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  setPointerCapture() {}
}

// The table on screen: one scene whose seats show the given names.
function makeScene(names) {
  const scene = new FakeElement("div");
  scene.className = "r-scene-container";
  scene.isConnected = true;
  const seats = names.map((name, idx) => {
    const seat = new FakeElement("div");
    seat.className = "r-seat seat-template-" + (idx + 1);
    seat.isConnected = true;
    const nameEl = new FakeElement("span");
    nameEl.textContent = name;
    const bar = new FakeElement("div");
    bar.rect = { left: 100 * idx, top: 50, right: 100 * idx + 80, bottom: 70, width: 80, height: 20 };
    seat.querySelector = (selector) => {
      if (selector === ".bar-text.player-name") return nameEl;
      if (selector === ".r-player-bar") return bar;
      return null;
    };
    seat.closest = (selector) => (selector === ".r-scene-container" ? scene : null);
    return seat;
  });
  return { scene: scene, seats: seats };
}

function createPage(options) {
  const opts = options || {};
  const clock = { now: 1000000 };
  const posts = [];
  const logs = [];
  const frames = [];
  // Tabs of one browser share localStorage: pass the same sharedStorage object to each page.
  const storage = opts.sharedStorage || Object.assign({}, opts.storage || {});
  const winListeners = {};
  const page = { shown: null };

  const documentElement = new FakeElement("html");
  documentElement.isConnected = true;
  const head = new FakeElement("head");
  documentElement.appendChild(head);
  const document = {
    documentElement: documentElement,
    head: head,
    visibilityState: "visible",
    getElementById: (id) => documentElement.find((el) => el.id === id),
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    dispatchEvent() {},
    querySelectorAll(selector) {
      const shown = page.shown;
      if (!shown) return [];
      if (selector === ".r-scene-container") return [shown.scene];
      if (selector === ".r-seat") return shown.seats;
      if (selector === ".r-seat .bar-text.player-name") return shown.seats.map((seat) => seat.querySelector(".bar-text.player-name"));
      return [];
    }
  };

  class NativeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = [];
    }
    addEventListener(type, fn) {
      if (type === "message") this.listeners.push(fn);
    }
    send() {}
  }

  const sandbox = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
      warn: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
      table() {}
    },
    document: document,
    location: { search: "?tableId=" + (opts.tableId || "") },
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => {
        storage[key] = String(value);
      },
      removeItem: (key) => {
        delete storage[key];
      }
    },
    fetch(url, init) {
      posts.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve("[]") });
    },
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    URLSearchParams: URLSearchParams,
    TextDecoder: TextDecoder,
    Blob: Blob,
    CustomEvent: class {},
    WebSocket: NativeSocket,
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    __clock: clock
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext("Date.now = () => __clock.now;", context);
  ["snapshot-recorder.js", "tournament-reporter.js", "inspector.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, { filename: file });
  });
  const socket = new sandbox.WebSocket("wss://newpokerserver.example/front");

  return {
    clock: clock,
    storage: storage,
    logs: logs,
    send(message) {
      const data = JSON.stringify(message);
      socket.listeners.forEach((fn) => fn({ data: data }));
    },
    // The user picks a table in the switcher: the URL and the scene change.
    show(tableId, names) {
      sandbox.location.search = "?tableId=" + tableId;
      page.shown = names ? makeScene(names) : null;
    },
    runFrame() {
      frames.splice(0).forEach((fn) => fn());
    },
    element: (id) => document.getElementById(id),
    hudNodes: () => {
      const layer = document.getElementById("poker-tracker-seat-hud-layer");
      return layer ? layer.children : [];
    },
    pageHide: () => (winListeners.pagehide || []).forEach((fn) => fn()),
    // Another tab wrote this localStorage key (the browser tells every tab but the writer).
    storageEvent: (key) => (winListeners.storage || []).forEach((fn) => fn({ key: key })),
    handPosts: () => posts.filter((post) => /\/raw$/.test(post.url)).map((post) => post.body),
    hudPosts: () => posts.filter((post) => /\/hud-stats$/.test(post.url)).map((post) => post.body),
    tournamentPosts: () => posts.filter((post) => /\/tournaments$/.test(post.url)).map((post) => post.body)
  };
}

function seat(name, la, b, stack) {
  const out = { dn: name, n: "p-" + name, c: stack === undefined ? 1000 : stack };
  if (la !== undefined && la !== null) out.la = la;
  if (b) out.b = b;
  return out;
}

// One full hand at a 3-handed table: blinds, open, fold, call, flop bet, fold, collect.
function hand(tableId, tournamentId, handId, names) {
  const [a, b, c] = names;
  const steps = [
    ["", [seat(a, 6, 10), seat(b, 7, 20), seat(c)]],
    ["", [seat(a, 6, 10), seat(b, 7, 20), seat(c, 9, 60)]],
    ["", [seat(a, 1, 10), seat(b, 7, 20), seat(c, 9, 60)]],
    ["", [seat(a, 1, 10), seat(b, 3, 60), seat(c, 9, 60)]],
    ["1;2;3", [seat(a, 1), seat(b, 3), seat(c, 9)]],
    ["1;2;3", [seat(a, 1), seat(b, 2), seat(c, 9)]],
    ["1;2;3", [seat(a, 1), seat(b, 2), seat(c, 8, 100)]],
    ["1;2;3", [seat(a, 1), seat(b, 1), seat(c, 8, 100)]],
    ["1;2;3", [seat(a, 1), seat(b, 1), seat(c, 16, 230)]]
  ];
  return steps.map(([board, seats]) => {
    const gameState = { ti: tableId, gi: handId, d: { c: board }, m: { di: 2 }, s: seats };
    if (tournamentId) gameState.tri = tournamentId;
    return { t: "GameState", gameState: gameState };
  });
}

// Plays several hands step by step, one message from each in turn, like one socket carrying
// several tables. A step callback can act between messages (switch tables, toggle REC).
function interleave(page, hands, onStep) {
  const queues = hands.map((steps) => steps.slice());
  let step = 0;
  while (queues.some((queue) => queue.length)) {
    queues.forEach((queue) => {
      if (!queue.length) return;
      if (onStep) onStep(step);
      page.send(queue.shift());
      step += 1;
      page.clock.now += 1000;
    });
  }
}

function complete(post) {
  const first = post.snapshots[0].seats.map((s) => String(s.la)).join(",");
  const last = post.snapshots[post.snapshots.length - 1].seats.map((s) => String(s.la)).join(",");
  return post.handId + " " + post.snapshots.length + " [" + first + "] .. [" + last + "]" + (post.tournamentId ? " t" + post.tournamentId : "");
}

function clickRec(page) {
  page.element("poker-tracker-tracking-switch").fire("click");
}

const T1 = 1788855;
const T2 = 1790109;
const P1 = ["A1", "B1", "C1"];
const P2 = ["A2", "B2", "C2"];
const FULL = " 9 [6,7,null] .. [1,1,16]";

// --- Two tables in one tab: the user switches between them while both play hands.
{
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  // The page opens mid-hand on both tables; REC goes on during those hands.
  interleave(page, [hand(T1, 11, 101, P1).slice(3), hand(T2, 22, 201, P2).slice(5)], (step) => {
    if (step === 2) clickRec(page);
  });
  check("REC is armed until a table starts a hand", page.element("poker-tracker-tracking-switch").title, "Tracking armed - each table starts at its next hand");
  // Next hands interleave message by message; the user switches tables in the middle of them.
  interleave(page, [hand(T1, 11, 102, P1), hand(T2, 22, 202, P2)], (step) => {
    if (step === 5) page.show(T2, P2);
    if (step === 11) page.show(T1, P1);
  });
  check("REC shows both tables recording", page.element("poker-tracker-tracking-switch").title, "Tracking active (2 tables)");
  interleave(page, [hand(T2, 22, 203, P2), hand(T1, 11, 103, P1)], (step) => {
    if (step === 3) page.show(T2, P2);
  });
  check("every hand of both tables is posted once and complete, first hands skipped",
    page.handPosts().map(complete).sort(),
    ["102" + FULL + " t11", "103" + FULL + " t11", "202" + FULL + " t22", "203" + FULL + " t22"]);
  check("posted snapshots hold only their own table's players",
    page.handPosts().every((post) => {
      const own = String(post.handId)[0] === "1" ? P1 : P2;
      return post.snapshots.every((snap) => snap.seats.every((s) => own.indexOf(s.name) >= 0));
    }), true);
  page.pageHide();
  check("closing the page posts nothing more after finished hands", page.handPosts().length, 4);
}

// --- UPD, REC off and closing the page drop unfinished hands instead of posting them cut.
function midHand(tableIds) {
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  interleave(page, tableIds.map((id) => hand(id, null, id === T1 ? 1201 : 1301, id === T1 ? P1 : P2)));
  clickRec(page);
  // Finished hands on every table, then the next ones are cut off in the middle.
  interleave(page, tableIds.map((id) => hand(id, null, id === T1 ? 1202 : 1302, id === T1 ? P1 : P2)));
  interleave(page, tableIds.map((id) => hand(id, null, id === T1 ? 1203 : 1303, id === T1 ? P1 : P2).slice(0, 5)));
  return page;
}
{
  const page = midHand([T1, T2]);
  clickRec(page);
  check("REC off mid-hand posts only the finished hands", page.handPosts().map((post) => post.handId).sort(), [1202, 1302]);
  check("REC off logs the dropped hands",
    page.logs.filter((line) => line.indexOf("dropped unfinished hand") >= 0).length, 2);
  check("REC off shows disabled", page.element("poker-tracker-tracking-switch").title, "Tracking disabled");
  hand(T1, null, 1203, P1).slice(5).forEach((msg) => page.send(msg));
  check("the dropped hand's end is not posted later", page.handPosts().length, 2);
}
{
  const page = midHand([T1, T2]);
  page.element("poker-tracker-extension-reload").fire("click");
  check("UPD mid-hand posts nothing more", page.handPosts().map((post) => post.handId).sort(), [1202, 1302]);
}
{
  const page = midHand([T1, T2]);
  page.pageHide();
  check("closing the page mid-hand posts nothing more", page.handPosts().map((post) => post.handId).sort(), [1202, 1302]);
}
{
  // A table closed mid-hand stops sending; its half hand is dropped at UPD / REC off / page close.
  const page = midHand([T1, T2]);
  hand(T1, null, 1203, P1).slice(5).forEach((msg) => page.send(msg));
  page.pageHide();
  check("a table closed mid-hand is dropped, the other table's hand still posted",
    page.handPosts().map((post) => post.handId).sort(), [1202, 1203, 1302]);
}
{
  // REC off then on in the same hand: that hand is not picked up again from the middle.
  const page = midHand([T1]);
  clickRec(page);
  clickRec(page);
  hand(T1, null, 1203, P1).slice(5).forEach((msg) => page.send(msg));
  hand(T1, null, 1204, P1).forEach((msg) => page.send(msg));
  check("REC back on resumes at the next hand", page.handPosts().map(complete), ["1202" + FULL, "1204" + FULL]);
}

// --- A table opened while REC is on skips its first (joined mid-way) hand only.
{
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  hand(T1, null, 401, P1).forEach((msg) => page.send(msg));
  clickRec(page);
  hand(T1, null, 402, P1).forEach((msg) => page.send(msg));
  hand(T2, null, 501, P2).slice(2).forEach((msg) => page.send(msg));
  hand(T2, null, 502, P2).forEach((msg) => page.send(msg));
  check("new table: first hand skipped, the next one posted", page.handPosts().map(complete), ["402" + FULL, "502" + FULL]);
}

// --- Tournaments of both tables are reported; a prize table can't be told apart, so it is dropped.
{
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  page.send({ t: "LobbyTournamentInfo", info: { i: 11, n: "One", na: 30 } });
  page.send({ t: "LobbyTournamentInfo", info: { i: 22, n: "Two", na: 40 } });
  interleave(page, [hand(T1, 11, 601, P1), hand(T2, 22, 701, P2)]);
  clickRec(page);
  interleave(page, [hand(T1, 11, 602, P1).slice(0, 2), hand(T2, 22, 702, P2).slice(0, 2)]);
  check("nothing is reported before REC is on and a table records", page.tournamentPosts().length, 0);
  page.send({ t: "TournamentPrizeDistributionResponse", distributionTable: [{ mpa: 100 }] });
  page.send({ t: "LobbyTournamentInfo", info: { i: 22, na: 39 } });
  check("both tables' tournaments are reported, without the unattributable prizes",
    page.tournamentPosts().map((post) => post.info.i + ":" + post.info.na + (post.prizes ? "+prizes" : "")),
    ["11:30", "22:40"]);
  page.clock.now += 61000;
  page.send({ t: "LobbyTournamentInfo", info: { i: 22, na: 38 } });
  check("each keeps reporting", page.tournamentPosts().map((post) => post.info.i + ":" + post.info.na), ["11:30", "22:40", "11:30", "22:38"]);
}

// --- HUD: dragged positions are kept per table across switches.
{
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  hand(T1, null, 801, P1).slice(0, 1).forEach((msg) => page.send(msg));
  hand(T2, null, 901, P2).slice(0, 1).forEach((msg) => page.send(msg));
  page.element("poker-tracker-table-players-toggle").fire("click");
  page.runFrame();
  const node = page.hudNodes()[1];
  const before = node.style.left;
  node.fire("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  node.fire("pointermove", { pointerId: 1, clientX: 140, clientY: 110 });
  node.fire("pointerup", { pointerId: 1 });
  page.runFrame();
  const dragged = page.hudNodes()[1].style.left;
  check("drag moves the seat HUD", [before, dragged], ["140px", "180px"]);
  // The URL switches a frame before the scene re-renders, then the other table shows.
  page.show(T2, null);
  page.show(T2, P1);
  page.runFrame();
  page.show(T2, P2);
  page.runFrame();
  check("the other table has its own positions", page.hudNodes().map((n) => n.style.left)[1], "140px");
  page.show(T1, P1);
  page.runFrame();
  check("switching back keeps the dragged position", page.hudNodes().map((n) => n.style.left)[1], "180px");
  check("offsets are stored per table", Object.keys(JSON.parse(page.storage["poker-tracker-hud-offsets"])), ["t" + T1 + ":seat-template-2"]);
}

// --- HUD: positions dragged before v9.9 (kept per scene index) move to the table that shows them.
{
  const legacySeating = { "0": { "seat-template-1": "A1", "seat-template-2": "B1", "seat-template-3": "C1" } };
  const legacyOffsets = { "0:seat-template-2": { dx: 40, dy: 10, barW: 80, barH: 20 } };
  const page = createPage({
    tableId: T1,
    storage: {
      "poker-tracker-hud-seating": JSON.stringify(legacySeating),
      "poker-tracker-hud-offsets": JSON.stringify(legacyOffsets)
    }
  });
  page.show(T1, P1);
  hand(T1, null, 811, P1).slice(0, 1).forEach((msg) => page.send(msg));
  page.element("poker-tracker-table-players-toggle").fire("click");
  // The seating is synced after the seats are placed, so the moved offset shows a frame later.
  page.runFrame();
  page.runFrame();
  check("legacy offset applies to the same seating", page.hudNodes()[1].style.left, "180px");
  check("legacy offset is now kept under the table",
    [Object.keys(JSON.parse(page.storage["poker-tracker-hud-offsets"])), Object.keys(JSON.parse(page.storage["poker-tracker-hud-seating"]))],
    [["t" + T1 + ":seat-template-2"], ["t" + T1]]);
}

// --- HUD: several tabs share the stored positions, and a tab saves only what it changed.
function hudTab(storage, tableId, names, handId) {
  const page = createPage({ tableId: tableId, sharedStorage: storage });
  page.show(tableId, names);
  page.send(hand(tableId, null, handId, names)[0]);
  page.element("poker-tracker-table-players-toggle").fire("click");
  return page;
}

function hudLefts(page) {
  return page.hudNodes().map((node) => parseFloat(node.style.left));
}

function startDrag(page, idx, dx) {
  const node = page.hudNodes()[idx];
  node.fire("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  node.fire("pointermove", { pointerId: 1, clientX: 100 + dx, clientY: 100 });
}

function endDrag(page, idx) {
  page.hudNodes()[idx].fire("pointerup", { pointerId: 1 });
}

const OFFSETS = "poker-tracker-hud-offsets";
const SEATING = "poker-tracker-hud-seating";
const storedKeys = (storage, key) => Object.keys(JSON.parse(storage[key] || "{}")).sort();

{
  const storage = {};
  const tabA = hudTab(storage, T1, P1, 821);
  const tabB = hudTab(storage, T2, P2, 921);
  // Both tabs load before either saves anything.
  tabA.runFrame();
  tabB.runFrame();
  startDrag(tabA, 1, 40);
  endDrag(tabA, 1);
  // Tab B has not heard of tab A's drag when it saves its own.
  startDrag(tabB, 1, 20);
  endDrag(tabB, 1);
  check("two tabs' drags are both kept", storedKeys(storage, OFFSETS), ["t" + T1 + ":seat-template-2", "t" + T2 + ":seat-template-2"]);
  check("two tabs' seatings are both kept", storedKeys(storage, SEATING), ["t" + T1, "t" + T2]);
  tabB.hudNodes()[1].fire("dblclick");
  check("resetting a seat in one tab keeps the other tab's drag", storedKeys(storage, OFFSETS), ["t" + T1 + ":seat-template-2"]);
}

{
  const storage = {};
  const tabA = hudTab(storage, T1, P1, 831);
  const tabB = hudTab(storage, T1, P1, 832);
  tabA.runFrame();
  tabB.runFrame();
  const start = hudLefts(tabB);
  startDrag(tabA, 1, 40);
  endDrag(tabA, 1);
  tabB.storageEvent(OFFSETS);
  tabB.runFrame();
  check("a drag shows in the other tab of the same table", hudLefts(tabB)[1] - start[1], 40);
  // Tab B is mid-drag when tab A saves another seat.
  startDrag(tabB, 0, 30);
  startDrag(tabA, 2, -25);
  endDrag(tabA, 2);
  tabB.storageEvent(OFFSETS);
  tabB.runFrame();
  check("another tab's save keeps a drag in progress", [0, 1, 2].map((i) => hudLefts(tabB)[i] - start[i]), [30, 40, -25]);
  endDrag(tabB, 0);
  check("all three drags are stored", storedKeys(storage, OFFSETS), ["t" + T1 + ":seat-template-1", "t" + T1 + ":seat-template-2", "t" + T1 + ":seat-template-3"]);
  check("the drag in progress is stored as dragged", JSON.parse(storage[OFFSETS])["t" + T1 + ":seat-template-1"].dx, 30);
}

// --- HUD stats are loaded for every open table's players, so a switched-to table has them at once.
(async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const page = createPage({ tableId: T1 });
  page.show(T1, P1);
  page.send(hand(T1, null, 1001, P1)[0]);
  await settle();
  page.send(hand(T2, null, 1101, P2)[0]);
  await settle();
  const asked = new Set();
  page.hudPosts().forEach((body) => body.playernames.forEach((name) => asked.add(name)));
  check("HUD stats are requested for the hidden table's players too", Array.from(asked).sort(), P1.concat(P2).sort());

  if (failed) {
    console.error(failed + " failed");
    process.exit(1);
  }
  console.log("all passed");
})();
