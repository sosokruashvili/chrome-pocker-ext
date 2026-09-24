const engine = require("./action-engine.js");

function snap(dealer, board, seats) {
  return {
    dealerIdx: dealer,
    boardCount: board,
    seats: seats.map((seat) => ({
      idx: seat.idx,
      name: seat.name,
      la: seat.la,
      b: seat.b || 0,
      stack: seat.stack
    }))
  };
}

function play(steps) {
  const hand = engine.createHand();
  const out = [];
  steps.forEach((step) => {
    engine.applySnapshot(hand, step).forEach((entry) => out.push(entry));
  });
  return out.map((entry) => entry.position + " " + entry.round + " " + entry.action);
}

function sixMax(actions, board) {
  const seats = [
    { idx: 0, name: "UTG" },
    { idx: 1, name: "UTG2" },
    { idx: 2, name: "BTN" },
    { idx: 3, name: "SB" },
    { idx: 4, name: "BB" }
  ];
  actions.forEach((action) => {
    const seat = seats.find((item) => item.idx === action.idx);
    seat.la = action.la;
    seat.b = action.b || 0;
  });
  return snap(2, board || 0, seats);
}

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

// Seats arrive with UTG2 before UTG. Hold until UTG acts, then open is raise and BTN is 3bet.
check(
  "preflop order",
  play([
    sixMax([
      { idx: 1, la: 1 },
      { idx: 2, la: 9, b: 2 },
      { idx: 3, la: 1 },
      { idx: 4, la: 1 }
    ]),
    sixMax([
      { idx: 1, la: 1 },
      { idx: 2, la: 9, b: 2 },
      { idx: 3, la: 1 },
      { idx: 4, la: 1 },
      { idx: 0, la: 9, b: 6 }
    ])
  ]),
  ["UTG preflop raise", "UTG2 preflop fold", "BTN preflop 3bet", "SB preflop fold", "BB preflop fold"]
);

// BB fold is visible first and must wait.
check(
  "bb fold waits",
  play([sixMax([{ idx: 4, la: 1 }])]),
  []
);

// Walk to the BB.
check(
  "walk",
  play([
    sixMax([
      { idx: 0, la: 1 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 1 }
    ])
  ]),
  [
    "UTG preflop fold",
    "UTG2 preflop fold",
    "BTN preflop fold",
    "SB preflop fold",
    "BB preflop win_uncontested"
  ]
);

// Everyone folds to the raiser.
check(
  "win fold",
  play([
    sixMax([
      { idx: 0, la: 9, b: 2 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 1 },
      { idx: 4, la: 1 }
    ])
  ]),
  [
    "UTG preflop raise",
    "UTG2 preflop fold",
    "BTN preflop fold",
    "SB preflop fold",
    "BB preflop fold",
    "UTG preflop win_fold"
  ]
);

// Limp is not an open-raise. SB completes. BB checks.
check(
  "limp complete check",
  play([
    sixMax([
      { idx: 0, la: 3, b: 1 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 3, b: 1 },
      { idx: 4, la: 7 }
    ]),
    sixMax([
      { idx: 0, la: 3, b: 1 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 3, b: 1 },
      { idx: 4, la: 2 }
    ])
  ]),
  [
    "UTG preflop limp",
    "UTG2 preflop fold",
    "BTN preflop fold",
    "SB preflop complete",
    "BB preflop check"
  ]
);

// BB bet then a sticky call on BB must not be emitted before the other player acts.
check(
  "no double act",
  play([
    sixMax([
      { idx: 0, la: 9, b: 2 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 1 },
      { idx: 4, la: 9, b: 6 }
    ]),
    sixMax([
      { idx: 0, la: 3, b: 6 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 1 },
      { idx: 4, la: 9, b: 6 }
    ], 0),
    sixMax([
      { idx: 0, la: 3, b: 6 },
      { idx: 4, la: 8, b: 4 }
    ], 3),
    sixMax([
      { idx: 0, la: 3, b: 6 },
      { idx: 4, la: 3, b: 4 }
    ], 3)
  ]),
  [
    "UTG preflop raise",
    "UTG2 preflop fold",
    "BTN preflop fold",
    "SB preflop fold",
    "BB preflop 3bet",
    "UTG preflop call",
    "BB flop bet"
  ]
);

