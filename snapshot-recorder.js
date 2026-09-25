// Records raw table snapshots for POST /api/hand-history/raw.
// Does not name actions. The server derives the line from la, b, and boardCount.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PokerSnapshotRecorder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createRecorder() {
    let current = null;
    const sent = new Set();

    function blank() {
      return {
        handId: null,
        snapshots: [],
        boardCount: 0,
        pot: 0,
        lastReal: {},
        lastBody: null,
        lastLa: null,
        locked: false
      };
    }

    function ensure(handId) {
      if (sent.has(handId)) return null;
      if (current && current.handId === handId) return current;
      if (current && current.snapshots.length && !sent.has(current.handId)) return null;
      current = blank();
      current.handId = handId;
      return current;
    }

    function sumB(seats) {
      return seats.reduce((total, seat) => total + (seat.b > 0 ? seat.b : 0), 0);
    }

    function bodyKey(seats) {
      return seats.map((seat) => [seat.idx, seat.name, seat.la, seat.b, seat.stack].join(":")).join(",");
    }

    function append(hand, boardCount, dealerIdx, seats) {
      const key = boardCount + "|" + dealerIdx + "|" + bodyKey(seats);
      if (hand.snapshots.length && hand.snapshots[hand.snapshots.length - 1].key === key) return;
      hand.snapshots.push({
        key: key,
        seq: hand.snapshots.length + 1,
        boardCount: boardCount,
        dealerIdx: dealerIdx,
        seats: seats.map((seat) => ({
          idx: seat.idx,
          name: seat.name,
          la: seat.la === undefined ? null : seat.la,
          b: seat.b || 0,
          stack: seat.stack === undefined ? null : seat.stack
        }))
      });
    }

    function remember(hand, seats) {
      seats.forEach((seat) => {
        if (seat.la === null || seat.la === undefined) return;
        if (seat.la === 10 || seat.la === 16) return;
        hand.lastReal[seat.idx] = seat.la;
      });
    }

    function pickWinner(seats) {
      const wins = seats.filter((seat) => seat.la === 10 || seat.la === 16);
      if (!wins.length) return null;
      const pool = wins.some((seat) => seat.la === 16) ? wins.filter((seat) => seat.la === 16) : wins;
      return pool.slice().sort((a, b) => (b.b - a.b) || (a.idx - b.idx))[0];
    }

    function withWinner(hand, seats) {
      const winner = pickWinner(seats);
      if (!winner) return seats;
      const pot = Math.max(hand.pot, winner.b > 0 ? winner.b : 0);
      return seats.map((seat) => {
        if (seat.idx === winner.idx) {
          return {
            idx: seat.idx,
            name: seat.name,
            la: 16,
            b: pot,
            stack: seat.stack
          };
        }
        if (seat.la === 10 || seat.la === 16) {
          const previous = hand.lastReal[seat.idx];
          return {
            idx: seat.idx,
            name: seat.name,
            la: previous === undefined ? 1 : previous,
            b: seat.b || 0,
            stack: seat.stack
          };
        }
        return seat;
      });
    }

    function add(handId, boardCount, dealerIdx, seats) {
      const hand = ensure(handId);
      if (!hand || hand.locked || hand.handId !== handId) return { done: false };
      remember(hand, seats);
      const win = pickWinner(seats);
      if (!win) hand.pot = Math.max(hand.pot, sumB(seats));

      const streetChange = hand.snapshots.length > 0 &&
        boardCount > hand.boardCount &&
        (boardCount === 3 || boardCount === 4 || boardCount === 5);
      if (streetChange) {
        append(hand, boardCount, dealerIdx, seats.map((seat) => ({
          idx: seat.idx,
          name: seat.name,
          la: null,
          b: seat.b || 0,
          stack: seat.stack
        })));
      }

      const laKey = seats.map((seat) => seat.idx + ":" + seat.la).join(",");
      const laChanged = laKey !== hand.lastLa;
      hand.lastBody = bodyKey(seats);
      hand.lastLa = laKey;
      hand.boardCount = boardCount;
      if (streetChange && !laChanged && !win) return { done: false };

      const outgoing = win ? withWinner(hand, seats) : seats;
      append(hand, boardCount, dealerIdx, outgoing);
      if (win) {
        hand.locked = true;
        return { done: true };
      }
      return { done: false };
    }

    function flush() {
      if (!current || !current.snapshots.length || sent.has(current.handId)) {
        current = null;
        return null;
      }
      sent.add(current.handId);
      const payload = {
        handId: current.handId,
        snapshots: current.snapshots.map((snap) => ({
          seq: snap.seq,
          boardCount: snap.boardCount,
          dealerIdx: snap.dealerIdx,
          seats: snap.seats
        }))
      };
      current = null;
      return payload;
    }

    function peek() {
      if (!current) return null;
      return {
        handId: current.handId,
        snapshots: current.snapshots.map((snap) => ({
          seq: snap.seq,
          boardCount: snap.boardCount,
          dealerIdx: snap.dealerIdx,
          seats: snap.seats
        }))
      };
    }

    return { add: add, flush: flush, peek: peek };
  }

  return { createRecorder: createRecorder };
});
