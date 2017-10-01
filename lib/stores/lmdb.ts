// This file implements an lmdb kv store on top of prozess.
//
// For now it bootstraps by replaying the event log.

import assert = require('assert')
import lmdb = require('node-lmdb')
import fs = require('fs')
import msgpack = require('msgpack-lite')
import debugLib = require('debug')

// Its very sad that this has a direct dependancy on prozess client.
// It'd be way better to abstract this out, but its too early for that.
import {PClient} from 'prozess-client'
import {encodeTxn, decodeTxn, decodeEvent, sendTxn} from '../prozess'

import fieldOps from '../types/fieldops'
import queryops from '../types/queryops'

import * as I from '../types/interfaces'
import * as err from '../err'

const debug = debugLib('statecraft')
const CONFIG_KEY = Buffer.from('\x01config')
const VERSION_KEY = Buffer.from('\x01v')
const encodeVersion = (v: I.Version) => {
  const buf = Buffer.allocUnsafe(8)
  buf.writeUInt32LE(0, 0)
  buf.writeUInt32LE(v, 4)
  return buf
}
const decodeVersion = (buf: NodeBuffer) => buf.readUInt32LE(4)

// We take ownership of the PClient, so don't use it elsewhere after passing it to lmdbstore.
const lmdbStore = (client: PClient, location: string): I.SimpleStore => {
  const env = new lmdb.Env()

  assert(client.source, 'Cannot attach lmdb store until source is known')
  const source: I.Source = client.source!

  // Check that the directory exists.
  try { fs.mkdirSync(location) }
  catch(e) { if (e.code !== 'EEXIST') throw e }

  env.open({path: location, maxDbs: 2, noTls: true})

  const dbi = env.openDbi({name: null, create: true})
  // const configdb = env.openDbi({name: 'config', create: true})

  // Note: I'm using 'native' Prozess version numbers, so the local store
  // starts at version 0 and event 1 moves us to version 1.
  let version: I.Version = 0

  const setVersion = (txn: lmdb.Txn, v: I.Version) => {
    version = v
    txn.putBinary(dbi, VERSION_KEY, encodeVersion(version))
  }

  // Ok, first do catchup.
  {
    const txn = env.beginTxn()
    const configBytes = txn.getBinary(dbi, CONFIG_KEY)
    if (configBytes == null) {
      console.log('Database was created - no config!')
      version = 0
      txn.putBinary(dbi, CONFIG_KEY, msgpack.encode({sc_ver: 1, source}))
      setVersion(txn, version)
    } else {
      const {sc_ver, source:dbSource} = msgpack.decode(configBytes)
      assert(sc_ver === 1)
      // assert(dbSource === source)
      version = decodeVersion(txn.getBinary(dbi, VERSION_KEY))
    }
    txn.commit()
  }
  debug('Opened database at version', version)

  // TODO: Generate these based on the opstore.
  const capabilities = {
    queryTypes: new Set<I.QueryType>(['allkv', 'kv']),
    mutationTypes: new Set<I.ResultType>(['resultmap']),
  }

  const store: I.SimpleStore = {
    sources: [source],
    capabilities: capabilities,

    fetch(qtype, query, opts, callback) {
      // TODO: Allow range queries too.
      if (/*qtype !== 'allkv' &&*/ qtype !== 'kv') return callback(new err.UnsupportedTypeError())
      const qops = queryops[qtype]

      const dbTxn = env.beginTxn({readOnly: true})

      // KV txn. Query is a set of keys.
      const results = new Map<I.Key, I.Val>()
      for (let k of query) {
        const docBytes = dbTxn.getBinary(dbi, k)
        const doc = docBytes == null ? null : msgpack.decode(docBytes)
        results.set(k, doc)
      }

      dbTxn.commit()

      callback(null, {
        results,
        queryRun: query,
        // TODO: Loosen this version bound.
        versions: {[source]: {from: version, to: version}}
      })
    },

    mutate(type, txn: I.KVTxn, versions, opts, callback) {
      if (type !== 'resultmap') return callback(new err.UnsupportedTypeError())

      debug('mutate', txn)
      sendTxn(client, txn, versions[source] || 0, {}, (err, version) => {
        if (err) callback(err)
        else callback(null, {[source]: version!})
        debug('mutate cb', err, version)
      })
    },

    getOps(qtype, query, versions, opts, callback) {
      // TODO: Allow range queries too.
      if (qtype !== 'allkv' && qtype !== 'kv') return callback(new err.UnsupportedTypeError())
      const qops = queryops[qtype]

      // We need to fetch ops in the range of (from, to].
      const vs = versions[source] || versions._other
      if (!vs) return callback(null, {ops: [], versions: {}})

      const {from, to} = vs

      client.getEvents(from + 1, to, {}, (err, data) => {
        if (err) return callback(err)

        // Filter events by query.
        const ops = data!.events.map(event => decodeEvent(event, source))
        ops.forEach((data) => data.txn = qops.filterTxn(data.txn, query))

        callback(null, {
          ops,
          versions: {[source]: {from:data!.v_start - 1, to: data!.v_end - 1}}
        })
      })
    },

    close() {
      dbi.close()
      env.close()

      // We take ownership, so this makes sense.
      client.close()
      // And close the lmdb database.
    },
  }


  client.onevents = (events, nextVersion) => {
    debug('Got events', events, nextVersion)

    const dbTxn = env.beginTxn()

    let newVersion = version

    const txnsOut: {txn: I.KVTxn, from: I.Version, to: I.Version}[] = []

    events.forEach(event => {
      // This is kind of a big assertion.
      assert(newVersion === event.version - 1, 'Error: Version consistency violation. This needs debugging')

      // TODO: Batches.
      const txn = decodeTxn(event.data)

      for (const [k, op] of txn) {
        const oldBytes = dbTxn.getBinary(dbi, k)
        const oldData = oldBytes == null ? null : msgpack.decode(oldBytes)

        const newData = fieldOps.apply(oldData, op)
        console.log('updated key', k, 'from', oldData, 'to', newData)
        dbTxn.putBinary(dbi, k, msgpack.encode(newData))
      }

      const nextVersion = event.version + event.batch_size - 1
      txnsOut.push({txn, from: version, to: nextVersion})
      newVersion = nextVersion
    })

    console.log('new version', newVersion)
    setVersion(dbTxn, newVersion)
    dbTxn.commit()

    if (store.onTxn) txnsOut.forEach(({txn, from, to}) =>
      store.onTxn!(source, from, to, 'resultmap', txn)
    )
  }

  client.subscribe(version + 1, {}, (err, results) => {
    if (err) {
      // Again, not sure what to do here. Eat it and continue.
      return console.error('Error subscribing', err)
    }

    // The events will all be emitted via the onevent callback. We'll do catchup there.
    console.log(`Catchup complete - ate ${results!.v_end - results!.v_start} events`)
  })


  return store
}

export default lmdbStore
