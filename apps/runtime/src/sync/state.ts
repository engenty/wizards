/**
 * What other parts of the runtime ask about the two-way sync without loading it: whether it
 * runs on this install, and how many spaces the organization in the cloud allows. Set by
 * sync/client.ts.
 */

let active = false;
let spaceLimit: number | null | undefined;

/** The two-way sync runs on this install: an account is linked and the switch is on. */
export const twoWayActive = () => active;

export function setTwoWayActive(on: boolean) {
  active = on;
}

/** The organization's number of spaces, as the cloud last said; `undefined` while it has not. */
export const cloudSpaceLimit = () => spaceLimit;

export function setCloudSpaceLimit(limit: number | null) {
  spaceLimit = limit;
}
