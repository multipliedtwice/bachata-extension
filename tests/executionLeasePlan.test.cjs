const assert = require("node:assert/strict");
const test = require("node:test");

const {
  checklistSuspensionRefusal,
  continuationLeasePlan,
  executionReleasePlan,
  executionStateLeaseIds,
  executionTopUpPlan,
  localAgentDemandRefusal,
  normalizedLocalAgentDemand,
  releaseOnce,
  topUpReservationHolds,
} = require("../dist/conversations/executionLeasePlan.js");

test("a demand names each persistent agent once and never negative slots", () => {
  assert.deepEqual(
    normalizedLocalAgentDemand({
      persistentAgentIds: ["lead", "worker", "lead"],
      transientSlots: -3,
      totalUnits: -1,
    }),
    { persistentAgentIds: ["lead", "worker"], transientSlots: 0, totalUnits: 0 },
  );
});

test("a demand that adds up and fits is not refused", () => {
  assert.equal(
    localAgentDemandRefusal(
      { persistentAgentIds: ["lead"], transientSlots: 1, totalUnits: 2 },
      2,
    ),
    undefined,
  );
});

test("a demand under its own parts is a defect, refused before the ceiling is consulted", () => {
  assert.equal(
    localAgentDemandRefusal(
      { persistentAgentIds: ["lead", "worker"], transientSlots: 1, totalUnits: 2 },
      99,
    ),
    "Local-provider demand is internally inconsistent",
  );
});

test("a demand over the ceiling names both numbers", () => {
  assert.equal(
    localAgentDemandRefusal({ persistentAgentIds: [], transientSlots: 3, totalUnits: 3 }, 2),
    "This operation needs 3 concurrent local provider processes, but bachata.maxConcurrentLocalAgents is 2",
  );
});

const topUp = (overrides = {}) =>
  executionTopUpPlan({
    reservedLocalAgents: 1,
    reservedPersistentAgents: ["lead"],
    demand: { persistentAgentIds: [], transientSlots: 0, totalUnits: 0 },
    maxLocalAgents: 4,
    userAlreadyRetained: false,
    ...overrides,
  });

test("a user that already holds a share cannot retain a second one", () => {
  assert.equal(topUp({ userAlreadyRetained: true }).refusal, "Execution ownership user is already retained");
});

test("a persistent agent the conversation already reserved costs nothing again", () => {
  assert.deepEqual(
    topUp({
      demand: { persistentAgentIds: ["lead"], transientSlots: 0, totalUnits: 1 },
    }).topUp,
    { newPersistentAgentIds: [], additionalUnits: 0, aggregateDemand: 1 },
  );
});

test("agents new to the lease and transient slots are what a top-up adds", () => {
  assert.deepEqual(
    topUp({
      demand: { persistentAgentIds: ["lead", "reviewer"], transientSlots: 1, totalUnits: 3 },
    }).topUp,
    { newPersistentAgentIds: ["reviewer"], additionalUnits: 2, aggregateDemand: 3 },
  );
});

test("a top-up over the ceiling is refused on the aggregate, not on its own size", () => {
  const refusal = topUp({
    reservedLocalAgents: 3,
    demand: { persistentAgentIds: [], transientSlots: 2, totalUnits: 2 },
    maxLocalAgents: 4,
  }).refusal;
  assert.equal(
    refusal,
    "Concurrent work in this conversation needs 5 local provider processes, but bachata.maxConcurrentLocalAgents is 4",
  );
});

test("a reservation holds only while its own lease is still the conversation's and open", () => {
  assert.equal(topUpReservationHolds({ currentStateIsTopUpState: true, closing: false }), true);
  assert.equal(topUpReservationHolds({ currentStateIsTopUpState: false, closing: false }), false);
  assert.equal(topUpReservationHolds({ currentStateIsTopUpState: true, closing: true }), false);
});

