// Decides when to POST /api/tournaments from LobbyTournamentInfo pushes (one every ~10-20 s).
// The client sends both full infos (~100 keys) and partial ones such as {i, chs}, often before
// the first GameState names the table's tournament, so infos are merged per tournament id and
// only the table's current tournament (setTournament, from GameState.tri) is reported. It is sent
// as soon as it is known, then when something that matters changed (at most every 10 s, so each
// new info is forwarded), and unchanged once a minute so the portal sees the table is still open
// (e.g. on a break). Prize tables carry no tournament id; they belong to the table's current tournament.
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
    let currentId = null;
    let prizes = null;
    let prizesChanged = false;
    let sentId = null;
    let sentKey = null;
    let sentAt = 0;

    function watchedKey(info) {
      return WATCHED_KEYS.map((key) => info[key]).join("|");
    }

    function onInfo(next) {
      if (!next || typeof next !== "object" || !next.i) return;
      infos[next.i] = Object.assign(infos[next.i] || {}, next);
    }

    function onPrizes(table) {
      if (!Array.isArray(table)) return;
      if (prizes && JSON.stringify(prizes) === JSON.stringify(table)) return;
      prizes = table;
      prizesChanged = true;
    }

    function setTournament(id) {
      const next = id || null;
      if (next === currentId) return;
      if (currentId !== null) {
        prizes = null;
        prizesChanged = false;
      }
      currentId = next;
    }

    function due(now) {
      const info = currentId !== null ? infos[currentId] : null;
      if (!info) return null;
      const isNew = currentId !== sentId;
      const key = watchedKey(info);
      if (!isNew) {
        if (key === sentKey && !prizesChanged && now - sentAt < HEARTBEAT_MS) return null;
        if (now - sentAt < minIntervalMs) return null;
      }
      const payload = { info: Object.assign({}, info) };
      if (prizes && (isNew || prizesChanged)) payload.prizes = prizes;
      sentId = currentId;
      sentKey = key;
      sentAt = now;
      prizesChanged = false;
      return payload;
    }

    return { onInfo: onInfo, onPrizes: onPrizes, setTournament: setTournament, due: due };
  }

  return { createReporter: createReporter };
});
