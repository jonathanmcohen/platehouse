import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPlate,
  gateVerdict,
  parseTimeV,
  pctDiff,
  planReason,
  proposeLimits,
  summarise,
} from "../lib/classify.mjs";

const TIME_OK = `\tCommand being timed: "timeout --verbose -s KILL 900 /opt/orca/AppRun"
\tUser time (seconds): 18.20
\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:21.50
\tMaximum resident set size (kbytes): 812000
\tExit status: 0
`;

test("parseTimeV reads wall time, peak RSS and exit status", () => {
  assert.deepEqual(parseTimeV(TIME_OK), { wallSeconds: 21.5, peakRssBytes: 812000 * 1024, exitStatus: 0, signal: null });
  const long = TIME_OK.replace("0:21.50", "1:02:03.25").replace("Exit status: 0", "Exit status: 239");
  assert.equal(parseTimeV(long).wallSeconds, 3723.25);
  assert.equal(parseTimeV(long).exitStatus, 239);
  const sig = `Command terminated by signal 9\n${TIME_OK.replace("\tExit status: 0\n", "")}`;
  assert.equal(parseTimeV(sig).signal, 9);
  assert.deepEqual(parseTimeV(""), { wallSeconds: null, peakRssBytes: null, exitStatus: null, signal: null });
});

const ok = { returnCode: 0, timeSeconds: 5025.1, weightGrams: 41.4, exitStatus: 0 };

test("a plate with time and weight above zero is ok", () => {
  assert.equal(classifyPlate(ok).verdict, "ok");
});

test("success without numbers fails", () => {
  const c = classifyPlate({ ...ok, weightGrams: 0 });
  assert.equal(c.verdict, "fail");
  assert.equal(c.reason, "no_numbers");
});

test("the four AC-034 refusals are reported, not failed", () => {
  for (const [code, reason] of [
    [-15, "machine_not_supported"],
    [-16, "machine_not_supported"],
    [-17, "process_not_compatible"],
    [-20, "bed_too_small"],
    [-52, "bed_too_small"],
    [-102, "bed_too_small"],
    [-66, "nozzle_mismatch"],
    [-68, "nozzle_mismatch"],
  ]) {
    const c = classifyPlate({ returnCode: code, exitStatus: 256 + code });
    assert.equal(c.verdict, "refused", String(code));
    assert.equal(c.reason, reason, String(code));
  }
});

test("codes the plan maps to nozzle_mismatch but Orca names otherwise need Jon's decision", () => {
  for (const code of [-50, -61, -62, -63, -64, -65, -67, -69]) {
    const c = classifyPlate({ returnCode: code, exitStatus: 256 + code });
    assert.equal(c.verdict, "needs-decision", String(code));
    assert.ok(c.meaning.length > 0);
  }
  assert.equal(planReason(-63), "nozzle_mismatch");
  assert.equal(planReason(-50), "slicer_error");
});

test("timeouts fail: the external kill and Orca's own -58", () => {
  assert.deepEqual(
    [classifyPlate({ timedOut: true }).reason, classifyPlate({ hostKilled: true }).reason, classifyPlate({ returnCode: -58 }).reason],
    ["timeout", "timeout", "timeout"],
  );
  assert.equal(classifyPlate({ returnCode: -58 }).verdict, "fail");
});

test("a crash fails: killed by a signal, no result.json, or a signal after numbers", () => {
  assert.equal(classifyPlate({ returnCode: null, exitStatus: 139 }).reason, "crash");
  assert.equal(classifyPlate({ returnCode: null, exitStatus: 1 }).reason, "crash");
  const late = classifyPlate({ ...ok, exitStatus: 139 });
  assert.equal(late.verdict, "fail");
  assert.equal(late.reason, "crash");
  assert.equal(classifyPlate({ returnCode: null, exitStatus: 137 }).reason, "crash");
});

test("any other code is an unexplained slicer error and fails", () => {
  const c = classifyPlate({ returnCode: -100, errorString: "Failed slicing" });
  assert.equal(c.verdict, "fail");
  assert.equal(c.reason, "slicer_error");
  assert.equal(classifyPlate({ returnCode: -5 }).reason, "slicer_error");
});

test("gate verdict: any fail fails; else any needs-decision; else pass", () => {
  const v = (...verdicts) => gateVerdict(verdicts.map((verdict) => ({ verdict })));
  assert.equal(v("ok", "refused"), "PASS");
  assert.equal(v("ok", "needs-decision", "refused"), "NEEDS-DECISION");
  assert.equal(v("ok", "needs-decision", "fail"), "FAIL");
  assert.equal(v(), "FAIL");
});

test("pctDiff and summarise give the per-plate gap, median and worst", () => {
  assert.equal(pctDiff(110, 100), 10);
  assert.equal(pctDiff(90, 100), -10);
  assert.equal(pctDiff(5, 0), null);
  assert.deepEqual(summarise([10, -30, 5]), { count: 3, median: 5, worst: -30 });
  assert.deepEqual(summarise([1, 2, 3, 4]), { count: 4, median: 2.5, worst: 4 });
  assert.deepEqual(summarise([]), { count: 0, median: null, worst: null });
});

test("proposeLimits sizes memory, plate seconds and tmpfs from the measured worst case", () => {
  const p = proposeLimits([
    { wallSeconds: 40, peakRssBytes: 1.2 * 2 ** 30, workBytes: 300 * 2 ** 20, inputBytes: 90 * 2 ** 20 },
    { wallSeconds: 130, peakRssBytes: 2.9 * 2 ** 30, workBytes: 100 * 2 ** 20, inputBytes: 2 * 2 ** 20 },
  ]);
  assert.equal(p.cpus, 4);
  assert.equal(p.memory, "5g");
  assert.equal(p.slicePlateSeconds, 270);
  assert.equal(p.tmpfs, "1g");
  assert.equal(p.measured.worstWallSeconds, 130);
});
