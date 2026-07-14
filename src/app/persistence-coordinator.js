'use strict';

class PersistenceCoordinator {
  constructor() {
    this.chains = new Map();
    this.revisions = new Map();
  }

  nextRevision(key) {
    const revision = (this.revisions.get(key) || 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  enqueue(key, task) {
    const revision = this.nextRevision(key);
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => task(revision));
    const tracked = run.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    return run;
  }

  async drain() {
    await Promise.allSettled([...this.chains.values()]);
  }
}

module.exports = { PersistenceCoordinator };