const release = (overrides = {}) =>
  executionReleasePlan({
    userId: "user-1",
    hasLease: true,
    isKnownUser: true,
    remainingUsersAfterRelease: 0,
    hasTransientLease: false,
    ...overrides,
  });

test("the last user closes the lease", () => {
  assert.deepEqual(release(), { action: "release", releaseTransient: false, closeLease: true });
});

test("a user before the last gives back only its own transient reservation", () => {
  assert.deepEqual(release({ remainingUsersAfterRelease: 1, hasTransientLease: true }), {
    action: "release",
    releaseTransient: true,
    closeLease: false,
  });
});

test("a suspended retention whose lease is gone is dropped, not released", () => {
  assert.deepEqual(release({ suspendedUserId: "user-1", hasLease: false }), {
    action: "dropSuspended",
  });
});

test("a suspended retention whose lease came back is released normally", () => {
  assert.deepEqual(release({ suspendedUserId: "user-1", hasLease: true }), {
    action: "release",
    releaseTransient: false,
    closeLease: true,
  });
});

test("releasing a user nothing knows about, or against no lease, does nothing", () => {
  assert.deepEqual(release({ isKnownUser: false }), { action: "none" });
  assert.deepEqual(release({ hasLease: false }), { action: "none" });
  assert.deepEqual(release({ suspendedUserId: "user-2", hasLease: false }), { action: "none" });
});

test("a checklist may suspend only an open lease with exactly one user", () => {
  assert.equal(
    checklistSuspensionRefusal({ hasLease: true, closing: false, userCount: 1 }),
    undefined,
  );
  for (const state of [
    { hasLease: false, closing: false, userCount: 1 },
    { hasLease: true, closing: true, userCount: 1 },
    { hasLease: true, closing: false, userCount: 2 },
    { hasLease: true, closing: false, userCount: 0 },
  ]) {
    assert.equal(
      checklistSuspensionRefusal(state),
      "Checklist execution requires exclusive ownership of the parent execution lease",
      JSON.stringify(state),
    );
  }
});

test("a continuation checks a lease it still holds and retakes one it suspended", () => {
  assert.deepEqual(continuationLeasePlan({ hasLease: true, hasSuspended: false }), {
    action: "assertHeld",
  });
  assert.deepEqual(continuationLeasePlan({ hasLease: true, hasSuspended: true }), {
    action: "assertHeld",
  });
  assert.deepEqual(continuationLeasePlan({ hasLease: false, hasSuspended: true }), {
    action: "retakeSuspended",
  });
  assert.deepEqual(continuationLeasePlan({ hasLease: false, hasSuspended: false }), {
    refusal: "Execution ownership was lost before the next iteration",
  });
});

test("every lease the state holds is named once, the shared one first", () => {
  assert.deepEqual(
    executionStateLeaseIds({
      leaseId: "shared",
      persistentLeaseIds: ["persistent", "shared"],
      transientLeaseIds: [undefined, "transient", "persistent"],
    }),
    ["shared", "persistent", "transient"],
  );
});

test("a release runs once however often it is called", async () => {
  let calls = 0;
  const release = releaseOnce(async () => {
    calls += 1;
  });
  await release();
  await release();
  await Promise.all([release(), release()]);
  assert.equal(calls, 1);
});

// EX-3. The resources a conversation's first execution lease asks for.
const { executionResourceClaims } = require("../dist/conversations/executionLeasePlan.js");

test("an ordinary run claims the run cap, the whole repository, and the local agents it needs", () => {
  const claims = executionResourceClaims({
    identity: { canonicalWorkingDirectory: "/repo", repositoryIdentity: "repo-id", repositoryRoot: "/repo" },
    managedTask: false,
    pairRunCapacity: 4,
    repositoryCapacity: 3,
    demandUnits: 2,
    maxLocalAgents: 5,
  });
  assert.deepEqual(claims[0], { key: "bachata-runs:global", capacity: 4 });
  assert.equal(claims[1].key.startsWith("repository-execution"), true);
  assert.equal(claims[1].units, 3);
  assert.equal(claims[1].capacity, 3);
  assert.deepEqual(claims[claims.length - 1], {
    key: "local-agents:global",
    units: 2,
    capacity: 5,
    kind: "physical",
  });
});

