// Server-side hand normalizer. The extension posts raw snapshots; this builds the stored actions.
// Seats are released in poker order. A street is closed before the next one starts.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PokerActionEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PREFLOP = ["UTG", "UTG2", "UTG3", "UTG4", "UTG5", "UTG6", "BTN", "SB", "BB"];
  const POSTFLOP = ["SB", "BB", "UTG", "UTG2", "UTG3", "UTG4", "UTG5", "UTG6", "BTN"];
  const ROUNDS = ["preflop", "flop", "turn", "river"];
  const IGNORE_LA = { 4: true, 6: true, 7: true };
  const LA_MAP = { 1: "fold", 2: "check", 3: "call", 5: "check", 8: "bet", 9: "raise", 10: "win", 16: "collect" };
  const CHIP = { call: 1, limp: 1, complete: 1, bet: 1, raise: 1, "3bet": 1, "4bet": 1, "5bet": 1, "6bet": 1, "7bet": 1, "8bet": 1, "9bet": 1 };

  function roundFromBoard(count) {
    if (count >= 5) return "river";
    if (count === 4) return "turn";
    if (count === 3) return "flop";
    return "preflop";
  }

  function rank(round) {
    const i = ROUNDS.indexOf(round);
    return i < 0 ? 0 : i;
  }

  function positionName(idx, dealerIdx, activeSeatIndexes) {
    const activeCount = activeSeatIndexes.length;
    if (activeCount === 0) return "BTN";
    const dealerPos = activeSeatIndexes.indexOf(dealerIdx);
    const safeDealerPos = dealerPos >= 0 ? dealerPos : 0;
    const seatPos = activeSeatIndexes.indexOf(idx);
    if (seatPos < 0) return "BTN";
    const relPos = (seatPos - safeDealerPos + activeCount) % activeCount;
    if (activeCount === 2) return relPos === 0 ? "BTN" : "BB";
    if (relPos === 0) return "BTN";
    if (relPos === 1) return "SB";
    if (relPos === 2) return "BB";
    if (relPos === 3) return "UTG";
    return "UTG" + (relPos - 2);
  }

  function createHand() {
    return {
      ready: false,
      names: {},
      positions: {},
      seatByPos: {},
      nPlayers: 0,
      street: "preflop",
      folded: {},
      allIn: {},
      acted: {},
      responded: {},
      pending: {},
      prevLa: {},
      prevB: {},
      seen: {},
      betLive: false,
      raiseCount: 0,
      aggressor: null,
      lastActor: null,
      voluntary: false,
      limpedToBb: false,
      sent: {},
      winner: false,
      sawWin: null
    };
  }

  function isAggName(action) {
    return action === "bet" || action === "raise" || /^[3-9]bet$/.test(action);
  }

  function isWin(action) {
    return action === "win_fold" || action === "win_showdown" || action === "win_uncontested";
  }

  function aggressionName(street, nth) {
    if (street === "preflop") {
      if (nth <= 1) return "raise";
      if (nth === 2) return "3bet";
      return Math.min(nth + 1, 9) + "bet";
    }
    if (nth <= 1) return "bet";
    if (nth === 2) return "raise";
    return Math.min(nth, 9) + "bet";
  }

  function isSmallBlind(hand, pos) {
    if (pos === "SB") return true;
    return pos === "BTN" && hand.nPlayers === 2;
  }

  function lock(hand, snap) {
    const indexes = [];
    snap.seats.forEach((seat) => {
      if (!seat || !seat.name) return;
      indexes.push(seat.idx);
      hand.names[seat.idx] = seat.name;
    });
    indexes.forEach((idx) => {
      hand.positions[idx] = positionName(idx, snap.dealerIdx, indexes);
    });
    hand.seatByPos = {};
    Object.keys(hand.positions).forEach((key) => {
      hand.seatByPos[hand.positions[key]] = Number(key);
    });
    hand.nPlayers = indexes.length;
    hand.ready = true;
  }

  function inferChip(currentB, previousB, tableMaxBefore) {
    if (currentB <= previousB) return null;
    if (tableMaxBefore <= 0) return "bet";
    if (currentB > tableMaxBefore) return "raise";
    return "call";
  }

  function noteSeat(hand, seat, tableMaxBefore) {
    if (!seat || seat.la === undefined || seat.la === null || !hand.names[seat.idx]) return;
    const la = seat.la;
    const b = seat.b || 0;
    if (IGNORE_LA[la]) {
      hand.prevLa[seat.idx] = la;
      hand.prevB[seat.idx] = b;
      hand.seen[seat.idx] = true;
      return;
    }
    const mapped = LA_MAP[la] || null;
    if (mapped === "win" || mapped === "collect") {
      hand.sawWin = seat.idx;
      hand.prevLa[seat.idx] = la;
      hand.prevB[seat.idx] = b;
      hand.seen[seat.idx] = true;
      return;
    }
    const first = !hand.seen[seat.idx];
    const prevLa = hand.prevLa[seat.idx];
    const prevB = hand.prevB[seat.idx] || 0;
    let raw = null;
    if (first) {
      if (mapped === "fold") raw = "fold";
      else if (b > 0 && (mapped === "call" || mapped === "bet" || mapped === "raise")) raw = mapped;
    } else if (prevLa !== la && mapped) {
      raw = mapped;
    } else if (b > prevB) {
      raw = inferChip(b, prevB, tableMaxBefore);
    }
    if (raw) hand.pending[seat.idx] = raw;
    hand.prevLa[seat.idx] = la;
    hand.prevB[seat.idx] = b;
    hand.seen[seat.idx] = true;
  }

  function streetOrder(hand) {
    if (hand.street !== "preflop" && hand.nPlayers === 2) {
      const btn = hand.seatByPos.BTN;
      const bb = hand.seatByPos.BB;
      return [btn, bb].filter((idx) => idx !== undefined && !hand.folded[idx]);
    }
    const names = hand.street === "preflop" ? PREFLOP : POSTFLOP;
    const seq = [];
    names.forEach((pos) => {
      const idx = hand.seatByPos[pos];
      if (idx === undefined || hand.folded[idx]) return;
      seq.push(idx);
    });
    return seq;
  }

  function needs(hand, idx) {
    if (hand.folded[idx] || hand.allIn[idx]) return false;
    if (!hand.positions[idx]) return false;
    if (hand.betLive) {
      if (idx === hand.aggressor) return false;
      return !hand.responded[idx];
    }
    if (hand.acted[idx]) return false;
    if (hand.street === "preflop" && hand.positions[idx] === "BB" && !hand.limpedToBb) return false;
    return true;
  }

  function nextNeeded(hand) {
    const seq = streetOrder(hand);
    if (!seq.length) return null;
    let rotated = seq;
    if (hand.betLive && hand.aggressor !== null && hand.aggressor !== undefined) {
      const at = seq.indexOf(hand.aggressor);
      if (at >= 0) rotated = seq.slice(at + 1).concat(seq.slice(0, at + 1));
    }
    for (let i = 0; i < rotated.length; i += 1) {
      if (needs(hand, rotated[i])) return rotated[i];
    }
    return null;
  }

  function laterHasPending(hand, idx) {
    const seq = streetOrder(hand);
    const at = seq.indexOf(idx);
    for (let i = at + 1; i < seq.length; i += 1) {
      if (hand.pending[seq[i]]) return true;
    }
    return false;
  }

  function canInventCheck(hand, idx) {
    if (hand.betLive || hand.allIn[idx] || hand.folded[idx]) return false;
    const pos = hand.positions[idx];
    if (hand.street === "preflop") {
      if (pos !== "BB" || !hand.limpedToBb) return false;
    }
    return laterHasPending(hand, idx);
  }

  function legalize(hand, idx, raw) {
    if (raw === "fold") return "fold";
    if (raw === "bet" || raw === "raise") return aggressionName(hand.street, hand.raiseCount + 1);
    if (hand.betLive) return "call";
    if (hand.street === "preflop") {
      const pos = hand.positions[idx];
      if (pos === "BB") return "check";
      if (isSmallBlind(hand, pos)) return "complete";
      return "limp";
    }
    return "check";
  }

  function liveSeats(hand) {
    const live = [];
    Object.keys(hand.positions).forEach((key) => {
      const idx = Number(key);
      if (!hand.folded[idx]) live.push(idx);
    });
    return live;
  }

  function emit(hand, out, idx, action) {
    if (hand.winner) return false;
    if (!isWin(action) && hand.lastActor === idx) return false;
    const player = hand.names[idx];
    const position = hand.positions[idx];
    if (!player || !position) return false;
    const key = [player, position, hand.street, action].join("|");
    if (hand.sent[key]) return false;
    hand.sent[key] = true;
    const entry = {
      player: player,
      position: position,
      round: hand.street,
      action: action
    };
    const amount = hand.prevB[idx] || 0;
    if (amount > 0 && CHIP[action]) entry.amount = amount;
    out.push(entry);
    if (isWin(action)) {
      hand.winner = true;
      return true;
    }
    hand.lastActor = idx;
    hand.acted[idx] = true;
    if (action === "fold") hand.folded[idx] = true;
    if (isAggName(action)) {
      hand.betLive = true;
      hand.raiseCount += 1;
      hand.aggressor = idx;
      hand.responded = {};
      hand.voluntary = true;
      hand.limpedToBb = false;
    } else if (action === "call" || action === "limp" || action === "complete") {
      hand.responded[idx] = true;
      hand.voluntary = true;
      if (action === "limp" || action === "complete") hand.limpedToBb = true;
    } else if (action === "check") {
      hand.responded[idx] = true;
    }
    finishIfOneLeft(hand, out);
    return true;
  }

  function finishIfOneLeft(hand, out) {
    if (hand.winner) return;
    const live = liveSeats(hand);
    if (live.length !== 1) return;
    emit(hand, out, live[0], hand.voluntary ? "win_fold" : "win_uncontested");
  }

  function owedClose(hand, idx, target) {
    return rank(target) > rank(hand.street) && (hand.pending[idx] === "check" || (hand.betLive && hand.pending[idx] === "call"));
  }

  function actNext(hand, out, target, allowInvent) {
    const idx = nextNeeded(hand);
    if (idx === null || idx === undefined) return false;
    if (hand.lastActor === idx) return false;
    const pending = hand.pending[idx];
    if (!pending) {
      if (allowInvent && canInventCheck(hand, idx)) return emit(hand, out, idx, "check");
      if (rank(target) > rank(hand.street)) {
        if (hand.betLive) return emit(hand, out, idx, "call");
        return emit(hand, out, idx, legalize(hand, idx, "check"));
      }
      return false;
    }
    if ((pending === "bet" || pending === "raise") && rank(target) > rank(hand.street) && !hand.betLive) {
      return emit(hand, out, idx, "check");
    }
    if (owedClose(hand, idx, target)) {
      const closed = emit(hand, out, idx, hand.betLive ? "call" : legalize(hand, idx, "check"));
      if (pending === "call" && hand.betLive) delete hand.pending[idx];
      return closed;
    }
    delete hand.pending[idx];
    return emit(hand, out, idx, legalize(hand, idx, pending));
  }

  function drain(hand, out, target) {
    let guard = 0;
    while (!hand.winner && guard < 40) {
      guard += 1;
      if (!actNext(hand, out, target, true)) return;
    }
  }

  function advance(hand) {
    const at = ROUNDS.indexOf(hand.street);
    if (at < 0 || at >= ROUNDS.length - 1) return;
    hand.street = ROUNDS[at + 1];
    hand.betLive = false;
    hand.raiseCount = 0;
    hand.aggressor = null;
    hand.responded = {};
    hand.acted = {};
    hand.lastActor = null;
  }

  function maybeShowdown(hand, out, target) {
    if (hand.winner || hand.sawWin === null || hand.sawWin === undefined) return;
    if (nextNeeded(hand)) return;
    if (rank(target) > rank(hand.street)) return;
    if (liveSeats(hand).length < 2) return;
    if (hand.folded[hand.sawWin]) return;
    emit(hand, out, hand.sawWin, "win_showdown");
  }

  function applySnapshot(hand, snap) {
    const out = [];
    if (!snap || !Array.isArray(snap.seats)) return out;
    if (!hand.ready) lock(hand, snap);
    else {
      snap.seats.forEach((seat) => {
        if (seat && seat.name) hand.names[seat.idx] = seat.name;
      });
    }
    let prevMax = 0;
    Object.keys(hand.prevB).forEach((key) => {
      if (hand.prevB[key] > prevMax) prevMax = hand.prevB[key];
    });
    snap.seats.forEach((seat) => noteSeat(hand, seat, prevMax));
    const target = roundFromBoard(snap.boardCount || 0);
    drain(hand, out, target);
    let guard = 0;
    while (!hand.winner && rank(target) > rank(hand.street) && guard < 4) {
      guard += 1;
      if (nextNeeded(hand)) {
        if (!actNext(hand, out, target, true)) break;
        continue;
      }
      advance(hand);
      drain(hand, out, target);
    }
    maybeShowdown(hand, out, target);
    return out;
  }

  function normalizeHand(body) {
    const hand = createHand();
    const actions = [];
    const snaps = body && Array.isArray(body.snapshots) ? body.snapshots : [];
    snaps.forEach((snap) => {
      applySnapshot(hand, {
        dealerIdx: snap.dealerIdx,
        boardCount: snap.boardCount,
        seats: snap.seats || []
      }).forEach((action) => {
        actions.push(action);
      });
    });
    return actions;
  }

  return {
    createHand: createHand,
    applySnapshot: applySnapshot,
    normalizeHand: normalizeHand,
    positionName: positionName,
    roundFromBoard: roundFromBoard
  };
});
