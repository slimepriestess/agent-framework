- A graceful framework shutdown (`AgentFramework.stop()`) with an inference
  still streaming no longer writes a `[turn-interrupted] … stopped by the
  user` marker into the agent's context. Membrane reports every
  `stream.cancel()` as reason `user` — the call, not the actor — so the
  shutdown now records its own provenance before cancelling (the same
  `frameworkCancelledStreams` track that `endTurn` and budget restarts use)
  and driveStream emits `inference:aborted` with reason `shutdown` and no
  marker: a host stopping is neither the user's act nor a failure, and a
  resident must not read after restart that they were stopped by someone.
