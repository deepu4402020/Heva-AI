export type Identifier = {
  digit: number;
  siteId: string;
};

export type PositionId = {
  pos: Identifier[];
  clock: number;
};

export type Character = {
  id: PositionId;
  value: string;
  siteId: string;
  tombstone: boolean;
};

export type FormatOp = {
  rangeStart: PositionId;
  rangeEnd: PositionId;
  attr: string;
  value: any;
  siteId: string;
  clock: number;
};

// Base used for digit generation. Large enough to allow many inserts between adjacent integers.
const BASE = 10000;

export function comparePositionIds(a: PositionId, b: PositionId): number {
  for (let i = 0; i < Math.max(a.pos.length, b.pos.length); i++) {
    const idA = a.pos[i];
    const idB = b.pos[i];
    if (!idA && idB) return -1;
    if (idA && !idB) return 1;
    if (idA.digit !== idB.digit) return idA.digit - idB.digit;
    if (idA.siteId !== idB.siteId) return idA.siteId.localeCompare(idB.siteId);
  }
  return a.clock - b.clock;
}

/**
 * Generates a PositionId strictly between `prev` and `next`.
 * If one is null, it acts as a boundary (0 or BASE).
 */
export function generatePositionBetween(
  prev: PositionId | null,
  next: PositionId | null,
  siteId: string,
  clock: number
): PositionId {
  let p1 = prev ? prev.pos : [];
  let p2 = next ? next.pos : [];
  
  const newPos: Identifier[] = [];
  let depth = 0;
  
  while (true) {
    const id1 = p1[depth];
    const id2 = p2[depth];
    
    const d1 = id1 ? id1.digit : 0;
    const d2 = id2 ? id2.digit : BASE;
    
    // Prefix matches entirely at this depth
    if (id1 && id2 && d1 === d2 && id1.siteId === id2.siteId) {
      newPos.push({ digit: d1, siteId: id1.siteId });
      depth++;
      continue;
    }
    
    // Same digit, different siteId
    if (id1 && id2 && d1 === d2) {
      // Branch under id1 so that it's strictly less than id2
      newPos.push({ digit: d1, siteId: id1.siteId });
      p2 = []; // Next levels are unconstrained by p2
      depth++;
      continue;
    }
    
    // There is room to allocate a new digit
    if (d2 - d1 > 1) {
      newPos.push({ digit: d1 + 1, siteId });
      return { pos: newPos, clock };
    } 
    // d2 - d1 === 1 (or less, though theoretically it shouldn't be less unless base boundaries)
    else {
      newPos.push({ digit: d1, siteId: id1 ? id1.siteId : siteId });
      p2 = []; // Next levels are unconstrained by p2
      depth++;
    }
  }
}

function charIdKey(id: PositionId) {
  return id.pos.map(p => `${p.digit}:${p.siteId}`).join(',') + `|${id.clock}`;
}

function formatOpKey(op: FormatOp) {
  return `${charIdKey(op.rangeStart)}|${charIdKey(op.rangeEnd)}|${op.attr}|${JSON.stringify(op.value)}|${op.siteId}|${op.clock}`;
}

export class Document {
  siteId: string;
  clock: number;
  characters: Character[];
  formatOps: FormatOp[];

  constructor(siteId: string) {
    this.siteId = siteId;
    this.clock = 0;
    this.characters = [];
    this.formatOps = [];
  }

  getVisibleCharacters(): Character[] {
    return this.characters.filter(c => !c.tombstone);
  }

  localInsert(visibleIndex: number, value: string) {
    this.clock++;
    const visibleChars = this.getVisibleCharacters();
    const prev = visibleIndex > 0 ? visibleChars[visibleIndex - 1].id : null;
    const next = visibleIndex < visibleChars.length ? visibleChars[visibleIndex].id : null;
    
    const id = generatePositionBetween(prev, next, this.siteId, this.clock);
    const char: Character = { id, value, siteId: this.siteId, tombstone: false };
    
    const insertIdx = this.findIndexForId(id);
    this.characters.splice(insertIdx, 0, char);
    return { type: 'insert', char };
  }

