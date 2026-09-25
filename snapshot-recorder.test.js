const { createRecorder } = require("./snapshot-recorder.js");

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

function las(payload) {
  return payload.snapshots.map((snap) => snap.boardCount + ":" + snap.seats.map((seat) => seat.name + "=" + seat.la + "@" + seat.b).join(","));
}

const street = createRecorder();
street.add(1, 0, 2, [
  { idx: 0, name: "BB", la: 2, b: 1, stack: 100 },
  { idx: 1, name: "BTN", la: 9, b: 3, stack: 97 }
]);
street.add(1, 3, 2, [
  { idx: 0, name: "BB", la: 2, b: 0, stack: 100 },
  { idx: 1, name: "BTN", la: 9, b: 0, stack: 97 }
]);
street.add(1, 3, 2, [
  { idx: 0, name: "BB", la: 2, b: 0, stack: 100 },
  { idx: 1, name: "BTN", la: 8, b: 4, stack: 93 }
]);
check("street clear then new la", las(street.peek()), [
  "0:BB=2@1,BTN=9@3",
  "3:BB=null@0,BTN=null@0",
  "3:BB=2@0,BTN=8@4"
]);

const blinds = createRecorder();
blinds.add(2, 0, 1, [
  { idx: 0, name: "SB", la: 7, b: 1, stack: 99 },
  { idx: 1, name: "BB", la: 4, b: 2, stack: 98 }
]);
check("blinds stay raw", las(blinds.peek()), ["0:SB=7@1,BB=4@2"]);

const winner = createRecorder();
winner.add(3, 0, 2, [
  { idx: 0, name: "UTG", la: 9, b: 4, stack: 96 },
  { idx: 1, name: "BB", la: 1, b: 2, stack: 98 },
  { idx: 2, name: "BTN", la: 3, b: 4, stack: 96 }
]);
const ended = winner.add(3, 0, 2, [
  { idx: 0, name: "UTG", la: 10, b: 0, stack: 96 },
  { idx: 1, name: "BB", la: 10, b: 0, stack: 98 },
  { idx: 2, name: "BTN", la: 1, b: 0, stack: 96 }
]);
winner.add(3, 0, 2, [
  { idx: 0, name: "UTG", la: 10, b: 0, stack: 106 },
  { idx: 1, name: "BB", la: 1, b: 0, stack: 98 },
  { idx: 2, name: "BTN", la: 1, b: 0, stack: 96 }
]);
check("one collect with pot", las(winner.peek()), [
  "0:UTG=9@4,BB=1@2,BTN=3@4",
  "0:UTG=16@10,BB=1@0,BTN=1@0"
]);
check("winner locks the hand", ended.done, true);
check("later zero is dropped", winner.peek().snapshots.length, 2);

const once = createRecorder();
once.add(4, 0, 0, [{ idx: 0, name: "A", la: 7, b: 1, stack: 10 }]);
once.add(4, 0, 0, [{ idx: 0, name: "A", la: 9, b: 3, stack: 8 }]);
once.add(4, 0, 0, [{ idx: 0, name: "A", la: 16, b: 3, stack: 11 }]);
const first = once.flush();
const second = once.flush();
once.add(4, 0, 0, [{ idx: 0, name: "A", la: 1, b: 0, stack: 11 }]);
const third = once.flush();
check("posted once", first.snapshots.length, 3);
check("second flush empty", second, null);
check("tail is not a new post", third, null);
check("winner kept in the only post", first.snapshots[2].seats[0].la, 16);
check("pot stays on the winner", first.snapshots[2].seats[0].b, 3);

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all passed");
