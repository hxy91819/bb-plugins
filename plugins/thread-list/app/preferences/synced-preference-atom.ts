import { atom, type SetStateAction, type WritableAtom } from "jotai";
import {
  conflictingGroupingPreference,
  type PreferenceKey,
  type PreferenceValue,
} from "../../shared/preferences.js";
import {
  preferenceValueAtom,
  schedulePreferenceWrite,
} from "./preferences-sync.js";

export type SyncedPreferenceAtom<Key extends PreferenceKey> = WritableAtom<
  PreferenceValue<Key>,
  [SetStateAction<PreferenceValue<Key>>],
  void
>;

export function createSyncedPreferenceAtom<Key extends PreferenceKey>(
  key: Key,
): SyncedPreferenceAtom<Key> {
  return atom(
    (get) => get(preferenceValueAtom(key)),
    (get, set, update: SetStateAction<PreferenceValue<Key>>) => {
      const valueAtom = preferenceValueAtom(key);
      const previous = get(valueAtom);
      const next = typeof update === "function" ? update(previous) : update;
      const conflictingKey = conflictingGroupingPreference(key);
      if (next === true && conflictingKey !== null) {
        const conflictingAtom = preferenceValueAtom(conflictingKey);
        if (get(conflictingAtom)) {
          set(conflictingAtom, false);
          schedulePreferenceWrite(conflictingKey, false);
        }
      }
      if (Object.is(next, previous)) return;
      set(valueAtom, next);
      schedulePreferenceWrite(key, next);
    },
  );
}
