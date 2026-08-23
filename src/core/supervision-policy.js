function resolveDueCheckpointAction({ desiredState, checkpoint }) {
  if (!checkpoint || checkpoint.state !== "pending") {
    return { action: "ignore", outcome: "not_pending" };
  }
  if (desiredState === "stopped") {
    return { action: "hold", outcome: "service_stopped" };
  }
  if (desiredState === "quiet") {
    return checkpoint.source === "random"
      ? { action: "discard", outcome: "suppressed_quiet" }
      : { action: "archive", outcome: "suppressed_quiet" };
  }
  return { action: "dispatch", outcome: "queued" };
}

function sourcePriority(source) {
  if (source === "conversation") return 40;
  if (source === "zhijiantime") return 30;
  if (source === "context") return 20;
  if (source === "system_report") return 10;
  return 0;
}

function shouldSupersede(existing, incoming) {
  if (!existing || existing.state !== "pending" || !incoming) return false;
  if (existing.canonicalTaskId !== incoming.canonicalTaskId) return false;
  const existingTime = Date.parse(existing.updatedAt || existing.createdAt || "") || 0;
  const incomingTime = Date.parse(incoming.updatedAt || incoming.createdAt || "") || Date.now();
  if (incomingTime < existingTime) return false;
  if (incoming.source === "context" && sourcePriority(existing.source) > sourcePriority("context")) return false;
  return true;
}

module.exports = { resolveDueCheckpointAction, shouldSupersede, sourcePriority };
