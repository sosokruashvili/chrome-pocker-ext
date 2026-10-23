// === POKER HAND TRACKER v9.4 ===

(function() {
  "use strict";

  const TRACKER_VERSION = "v9.9";
  const API_URL = "https://team.evlog.ge/api/hand-history";
  const RAW_HAND_API_URL = API_URL + "/raw";
  const HUD_STATS_API_URL = "https://team.evlog.ge/api/hand-history/hud-stats";
  const TOURNAMENT_API_URL = "https://team.evlog.ge/api/tournaments";
  const HUD_STATS_REFRESH_MS = 3 * 60 * 1000;
  const DEBUG_HUD_STATS = false;
  const HUD_STAT_BADGE_COLORS = {
    vpip: "#22543d",
    pfr: "#742a2a",
    threeBet: "#744210",
    af: "#553c9a",
    hands: "#2a4365"
  };
  // A table not heard from for this long stops counting as open (HUD stats, tournament reports).
  const TABLE_IDLE_MS = 10 * 60 * 1000;

  // Tables by table id (GameState ti). One tab can hold several tables: the client's table
  // switcher shows one at a time, but its socket carries every open table's GameStates.
  const tables = new Map();
  const tournamentReporter = PokerTournamentReporter.createReporter();
  let tablePlayersOverlayHidden = true;
  let trackingEnabled = false;
  let currentTablePlayerNames = [];
  let hudStatsByPlayerName = {};
  let hudStatsFetchedAtByPlayerName = {};
  let hudStatsRequestInFlight = false;
  let hudStatsLoopTimer = null;
  let hudCountdownTimer = null;
  let nextHudReloadAt = 0;
  let seatHudFrame = 0;
  const seatHudBySeat = new Map();

  console.log(
    "%c[tracker] " + TRACKER_VERSION + " loaded",
    "background:#16a34a;color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;"
  );

  function showVersionBadge() {
    try {
      const existing = document.getElementById("poker-tracker-version-badge");
      if (existing) existing.remove();

      const badge = document.createElement("div");
      badge.id = "poker-tracker-version-badge";
      badge.textContent = "Poker Tracker " + TRACKER_VERSION;
      badge.style.cssText = [
        "position:fixed",
        "bottom:12px",
        "right:12px",
        "z-index:2147483647",
        "background:#111827",
        "color:#f9fafb",
        "border:1px solid #22c55e",
        "padding:8px 10px",
        "border-radius:8px",
        "font:12px/1.2 Arial,sans-serif",
        "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
        "pointer-events:none",
        "opacity:0",
        "transform:translateY(-4px)",
        "transition:opacity .2s ease, transform .2s ease"
      ].join(";");

      document.documentElement.appendChild(badge);
      requestAnimationFrame(() => {
        badge.style.opacity = "1";
        badge.style.transform = "translateY(0)";
      });
    } catch (e) {}
  }
  showVersionBadge();

  function toNum(val, fallback) {
    if (val === undefined || val === null || val === "") return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function getPageTableId() {
    try {
      return toNum(new URLSearchParams(window.location.search).get("tableId"), null);
    } catch (e) {
      return null;
    }
  }

  function getBoardCount(gameState) {
    const cards = gameState?.d?.c;
    if (!cards) return 0;
    return cards.split(";").filter(Boolean).length;
  }

  function normalizePlayerNames(names) {
    const uniq = new Set();
    const normalized = [];
    (Array.isArray(names) ? names : []).forEach((name) => {
      const safeName = String(name || "").trim();
      if (!safeName) return;
      if (uniq.has(safeName)) return;
      uniq.add(safeName);
      normalized.push(safeName);
    });
    return normalized;
  }

  function debugHudStatsLog(message, extra) {
    if (!DEBUG_HUD_STATS) return;
    if (extra !== undefined) {
      console.log("[tracker][hud] " + message, extra);
      return;
    }
    console.log("[tracker][hud] " + message);
  }

  function ensureHudSpinnerKeyframes() {
    if (document.getElementById("poker-tracker-hud-spinner-style")) return;
    const style = document.createElement("style");
    style.id = "poker-tracker-hud-spinner-style";
    style.textContent =
      "@keyframes poker-tracker-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
    (document.head || document.documentElement).appendChild(style);
  }

  function setHudLoadingOverlay(visible) {
    const host = document.getElementById("poker-tracker-table-players-overlay");
    if (!host) return;
    const overlayId = "poker-tracker-hud-loading-overlay";
    let overlay = document.getElementById(overlayId);
    if (!visible) {
      if (overlay) overlay.remove();
      return;
    }
    ensureHudSpinnerKeyframes();
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = overlayId;
      overlay.style.cssText = [
        "position:absolute",
        "inset:0",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:10px",
        "background:rgba(17,24,39,0.55)",
        "backdrop-filter:blur(2px)",
        "-webkit-backdrop-filter:blur(2px)",
        "border-radius:8px",
        "z-index:2",
        "pointer-events:auto",
        "color:#f9fafb",
        "font:600 12px/1.2 Arial,sans-serif",
        "letter-spacing:.06em",
        "text-transform:uppercase"
      ].join(";");

      const spinner = document.createElement("div");
      spinner.style.cssText = [
        "width:28px",
        "height:28px",
        "border-radius:50%",
        "border:3px solid rgba(255,255,255,0.18)",
        "border-top-color:#22c55e",
        "animation:poker-tracker-spin .8s linear infinite"
      ].join(";");
      overlay.appendChild(spinner);

      const label = document.createElement("div");
      label.textContent = "Loading stats...";
      overlay.appendChild(label);

      host.appendChild(overlay);
    }
  }

  async function forceRefreshHudStats() {
    if (hudStatsRequestInFlight) return;
    const players = currentTablePlayerNames.slice();
    if (!players.length) return;
    players.forEach((name) => {
      delete hudStatsFetchedAtByPlayerName[name];
    });
    debugHudStatsLog("manual refresh", players);
    setHudLoadingOverlay(true);
    try {
      await requestHudStats(players, "manual_refresh", true);
    } finally {
      setHudLoadingOverlay(false);
      restartHudStatsLoop();
      updateHudCountdownDisplay();
    }
  }

  function buildHudReloadButton() {
    const btn = document.createElement("button");
    btn.id = "poker-tracker-hud-reload";
    btn.type = "button";
    btn.title = "Refresh stats";
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "width:22px",
      "height:22px",
      "padding:0",
      "border:1px solid #22c55e",
      "border-radius:4px",
      "background:linear-gradient(180deg,#1f2937,#111827)",
      "color:#f8fafc",
      "font:700 14px/1 Arial,sans-serif",
      "cursor:pointer",
      "pointer-events:auto",
      "user-select:none",
      "box-shadow:0 2px 6px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)"
    ].join(";");
    btn.textContent = "\u21bb";
    btn.addEventListener("click", function(ev) {
      ev.stopPropagation();
      if (hudStatsRequestInFlight) return;
      const original = this.textContent;
      this.disabled = true;
      this.style.opacity = "0.6";
      this.textContent = "\u22ef";
      forceRefreshHudStats().finally(() => {
        this.disabled = false;
        this.style.opacity = "1";
        this.textContent = original;
      });
    });
    return btn;
  }

  function renderHudOverlayFromCurrentState() {
    markSeatHudsDirty();
  }

  function setCurrentTablePlayerNames(names) {
    // Stats are loaded for every open table's players too, so a table switched to has them at once.
    const tablePlayers = [];
    openTables().forEach((table) => {
      table.players.forEach((name) => tablePlayers.push(name));
    });
    const next = normalizePlayerNames(names.concat(tablePlayers)).sort();
    const prevKey = currentTablePlayerNames.join("|");
    const nextKey = next.join("|");
    currentTablePlayerNames = next;
    if (prevKey !== nextKey) {
      debugHudStatsLog("table players updated", currentTablePlayerNames);
      runHudStatsLoopTick().catch(() => {});
    }
  }

  function hasCompleteHudStats(stats) {
    if (!stats || typeof stats !== "object") return false;
    return (
      stats.hands !== undefined &&
      stats.vpip_percentage !== undefined &&
      stats.pfr_percentage !== undefined &&
      stats.af !== undefined &&
      stats.three_bet_percentage !== undefined
    );
  }

  function fmtHudNum(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
  }

  function formatHudLine(playerName) {
    const stats = hudStatsByPlayerName[playerName];
    if (!hasCompleteHudStats(stats)) {
      return "loading...";
    }
    const hands = toNum(stats.hands, 0);
    const vpip = fmtHudNum(stats.vpip_percentage, 2);
    const pfr = fmtHudNum(stats.pfr_percentage, 2);
    const af = fmtHudNum(stats.af, 2);
    const threeBet = fmtHudNum(stats.three_bet_percentage, 2);
    return vpip + " | " + pfr + " | " + af + " | " + threeBet + " | " + hands;
  }

  function hudVisualScale() {
    const dpr = window.devicePixelRatio || 1;
    const screenW = window.screen && window.screen.width ? window.screen.width : 0;
    const screenH = window.screen && window.screen.height ? window.screen.height : 0;
    const physical = Math.max(screenW, screenH) * dpr;
    const css = Math.max(window.innerWidth || 0, window.innerHeight || 0, screenW, screenH);
    const basis = Math.max(physical, css);
    return Math.min(2, Math.max(1, basis / 1920));
  }

  const HUD_SIZE_STORAGE_KEY = "poker-tracker-hud-size";
  let hudSizeLevel = 0;
  try {
    const storedSize = Number(localStorage.getItem(HUD_SIZE_STORAGE_KEY));
    if (Number.isFinite(storedSize)) hudSizeLevel = Math.max(-4, Math.min(8, Math.round(storedSize)));
  } catch (e) {}

  function hudUserScale() {
    return 1 + hudSizeLevel * 0.1;
  }

  function saveHudSize() {
    try {
      localStorage.setItem(HUD_SIZE_STORAGE_KEY, String(hudSizeLevel));
    } catch (e) {}
  }

  function changeHudSize(delta) {
    const next = Math.max(-4, Math.min(8, hudSizeLevel + delta));
    if (next === hudSizeLevel) return;
    hudSizeLevel = next;
    saveHudSize();
    markSeatHudsDirty();
  }

  function hudMetrics() {
    const screenScale = hudVisualScale();
    const userScale = hudUserScale();
    const grow = (value) => Math.max(1, Math.round(value * userScale));
    return {
      scale: Math.round(screenScale * userScale * 100) / 100,
      font: grow(Math.round(11 * screenScale)),
      padY: grow(Math.max(1, Math.round(1 * screenScale)) + 2),
      padX: grow(Math.max(2, Math.round(2 * screenScale)) + 2),
      gap: grow(Math.max(2, Math.round(2 * screenScale))),
      radius: grow(Math.max(3, Math.round(3 * screenScale))),
      offset: Math.max(2, Math.round(2 * screenScale)),
      stripPadY: grow(Math.max(1, Math.round(1 * screenScale)) + 2),
      stripPadX: grow(Math.max(2, Math.round(2 * screenScale)) + 2)
    };
  }

  function makeHudBadge(text, backgroundColor, title, metrics) {
    const badge = document.createElement("span");
    badge.style.cssText = [
      "display:inline-block",
      "padding:" + metrics.padY + "px " + metrics.padX + "px",
      "margin:0",
      "border-radius:" + metrics.radius + "px",
      "background:" + backgroundColor,
      "box-shadow:0 0 0 1px rgba(0,0,0,0.45)",
      "color:#ffffff",
      "font:700 " + metrics.font + "px/1.15 Arial,sans-serif",
      "white-space:nowrap"
    ].join(";");
    badge.textContent = text;
    if (title) badge.title = title;
    return badge;
  }

  function statsForPlayerName(playerName) {
    if (hudStatsByPlayerName[playerName]) return hudStatsByPlayerName[playerName];
    const lower = String(playerName || "").toLowerCase();
    const key = Object.keys(hudStatsByPlayerName).find((name) => name.toLowerCase() === lower);
    return key ? hudStatsByPlayerName[key] : null;
  }

  function makeHudNameLabel(playerName, metrics) {
    const label = document.createElement("span");
    label.className = "poker-tracker-seat-hud-name";
    label.style.cssText = [
      "display:inline-block",
      "padding:" + metrics.padY + "px " + metrics.padX + "px",
      "border-radius:" + metrics.radius + "px",
      "background:transparent",
      "color:#f9fafb",
      "font:700 " + metrics.font + "px/1.15 Arial,sans-serif",
      "white-space:nowrap"
    ].join(";");
    label.textContent = String(playerName || "").slice(0, 2);
    return label;
  }

  function renderHudStatBadges(container, playerName, metrics) {
    const style = metrics || hudMetrics();
    container.replaceChildren();
    container.style.color = "";
    container.style.font = "";
    container.appendChild(makeHudNameLabel(playerName, style));
    const stats = statsForPlayerName(playerName);
    if (!hasCompleteHudStats(stats)) {
      const waiting = document.createElement("span");
      waiting.textContent = "...";
      waiting.style.cssText = "color:#9ca3af;font:700 " + style.font + "px/1.15 Arial,sans-serif;";
      container.appendChild(waiting);
      return;
    }

    const vpip = fmtHudNum(stats.vpip_percentage, 2);
    const pfr = fmtHudNum(stats.pfr_percentage, 2);
    const threeBet = fmtHudNum(stats.three_bet_percentage, 2);
    const af = fmtHudNum(stats.af, 2);
    const hands = String(toNum(stats.hands, 0));

    container.appendChild(makeHudBadge(vpip, HUD_STAT_BADGE_COLORS.vpip, "VPIP", style));
    container.appendChild(makeHudBadge(pfr, HUD_STAT_BADGE_COLORS.pfr, "PFR", style));
    container.appendChild(makeHudBadge(af, HUD_STAT_BADGE_COLORS.af, "AF", style));
    container.appendChild(makeHudBadge(threeBet, HUD_STAT_BADGE_COLORS.threeBet, "3B", style));
    container.appendChild(makeHudBadge(hands, HUD_STAT_BADGE_COLORS.hands, "Hands", style));
  }

  async function requestHudStats(playerNames, reason, allowMissingRetry) {
    const normalizedNames = normalizePlayerNames(playerNames);
    if (!normalizedNames.length) return;

    hudStatsRequestInFlight = true;
    const payload = JSON.stringify({ playernames: normalizedNames });
    debugHudStatsLog("POST " + HUD_STATS_API_URL + " (" + reason + ")", normalizedNames);
    try {
      const response = await fetch(HUD_STATS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      });
      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (e) {
        debugHudStatsLog("json parse failed", { status: response.status, sample: String(rawText || "").slice(0, 240) });
      }
      const rows = data && Array.isArray(data.data)
        ? data.data
        : data && Array.isArray(data.players)
          ? data.players
          : Array.isArray(data)
            ? data
            : [];
      const now = Date.now();
      debugHudStatsLog("response meta", {
        status: response.status,
        ok: response.ok,
        rows: rows.length
      });

      normalizedNames.forEach((name) => {
        hudStatsFetchedAtByPlayerName[name] = now;
      });

      rows.forEach((row) => {
        if (!row || typeof row !== "object") return;
        const rowName = String(row.player_name || row.playerName || row.name || "").trim();
        if (!rowName) return;
        hudStatsByPlayerName[rowName] = row;
        hudStatsFetchedAtByPlayerName[rowName] = now;
      });
      renderHudOverlayFromCurrentState();
    } catch (e) {
      debugHudStatsLog("request failed", String((e && e.message) || e || "unknown_error"));
    } finally {
      hudStatsRequestInFlight = false;
    }

    if (!allowMissingRetry) return;
    const missing = normalizedNames.filter((name) => !hasCompleteHudStats(hudStatsByPlayerName[name]));
    if (!missing.length) return;
    await requestHudStats(missing, "missing_retry", false);
  }

  async function runHudStatsLoopTick() {
    if (hudStatsRequestInFlight) return;
    const now = Date.now();
    const players = currentTablePlayerNames.slice();
    if (!players.length) return;

    const playersToFetch = players.filter((name) => {
      const lastFetchedAt = toNum(hudStatsFetchedAtByPlayerName[name], 0);
      if (!hasCompleteHudStats(hudStatsByPlayerName[name])) return true;
      return now - lastFetchedAt >= HUD_STATS_REFRESH_MS;
    });
    if (!playersToFetch.length) return;
    debugHudStatsLog("tick fetch players", playersToFetch);

    await requestHudStats(playersToFetch, "minute_loop", true);
  }

  function startHudStatsLoop() {
    if (hudStatsLoopTimer) return;
    nextHudReloadAt = Date.now() + HUD_STATS_REFRESH_MS;
    hudStatsLoopTimer = setInterval(() => {
      nextHudReloadAt = Date.now() + HUD_STATS_REFRESH_MS;
      forceRefreshHudStats().catch(() => {});
    }, HUD_STATS_REFRESH_MS);
    runHudStatsLoopTick().catch(() => {});
  }

  function restartHudStatsLoop() {
    if (hudStatsLoopTimer) {
      clearInterval(hudStatsLoopTimer);
      hudStatsLoopTimer = null;
    }
    startHudStatsLoop();
  }

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ":" + String(seconds).padStart(2, "0");
  }

  function updateHudCountdownDisplay() {
    const el = document.getElementById("poker-tracker-hud-countdown");
    if (!el) return;
    const remaining = nextHudReloadAt - Date.now();
    el.textContent = "(" + formatCountdown(remaining) + ")";
  }

  function startHudCountdownTicker() {
    if (hudCountdownTimer) return;
    hudCountdownTimer = setInterval(updateHudCountdownDisplay, 1000);
  }
  startHudStatsLoop();
  startHudCountdownTicker();

  // Background tabs throttle timers, so the interval can drift or stall while hidden.
  // When the tab becomes visible again, run an overdue refresh immediately.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      ensureSeatHudLoop();
      return;
    }
    updateHudCountdownDisplay();
    ensureSeatHudLoop();
    if (Date.now() >= nextHudReloadAt) {
      forceRefreshHudStats().catch(() => {});
    }
  });

  function collectDomSeatNames() {
    const names = [];
    document.querySelectorAll(".r-seat .bar-text.player-name").forEach((el) => {
      const name = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (name) names.push(name);
    });
    return normalizePlayerNames(names);
  }

  function ensureSeatHudLayer() {
    let layer = document.getElementById("poker-tracker-seat-hud-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "poker-tracker-seat-hud-layer";
      layer.style.cssText = [
        "position:fixed",
        "left:0",
        "top:0",
        "width:0",
        "height:0",
        "overflow:visible",
        "z-index:2147483646",
        "pointer-events:none"
      ].join(";");
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function seatHudSignature(playerName, scale) {
    const stats = statsForPlayerName(playerName);
    if (!hasCompleteHudStats(stats)) return scale + "|" + playerName + "|loading";
    return [
      scale,
      playerName,
      stats.vpip_percentage,
      stats.pfr_percentage,
      stats.three_bet_percentage,
      stats.af,
      stats.hands
    ].join("|");
  }

  function markSeatHudsDirty() {
    seatHudBySeat.forEach((node) => {
      node._sig = "";
    });
  }

  const HUD_OFFSET_STORAGE_KEY = "poker-tracker-hud-offsets";
  let hudOffsets = {};
  try {
    const storedOffsets = JSON.parse(localStorage.getItem(HUD_OFFSET_STORAGE_KEY) || "{}");
    if (storedOffsets && typeof storedOffsets === "object") hudOffsets = storedOffsets;
  } catch (e) {}
  let hudDrag = null;

  function saveHudOffsets() {
    try {
      localStorage.setItem(HUD_OFFSET_STORAGE_KEY, JSON.stringify(hudOffsets));
    } catch (e) {}
  }

  // Seat template -> player name per table, i.e. the seating the table's dragged offsets belong to.
  const HUD_SEATING_STORAGE_KEY = "poker-tracker-hud-seating";
  let hudSeating = {};
  try {
    const storedSeating = JSON.parse(localStorage.getItem(HUD_SEATING_STORAGE_KEY) || "{}");
    if (storedSeating && typeof storedSeating === "object") hudSeating = storedSeating;
  } catch (e) {}

  function saveHudSeating() {
    try {
      localStorage.setItem(HUD_SEATING_STORAGE_KEY, JSON.stringify(hudSeating));
    } catch (e) {}
  }

  // Dragged offsets are kept per table and survive HUD hide/show, page reloads and switching
  // between tables, but a player sitting down or players changing seats drops that table's
  // offsets. Players leaving keeps them.
  function syncHudSeating(seatingByTable) {
    Object.keys(seatingByTable).forEach((tableKey) => {
      const current = seatingByTable[tableKey];
      if (!hudSeating[tableKey]) adoptSceneHudOffsets(tableKey, current);
      const known = hudSeating[tableKey];
      if (known && !Object.keys(current).some((seat) => known[seat] !== current[seat])) return;
      if (known) {
        Object.keys(hudOffsets).forEach((key) => {
          if (key.indexOf(tableKey + ":") === 0) delete hudOffsets[key];
        });
        saveHudOffsets();
      }
      hudSeating[tableKey] = current;
      saveHudSeating();
    });
  }

  // Up to v9.8 offsets were kept per scene index ("0:seat-template-3"), and the table switcher
  // always shows scene 0. The first table seen with that scene's seating takes its offsets over.
  function adoptSceneHudOffsets(tableKey, current) {
    Object.keys(hudSeating).forEach((scene) => {
      if (!/^\d+$/.test(scene)) return;
      const seating = hudSeating[scene];
      if (Object.keys(current).some((seat) => seating[seat] !== current[seat])) return;
      Object.keys(hudOffsets).forEach((key) => {
        if (key.indexOf(scene + ":") !== 0) return;
        hudOffsets[tableKey + key.slice(scene.length)] = hudOffsets[key];
        delete hudOffsets[key];
      });
      delete hudSeating[scene];
      hudSeating[tableKey] = seating;
      saveHudOffsets();
      saveHudSeating();
    });
  }

  // The table a scene shows: the open table seating most of the scene's players, the page's
  // table on a tie. The URL's tableId can change a frame before or after the scene re-renders.
  function sceneTableKey(names, sceneIdx) {
    const shownTableId = getPageTableId();
    const wanted = names.map((name) => name.toLowerCase());
    let best = null;
    let bestHits = 0;
    openTables().forEach((table) => {
      const seated = table.players.map((name) => String(name).toLowerCase());
      const hits = wanted.filter((name) => seated.indexOf(name) >= 0).length;
      if (hits > bestHits || (hits > 0 && hits === bestHits && table.id === shownTableId)) {
        best = table;
        bestHits = hits;
      }
    });
    if (best) return "t" + best.id;
    return shownTableId ? "t" + shownTableId : "s" + sceneIdx;
  }

  function seatTemplate(seatEl) {
    const className = typeof seatEl.className === "string" ? seatEl.className : "";
    const template = className.match(/seat-template-\d+/);
    return template ? template[0] : "seat";
  }

  function shownHudOffset(key, barW, barH) {
    const saved = hudOffsets[key];
    if (!saved) return { dx: 0, dy: 0 };
    const width = saved.barW > 0 ? barW / saved.barW : 1;
    const height = saved.barH > 0 ? barH / saved.barH : 1;
    return {
      dx: saved.dx * width,
      dy: saved.dy * height
    };
  }

  function bindSeatHudDrag(node) {
    if (node._dragBound) return;
    node._dragBound = true;
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const key = node._seatKey;
      if (!key) return;
      const shown = shownHudOffset(key, node._barW || 1, node._barH || 1);
      hudDrag = {
        key: key,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: shown.dx,
        dy: shown.dy,
        barW: node._barW || 1,
        barH: node._barH || 1
      };
      node.style.cursor = "grabbing";
      try { node.setPointerCapture(event.pointerId); } catch (err) {}
      event.preventDefault();
      event.stopPropagation();
    });
    node.addEventListener("pointermove", (event) => {
      if (!hudDrag || hudDrag.pointerId !== event.pointerId) return;
      hudOffsets[hudDrag.key] = {
        dx: hudDrag.dx + (event.clientX - hudDrag.startX),
        dy: hudDrag.dy + (event.clientY - hudDrag.startY),
        barW: hudDrag.barW,
        barH: hudDrag.barH
      };
      event.preventDefault();
      event.stopPropagation();
    });
    const endDrag = (event) => {
      if (!hudDrag || hudDrag.pointerId !== event.pointerId) return;
      saveHudOffsets();
      hudDrag = null;
      node.style.cursor = "grab";
    };
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
    node.addEventListener("dblclick", (event) => {
      const key = node._seatKey;
      if (!key || !hudOffsets[key]) return;
      delete hudOffsets[key];
      saveHudOffsets();
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function createSeatHudNode() {
    const node = document.createElement("div");
    node.className = "poker-tracker-seat-hud";
    node.style.cssText = [
      "position:fixed",
      "z-index:2147483646",
      "transform:translateX(-50%)",
      "display:flex",
      "align-items:center",
      "gap:4px",
      "pointer-events:auto",
      "cursor:grab",
      "touch-action:none",
      "user-select:none",
      "white-space:nowrap"
    ].join(";");
    bindSeatHudDrag(node);
    return node;
  }

  function layoutSeatHuds() {
    const layer = ensureSeatHudLayer();
    if (tablePlayersOverlayHidden) {
      layer.style.display = "none";
      return;
    }
    layer.style.display = "block";

    const live = new Set();
    const names = [];
    const seatingByTable = {};
    const metrics = hudMetrics();
    const scenes = Array.prototype.slice.call(document.querySelectorAll(".r-scene-container"));
    const namedSeats = [];
    const namesByScene = {};
    document.querySelectorAll(".r-seat").forEach((seatEl) => {
      const nameEl = seatEl.querySelector(".bar-text.player-name");
      const name = nameEl ? String(nameEl.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (!name || !nameEl) return;
      const scene = seatEl.closest(".r-scene-container");
      const sceneIdx = scene ? scenes.indexOf(scene) : 0;
      namedSeats.push({ seatEl: seatEl, nameEl: nameEl, name: name, sceneIdx: sceneIdx });
      (namesByScene[sceneIdx] = namesByScene[sceneIdx] || []).push(name);
    });
    const tableKeyByScene = {};
    Object.keys(namesByScene).forEach((sceneIdx) => {
      tableKeyByScene[sceneIdx] = sceneTableKey(namesByScene[sceneIdx], sceneIdx);
    });

    namedSeats.forEach((namedSeat) => {
      const seatEl = namedSeat.seatEl;
      const nameEl = namedSeat.nameEl;
      const name = namedSeat.name;
      live.add(seatEl);
      names.push(name);
      const tableKey = tableKeyByScene[namedSeat.sceneIdx];
      const template = seatTemplate(seatEl);
      const seatKey = tableKey + ":" + template;
      (seatingByTable[tableKey] = seatingByTable[tableKey] || {})[template] = name;

      let node = seatHudBySeat.get(seatEl);
      if (!node || !node.isConnected) {
        node = createSeatHudNode();
        layer.appendChild(node);
        seatHudBySeat.set(seatEl, node);
      }

      const bar = seatEl.querySelector(".r-player-bar") || nameEl;
      const rect = bar.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        node.style.visibility = "hidden";
        return;
      }
      node.style.visibility = "visible";
      node.style.gap = metrics.gap + "px";
      node.style.padding = metrics.stripPadY + "px " + metrics.stripPadX + "px";
      node.style.borderRadius = (metrics.radius + 2) + "px";
      node.style.background = "rgba(0,0,0,0.55)";
      node.style.opacity = "0.8";
      node._seatKey = seatKey;
      node._barW = rect.width;
      node._barH = rect.height;
      const placed = shownHudOffset(node._seatKey, rect.width, rect.height);
      const left = Math.round(rect.left + rect.width / 2 + placed.dx);
      const top = Math.round(rect.bottom + metrics.offset + 20 + placed.dy);
      if (node._left !== left) {
        node._left = left;
        node.style.left = left + "px";
      }
      if (node._top !== top) {
        node._top = top;
        node.style.top = top + "px";
      }
      const sig = seatHudSignature(name, metrics.scale);
      if (node._sig !== sig) {
        node._sig = sig;
        renderHudStatBadges(node, name, metrics);
      }
    });

    seatHudBySeat.forEach((node, seatEl) => {
      if (live.has(seatEl) && seatEl.isConnected) return;
      node.remove();
      seatHudBySeat.delete(seatEl);
    });

    syncHudSeating(seatingByTable);

    if (names.length) {
      const nextKey = names.join("|");
      if (nextKey !== layoutSeatHuds._namesKey) {
        layoutSeatHuds._namesKey = nextKey;
        setCurrentTablePlayerNames(names);
      }
    }
  }

  function seatHudLoop() {
    try {
      layoutSeatHuds();
    } catch (e) {}
    if (!tablePlayersOverlayHidden && document.visibilityState === "visible") {
      seatHudFrame = requestAnimationFrame(seatHudLoop);
      return;
    }
    seatHudFrame = 0;
  }

  function ensureSeatHudLoop() {
    if (tablePlayersOverlayHidden || document.visibilityState !== "visible") {
      if (seatHudFrame) cancelAnimationFrame(seatHudFrame);
      seatHudFrame = 0;
      try {
        layoutSeatHuds();
      } catch (e) {}
      return;
    }
    if (!seatHudFrame) seatHudFrame = requestAnimationFrame(seatHudLoop);
  }

  function updateTablePlayersOverlay(gs, activeSeatIndexes) {
    try {
      const toggleId = "poker-tracker-table-players-toggle";
      const controlsId = "poker-tracker-controls";
      let controlsEl = document.getElementById(controlsId);
      if (!controlsEl) {
        controlsEl = document.createElement("div");
        controlsEl.id = controlsId;
        controlsEl.style.cssText = [
          "position:fixed",
          "top:10%",
          "right:12px",
          "z-index:2147483647",
          "display:flex",
          "flex-direction:row",
          "align-items:stretch",
          "gap:8px"
        ].join(";");
        document.documentElement.appendChild(controlsEl);
      }

      const controlHeight = "30px";
      const sharedControlBaseCss = [
        "height:" + controlHeight,
        "box-sizing:border-box",
        "display:inline-flex",
        "align-items:center",
        "border:1px solid #22c55e",
        "border-radius:6px",
        "background:linear-gradient(180deg,#1f2937,#111827)",
        "color:#f8fafc",
        "font:700 12px/1 Arial,sans-serif",
        "letter-spacing:.06em",
        "cursor:pointer",
        "pointer-events:auto",
        "user-select:none",
        "box-shadow:0 3px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)"
      ];

      const trackingSwitchId = "poker-tracker-tracking-switch";
      let trackingSwitch = document.getElementById(trackingSwitchId);
      if (!trackingSwitch) {
        trackingSwitch = document.createElement("div");
        trackingSwitch.id = trackingSwitchId;
        trackingSwitch.style.cssText = sharedControlBaseCss.concat([
          "gap:8px",
          "padding:0 12px"
        ]).join(";");

        const labelEl = document.createElement("span");
        labelEl.id = trackingSwitchId + "-label";
        labelEl.textContent = "REC";
        trackingSwitch.appendChild(labelEl);

        const trackEl = document.createElement("span");
        trackEl.id = trackingSwitchId + "-track";
        trackEl.style.cssText = [
          "position:relative",
          "display:inline-block",
          "width:32px",
          "height:18px",
          "border-radius:999px",
          "transition:background-color .15s ease",
          "box-shadow:inset 0 1px 2px rgba(0,0,0,0.4)"
        ].join(";");

        const thumbEl = document.createElement("span");
        thumbEl.id = trackingSwitchId + "-thumb";
        thumbEl.style.cssText = [
          "position:absolute",
          "top:2px",
          "left:2px",
          "width:14px",
          "height:14px",
          "border-radius:50%",
          "background:#ffffff",
          "transition:left .15s ease",
          "box-shadow:0 1px 2px rgba(0,0,0,0.4)"
        ].join(";");
        trackEl.appendChild(thumbEl);
        trackingSwitch.appendChild(trackEl);

        trackingSwitch.setAttribute("role", "switch");
        trackingSwitch.addEventListener("click", function() {
          if (trackingEnabled) {
            flushAllTables();
            trackingEnabled = false;
            tables.forEach((table) => {
              table.recording = false;
            });
          } else {
            trackingEnabled = true;
            console.log("[tracker] tracking armed - each table starts sending at its next hand");
          }
          applyTrackingSwitchState(this);
        });
        controlsEl.appendChild(trackingSwitch);
      }
      applyTrackingSwitchState(trackingSwitch);

      let toggleBtn = document.getElementById(toggleId);
      if (!toggleBtn) {
        toggleBtn = document.createElement("button");
        toggleBtn.id = toggleId;
        toggleBtn.type = "button";
        toggleBtn.style.cssText = sharedControlBaseCss.concat([
          "padding:0 14px"
        ]).join(";");
        toggleBtn.addEventListener("click", function() {
          tablePlayersOverlayHidden = !tablePlayersOverlayHidden;
          this.textContent = "HUD";
          this.style.opacity = tablePlayersOverlayHidden ? "0.75" : "1";
          ensureSeatHudLoop();
        });
        controlsEl.appendChild(toggleBtn);
      }
      toggleBtn.textContent = "HUD";
      toggleBtn.style.opacity = tablePlayersOverlayHidden ? "0.75" : "1";

      if (!document.getElementById("poker-tracker-hud-countdown")) {
        const countdown = document.createElement("span");
        countdown.id = "poker-tracker-hud-countdown";
        countdown.title = "Time until next auto-refresh";
        countdown.style.cssText = sharedControlBaseCss.concat([
          "padding:0 8px",
          "cursor:default",
          "font:600 12px/1 Consolas,Monaco,'Courier New',monospace",
          "letter-spacing:0",
          "color:#9ca3af"
        ]).join(";");
        controlsEl.appendChild(countdown);
        updateHudCountdownDisplay();
      }
      if (!document.getElementById("poker-tracker-hud-reload")) {
        const reloadBtn = buildHudReloadButton();
        reloadBtn.style.height = controlHeight;
        reloadBtn.style.width = controlHeight;
        controlsEl.appendChild(reloadBtn);
      }
      if (!document.getElementById("poker-tracker-extension-reload")) {
        const extBtn = document.createElement("button");
        extBtn.id = "poker-tracker-extension-reload";
        extBtn.type = "button";
        extBtn.title = "Reload extension and this table";
        extBtn.textContent = "UPD";
        extBtn.style.cssText = sharedControlBaseCss.concat([
          "padding:0 10px"
        ]).join(";");
        extBtn.addEventListener("click", function(ev) {
          ev.stopPropagation();
          try { flushAllTables(); } catch (err) {}
          const btn = this;
          btn.disabled = true;
          btn.textContent = "...";
          document.dispatchEvent(new CustomEvent("poker-tracker-reload-extension"));
          // extension-bridge.js reloads the page; if that was blocked or cancelled, let UPD be clicked again.
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = "UPD";
          }, 10000);
        });
        controlsEl.appendChild(extBtn);
      }
      if (!document.getElementById("poker-tracker-hud-size-minus")) {
        const minusBtn = document.createElement("button");
        minusBtn.id = "poker-tracker-hud-size-minus";
        minusBtn.type = "button";
        minusBtn.title = "Smaller stats";
        minusBtn.textContent = "\u2212";
        minusBtn.style.cssText = sharedControlBaseCss.concat([
          "width:" + controlHeight,
          "padding:0",
          "justify-content:center",
          "font-size:18px"
        ]).join(";");
        minusBtn.addEventListener("click", function(ev) {
          ev.stopPropagation();
          changeHudSize(-1);
        });
        controlsEl.appendChild(minusBtn);
      }
      if (!document.getElementById("poker-tracker-hud-size-plus")) {
        const plusBtn = document.createElement("button");
        plusBtn.id = "poker-tracker-hud-size-plus";
        plusBtn.type = "button";
        plusBtn.title = "Bigger stats";
        plusBtn.textContent = "+";
        plusBtn.style.cssText = sharedControlBaseCss.concat([
          "width:" + controlHeight,
          "padding:0",
          "justify-content:center",
          "font-size:18px"
        ]).join(";");
        plusBtn.addEventListener("click", function(ev) {
          ev.stopPropagation();
          changeHudSize(1);
        });
        controlsEl.appendChild(plusBtn);
      }

      const domNames = collectDomSeatNames();
      if (!activeSeatIndexes.length && !domNames.length) {
        setCurrentTablePlayerNames([]);
        ensureSeatHudLoop();
        return;
      }
      const players = activeSeatIndexes.map((idx) => {
        const seat = gs.s[idx];
        return (seat && (seat.dn || seat.n)) || "";
      });
      setCurrentTablePlayerNames(domNames.length ? domNames : players);
      ensureSeatHudLoop();
    } catch (e) {}
  }

  function tableFor(tableId) {
    const id = tableId || 0;
    let table = tables.get(id);
    if (!table) {
      table = {
        id: id,
        recorder: PokerSnapshotRecorder.createRecorder(),
        handId: null,
        boardCount: 0,
        tournamentId: null,
        // Tournament of the hand being recorded, fixed when the hand starts.
        handTournamentId: null,
        // REC was on when the current hand started, so it is recorded from its first snapshot.
        recording: false,
        players: [],
        seenAt: 0
      };
      tables.set(id, table);
    }
    return table;
  }

  // The shown table always counts as open, so a long break keeps its tournament reported.
  function openTables() {
    const now = Date.now();
    const shownTableId = getPageTableId();
    return Array.from(tables.values()).filter((table) => now - table.seenAt < TABLE_IDLE_MS || table.id === shownTableId);
  }

  function recordingTableCount() {
    return Array.from(tables.values()).filter((table) => table.recording).length;
  }

  function startHand(table, handId, boardCount) {
    flushTable(table);
    // A table's first hand is joined mid-way (table opened, page loaded), so it is never recorded.
    const sawStart = table.handId !== null;
    const wasRecording = table.recording;
    table.handId = handId;
    table.boardCount = boardCount;
    table.handTournamentId = table.tournamentId;
    table.recording = trackingEnabled && sawStart;
    if (table.recording && !wasRecording) {
      console.log("%c[tracker] table " + table.id + ": sending hands starting hand " + handId, "color:#22c55e;font-weight:bold;");
      try {
        const switchEl = document.getElementById("poker-tracker-tracking-switch");
        if (switchEl) applyTrackingSwitchState(switchEl);
      } catch (e) {}
    }
    console.log("%c[tracker] ===== NEW HAND " + handId + " (table " + table.id + ") =====", "color:#22c55e;font-weight:bold;");
  }

  function recordSnapshot(table, boardCount, dealerIdx, gs) {
    if (!table.recording) return;
    const seats = [];
    for (let i = 0; i < gs.s.length; i += 1) {
      const seat = gs.s[i];
      if (!seat) continue;
      const playerName = seat.dn || seat.n;
      if (!playerName) continue;
      // seat.c is the chip stack (the server omits it at 0); seat.s is not a stack.
      // seat.i is the player id, seat.ec the entry count (1 + re-entries); tournaments only.
      seats.push({
        idx: i,
        name: playerName,
        la: toNum(seat.la, null),
        b: toNum(seat.b, 0),
        stack: toNum(seat.c, 0),
        pid: toNum(seat.i, null),
        ec: toNum(seat.ec, null)
      });
    }
    if (!seats.length) return;
    const result = table.recorder.add(table.handId, boardCount, dealerIdx, seats);
    if (result && result.done) flushTable(table);
  }

  function flushTable(table) {
    if (!table.recording) return;
    const hand = table.recorder.flush();
    if (!hand) return;
    if (table.handTournamentId) hand.tournamentId = table.handTournamentId;
    const payload = JSON.stringify(hand);
    console.log("[tracker] POST raw hand " + hand.handId + " table " + table.id + " (" + hand.snapshots.length + " snapshots)");
    try {
      fetch(RAW_HAND_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  function flushAllTables() {
    tables.forEach((table) => flushTable(table));
  }

  function syncOpenTournaments() {
    tournamentReporter.setTournaments(openTables().map((table) => table.tournamentId));
  }

  function sendTournamentsIfDue() {
    syncOpenTournaments();
    if (!trackingEnabled || !recordingTableCount()) return;
    const now = Date.now();
    let payload = tournamentReporter.due(now);
    while (payload) {
      try {
        fetch(TOURNAMENT_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => {});
      } catch (e) {}
      payload = tournamentReporter.due(now);
    }
  }

  function applyTrackingSwitchState(switchEl) {
    if (!switchEl) return;
    const track = switchEl.querySelector("#" + switchEl.id + "-track");
    const thumb = switchEl.querySelector("#" + switchEl.id + "-thumb");
    switchEl.setAttribute("aria-checked", trackingEnabled ? "true" : "false");

    let trackColor = "#4b5563";
    let title = "Tracking disabled";
    if (trackingEnabled) {
      const recording = recordingTableCount();
      if (!recording) {
        trackColor = "#eab308";
        title = "Tracking armed - each table starts at its next hand";
      } else {
        trackColor = "#16a34a";
        title = "Tracking active (" + recording + (recording === 1 ? " table)" : " tables)");
      }
    }
    switchEl.title = title;
    if (track) track.style.background = trackColor;
    if (thumb) thumb.style.left = trackingEnabled ? "16px" : "2px";
    switchEl.style.opacity = trackingEnabled ? "1" : "0.85";
  }

  function processGameState(payload) {
    const gs = payload.gameState || payload;
    if (!gs || !gs.gi || !Array.isArray(gs.s)) return;
    // Every table is tracked, shown or not: a tab with several tables gets all their GameStates
    // interleaved on one socket, and the URL's tableId only names the one on screen.
    const table = tableFor(gs.ti);
    table.seenAt = Date.now();
    table.tournamentId = gs.tri || null;
    const activeSeatIndexes = [];
    const players = [];
    for (let i = 0; i < gs.s.length; i += 1) {
      const seat = gs.s[i];
      if (seat && (seat.dn || seat.n)) {
        activeSeatIndexes.push(i);
        players.push(seat.dn || seat.n);
      }
    }
    table.players = players;

    const handId = gs.gi;
    const boardCount = getBoardCount(gs);
    if (handId !== table.handId) startHand(table, handId, boardCount);
    // Street changes are driven by board-card events only (0->3->4->5).
    table.boardCount = Math.max(boardCount, table.boardCount);
    recordSnapshot(table, table.boardCount, toNum(gs?.m?.di, 0), gs);
    syncOpenTournaments();
    updateTablePlayersOverlay(gs, activeSeatIndexes);
  }

  const tappedSockets = new WeakSet();

  function handleWsPayload(rawText) {
    try {
      const msg = JSON.parse(rawText);
      if (msg.t === "GameState" || msg.gameState || (msg.gi && msg.s)) {
        processGameState(msg);
      } else if (msg.t === "LobbyTournamentInfo") {
        // The reporter merges full and partial infos and only reports the open tables' tournaments.
        tournamentReporter.onInfo(msg.info);
        sendTournamentsIfDue();
      } else if (msg.t === "TournamentPrizeDistributionResponse") {
        tournamentReporter.onPrizes(msg.distributionTable);
        sendTournamentsIfDue();
      }
    } catch (e) {}
  }

  function onWsMessage(event) {
    const data = event.data;
    if (typeof data === "string") {
      handleWsPayload(data);
      return;
    }
    if (data instanceof Blob) {
      data.text().then(handleWsPayload).catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder("utf-8").decode(new Uint8Array(data));
        handleWsPayload(text);
      } catch (e) {}
    }
  }

  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (!tappedSockets.has(this)) {
      tappedSockets.add(this);
      this.addEventListener("message", onWsMessage);
    }
    return originalSend.call(this, data);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    if (!tappedSockets.has(ws)) {
      tappedSockets.add(ws);
      ws.addEventListener("message", onWsMessage);
    }
    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  window.addEventListener("pagehide", flushAllTables);

  window._pokerActions = function() {
    const hands = [];
    tables.forEach((table) => {
      const hand = table.recorder.peek();
      if (!hand) return;
      console.log("[tracker] table " + table.id);
      console.table(hand.snapshots);
      hands.push(Object.assign({ tableId: table.id }, hand));
    });
    return hands;
  };
})();
