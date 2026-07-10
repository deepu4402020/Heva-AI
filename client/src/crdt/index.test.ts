import { expect, test, describe } from 'vitest';
import { Document, merge } from './index';

describe('CRDT Core', () => {

  test('Two sites insert at the same position concurrently — both survive, deterministic final order', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    // Simulate initial identical state
    const initOp = docA.localInsert(0, 'X');
    docB.applyRemoteOp(initOp);
    
    const opA = docA.localInsert(1, 'A');
    const opB = docB.localInsert(1, 'B');
    
    docA.applyRemoteOp(opB);
    docB.applyRemoteOp(opA);
    
    expect(docA.toText()).toBe(docB.toText());
    expect(docA.toText().length).toBe(3);
    expect(docA.toText() === 'XAB' || docA.toText() === 'XBA').toBe(true);
  });

  test('Two sites delete the same character concurrently — idempotent, no error', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    const initOp = docA.localInsert(0, 'X');
    docB.applyRemoteOp(initOp);
    
    const delA = docA.localDelete(0);
    const delB = docB.localDelete(0);
    
    docA.applyRemoteOp(delB);
    docB.applyRemoteOp(delA);
    
    expect(docA.toText()).toBe('');
    expect(docB.toText()).toBe('');
  });

  test('Site A deletes a character while Site B concurrently inserts into that deleted region', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    const op1 = docA.localInsert(0, 'X');
    const op2 = docA.localInsert(1, 'Y');
    docB.applyRemoteOp(op1);
    docB.applyRemoteOp(op2);
    
    // A deletes 'X'
    const delA = docA.localDelete(0);
    
    // B inserts between 'X' and 'Y'
    const opB = docB.localInsert(1, 'Z');
    
    docA.applyRemoteOp(opB);
    docB.applyRemoteOp(delA);
    
    // Final text should be 'ZY' because X was deleted but Z was anchored to it
    expect(docA.toText()).toBe('ZY');
    expect(docB.toText()).toBe('ZY');
  });

  test('Three-way concurrent insert at the same anchor point', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    const docC = new Document('C');
    
    const init = docA.localInsert(0, 'X');
    docB.applyRemoteOp(init);
    docC.applyRemoteOp(init);
    
    const opA = docA.localInsert(1, 'A');
    const opB = docB.localInsert(1, 'B');
    const opC = docC.localInsert(1, 'C');
    
    const ops = [opA, opB, opC];
    [docA, docB, docC].forEach(doc => {
      ops.forEach(op => {
        if (op!.char.siteId !== doc.siteId) {
          doc.applyRemoteOp(op);
        }
      });
    });
    
    expect(docA.toText()).toBe(docB.toText());
    expect(docB.toText()).toBe(docC.toText());
    expect(docA.toText().length).toBe(4);
  });

  test('Interleaved inserts from two sites typing different words at the same position simultaneously', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    const op1 = docA.localInsert(0, 'X');
    const op2 = docB.localInsert(0, 'Y');
    docA.applyRemoteOp(op2);
    docB.applyRemoteOp(op1);
    
    // At this point both have some deterministically sorted 'XY' or 'YX'
    const op3 = docA.localInsert(1, 'A');
    const op4 = docB.localInsert(1, 'B');
    
    docA.applyRemoteOp(op4);
    docB.applyRemoteOp(op3);
    
    expect(docA.toText()).toBe(docB.toText());
  });

  test('Delete-then-reinsert race', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    const init = docA.localInsert(0, 'X');
    docB.applyRemoteOp(init);
    
    const delA = docA.localDelete(0);
    // B hasn't seen the delete yet, inserts after 'X'
    const opB = docB.localInsert(1, 'Y');
    
    docA.applyRemoteOp(opB);
    docB.applyRemoteOp(delA);
    
    expect(docA.toText()).toBe('Y');
    expect(docB.toText()).toBe('Y');
  });

  test('Merge is commutative: merge(A, B) === merge(B, A)', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    docA.localInsert(0, 'H');
    docB.localInsert(0, 'W');
    
    const mergeAB = merge(docA, docB);
    const mergeBA = merge(docB, docA);
    
    expect(mergeAB.toText()).toBe(mergeBA.toText());
    expect(mergeAB.characters.length).toBe(mergeBA.characters.length);
  });

  test('Merge is associative: merge(merge(A, B), C) === merge(A, merge(B, C))', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    const docC = new Document('C');
    
    docA.localInsert(0, 'A');
    docB.localInsert(0, 'B');
    docC.localInsert(0, 'C');
    
    const mergeAB_C = merge(merge(docA, docB), docC);
    const mergeA_BC = merge(docA, merge(docB, docC));
    
    expect(mergeAB_C.toText()).toBe(mergeA_BC.toText());
    expect(mergeAB_C.characters.length).toBe(mergeA_BC.characters.length);
  });

  test('Merge is idempotent: merge(A, A) === A', () => {
    const docA = new Document('A');
    docA.localInsert(0, 'X');
    docA.localInsert(1, 'Y');
    docA.localDelete(0);
    
    const mergeAA = merge(docA, docA);
    
    expect(mergeAA.toText()).toBe(docA.toText());
    expect(mergeAA.characters.length).toBe(docA.characters.length);
  });

  test('Concurrent conflicting format ops on overlapping ranges', () => {
    const docA = new Document('A');
    const docB = new Document('B');
    
    // Insert "HelloWorld"
    for (let i = 0; i < 10; i++) {
      const op = docA.localInsert(i, "HelloWorld"[i]);
      docB.applyRemoteOp(op);
    }
    
    // A bolds chars 3-8, B italicizes chars 5-10
    // Wait, the test says: both resolve without exception, LWW tie-break is deterministic given equal timestamps.
    // They are different attributes, so they both apply to the intersection.
    const opFormatA = docA.localFormat(3, 8, 'bold', true);
    const opFormatB = docB.localFormat(5, 9, 'italic', true); // 'HelloWorld' is 10 chars, index 0-9
    
    docA.applyRemoteOp(opFormatB);
    docB.applyRemoteOp(opFormatA);
    
    const mergedA = merge(docA, docB);
    const mergedB = merge(docB, docA);
    
    expect(mergedA.formatOps.length).toBe(2);
    expect(mergedB.formatOps.length).toBe(2);
    
    // Add conflicting format op on SAME attribute
    const opFormatA2 = docA.localFormat(2, 6, 'color', 'red');
    const opFormatB2 = docB.localFormat(4, 8, 'color', 'blue');
    
    docA.applyRemoteOp(opFormatB2);
    docB.applyRemoteOp(opFormatA2);
    
    // Both resolve without crashing
    expect(docA.formatOps.length).toBe(4);
    expect(docB.formatOps.length).toBe(4);
  });
});