// Flop cannot start until SB answers the 4-bet. The check is the flop action.
check(
  "close preflop before flop",
  play([
    sixMax([
      { idx: 0, la: 1 },
      { idx: 1, la: 1 },
      { idx: 2, la: 9, b: 2 },
      { idx: 3, la: 9, b: 6 },
      { idx: 4, la: 9, b: 18 }
    ]),
    sixMax([
      { idx: 0, la: 1 },
      { idx: 1, la: 1 },
      { idx: 2, la: 1 },
      { idx: 3, la: 9, b: 6 },
      { idx: 4, la: 9, b: 18 }
    ]),
    sixMax([
      { idx: 2, la: 1 },
      { idx: 3, la: 2 },
      { idx: 4, la: 2 }
    ], 3)
  ]),
  [
    "UTG preflop fold",
    "UTG2 preflop fold",
    "BTN preflop raise",
    "SB preflop 3bet",
    "BB preflop 4bet",
    "BTN preflop fold",
    "SB preflop call",
    "SB flop check",
    "BB flop check"
  ]
);

// BB called preflop. Flop call is still sent when the turn card arrives.
check(
  "repeat call on next street",
  play([
    snap(0, 0, [
      { idx: 0, name: "SB", la: 9, b: 2 },
      { idx: 1, name: "BB", la: 3, b: 2 }
    ]),
    snap(0, 3, [
      { idx: 0, name: "SB", la: 8, b: 3 },
      { idx: 1, name: "BB", la: 3, b: 2 }
    ]),
    snap(0, 4, [
      { idx: 0, name: "SB", la: 8, b: 3 },
      { idx: 1, name: "BB", la: 3, b: 3 }
    ])
  ]),
  [
    "BTN preflop raise",
    "BB preflop call",
    "BTN flop bet",
    "BB flop call"
  ]
);

// BB checked the flop. Turn check is sent before the button acts.
check(
  "repeat check on next street",
  play([
    snap(1, 0, [
      { idx: 0, name: "UTG", la: 1 },
      { idx: 1, name: "BTN", la: 9, b: 2 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 3, b: 2 }
    ]),
    snap(1, 3, [
      { idx: 0, name: "UTG", la: 1 },
      { idx: 1, name: "BTN", la: 2 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 2 }
    ]),
    snap(1, 4, [
      { idx: 0, name: "UTG", la: 1 },
      { idx: 1, name: "BTN", la: 8, b: 4 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 2 }
    ])
  ]),
  [
    "UTG preflop fold",
    "BTN preflop raise",
    "SB preflop fold",
    "BB preflop call",
    "BB flop check",
    "BTN flop check",
    "BB turn check",
    "BTN turn bet"
  ]
);

// BB checked preflop. Flop check is sent before UTG bets.
check(
  "bb flop check after preflop check",
  play([
    snap(1, 0, [
      { idx: 0, name: "UTG", la: 3, b: 1 },
      { idx: 1, name: "BTN", la: 1 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 7 }
    ]),
    snap(1, 0, [
      { idx: 0, name: "UTG", la: 3, b: 1 },
      { idx: 1, name: "BTN", la: 1 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 2 }
    ]),
    snap(1, 3, [
      { idx: 0, name: "UTG", la: 8, b: 3 },
      { idx: 1, name: "BTN", la: 1 },
      { idx: 2, name: "SB", la: 1 },
      { idx: 3, name: "BB", la: 2 }
    ])
  ]),
  [
    "UTG preflop limp",
    "BTN preflop fold",
    "SB preflop fold",
    "BB preflop check",
    "BB flop check",
    "UTG flop bet"
  ]
);

// Turn is closed before a river fold.
check(
  "turn closed before river fold",
  play([
    snap(0, 0, [
      { idx: 0, name: "SB", la: 9, b: 2 },
      { idx: 1, name: "BB", la: 3, b: 2 }
    ]),
    snap(0, 3, [
      { idx: 0, name: "SB", la: 2 },
      { idx: 1, name: "BB", la: 2 }
    ]),
    snap(0, 5, [
      { idx: 0, name: "SB", la: 2 },
      { idx: 1, name: "BB", la: 1 }
    ])
  ]),
  [
    "BTN preflop raise",
    "BB preflop call",
    "BTN flop check",
    "BB flop check",
    "BTN turn check",
    "BB turn fold",
    "BTN turn win_fold"
  ]
);

// Showdown is last, after both river checks.
check(
  "showdown last",
  play([
    snap(0, 0, [
      { idx: 0, name: "SB", la: 9, b: 2 },
      { idx: 1, name: "BB", la: 3, b: 2 }
    ]),
    snap(0, 5, [
      { idx: 0, name: "SB", la: 2 },
      { idx: 1, name: "BB", la: 2 }
    ]),
    snap(0, 5, [
      { idx: 0, name: "SB", la: 10 },
      { idx: 1, name: "BB", la: 2 }
    ])
  ]),
  [
    "BTN preflop raise",
    "BB preflop call",
    "BTN flop check",
    "BB flop check",
    "BTN turn check",
    "BB turn check",
    "BTN river check",
    "BB river check",
    "BTN river win_showdown"
  ]
);

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all passed");
