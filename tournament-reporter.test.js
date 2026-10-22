const { createReporter } = require("./tournament-reporter.js");

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

const ID = 1118195;
function info(extra) {
  return Object.assign({ i: ID, n: "GTD", na: 39, l: 8, np: 64, npre: 10, pt: 86100, st: 5, avc: 98717 }, extra || {});
}
const PRIZES = [{ mpa: 36000, mpp: 0.3 }, { pf: 1, pt: 1, mpa: 24000, mpp: 0.2 }];
const MIN = 60 * 1000;

const empty = createReporter();
check("nothing before info", empty.due(0), null);
empty.setTournament(ID);
empty.onInfo({ n: "no id" });
check("info without id ignored", empty.due(0), null);

const early = createReporter();
early.onInfo(info());
check("info before the table names its tournament waits", early.due(0), null);
early.setTournament(ID);
check("sent once the tournament is known", early.due(1000), { info: info() });
check("same info not resent", early.due(1000 + MIN * 5), null);

const partial = createReporter();
partial.setTournament(ID);
partial.onInfo(info());
partial.due(0);
partial.onInfo({ i: ID, chs: 2 });
check("partial info alone does not trigger", partial.due(30 * 1000), null);
partial.onInfo({ i: ID, na: 38 });
check("partial change waits for the interval", partial.due(45 * 1000), null);
check("partials are merged into the full info", partial.due(MIN), { info: info({ chs: 2, na: 38 }) });

const stacks = createReporter();
stacks.setTournament(ID);
stacks.onInfo(info());
stacks.due(0);
stacks.onInfo({ i: ID, avc: 120000 });
check("stack stats alone do not trigger", stacks.due(MIN * 2), null);
stacks.onInfo({ i: ID, na: 37 });
check("players left change waits for the interval", stacks.due(MIN - 1), null);
check("sent after the interval with latest stats", stacks.due(MIN), { info: info({ avc: 120000, na: 37 }) });

const other = createReporter();
other.setTournament(ID);
other.onInfo(info());
other.due(0);
other.onInfo({ i: 777, n: "browsed in the lobby", na: 5 });
check("other tournaments are not reported", other.due(MIN * 5), null);

const prizes = createReporter();
prizes.onPrizes(PRIZES);
prizes.onInfo(info());
prizes.setTournament(ID);
check("prizes seen before the tournament ride with the first send", prizes.due(0), { info: info(), prizes: PRIZES });
prizes.onPrizes(PRIZES);
check("identical prizes do not trigger", prizes.due(MIN * 2), null);
const morePrizes = PRIZES.concat([{ pf: 2, pt: 2, mpa: 14400, mpp: 0.12 }]);
prizes.onPrizes(morePrizes);
check("changed prizes are sent", prizes.due(MIN * 3), { info: info(), prizes: morePrizes });
prizes.onInfo({ i: ID, l: 9 });
check("later sends leave prizes out", prizes.due(MIN * 5), { info: info({ l: 9 }) });

const moved = createReporter();
moved.onPrizes(PRIZES);
moved.onInfo(info());
moved.setTournament(ID);
moved.due(0);
moved.onInfo(info({ i: 999 }));
moved.setTournament(999);
check("new tournament sent at once, old prizes dropped", moved.due(1), { info: info({ i: 999 }) });

const copy = createReporter();
copy.setTournament(ID);
copy.onInfo(info());
const sent = copy.due(0);
copy.onInfo({ i: ID, na: 1 });
check("payload is a snapshot, not the live merged object", sent.info.na, 39);

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all passed");