test("a managed task takes one unit of the repository plus its worktree", () => {
  const claims = executionResourceClaims({
    identity: { canonicalWorkingDirectory: "/repo/.worktrees/t1", repositoryIdentity: "repo-id", repositoryRoot: "/repo" },
    managedTask: true,
    pairRunCapacity: 4,
    repositoryCapacity: 3,
    demandUnits: 0,
    maxLocalAgents: 5,
  });
  assert.equal(claims[1].units, 1);
  assert.equal(claims.some((claim) => claim.key.startsWith("managed-worktree")), true);
  assert.equal(claims.some((claim) => claim.key === "local-agents:global"), false);
});

test("a directory that is not a repository claims itself, and capacities never fall below one", () => {
  const claims = executionResourceClaims({
    identity: { canonicalWorkingDirectory: "/scratch" },
    managedTask: false,
    pairRunCapacity: 0,
    repositoryCapacity: 0,
    demandUnits: 1,
    maxLocalAgents: 1,
  });
  assert.deepEqual(claims[0], { key: "bachata-runs:global", capacity: 1 });
  assert.equal(claims[1].key.startsWith("working-directory"), true);
  assert.equal(claims.length, 3);
});

// EX-3. What closing a lease reports, and the lease held when no broker is configured.
const {
  leaseQuarantineOutcome,
  leaseReleaseFailure,
  localExecutionLease,
  quarantineReasonFor,
  rejectedReasons,
} = require("../dist/conversations/executionLeasePlan.js");

test("only rejected results contribute a reason, in order", () => {
  assert.deepEqual(
    rejectedReasons([
      { status: "fulfilled", value: 1 },
      { status: "rejected", reason: "first" },
      { status: "fulfilled", value: 2 },
      { status: "rejected", reason: "second" },
    ]),
    ["first", "second"],
  );
  assert.deepEqual(rejectedReasons([]), []);
});

test("every release that failed is reported together, and none is no failure", () => {
  assert.equal(leaseReleaseFailure([]), undefined);
  const failure = leaseReleaseFailure([new Error("a"), new Error("b")]);
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, "One or more execution resources could not be released");
  assert.deepEqual(failure.errors.map((error) => error.message), ["a", "b"]);
});

test("a close that quarantined cleanly rethrows its own failure; one that did not says both", () => {
  const error = new Error("cleanup hung");
  assert.equal(leaseQuarantineOutcome(error, []), error);
  const both = leaseQuarantineOutcome(error, [new Error("quarantine refused")]);
  assert.ok(both instanceof AggregateError);
  assert.equal(both.message, "Provider cleanup failed and its execution resources could not be quarantined");
  assert.equal(both.errors[0], error);
  assert.equal(both.errors[1].message, "quarantine refused");
});

test("the quarantine is told the failure in the reader's words", () => {
  assert.equal(quarantineReasonFor(new Error("cleanup hung")), "Provider cleanup was not confirmed: cleanup hung");
  assert.equal(quarantineReasonFor("gone"), "Provider cleanup was not confirmed: gone");
});

test("the broker-less lease is always valid and gives back nothing", async () => {
  const lease = localExecutionLease({ id: "local-run-1", resources: [{ key: "bachata-runs:global", capacity: 1 }] });
  assert.equal(lease.id, "local-run-1");
  assert.deepEqual(lease.resources, [{ key: "bachata-runs:global", capacity: 1 }]);
  assert.deepEqual(lease.fences, {});
  assert.equal(lease.isValid(), true);
  assert.equal(lease.assertValid(), undefined);
  assert.equal(await lease.release(), undefined);
  assert.equal(await lease.quarantine("why"), undefined);
  assert.equal(lease.signal.aborted, false);
});
