// Decides when to POST /api/tournaments from LobbyTournamentInfo pushes (one every ~10-20 s).
// The client sends both full infos (~100 keys) and partial ones such as {i, chs}, often before
// the first GameState names the table's tournament, so infos are merged per tournament id and
// only the tournaments of the tab's open tables (setTournaments, from GameState.tri) are reported.
// Each is sent as soon as it is known, then when something that matters changed (at most every
// 10 s, so each new info is forwarded), and unchanged once a minute so the portal sees the table
// is still open (e.g. on a break). Prize tables carry no tournament id: one belongs to the open
// tournament while exactly one is open, and is dropped when several are (it can't be told whose).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PokerTournamentReporter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // players left, level, entries, re-entries, prize pool, state
  const WATCHED_KEYS = ["na", "l", "np", "npre", "pt", "st"];
  const MIN_INTERVAL_MS = 10 * 1000;
  const HEARTBEAT_MS = 60 * 1000;

  function createReporter(options) {
    const minIntervalMs = options && options.minIntervalMs !== undefined ? options.minIntervalMs : MIN_INTERVAL_MS;
    const infos = {};
    // Last send per tournament id: { key, at }.
    const sent = {};
    let open = [];
    let prizes = null;
    // Tournament the prize table belongs to; null while no tournament is open.
    let prizesId = null;
    let prizesChanged = false;

    function watchedKey(info) {
      return WATCHED_KEYS.map((key) => info[key]).join("|");
    }

    function onInfo(next) {
      if (!next || typeof next !== "object" || !next.i) return;
      infos[next.i] = Object.assign(infos[next.i] || {}, next);
    }

    function dropPrizes() {
      prizes = null;
      prizesId = null;
      prizesChanged = false;
    }

    function claimPrizes() {
      if (!prizes || prizesId !== null) return;
      if (open.length === 1) prizesId = open[0];
      else if (open.length > 1) dropPrizes();
    }

    function onPrizes(table) {
      if (!Array.isArray(table)) return;
      if (prizes && JSON.stringify(prizes) === JSON.stringify(table)) return;
      prizes = table;
      prizesId = null;
      prizesChanged = true;
      claimPrizes();
    }

    function setTournaments(ids) {
      const next = [];
      (Array.isArray(ids) ? ids : []).forEach((id) => {
        if (id && next.indexOf(id) < 0) next.push(id);
      });
      open = next;
      if (prizesId !== null && open.indexOf(prizesId) < 0) dropPrizes();
      claimPrizes();
    }

    // Returns one due payload per call (null when none is due), so callers loop until null.
    function due(now) {
      for (let k = 0; k < open.length; k += 1) {
        const id = open[k];
        const info = infos[id];
        if (!info) continue;
        const last = sent[id];
        const key = watchedKey(info);
        const withPrizes = prizesId === id && (!last || prizesChanged);
        if (last) {
          if (key === last.key && !withPrizes && now - last.at < HEARTBEAT_MS) continue;
          if (now - last.at < minIntervalMs) continue;
        }
        const payload = { info: Object.assign({}, info) };
        if (withPrizes) {
          payload.prizes = prizes;
          prizesChanged = false;
        }
        sent[id] = { key: key, at: now };
        return payload;
      }
      return null;
    }

    return { onInfo: onInfo, onPrizes: onPrizes, setTournaments: setTournaments, due: due };
  }

  return { createReporter: createReporter };
});
