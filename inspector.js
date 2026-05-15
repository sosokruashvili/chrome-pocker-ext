// === POKER HAND TRACKER v81 ===

(function() {
  "use strict";

  const TRACKER_VERSION = "v81";
  const LOAD_STAMP = new Date().toLocaleTimeString() + " #" + Math.random().toString(36).slice(2, 7);
  const API_URL = "https://team.evlog.ge/api/hand-history";
  const HUD_STATS_API_URL = "https://team.evlog.ge/api/hand-history/hud-stats";
  const HUD_STATS_REFRESH_MS = 60 * 1000;
  const DEBUG_HUD_STATS = false;
  const HUD_STAT_BADGE_COLORS = {
    vpip: "#22543d",
    pfr: "#742a2a",
    threeBet: "#744210",
    af: "#553c9a",
    hands: "#2a4365"
  };
  const DEBUG_EMIT_REASONS = false;
  const DEBUG_SANITY_MONITOR = false;
  const LOG_COL_WIDTH = 10;

  // action_7 is treated as blind/system event and filtered.
  const IGNORE_LA = new Set([4, 6, 7]);
  const ACTION_MAP = {
    1: "fold",
    2: "check",
    3: "call",
    5: "check",
    8: "bet",
    9: "raise",
    10: "win",
    16: "collect"
  };
  const CHIP_IN_ACTIONS = new Set(["call", "limp", "bet", "raise", "complete", "3bet", "4bet", "5bet", "6bet"]);

  let currentHandId = null;
  let previousRound = "preflop";
  let previousBoardCount = 0;
  let snapshotSeq = 0;

  // Per-seat state keyed by seat index.
  let seatState = {};
  let foldedBySeat = {};
  let handClosed = false;
  let streetAggressorSeat = null;
  let streetOpenBetAmount = 0;
  let streetPendingResponseBySeat = {};
  let pendingCarryResponseRoundBySeat = {};
  let streetRaiseCountByRound = {};
  let preflopRaisedSeen = false;
  let firstSeenChipInBySeatRound = {};
  let preflopActionCountBySeat = {};
  let actionCountBySeat = {};
  let maxRoundSeenBySeat = {};
  let lockedPositionBySeat = {};
  let lastActionRoundBySeat = {};
  let lastEmitSignatureBySeat = {};
  let handActions = [];
  let playerNameBySeat = {};
  let tablePlayersOverlayHidden = true;
  let trackingEnabled = true;
  let currentTablePlayerNames = [];
  let hudStatsByPlayerName = {};
  let hudStatsFetchedAtByPlayerName = {};
  let hudStatsRequestInFlight = false;
  let hudStatsLoopTimer = null;
  const seenUnknownLa = new Set();
  let seenSanityWarningKeys = new Set();

  console.log(
    "%c[tracker] " + TRACKER_VERSION + " loaded " + LOAD_STAMP,
    "background:#16a34a;color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;"
  );

  function showVersionBadge() {
    try {
      const existing = document.getElementById("poker-tracker-version-badge");
      if (existing) existing.remove();

      const badge = document.createElement("div");
      badge.id = "poker-tracker-version-badge";
      badge.textContent = "Poker Tracker " + TRACKER_VERSION + " | " + LOAD_STAMP;
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

  function fixedCol(value) {
    const raw = String(value === undefined || value === null ? "" : value);
    if (raw.length > LOG_COL_WIDTH) {
      return raw.slice(0, LOG_COL_WIDTH);
    }
    return raw.padEnd(LOG_COL_WIDTH, " ");
  }

  function formatLogRow(player, position, round, action) {
    return [fixedCol(player), fixedCol(position), fixedCol(round), fixedCol(action)].join(" | ");
  }

  function getBoardCount(gameState) {
    const cards = gameState?.d?.c;
    if (!cards) return 0;
    return cards.split(";").filter(Boolean).length;
  }

  function getRoundFromBoardCount(count) {
    if (count >= 5) return "river";
    if (count === 4) return "turn";
    if (count === 3) return "flop";
    return "preflop";
  }

  function getPositionName(idx, dealerIdx, activeSeatIndexes) {
    const activeCount = activeSeatIndexes.length;
    if (activeCount === 0) return "BTN";

    const dealerPos = activeSeatIndexes.indexOf(dealerIdx);
    const safeDealerPos = dealerPos >= 0 ? dealerPos : 0;
    const seatPos = activeSeatIndexes.indexOf(idx);
    if (seatPos < 0) return "BTN";

    const relPos = (seatPos - safeDealerPos + activeCount) % activeCount;
    if (activeCount === 2) {
      if (relPos === 0) return "BTN";
      return "BB";
    }
    if (relPos === 0) return "BTN";
    if (relPos === 1) return "SB";
    if (relPos === 2) return "BB";
    if (relPos === 3) return "UTG";
    return "UTG" + (relPos - 2);
  }

  function resetHandState(handId, startingBoardCount) {
    currentHandId = handId;
    previousBoardCount = startingBoardCount;
    previousRound = getRoundFromBoardCount(startingBoardCount);
    snapshotSeq = 0;
    seatState = {};
    foldedBySeat = {};
    handClosed = false;
    streetAggressorSeat = null;
    streetOpenBetAmount = 0;
    streetPendingResponseBySeat = {};
    pendingCarryResponseRoundBySeat = {};
    streetRaiseCountByRound = {};
    preflopRaisedSeen = false;
    firstSeenChipInBySeatRound = {};
    preflopActionCountBySeat = {};
    actionCountBySeat = {};
    maxRoundSeenBySeat = {};
    lockedPositionBySeat = {};
    lastActionRoundBySeat = {};
    lastEmitSignatureBySeat = {};
    handActions = [];
    playerNameBySeat = {};
    seenSanityWarningKeys = new Set();
    console.log("%c[tracker] ===== NEW HAND " + handId + " =====", "color:#22c55e;font-weight:bold;");
  }

  function buildEntry(handId, player, position, round, action, amount) {
    const entry = {
      handId: handId,
      player: player,
      position: position,
      round: round,
      action: action
    };
    if (amount > 0 && CHIP_IN_ACTIONS.has(action)) {
      entry.amount = amount;
    }
    return entry;
  }

  function isAggressiveAction(action) {
    return action === "bet" || action === "raise" || /^\dbet$/.test(action);
  }

  function inferChipInAction(currentB, previousB, tableMaxBefore) {
    if (currentB <= previousB) return null;
    if (tableMaxBefore <= 0) return "bet";
    if (currentB > tableMaxBefore) return "raise";
    return "call";
  }

  function shouldEmitBySignal(params) {
    const actionName = params.actionName;
    const currentLa = params.currentLa;
    const prev = params.prev;
    const roundChanged = params.roundChanged;
    const seatIdx = params.seatIdx;
    const roundNow = params.roundNow;
    const bIncreased = params.bIncreased;
    const sChanged = params.sChanged;
    const cChanged = params.cChanged;

    if (!actionName) {
      if (!seenUnknownLa.has(currentLa)) {
        seenUnknownLa.add(currentLa);
        console.warn("[tracker] unmapped la:", currentLa);
      }
      if (!prev) return { ok: false, reason: "unknown_la_" + currentLa };
      if (roundChanged) return { ok: false, reason: "unknown_la_round_boundary" };
      if (bIncreased) return { ok: true, reason: "b_increased_unknown_la" };
      return { ok: false, reason: "unknown_la_" + currentLa };
    }

    // First sighting of a seat in a hand: only emit clear action states.
    if (!prev) {
      if (actionName === "fold" && roundNow === "preflop") return { ok: true, reason: "first_seen_preflop_fold" };
      if (CHIP_IN_ACTIONS.has(actionName) && params.currentB > 0) return { ok: true, reason: "first_seen_chip_in" };
      return { ok: false, reason: "first_seen_no_action" };
    }

    const laChanged = prev.la !== currentLa;
    if (laChanged) {
      return { ok: true, reason: "la_changed" };
    }

    // If the street has just changed, ignore non-la boundary noise.
    if (roundChanged) {
      return { ok: false, reason: "round_boundary_without_la_change" };
    }

    // Fallback for clients that repeat sticky/non-chip la while contribution increases.
    if (bIncreased) {
      if (CHIP_IN_ACTIONS.has(actionName)) {
        return { ok: true, reason: "b_increased_same_la" };
      }
      return { ok: true, reason: "b_increased_infer_action" };
    }

    // Last-resort signal only for folds where clients can keep la sticky.
    // We intentionally avoid fallback-based checks because they create false positives.
    if ((sChanged || cChanged) && lastActionRoundBySeat[seatIdx] !== roundNow && actionName === "fold") {
      return { ok: true, reason: "state_changed_fallback" };
    }

    return { ok: false, reason: "no_signal" };
  }

  function tagRound(params) {
    const roundNow = params.roundNow;
    const prevRound = params.prevRound;
    const roundChanged = params.roundChanged;
    const usedReason = params.usedReason;
    const actionName = params.actionName;

    // If street just changed and we emitted from non-la fallback, pin to previous street.
    if (roundChanged && usedReason !== "la_changed") {
      return prevRound;
    }
    // Some la updates arrive one snapshot late right after board street advances.
    // Re-tag delayed boundary calls to previous round to prevent +1 street drift.
    if (roundChanged && usedReason === "la_changed" && actionName === "call") {
      return prevRound;
    }
    // Check updates can also arrive one snapshot late at street boundaries.
    if (roundChanged && usedReason === "la_changed" && actionName === "check") {
      return prevRound;
    }
    return roundNow;
  }

  function roundRank(round) {
    if (round === "preflop") return 0;
    if (round === "flop") return 1;
    if (round === "turn") return 2;
    if (round === "river") return 3;
    return -1;
  }

  function prevRoundName(round) {
    if (round === "flop") return "preflop";
    if (round === "turn") return "flop";
    if (round === "river") return "turn";
    return null;
  }

  function warnInvariant(code, details) {
    if (!DEBUG_SANITY_MONITOR) return;
    const seatPart = details && details.seatIdx !== undefined ? String(details.seatIdx) : "-";
    const roundPart = details && details.round ? details.round : "-";
    const key = [currentHandId, code, seatPart, roundPart].join("|");
    if (seenSanityWarningKeys.has(key)) return;
    seenSanityWarningKeys.add(key);
    console.warn("[tracker][sanity] " + code, details || {});
  }

  function isSeatMeaningfulPending(seatIdx) {
    if (!playerNameBySeat[seatIdx]) return false;
    if (foldedBySeat[seatIdx]) return false;
    if (toNum(actionCountBySeat[seatIdx], 0) > 0) return true;
    if (lastActionRoundBySeat[seatIdx] !== undefined) return true;
    // Do not use seat.b here: some feeds can carry non-zero baseline values for
    // players who never actually acted in the current hand, causing false folds.
    if (pendingCarryResponseRoundBySeat[seatIdx]) return true;
    return false;
  }

  function getLockedOrComputedPosition(seatIdx, dealerIdx, activeSeatIndexes) {
    const existing = lockedPositionBySeat[seatIdx];
    if (existing) return existing;
    const computed = getPositionName(seatIdx, dealerIdx, activeSeatIndexes);
    lockedPositionBySeat[seatIdx] = computed;
    return computed;
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

  function renderHudOverlayFromCurrentState() {
    const el = document.getElementById("poker-tracker-table-players-overlay");
    if (!el) return;
    if (!currentTablePlayerNames.length) {
      el.textContent = "-";
      return;
    }
    el.replaceChildren();

    const table = document.createElement("table");
    table.style.cssText = [
      "width:100%",
      "border-collapse:collapse",
      "table-layout:fixed",
      "font:14px/1.35 Consolas,Monaco,'Courier New',monospace"
    ].join(";");

    const headerRow = document.createElement("tr");
    const playerHeader = document.createElement("th");
    playerHeader.style.cssText = [
      "padding:0 4px 6px 0",
      "width:38%",
      "font:600 11px/1.2 Arial,sans-serif",
      "letter-spacing:.04em",
      "text-transform:uppercase",
      "color:#9ca3af",
      "white-space:nowrap",
      "text-align:left"
    ].join(";");
    playerHeader.textContent = "Player";
    headerRow.appendChild(playerHeader);
    ["VPIP", "PFR", "3B", "AF", "H"].forEach((label) => {
      const statHeader = document.createElement("th");
      statHeader.style.cssText = [
        "padding:0 0 6px 0",
        "width:12.4%",
        "font:600 11px/1.2 Arial,sans-serif",
        "letter-spacing:.04em",
        "text-transform:uppercase",
        "color:#9ca3af",
        "white-space:nowrap",
        "text-align:center"
      ].join(";");
      statHeader.textContent = label;
      headerRow.appendChild(statHeader);
    });
    table.appendChild(headerRow);

    currentTablePlayerNames.forEach((name) => {
      const row = document.createElement("tr");

      const playerCell = document.createElement("td");
      playerCell.style.cssText = [
        "padding:2px 0px 2px 0",
        "width:38%",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "vertical-align:top",
        "color:#f9fafb"
      ].join(";");
      playerCell.textContent = name;
      row.appendChild(playerCell);

      const stats = hudStatsByPlayerName[name];
      if (!hasCompleteHudStats(stats)) {
        const loadingCell = document.createElement("td");
        loadingCell.colSpan = 5;
        loadingCell.style.cssText = [
          "padding:2px 0",
          "color:#9ca3af",
          "font:12px/1.2 Arial,sans-serif",
          "text-align:center"
        ].join(";");
        loadingCell.textContent = "loading...";
        row.appendChild(loadingCell);
      } else {
        const values = [
          { text: fmtHudNum(stats.vpip_percentage, 2), color: HUD_STAT_BADGE_COLORS.vpip, title: "VPIP" },
          { text: fmtHudNum(stats.pfr_percentage, 2), color: HUD_STAT_BADGE_COLORS.pfr, title: "PFR" },
          { text: fmtHudNum(stats.three_bet_percentage, 2), color: HUD_STAT_BADGE_COLORS.threeBet, title: "3B" },
          { text: fmtHudNum(stats.af, 2), color: HUD_STAT_BADGE_COLORS.af, title: "AF" },
          { text: String(toNum(stats.hands, 0)), color: HUD_STAT_BADGE_COLORS.hands, title: "Hands" }
        ];
        values.forEach((item) => {
          const statCell = document.createElement("td");
          statCell.style.cssText = [
            "padding:2px 0",
            "width:12.4%",
            "text-align:center",
            "vertical-align:top"
          ].join(";");
          statCell.appendChild(makeHudBadge(item.text, item.color, item.title));
          row.appendChild(statCell);
        });
      }
      table.appendChild(row);
    });

    el.appendChild(table);
  }

  function setCurrentTablePlayerNames(names) {
    const next = normalizePlayerNames(names);
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
    return vpip + " | " + pfr + " | " + threeBet + " | " + af + " | " + hands;
  }

  function makeHudBadge(text, backgroundColor, title) {
    const badge = document.createElement("span");
    badge.style.cssText = [
      "display:inline-block",
      "padding:2px 6px",
      "margin:0",
      "border-radius:5px",
      "background:" + backgroundColor,
      "color:#ffffff",
      "font:600 12px/1.2 Arial,sans-serif",
      "white-space:nowrap"
    ].join(";");
    badge.textContent = text;
    if (title) badge.title = title;
    return badge;
  }

  function renderHudStatBadges(container, playerName) {
    container.replaceChildren();
    const stats = hudStatsByPlayerName[playerName];
    if (!hasCompleteHudStats(stats)) {
      container.textContent = "loading...";
      return;
    }

    const vpip = fmtHudNum(stats.vpip_percentage, 2);
    const pfr = fmtHudNum(stats.pfr_percentage, 2);
    const threeBet = fmtHudNum(stats.three_bet_percentage, 2);
    const af = fmtHudNum(stats.af, 2);
    const hands = String(toNum(stats.hands, 0));

    container.appendChild(makeHudBadge(vpip, HUD_STAT_BADGE_COLORS.vpip, "VPIP"));
    container.appendChild(makeHudBadge(pfr, HUD_STAT_BADGE_COLORS.pfr, "PFR"));
    container.appendChild(makeHudBadge(threeBet, HUD_STAT_BADGE_COLORS.threeBet, "3B"));
    container.appendChild(makeHudBadge(af, HUD_STAT_BADGE_COLORS.af, "AF"));
    container.appendChild(makeHudBadge(hands, HUD_STAT_BADGE_COLORS.hands, "Hands"));
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
    hudStatsLoopTimer = setInterval(() => {
      runHudStatsLoopTick().catch(() => {});
    }, HUD_STATS_REFRESH_MS);
    runHudStatsLoopTick().catch(() => {});
  }
  startHudStatsLoop();

  function updateTablePlayersOverlay(gs, activeSeatIndexes) {
    try {
      const id = "poker-tracker-table-players-overlay";
      const toggleId = "poker-tracker-table-players-toggle";
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.style.cssText = [
          "position:fixed",
          "top:50%",
          "right:12px",
          "transform:translateY(-50%)",
          "z-index:2147483646",
          "background:rgba(17,24,39,0.92)",
          "color:#e5e7eb",
          "border:1px solid #22c55e",
          "padding:12px 14px",
          "border-radius:8px",
          "font:15px/1.5 Arial,sans-serif",
          "box-shadow:0 4px 16px rgba(0,0,0,0.3)",
          "pointer-events:none",
          "min-width:260px",
          "max-width:320px",
          "max-height:70vh",
          "overflow-y:auto",
          "overflow-x:hidden",
          "white-space:pre-wrap",
          "word-break:break-word"
        ].join(";");
        document.documentElement.appendChild(el);
      }
      let toggleBtn = document.getElementById(toggleId);
      if (!toggleBtn) {
        toggleBtn = document.createElement("button");
        toggleBtn.id = toggleId;
        toggleBtn.type = "button";
        toggleBtn.style.cssText = [
          "position:fixed",
          "top:calc(50% - 220px)",
          "right:12px",
          "z-index:2147483647",
          "background:linear-gradient(180deg,#1f2937,#111827)",
          "color:#f8fafc",
          "border:1px solid #22c55e",
          "border-radius:6px",
          "padding:6px 12px",
          "font:700 12px/1 Arial,sans-serif",
          "letter-spacing:.06em",
          "cursor:pointer",
          "pointer-events:auto",
          "box-shadow:0 3px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)"
        ].join(";");
        toggleBtn.addEventListener("click", function() {
          tablePlayersOverlayHidden = !tablePlayersOverlayHidden;
          const overlay = document.getElementById(id);
          if (overlay) {
            overlay.style.display = tablePlayersOverlayHidden ? "none" : "block";
          }
          this.textContent = "HUD";
          this.style.opacity = tablePlayersOverlayHidden ? "0.75" : "1";
        });
        document.documentElement.appendChild(toggleBtn);
      }
      toggleBtn.textContent = "HUD";
      toggleBtn.style.opacity = tablePlayersOverlayHidden ? "0.75" : "1";
      el.style.display = tablePlayersOverlayHidden ? "none" : "block";

      const trackingToggleId = "poker-tracker-tracking-toggle";
      let trackingBtn = document.getElementById(trackingToggleId);
      if (!trackingBtn) {
        trackingBtn = document.createElement("button");
        trackingBtn.id = trackingToggleId;
        trackingBtn.type = "button";
        trackingBtn.style.cssText = [
          "position:fixed",
          "top:calc(50% - 220px)",
          "right:84px",
          "z-index:2147483647",
          "border:1px solid #22c55e",
          "border-radius:6px",
          "padding:6px 12px",
          "font:700 12px/1 Arial,sans-serif",
          "letter-spacing:.06em",
          "cursor:pointer",
          "pointer-events:auto",
          "box-shadow:0 3px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)"
        ].join(";");
        trackingBtn.addEventListener("click", function() {
          trackingEnabled = !trackingEnabled;
          applyTrackingToggleStyle(this);
        });
        document.documentElement.appendChild(trackingBtn);
      }
      applyTrackingToggleStyle(trackingBtn);

      if (!activeSeatIndexes.length) {
        setCurrentTablePlayerNames([]);
        el.textContent = "-";
        return;
      }
      const players = activeSeatIndexes.map((idx) => {
        const seat = gs.s[idx];
        const name = (seat && (seat.dn || seat.n)) || "?";
        return name;
      });
      setCurrentTablePlayerNames(players);
      renderHudOverlayFromCurrentState();
    } catch (e) {}
  }

  function getPendingResponderSeatIndexes(excludeSeatIdx) {
    return Object.keys(streetPendingResponseBySeat)
      .map((key) => Number(key))
      .filter((seatIdx) => !!streetPendingResponseBySeat[seatIdx] && seatIdx !== excludeSeatIdx && isSeatMeaningfulPending(seatIdx));
  }

  async function sendAction(entry) {
    if (!trackingEnabled) return;
    const payload = JSON.stringify(entry);
    //console.log("[tracker] POST " + API_URL, payload);
    try {
      await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      });
    } catch (e) {}
  }

  function applyTrackingToggleStyle(btn) {
    if (!btn) return;
    if (trackingEnabled) {
      btn.style.background = "linear-gradient(180deg,#16a34a,#15803d)";
      btn.style.borderColor = "#22c55e";
      btn.style.color = "#f0fdf4";
      btn.textContent = "REC ON";
    } else {
      btn.style.background = "linear-gradient(180deg,#374151,#1f2937)";
      btn.style.borderColor = "#6b7280";
      btn.style.color = "#e5e7eb";
      btn.textContent = "REC OFF";
    }
  }

  function trackStreetPressure(action, seatIdx, amount, activeSeatIndexes) {
    if (isAggressiveAction(action)) {
      streetAggressorSeat = seatIdx;
      streetOpenBetAmount = amount;
      streetPendingResponseBySeat = {};
      activeSeatIndexes.forEach((idx) => {
        if (idx !== seatIdx && !foldedBySeat[idx]) {
          streetPendingResponseBySeat[idx] = true;
        }
      });
      return;
    }

    if (!streetAggressorSeat && streetAggressorSeat !== 0) return;
    if (action === "call" || action === "complete" || action === "fold") {
      delete streetPendingResponseBySeat[seatIdx];
    }
  }

  function emitAction(params) {
    const handId = params.handId;
    const idx = params.idx;
    const playerName = params.playerName;
    const position = params.position;
    const finalRound = params.finalRound;
    const resolvedAction = params.resolvedAction;
    const currentLa = params.currentLa;
    const currentB = params.currentB;
    const seat = params.seat;
    const reason = params.reason;

    if (resolvedAction === "win_fold") {
      const pendingSeats = getPendingResponderSeatIndexes(idx);
      pendingSeats.forEach((seatIdx) => {
        const pendingName = playerNameBySeat[seatIdx];
        if (!pendingName) return;
        const pendingPos = lockedPositionBySeat[seatIdx] || "UNK";
        const pendingState = seatState[seatIdx] || {};
        emitAction({
          handId: handId,
          idx: seatIdx,
          playerName: pendingName,
          position: pendingPos,
          finalRound: finalRound,
          resolvedAction: "fold",
          currentLa: toNum(pendingState.la, -1),
          currentB: toNum(pendingState.b, 0),
          seat: { s: pendingState.s, c: pendingState.c },
          reason: "win_fold_response_fill_fold"
        });
        delete streetPendingResponseBySeat[seatIdx];
      });
    }
    if (resolvedAction === "win_showdown") {
      const pendingSeats = getPendingResponderSeatIndexes(idx);
      pendingSeats.forEach((seatIdx) => {
        const pendingName = playerNameBySeat[seatIdx];
        if (!pendingName) return;
        const pendingPos = lockedPositionBySeat[seatIdx] || "UNK";
        const pendingState = seatState[seatIdx] || {};
        emitAction({
          handId: handId,
          idx: seatIdx,
          playerName: pendingName,
          position: pendingPos,
          finalRound: finalRound,
          resolvedAction: "call",
          currentLa: toNum(pendingState.la, -1),
          currentB: toNum(pendingState.b, 0),
          seat: { s: pendingState.s, c: pendingState.c },
          reason: "win_showdown_response_fill_call"
        });
        delete streetPendingResponseBySeat[seatIdx];
      });
    }

    if (resolvedAction === "check" && finalRound === "preflop" && position !== "BB") {
      warnInvariant("impossible_preflop_check", {
        seatIdx: idx,
        player: playerName,
        position: position,
        round: finalRound,
        reason: reason
      });
    }
    if (resolvedAction === "win_fold" || resolvedAction === "win_showdown" || resolvedAction === "win_uncontested") {
      const unresolved = Object.keys(streetPendingResponseBySeat).filter((key) => {
        const seatIdx = Number(key);
        return !!streetPendingResponseBySeat[seatIdx] && isSeatMeaningfulPending(seatIdx);
      });
      if (unresolved.length > 0) {
        warnInvariant("win_with_pending_responders", {
          seatIdx: idx,
          player: playerName,
          round: finalRound,
          pending: unresolved.map(Number)
        });
      }
    }

    if (foldedBySeat[idx] && resolvedAction !== "fold") return false;
    if (handClosed && resolvedAction !== "win_fold" && resolvedAction !== "win_showdown" && resolvedAction !== "win_uncontested") return false;

    const emitSignature = [
      handId,
      idx,
      finalRound,
      resolvedAction,
      currentLa,
      currentB,
      seat.s !== undefined ? seat.s : "",
      seat.c !== undefined ? seat.c : ""
    ].join("|");
    if (lastEmitSignatureBySeat[idx] === emitSignature) return false;
    lastEmitSignatureBySeat[idx] = emitSignature;
    lastActionRoundBySeat[idx] = finalRound;

    if (resolvedAction === "fold") foldedBySeat[idx] = true;
    if (resolvedAction === "win_fold" || resolvedAction === "win_showdown" || resolvedAction === "win_uncontested") handClosed = true;
    const isAggression = isAggressiveAction(resolvedAction);
    // Bootstrap first-seen chip-ins can be noisy. Count them for depth only if they are
    // the first known preflop aggression; ignore otherwise to avoid depth inflation.
    const preflopRaiseCount = toNum(streetRaiseCountByRound.preflop, 0);
    const countForRaiseDepth =
      !(finalRound === "preflop" && reason === "first_seen_chip_in") || preflopRaiseCount === 0;
    if (isAggression && finalRound === "preflop") {
      preflopRaisedSeen = true;
    }
    if (isAggression && countForRaiseDepth) {
      streetRaiseCountByRound[finalRound] = toNum(streetRaiseCountByRound[finalRound], 0) + 1;
    }
    maxRoundSeenBySeat[idx] = Math.max(toNum(maxRoundSeenBySeat[idx], -1), roundRank(finalRound));
    actionCountBySeat[idx] = toNum(actionCountBySeat[idx], 0) + 1;
    if (finalRound === "preflop" && resolvedAction !== "win_fold" && resolvedAction !== "win_showdown" && resolvedAction !== "win_uncontested") {
      preflopActionCountBySeat[idx] = toNum(preflopActionCountBySeat[idx], 0) + 1;
    }

    if (DEBUG_EMIT_REASONS) {
      console.log(
        "[tracker] " + formatLogRow(playerName, position, finalRound, resolvedAction) + " | " + reason
      );
    } else {
      console.log("[tracker] " + formatLogRow(playerName, position, finalRound, resolvedAction));
    }

    const entry = buildEntry(handId, playerName, position, finalRound, resolvedAction, currentB);
    handActions.push(entry);
    sendAction(entry);
    return true;
  }

  function processGameState(payload) {
    const gs = payload.gameState || payload;
    if (!gs || !gs.gi || !Array.isArray(gs.s)) return;

    const handId = gs.gi;
    const boardCount = getBoardCount(gs);
    if (handId !== currentHandId) {
      resetHandState(handId, boardCount);
    }
    const effectiveBoardCount = Math.max(boardCount, previousBoardCount);
    const roundNow = getRoundFromBoardCount(effectiveBoardCount);
    const prevRound = getRoundFromBoardCount(previousBoardCount);

    snapshotSeq += 1;
    // Street changes are driven by board-card events only (0->3->4->5).
    const roundChanged = effectiveBoardCount > previousBoardCount;
    const dealerIdx = toNum(gs?.m?.di, 0);
    const activeSeatIndexes = [];
    for (let i = 0; i < gs.s.length; i += 1) {
      const seat = gs.s[i];
      if (seat && (seat.dn || seat.n)) {
        activeSeatIndexes.push(i);
      }
    }
    // Lock seat->position mapping at hand start so position cannot drift mid-hand.
    if (snapshotSeq === 1) {
      activeSeatIndexes.forEach((idx) => {
        lockedPositionBySeat[idx] = getPositionName(idx, dealerIdx, activeSeatIndexes);
      });
    }
    let snapshotPrevMaxB = 0;
    Object.keys(seatState).forEach((key) => {
      const prevSeat = seatState[key];
      const bVal = toNum(prevSeat && prevSeat.b, 0);
      if (bVal > snapshotPrevMaxB) snapshotPrevMaxB = bVal;
    });

    const pendingFromPrevStreet = roundChanged ? { ...streetPendingResponseBySeat } : {};
    const prevRoundHadPressure = roundChanged && !handClosed && (streetAggressorSeat || streetAggressorSeat === 0);

    if (prevRoundHadPressure) {
      Object.keys(streetPendingResponseBySeat).forEach((key) => {
        const idx = Number(key);
        if (!streetPendingResponseBySeat[idx]) return;
        if (foldedBySeat[idx]) return;

        const seat = gs.s[idx];
        if (!seat) return;
        const playerName = seat.dn || seat.n;
        if (!playerName) return;

        const currentB = toNum(seat.b, 0);
        const currentLa = toNum(seat.la, null);
        const currentAction = currentLa !== null ? (ACTION_MAP[currentLa] || null) : null;
        const isFoldNow = currentAction === "fold";
        const isPassiveNow = currentAction === "check" || currentAction === "call";
        const matchedByAmount = !isFoldNow && streetOpenBetAmount > 0 && currentB >= streetOpenBetAmount;
        // Continuity fallback: some feeds reset/reshape b across streets.
        // If a pending player is still in the hand at next street (any non-terminal action state),
        // infer they completed the previous street response.
        const continuitySuggestsCall = isPassiveNow;

        if (prevRound === "preflop") {
          const position = getLockedOrComputedPosition(idx, dealerIdx, activeSeatIndexes);
          // Hard preflop response enforcement: resolve limper-facing-raise before flop actions.
          if (currentAction === "fold") {
            emitAction({
              handId: handId,
              idx: idx,
              playerName: playerName,
              position: position,
              finalRound: "preflop",
              resolvedAction: "fold",
              currentLa: currentLa !== null ? currentLa : -1,
              currentB: currentB,
              seat: seat,
              reason: "preflop_response_fill_fold"
            });
            delete pendingCarryResponseRoundBySeat[idx];
            return;
          }
          if (matchedByAmount || continuitySuggestsCall) {
            emitAction({
              handId: handId,
              idx: idx,
              playerName: playerName,
              position: position,
              finalRound: "preflop",
              resolvedAction: "call",
              currentLa: currentLa !== null ? currentLa : -1,
              currentB: currentB,
              seat: seat,
              reason: "preflop_response_fill_call"
            });
            trackStreetPressure("call", idx, currentB, activeSeatIndexes);
            delete pendingCarryResponseRoundBySeat[idx];
            return;
          }
          pendingCarryResponseRoundBySeat[idx] = prevRound;
          return;
        }

        if (matchedByAmount) {
          const position = getLockedOrComputedPosition(idx, dealerIdx, activeSeatIndexes);
          emitAction({
            handId: handId,
            idx: idx,
            playerName: playerName,
            position: position,
            finalRound: prevRound,
            resolvedAction: "call",
            currentLa: currentLa !== null ? currentLa : -1,
            currentB: currentB,
            seat: seat,
            reason: "postflop_response_fill_call_boundary"
          });
          trackStreetPressure("call", idx, currentB, activeSeatIndexes);
          delete pendingCarryResponseRoundBySeat[idx];
          return;
        }
        if (continuitySuggestsCall) {
          const position = getLockedOrComputedPosition(idx, dealerIdx, activeSeatIndexes);
          emitAction({
            handId: handId,
            idx: idx,
            playerName: playerName,
            position: position,
            finalRound: prevRound,
            resolvedAction: "call",
            currentLa: currentLa !== null ? currentLa : -1,
            // Continuity-only fill can have ambiguous amount.
            currentB: 0,
            seat: seat,
            reason: "postflop_response_fill_call_boundary"
          });
          trackStreetPressure("call", idx, currentB, activeSeatIndexes);
          delete pendingCarryResponseRoundBySeat[idx];
        }
      });
      const unresolvedAtBoundary = Object.keys(streetPendingResponseBySeat).filter((key) => {
        const idx = Number(key);
        if (!streetPendingResponseBySeat[idx]) return false;
        if (!isSeatMeaningfulPending(idx)) return false;
        if (lastActionRoundBySeat[idx] === prevRound) return false;
        if (pendingCarryResponseRoundBySeat[idx] === prevRound) return false;
        return true;
      });
      if (unresolvedAtBoundary.length > 0) {
        warnInvariant("street_change_unresolved_responders", {
          round: prevRound,
          pending: unresolvedAtBoundary.map(Number)
        });
      }
      streetAggressorSeat = null;
      streetOpenBetAmount = 0;
      streetPendingResponseBySeat = {};
    }

    // Backfill passive rounds: when a postflop street closes with no aggression,
    // some clients keep sticky "check" states and never emit per-player la changes.
    // If a player reaches next street without an action in the previous street,
    // infer a check for that previous street.
    if (roundChanged && !handClosed && prevRound !== "preflop") {
      if (!prevRoundHadPressure) {
        activeSeatIndexes.forEach((idx) => {
          if (foldedBySeat[idx]) return;
          if (lastActionRoundBySeat[idx] === prevRound) return;
          // If any earlier-street carry response is still unresolved, do not emit
          // passive checkback fill for this boundary yet (prevents out-of-order lines).
          if (pendingCarryResponseRoundBySeat[idx]) return;
          const seat = gs.s[idx];
          if (!seat) return;
          const playerName = seat.dn || seat.n;
          if (!playerName) return;
          // Skip likely all-in players; they may not have checking options.
          if (toNum(seat.s, 1) <= 0) return;
          const currentLa = toNum(seat.la, null);
          const currentAction = currentLa !== null ? (ACTION_MAP[currentLa] || null) : null;
          if (currentAction !== "check" && currentAction !== "call") return;
          const position = getLockedOrComputedPosition(idx, dealerIdx, activeSeatIndexes);
          emitAction({
            handId: handId,
            idx: idx,
            playerName: playerName,
            position: position,
            finalRound: prevRound,
            resolvedAction: "check",
            currentLa: currentLa !== null ? currentLa : -1,
            currentB: 0,
            seat: seat,
            reason: "round_checkback_fill"
          });
        });
      }
    }

    for (let idx = 0; idx < gs.s.length; idx += 1) {
      const seat = gs.s[idx];
      if (!seat) continue;

      const playerName = seat.dn || seat.n;
      if (!playerName) continue;
      playerNameBySeat[idx] = playerName;

      const currentLa = toNum(seat.la, null);
      if (currentLa === null) continue;
      if (handClosed) continue;
      if (IGNORE_LA.has(currentLa)) {
        seatState[idx] = {
          la: currentLa,
          b: toNum(seat.b, 0),
          s: seat.s,
          c: seat.c,
          seq: snapshotSeq
        };
        continue;
      }

      const actionName = ACTION_MAP[currentLa] || null;
      const currentB = toNum(seat.b, 0);
      const prev = seatState[idx] || null;
      const previousB = prev ? toNum(prev.b, 0) : 0;
      const bIncreased = !!prev && currentB > previousB;
      const sChanged = !!prev && seat.s !== undefined && prev.s !== undefined && seat.s !== prev.s;
      const cChanged = !!prev && seat.c !== undefined && prev.c !== undefined && seat.c !== prev.c;

      const decision = shouldEmitBySignal({
        actionName: actionName,
        currentLa: currentLa,
        prev: prev,
        roundChanged: roundChanged,
        seatIdx: idx,
        roundNow: roundNow,
        currentB: currentB,
        bIncreased: bIncreased,
        sChanged: sChanged,
        cChanged: cChanged
      });

      seatState[idx] = {
        la: currentLa,
        b: currentB,
        s: seat.s,
        c: seat.c,
        seq: snapshotSeq
      };

      if (!decision.ok) continue;

      let resolvedAction = actionName;
      if (decision.reason === "b_increased_infer_action" || decision.reason === "b_increased_unknown_la") {
        resolvedAction = inferChipInAction(currentB, previousB, snapshotPrevMaxB);
      }
      if (!resolvedAction) continue;

      const finalRound = tagRound({
        roundNow: roundNow,
        prevRound: prevRound,
        roundChanged: roundChanged,
        usedReason: decision.reason,
        actionName: resolvedAction
      });
      let normalizedRound = finalRound;
      // If player had unresolved response to previous-street aggression and folds exactly at
      // street boundary, this fold belongs to previous street.
      if (
        roundChanged &&
        decision.reason === "la_changed" &&
        resolvedAction === "fold" &&
        pendingFromPrevStreet[idx]
      ) {
        normalizedRound = prevRound;
      }
      const stablePosition = getLockedOrComputedPosition(idx, dealerIdx, activeSeatIndexes);

      // Allow one bootstrap chip-in per player per street (not globally per street).
      const firstSeenSeatRoundKey = normalizedRound + "|" + idx;
      if (decision.reason === "first_seen_chip_in" && firstSeenChipInBySeatRound[firstSeenSeatRoundKey]) {
        continue;
      }

      if (resolvedAction === "call" && normalizedRound === "preflop" && stablePosition === "SB") {
        if (!preflopRaisedSeen) {
          resolvedAction = "complete";
        }
      }
      if (resolvedAction === "call" && normalizedRound === "preflop" && stablePosition === "BB") {
        if (!preflopRaisedSeen) {
          resolvedAction = "check";
        }
      }
      if (resolvedAction === "call" && normalizedRound === "preflop" && stablePosition !== "SB" && stablePosition !== "BB") {
        if (!preflopRaisedSeen) {
          resolvedAction = "limp";
        }
      }
      // Some feeds report preflop non-BB checks where a chip-in action happened.
      // Normalize impossible preflop checks by context to avoid false "check" actions.
      if (resolvedAction === "check" && normalizedRound === "preflop" && stablePosition !== "BB") {
        if (!preflopRaisedSeen) {
          resolvedAction = stablePosition === "SB" ? "complete" : "limp";
        } else {
          resolvedAction = "call";
        }
      }

      if (resolvedAction === "raise" && normalizedRound === "preflop") {
        const nextRaiseCount = toNum(streetRaiseCountByRound.preflop, 0) + 1;
        if (nextRaiseCount === 2) resolvedAction = "3bet";
        else if (nextRaiseCount === 3) resolvedAction = "4bet";
        else if (nextRaiseCount > 3) resolvedAction = (nextRaiseCount + 1) + "bet";
        // If player already acted preflop, this cannot be an opening raise.
        if (nextRaiseCount === 1 && toNum(preflopActionCountBySeat[idx], 0) > 0) {
          resolvedAction = "3bet";
        }
      }

      if (resolvedAction === "win" || resolvedAction === "collect") {
        const livePlayers = Object.keys(actionCountBySeat).reduce((acc, key) => {
          const seatIdx = Number(key);
          if (toNum(actionCountBySeat[seatIdx], 0) <= 0) return acc;
          if (seatIdx === idx || !foldedBySeat[seatIdx]) return acc + 1;
          return acc;
        }, 0);
        const winnerPriorActions = toNum(actionCountBySeat[idx], 0);
        if (normalizedRound === "preflop" && winnerPriorActions === 0) {
          resolvedAction = "win_uncontested";
        } else {
          resolvedAction = livePlayers <= 1 ? "win_fold" : "win_showdown";
        }
      }

      // River has no next-street boundary, so pure check-check showdowns can miss both
      // river checks. Backfill them right before winner emission when river had no pressure.
      if (resolvedAction === "win_showdown" && normalizedRound === "river") {
        const riverHadPressure = toNum(streetRaiseCountByRound.river, 0) > 0;
        if (!riverHadPressure) {
          activeSeatIndexes.forEach((seatIdx) => {
            if (foldedBySeat[seatIdx]) return;
            if (toNum(actionCountBySeat[seatIdx], 0) <= 0) return;
            if (lastActionRoundBySeat[seatIdx] === "river") return;
            const liveSeat = gs.s[seatIdx];
            if (!liveSeat) return;
            const liveName = liveSeat.dn || liveSeat.n;
            if (!liveName) return;
            const livePos = getLockedOrComputedPosition(seatIdx, dealerIdx, activeSeatIndexes);
            emitAction({
              handId: handId,
              idx: seatIdx,
              playerName: liveName,
              position: livePos,
              finalRound: "river",
              resolvedAction: "check",
              currentLa: toNum(liveSeat.la, -1),
              currentB: 0,
              seat: liveSeat,
              reason: "river_showdown_check_fill"
            });
          });
        }
      }

      const queuedCarryRound = pendingCarryResponseRoundBySeat[idx];
      if (queuedCarryRound) {
        // If the next real action is a later-street fold, this fold is most likely
        // the delayed response to previous street aggression. Re-tag it back.
        if (resolvedAction === "fold" && normalizedRound !== queuedCarryRound) {
          if (queuedCarryRound === "preflop") {
            normalizedRound = "preflop";
          } else {
          const hasAggressionInCurrentRound = toNum(streetRaiseCountByRound[normalizedRound], 0) > 0;
          if (!hasAggressionInCurrentRound) {
            normalizedRound = queuedCarryRound;
          }
          }
        }
        const shouldBackfillQueuedCall =
          !handClosed &&
          !foldedBySeat[idx] &&
          resolvedAction !== "fold" &&
          lastActionRoundBySeat[idx] !== queuedCarryRound &&
          !(resolvedAction === "fold" && normalizedRound === queuedCarryRound);
        const shouldEmitQueuedCarryCall =
          shouldBackfillQueuedCall &&
          queuedCarryRound !== "preflop" &&
          normalizedRound !== queuedCarryRound;
        if (shouldEmitQueuedCarryCall) {
          emitAction({
            handId: handId,
            idx: idx,
            playerName: playerName,
            position: stablePosition,
            finalRound: queuedCarryRound,
            resolvedAction: "call",
            currentLa: currentLa,
            // Synthetic carry call: avoid sending ambiguous chip amount.
            currentB: 0,
            seat: seat,
            reason: "postflop_response_fill_call"
          });
        }
        if (shouldBackfillQueuedCall) {
          // Reconcile internal pressure bookkeeping even when synthetic call is emitted.
          lastActionRoundBySeat[idx] = queuedCarryRound;
          maxRoundSeenBySeat[idx] = Math.max(toNum(maxRoundSeenBySeat[idx], -1), roundRank(queuedCarryRound));
          trackStreetPressure("call", idx, currentB, activeSeatIndexes);
        }
        delete pendingCarryResponseRoundBySeat[idx];
      }

      // Player must be valid in the previous street before appearing in this street.
      // If not, block action to prevent impossible street jumps.
      if (normalizedRound !== "preflop") {
        const requiredPrev = prevRoundName(normalizedRound);
        const maxSeenRank = toNum(maxRoundSeenBySeat[idx], -1);
        const requiredPrevRank = roundRank(requiredPrev);
        if (requiredPrev && maxSeenRank < requiredPrevRank) {
          warnInvariant("street_jump_blocked", {
            seatIdx: idx,
            player: playerName,
            round: normalizedRound,
            reason: decision.reason,
            maxSeenRank: maxSeenRank,
            requiredPrev: requiredPrev
          });
          continue;
        }
      }

      const emitted = emitAction({
        handId: handId,
        idx: idx,
        playerName: playerName,
        position: stablePosition,
        finalRound: normalizedRound,
        resolvedAction: resolvedAction,
        currentLa: currentLa,
        currentB: currentB,
        seat: seat,
        reason: decision.reason
      });
      if (!emitted) continue;
      if (decision.reason === "first_seen_chip_in") {
        firstSeenChipInBySeatRound[firstSeenSeatRoundKey] = true;
      }
      trackStreetPressure(resolvedAction, idx, currentB, activeSeatIndexes);
    }

    updateTablePlayersOverlay(gs, activeSeatIndexes);

    previousBoardCount = effectiveBoardCount;
    previousRound = roundNow;
  }

  const tappedSockets = new WeakSet();

  function handleWsPayload(rawText) {
    try {
      const msg = JSON.parse(rawText);
      if (msg.t === "GameState" || msg.gameState || (msg.gi && msg.s)) {
        processGameState(msg);
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

  window._pokerActions = function() {
    console.table(handActions);
  };
})();
