import 'mocha'
import * as I from '../lib/interfaces'

import fs from 'fs'
import assert from 'assert'

import createMock from './prozess-mock'
import {PClient} from 'prozess-client'
import lmdb from '../lib/stores/lmdb'
import prozessOps from '../lib/stores/prozessops'
import runTests from './common'

const rmdir = (path: string) => {
  //console.log('rmdir path', path)
  require('child_process').exec('rm -r ' + path)
}

const pathOfDb = new Map
let _dbid = 1

process.on('exit', function() {
  for (let p of pathOfDb.values()) {
    rmdir(p)
  }
})

const create = async () => {
  let path: string
  do {
    // path = __dirname + '/_test' + _dbid++
    path = '_test' + _dbid++
  } while (fs.existsSync(path))

  const store = await lmdb(prozessOps(createMock()), path)
  pathOfDb.set(store, path)
  return store
}

const teardown = (store: I.Store<any>) => { // teardown. Nuke it.
  const path = pathOfDb.get(store)
  rmdir(path)
  pathOfDb.delete(store)
}

describe('prozess mock', () => {
  beforeEach(function() {
    this.client = createMock()
  })

  it('conflicts at the right time', async function() {
    const client = this.client as PClient
    const base = await client.getVersion()
    await client.send("hi", {conflictKeys: ['a']})

    try {
      await client.send("hi", {
        conflictKeys: ['a'],
        targetVersion: 1 + base, // should conflict with a 1, pass with a 2.
      })
    } catch (e) {
      assert(e)
    }

    // Ok like this.
    await client.send("hi", {
      conflictKeys: ['a'],
      targetVersion: 2 + base, // should conflict with a 1, pass with a 2.
    })
  })
})

describe('lmdb on prozess', () => {
  it('supports two stores pointed to the same prozess backend')
  it('catches up on missing operations from prozess')

  runTests(create, teardown)
})