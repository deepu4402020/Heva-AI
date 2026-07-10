# Collaborative Rich-Text Editor

A custom CRDT-based collaborative rich-text editor built for a 48-hour take-home assignment. It operates entirely without operational transformation (OT) libraries or managed backend sync services.

## Architecture & Algorithm

### Position Identifier CRDT (LSEQ Family)

The core data structure relies on a sequence CRDT using dense fractional position identifiers, inspired by Logoot/LSEQ.

**How it works:**
- Each character is assigned a globally unique `PositionId`.
- A `PositionId` consists of a list of `(digit, siteId)` pairs, defining a total order, plus a per-site monotonic counter (clock) for tie-breaking.
- **Insert:** When a user types between two existing characters, we generate a new ID that sorts strictly between their IDs. We allocate a fresh digit in the interval if space allows; otherwise, we fall back to extending precision (adding a new level to the list).
- **Delete:** Deletions are represented by tombstones. Characters are never physically removed, allowing concurrent inserts into a deleted region to remain accurately anchored.
- **Merge:** Merging two divergent documents is achieved by taking the mathematical union of both character sets by ID, sorting them by ID, and filtering out tombstones when rendering the final text. 

**Why it works (The Proof):**
The merge function is inherently commutative, associative, and idempotent because it is fundamentally a set union operation based on unique identifiers:
- **Commutative** ($A \cup B = B \cup A$): Merging A into B yields the exact same sorted array as merging B into A.
- **Associative** ($(A \cup B) \cup C = A \cup (B \cup C)$): The order in which multiple clients sync their states does not affect the final set of characters.
- **Idempotent** ($A \cup A = A$): Re-applying the same document state or receiving duplicated network operations doesn't change the underlying set.

### Formatting CRDT (LWW)

Formatting (bold, italic, headers, etc.) is handled via a separate CRDT consisting of attribute operations applied over specific `PositionId` ranges.

- Formatting operations are broadcast with `(siteId, clock)` timestamps.
- We resolve concurrent conflicting format ops on overlapping ranges (e.g., User A bolds a word while User B italicizes it) using **Last-Writer-Wins (LWW)** per attribute.
- Because ties are broken deterministically by the timestamp/siteId, neither client crashes or drops data.

### Server & Peer Sync

- The server acts as a **dumb relay** over WebSockets. It does not store document state or compute operations.
- Late-joining clients initialize their state by broadcasting a `sync-request`. Existing peers respond directly with their current state, making the system highly distributed and easily scalable.
- **Offline Support:** If a client disconnects, local edits queue up in-memory. Upon reconnecting, the queue is flushed to the relay and remote ops are seamlessly merged without conflict.

## Running Locally

**Prerequisites:** Node.js v18+

1. Start the relay server:
   ```bash
   cd server
   npm install
   npm run dev
   ```

2. Start the client:
   ```bash
   cd client
   npm install
   npm run dev
   ```

## Demo Instructions

1. Open two browser tabs pointing to `http://localhost:5173`.
2. Join the same `demo-doc` with different names.
3. Edit concurrently in both tabs and observe the real-time sync and presence cursors.
4. **Offline test:** 
   - Kill one tab's network via DevTools (Network -> Offline).
   - Continue typing completely different sentences in both tabs.
   - Reconnect the offline tab.
   - Observe that both sets of edits survive and merge gracefully without errors.

## Testing

The core CRDT is strictly tested in isolation using Vitest (`cd client && npx vitest`). The 10 passing scenarios prove:
1. Two sites insert concurrently.
2. Two sites delete concurrently (idempotency).
3. Anchor survival (inserting into a concurrently deleted region).
4. Three-way concurrent insertions.
5. Interleaved identical-position inserts.
6. Delete-then-reinsert race conditions.
7. Commutative merges.
8. Associative merges.
9. Idempotent merges.
10. Deterministic LWW formatting resolution.

## What is NOT handled

Given the 48-hour timeframe, some features are intentionally omitted:
- **Tombstone Garbage Collection:** Deleted characters accumulate forever. In a production system, an epoch-based GC mechanism would be required.
- **Heavy Document Performance:** Without chunking or a balanced tree (like B-trees used in Y.js), sorting a flat array of identifiers becomes slow on extremely large documents (e.g., 100+ pages).
- **Images/Embeds:** Only text and basic text-formatting are natively bound to the CRDT logic.
