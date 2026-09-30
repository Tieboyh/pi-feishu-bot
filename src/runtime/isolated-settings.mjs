// Node preload for the official Pi RPC entry. Keep Pi's CLI/resource/trust
// behavior, but back each SettingsManager with a private copy-on-write store.
// set_model also updates defaults and thinking settings; none may reach disk.
// This intentionally adapts the public SettingsManager factory at the process
// boundary. Real-RPC tests guard this integration against Pi upgrades.
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const fromStorage = SettingsManager.fromStorage.bind(SettingsManager);
SettingsManager.fromStorage = (source, options) => {
  const snapshots = new Map();
  return fromStorage({
    withLock(scope, update) {
      if (!snapshots.has(scope)) {
        source.withLock(scope, (current) => {
          snapshots.set(scope, current);
          return undefined; // Read only: do not modify the source storage.
        });
      }
      const next = update(snapshots.get(scope));
      if (next !== undefined) snapshots.set(scope, next);
    },
  }, options);
};
