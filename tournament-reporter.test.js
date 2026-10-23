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
const MIN = 10 * 1000;
const BEAT = 60 * 1000;

const empty = createReporter();
check("nothing before info", empty.due(0), null);
empty.setTournaments([ID]);
empty.onInfo({ n: "no id" });
check("info without id ignored", empty.due(0), null);

const early = createReporter();
early.onInfo(info());
check("info before the table names its tournament waits", early.due(0), null);
early.setTournaments([ID]);
check("sent once the tournament is known", early.due(1000), { info: info() });
check("same info not resent before the heartbeat", early.due(1000 + BEAT - 1), null);
check("same info resent as a heartbeat", early.due(1000 + BEAT), { info: info() });

const partial = createReporter();
partial.setTournaments([ID]);
partial.onInfo(info());
partial.due(0);
partial.onInfo({ i: ID, chs: 2 });
check("partial info alone does not trigger", partial.due(MIN * 3), null);
partial.onInfo({ i: ID, na: 38 });
check("partials are merged into the full info", partial.due(MIN * 3), { info: info({ chs: 2, na: 38 }) });
partial.onInfo({ i: ID, na: 37 });
check("a change waits for the interval", partial.due(MIN * 4 - 1), null);
check("a change is sent after the interval", partial.due(MIN * 4), { info: info({ chs: 2, na: 37 }) });

const stacks = createReporter();
stacks.setTournaments([ID]);
stacks.onInfo(info());
stacks.due(0);
stacks.onInfo({ i: ID, avc: 120000 });
check("stack stats alone do not trigger", stacks.due(MIN * 2), null);
stacks.onInfo({ i: ID, na: 37 });
check("players left change waits for the interval", stacks.due(MIN - 1), null);
check("sent after the interval with latest stats", stacks.due(MIN), { info: info({ avc: 120000, na: 37 }) });

const other = createReporter();
other.setTournaments([ID]);
other.onInfo(info());
other.due(0);
other.onInfo({ i: 777, n: "browsed in the lobby", na: 5 });
check("other tournaments are not reported", other.due(BEAT - 1), null);

const prizes = createReporter();
prizes.onPrizes(PRIZES);
prizes.onInfo(info());
prizes.setTournaments([ID]);
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
moved.setTournaments([ID]);
moved.due(0);
moved.onInfo(info({ i: 999 }));
moved.setTournaments([999]);
check("new tournament sent at once, old prizes dropped", moved.due(1), { info: info({ i: 999 }) });

// Two tables in one tab (the client's table switcher), each in its own tournament.
const OTHER = 1118315;
function drain(reporter, now) {
  const out = [];
  let payload = reporter.due(now);
  while (payload) {
    out.push(payload.info.i + (payload.prizes ? "+prizes" : ""));
    payload = reporter.due(now);
  }
  return out;
}

const two = createReporter();
two.onInfo(info());
two.onInfo(info({ i: OTHER }));
two.setTournaments([ID, OTHER]);
check("both open tournaments are sent", drain(two, 0), [String(ID), String(OTHER)]);
check("neither is resent before the heartbeat", drain(two, BEAT - 1), []);
two.onInfo({ i: OTHER, na: 20 });
check("a change in one is sent for that one only", drain(two, MIN), [String(OTHER)]);
check("heartbeats keep their own clocks", drain(two, BEAT), [String(ID)]);
two.setTournaments([OTHER]);
check("a closed table's tournament is no longer reported", drain(two, BEAT * 3), [String(OTHER)]);
two.setTournaments([OTHER, OTHER, null]);
check("duplicates and cash tables are ignored", drain(two, BEAT * 5), [String(OTHER)]);

const unclear = createReporter();
unclear.onInfo(info());
unclear.onInfo(info({ i: OTHER }));
unclear.setTournaments([ID, OTHER]);
unclear.onPrizes(PRIZES);
check("prizes with two tournaments open are dropped", drain(unclear, 0), [String(ID), String(OTHER)]);
unclear.setTournaments([ID]);
check("and are not given to the one left open", drain(unclear, BEAT), [String(ID)]);

const claimed = createReporter();
claimed.onInfo(info());
claimed.onInfo(info({ i: OTHER }));
claimed.setTournaments([ID]);
claimed.onPrizes(PRIZES);
claimed.setTournaments([ID, OTHER]);
check("prizes seen while one tournament was open stay with it", drain(claimed, 0), [ID + "+prizes", String(OTHER)]);

const pending = createReporter();
pending.onInfo(info());
pending.onInfo(info({ i: OTHER }));
pending.onPrizes(PRIZES);
pending.setTournaments([ID, OTHER]);
check("prizes seen before two tournaments open are dropped", drain(pending, 0), [String(ID), String(OTHER)]);

const sameTournament = createReporter();
sameTournament.onInfo(info());
sameTournament.onPrizes(PRIZES);
sameTournament.setTournaments([ID, ID]);
check("two tables of one tournament keep its prizes", drain(sameTournament, 0), [ID + "+prizes"]);

const copy = createReporter();
copy.setTournaments([ID]);
copy.onInfo(info());
const sent = copy.due(0);
copy.onInfo({ i: ID, na: 1 });
check("payload is a snapshot, not the live merged object", sent.info.na, 39);

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all passed");
