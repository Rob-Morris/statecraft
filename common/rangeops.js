// This defines a data structure and operations for ranges.
//
// Range data is an associative data structure from string ranges to integer values.
//
// A set of ranges (or a range operation) is expressed as a sorted list of
// marker keys with the values in between them.
//
// Markers sit *between* key values, so we need to differentiate between a
// marker before a key and a marker after one. (This lets us express inclusive
// and exclusive ranges). Its a little goofy for now but all strings are prefixed with a character:
//
// - '<key' means the marker is before 'key'
// - '>key' means the marker is after 'key'
//
// You can also use the placeholder marker of '.', which means "Repeat the
// previous <key but instead store >key". This is used to make it easy to
// express single keys.
//
// A document is expressed as [marker, value, marker, value, ..., marker]
// Eg: ['<a', 1, '.', 0, '>c', 1, '<d']
//
// All ranges before the first specified key and after the last are considered
// to have the value of 0.
//
// Ranges should always be stored in a normalized canonical (collapsed) form.
// Its invalid to have the same value either side of a marker:
// [ ..., 1, '>b', 1 ... ]
// Its also invalid to end with a value - you should always end with a key.
//
// Operations:
// Operations express a set of additive changes to the keys stored in the
// ranges. An operation has the same list structure as a document, but when
// applying it the values are added together. Thus compose() is the same as
// apply() (!!).
//
// Another way we could do this is to specify the merge type (naming another OT
// type). That'd be pretty neat, but I can't think of any good uses for it.

const assert = require('assert')

// a < b
const lt = (a, b) => {
  if (a === b) return false
  const a_ = a.slice(1), b_ = b.slice(1)
  // Could just compare the first characters, but I'm not sure if that'd
  // actually be faster.
  return (a_ === b_) ? (a < b) : (a_ < b_)
}
const lte = (a, b) => a === b || lt(a, b)

// a > b
const gt = (a, b) => lt(b, a)

const min = (a, b) => lt(a, b) ? a : b
const expandKey = (k, prev) => k !== '.' ? k : '>' + prev.slice(1)
const expandItem = (range, idx) => expandKey(range[idx], range[idx - 2])
const shortKey = (k, prev) => (prev[0] === '<' && k[0] === '>' && prev.slice(1) === k.slice(1)) ? '.' : k

const iter = (range) => {
  let i = -1
  
  return {
    peek() {
      // Arbitrarily i points to the index of the current value
      if (range.length === 0 || i >= range.length) return null
      assert(i < range.length - 1)
      // We have to specialcase -1. Can't skip it because we need to track lastKey in append.
      return (i === -1) ? [0, range[0]] : [range[i], expandItem(range, i+1)]
    },

    consumeTo(k) {
      // Based on the current code below I think this'll never loop more than once, but still.
      while (true) {
        if (i >= range.length - 1) break
        const nextKey = expandItem(range, i+1)
        
        if (lt(k, nextKey)) break
        i += 2
      }
    },
  }
}

const doubleIter = (a, b) => {
  const aiter = iter(a), biter = iter(b)
  // Don't need a peek function.
  return () => {
    const anext = aiter.peek()
    const bnext = biter.peek()

    if (anext == null) {
      if (bnext == null) return null
      const [bval, to] = bnext
      biter.consumeTo(to) // or no argument?
      return [0, bval, to]
    } else if (bnext == null) {
      const [aval, to] = anext
      aiter.consumeTo(to)
      return [aval, 0, to]
    } else {
      const [aval, ato] = anext
      const [bval, bto] = bnext

      const k = min(ato, bto)
      aiter.consumeTo(k)
      biter.consumeTo(k)
      return [aval, bval, k]
    }
  }
}

const append = (range, from, val, to) => {
  if (val === 0 || from === to) return
  else if (range.length === 0) range.push(from, val, shortKey(to, from))
  else {
    const lastK = expandItem(range, range.length - 1)

    if (from === lastK) {
      if (val === range[range.length - 2]) {
        range[range.length - 1] = to // Its impossible that this could be '.'.
      } else {
        range.push(val, shortKey(to, from))
      }
    } else {
      range.push(0, shortKey(from, lastK), val, shortKey(to, from))
    }
  }
}

const plus = (a, b) => a + b
const minus = (a, b) => a - b

const type = module.exports = {
  name: 'range',
  create(data) {
    return data ? Array.from(data) : []
  },
  apply(snapshot, op, combine = plus) {
    // We'll walk the snapshot and operation together, copying resulting values in.
    const result = []
    let lastKey = ''

    const take = doubleIter(snapshot, op)
    let next
    while ((next = take())) {
      const [snapval, opval, to] = next
      append(result, lastKey, combine(snapval, opval, lastKey, to), to)
      lastKey = to
    }
    return result
  },
  compose(op1, op2) {
    // TODO: Not sure what this should do about values ending up >1.
    return type.apply(op1, op2) // HOW MYSTERIOUSLY CONVENIENT
  },


  // **** Helper functions
 
  forEach(range, fn) { // Helper function for iterating over a range. Yields (k1, val, k2) to fn.
    const {peek, consumeTo} = iter(range)
    let lastKey = ''

    let next 
    while ((next = peek())) {
      const [val, to] = next
      if (val !== 0) fn(lastKey, val, to)
      lastKey = to
      consumeTo(to)
    }
  },

  fromKeys(keys, val = 1) { // Ranges from a list or set of individual keys.
    keys = (Array.isArray(keys) ? keys : Array.from(keys))
      .sort()

    const result = []
    for (let i = 0; i < keys.length; i++) {
      if (result.length !== 0) result.push(0)
      result.push('<'+keys[i], val, '.')
    }
    return result
  },

  // Convert from a sorted list of inclusive [[a,b], [c,d]] pairs.
  fromInclusivePairs(pairs) {
    const result = []
    for (let i = 0; i < keys.length; i++) {
      append(result, '<'+pairs[i][0], 1, '>'+pairs[i][1])
    }
    return result
  },

  subtract(op1, op2) {
    return type.apply(op1, op2, minus)
  },

  // Append an op component onto the end of the (mutable) op.
  append(op, from, val, to) {
    // The op must be valid and the specified range must be after all other
    // ranges.
    assert(op.length === 0
      || (op.length >= 3 && lte(expandItem(op, op.length - 1), from)))
    assert(lte(from, to))
    append(op, from, val, to)
    return op
  },
}

