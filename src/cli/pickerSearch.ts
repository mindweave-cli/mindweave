/**
 * pickerSearch.ts — the words typed into a picker, kept where the input box can show them.
 *
 * A long list (a router's catalogue is nearly three hundred models) is chosen from by
 * searching it, and the place to type a search is the box the eye is already on: the input
 * box. The picker owns the keys and the filtered list; the input box owns the drawing of the
 * field. The only thing that has to pass between them is the text, and passing it through
 * the app's own state would re-render the whole conversation for every letter. This is a
 * store of one string that only the two components that need it subscribe to.
 */
import { useSyncExternalStore } from "react";

let text = "";
/**
 * Whether the open surface is searching at this moment. True unless it says otherwise: a list
 * that is a search all the way through never touches it, while a manager with levels (the keys
 * manager has a searchable list of providers, then screens that are not searches) turns it off
 * on the levels that are not.
 */
let active = true;
const listeners = new Set<() => void>();

/** Set what the search field shows. Does nothing when it is already that. */
export function setPickerSearchText(next: string): void {
  if (next === text) return;
  text = next;
  for (const listener of listeners) listener();
}

/** Say whether the open surface is searching right now. See `active`. */
export function setPickerSearchActive(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

/** Whether the open surface is searching right now. */
export function pickerSearchActive(): boolean {
  return active;
}

/** What the search field shows now. */
export function pickerSearchText(): string {
  return text;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The search text, re-rendering the caller whenever it changes. */
export function usePickerSearchText(): string {
  return useSyncExternalStore(subscribe, pickerSearchText);
}

/** Whether the open surface is searching, re-rendering the caller whenever that changes. */
export function usePickerSearchActive(): boolean {
  return useSyncExternalStore(subscribe, pickerSearchActive);
}