  localDelete(visibleIndex: number) {
    const visibleChars = this.getVisibleCharacters();
    const char = visibleChars[visibleIndex];
    if (char) {
      char.tombstone = true;
      return { type: 'delete', id: char.id };
    }
    return null;
  }

  localFormat(startIndex: number, endIndex: number, attr: string, value: any) {
    this.clock++;
    const visibleChars = this.getVisibleCharacters();
    const rangeStart = visibleChars[startIndex].id;
    const rangeEnd = visibleChars[endIndex].id;
    
    const op: FormatOp = { rangeStart, rangeEnd, attr, value, siteId: this.siteId, clock: this.clock };
    this.formatOps.push(op);
    return { type: 'format', op };
  }

  applyRemoteOp(op: any) {
    if (op.type === 'insert') {
      const charCopy = JSON.parse(JSON.stringify(op.char));
      const idx = this.findIndexForId(charCopy.id);
      const existing = this.characters[idx];
      if (existing && comparePositionIds(existing.id, charCopy.id) === 0) return;
      this.characters.splice(idx, 0, charCopy);
    } else if (op.type === 'delete') {
      const idx = this.findIndexForId(op.id);
      const existing = this.characters[idx];
      if (existing && comparePositionIds(existing.id, op.id) === 0) {
        existing.tombstone = true;
      }
    } else if (op.type === 'format') {
      this.formatOps.push(JSON.parse(JSON.stringify(op.op)));
    }
  }

  findIndexForId(id: PositionId): number {
    let low = 0;
    let high = this.characters.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (comparePositionIds(this.characters[mid].id, id) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  toText(): string {
    return this.characters
      .filter(c => !c.tombstone)
      .map(c => c.value)
      .join('');
  }

  getFormattedText() {
    const visibleChars = this.getVisibleCharacters();
    return visibleChars.map(c => {
      const activeOps = this.formatOps.filter(op => 
        comparePositionIds(op.rangeStart, c.id) <= 0 &&
        comparePositionIds(op.rangeEnd, c.id) >= 0
      );
      
      const formats: Record<string, any> = {};
      const latestOps: Record<string, FormatOp> = {};
      
      for (const op of activeOps) {
        const existing = latestOps[op.attr];
        if (!existing || op.clock > existing.clock || (op.clock === existing.clock && op.siteId > existing.siteId)) {
          latestOps[op.attr] = op;
          formats[op.attr] = op.value;
        }
      }
      
      return { char: c.value, formats, id: c.id };
    });
  }

  serialize(): any {
    return {
      siteId: this.siteId,
      clock: this.clock,
      characters: this.characters,
      formatOps: this.formatOps
    };
  }

  loadState(data: any) {
    const dummy = new Document(data.siteId);
    dummy.clock = data.clock;
    dummy.characters = data.characters;
    dummy.formatOps = data.formatOps;
    
    const merged = merge(this, dummy);
    this.characters = merged.characters;
    this.formatOps = merged.formatOps;
    this.clock = Math.max(this.clock, merged.clock);
  }
}

/**
 * Merge two divergent documents into a new Document.
 * Pure function: union + sort + tombstone filter.
 * This is commutative, associative, and idempotent.
 */
export function merge(docA: Document, docB: Document): Document {
  const merged = new Document(docA.siteId); // Site ID doesn't strictly matter for the merged output state
  merged.clock = Math.max(docA.clock, docB.clock);
  
  const charMap = new Map<string, Character>();
  for (const c of docA.characters) {
    charMap.set(charIdKey(c.id), { ...c });
  }
  for (const c of docB.characters) {
    const key = charIdKey(c.id);
    if (charMap.has(key)) {
      if (c.tombstone) {
        charMap.get(key)!.tombstone = true;
      }
    } else {
      charMap.set(key, { ...c });
    }
  }
  
  merged.characters = Array.from(charMap.values()).sort((a, b) => comparePositionIds(a.id, b.id));
  
  const formatMap = new Map<string, FormatOp>();
  for (const op of docA.formatOps) {
    formatMap.set(formatOpKey(op), { ...op });
  }
  for (const op of docB.formatOps) {
    formatMap.set(formatOpKey(op), { ...op });
  }
  merged.formatOps = Array.from(formatMap.values());
  
  return merged;
}
