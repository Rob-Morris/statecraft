const fs = require('fs')
const dbroot = require('../lib/dbroot')

const rmdir = (path) => {
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

exports.create = () => {
  let path
  do {
    path = __dirname + '/_test' + _dbid++
  } while (fs.existsSync(path))

  const store = dbroot(path, {})
  pathOfDb.set(store, path)
  return store
}

exports.close = (store) => { // teardown. Nuke it.
  store.close()
  const path = pathOfDb.get(store)
  rmdir(path)
  pathOfDb.delete(store)
}

