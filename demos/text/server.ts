// This is a simple collaborative text editing demo.

// Features:
// - Live markdown rendering

// TODO:
// - Security around the editing capability

import * as I from '../../lib/interfaces'
import lmdbStore from '../../lib/stores/lmdb'

import {reconnecter, PClient} from 'prozess-client'
import kvStore from '../../lib/stores/kvmem'

import augment from '../../lib/augment'
import otStore from '../../lib/stores/ot'
import mapStore from '../../lib/stores/map'
import router, {ALL} from '../../lib/stores/router'
import onekey from '../../lib/stores/onekey'
import createWss from '../../lib/net/wsserver'
import {register} from '../../lib/typeregistry'
import sel from '../../lib/sel'

import http from 'http'

import express from 'express'
import jsesc from 'jsesc'

import assert from 'assert'
import commonmark from 'commonmark'

import {type as texttype} from 'ot-text-unicode'
import fresh from 'fresh'
import html from 'nanohtml'

process.on('unhandledRejection', err => { throw err })

register(texttype)

const changePrefix = (k: I.Key, fromPrefix: string, toPrefix: string = '') => {
  assert(k.startsWith(fromPrefix), `'${k}' does not start with ${fromPrefix}`)
  return toPrefix + k.slice(fromPrefix.length)
}


;(async () => {
  const backend = kvStore()

  // const pclient = await new Promise<PClient>((resolve, reject) => {
  //   const pclient = reconnecter(9999, 'localhost', err => {
  //     if (err) reject(err)
  //     else resolve(pclient)
  //   })
  // })

  // const LMDBPATH = process.env.LMDBPATH || 'textdemo_db'
  // const backend = await lmdbStore(pclient, LMDBPATH)

  // const backend = lmdbStore(
  const rootStore = otStore(augment(backend))

  const store = router()
  store.mount(rootStore, 'raw/', ALL, '', true)

  const mdstore = mapStore(rootStore, (v, k) => {
    // console.log('v', v)
    const parser = new commonmark.Parser({smart: true})
    const writer = new commonmark.HtmlRenderer({smart: true, safe: true})
    
    const tree = parser.parse(v)
    return writer.render(tree)
    // return Buffer.from(mod.convert(v.img, 8, 1, 2) as any)
  })
  store.mount(mdstore, 'mdraw/', ALL, '', false)

  interface HTMLDocData {
    headers: {[k: string]: string},
    data: string | Buffer,
  }

  const renderEditor = (value: string | null, key: I.Key, versions: I.FullVersion): HTMLDocData => (
    {
      headers: {
        'x-sc-version': JSON.stringify(versions),
        // ETAG.
        'content-type': 'text/html',
      },
      data: `<!doctype html>
  <meta name="viewport" content="width=device-width">
  <link rel="stylesheet" type="text/css" href="/editorstyle.css">
  <textarea id=content autofocus>${value || 'YOOOOOOO'}</textarea>
  <script>
  const config = ${jsesc({
    key,
    initialValue: value,
    initialVersions: versions
  } as any)}
  </script>
  <script src="/bundle.js"></script>
  `
    }
  )

  store.mount(
    mapStore(rootStore, (value, key, versions) => renderEditor(value, 'raw/' + key!, versions)),
    'editor/', ALL, '', false
  )

  const genEtag = (key: string, versions: I.FullVersion): string => {
    const sources = Object.keys(versions).sort()
    return key + '_' + sources.map(s => `${s}-${versions[s]}`).join('_')
  }

  const renderMarkdown = (value: string, key: I.Key, versions: I.FullVersion): HTMLDocData => (
    {
      headers: {
        'x-sc-version': JSON.stringify(versions),
        'etag': genEtag(key, versions),
        // ETAG.
        'content-type': 'text/html',
      },
      data: `<!doctype html>
  <meta name="viewport" content="width=1000, initial-scale=1, maximum-scale=1">
  <link rel="stylesheet" type="text/css" href="/mdstyle.css" />
  <div id=content>${value}</div>
  `
    }
  )
  // const mdrender = mapStore(mdstore, (v, k) => {

  // })

  store.mount(
    mapStore(mdstore, (value, key, versions) => renderMarkdown(value, key!, versions)),
    'md/', ALL, '', false
  )


  const app = express()
  app.use(express.static(`${__dirname}/public`))

  const resultingVersion = (v: I.FullVersionRange): I.FullVersion => {
    const result: I.FullVersion = {}
    for (const s in v) result[s] = v[s].to
    return result
  }

  const scHandler = (
      getKey: (params: any) => string,
      getDefault?: (params: any, versions: I.FullVersionRange) => HTMLDocData | null): express.RequestHandler => (
    async (req, res, next) => {
      const k = getKey(req.params)
      const result = await store.fetch({type: 'kv', q: new Set([k])})
      // console.log('Got result from', k, result.results)
      let value = result.results.get(k)
      if (value == null && getDefault) value = getDefault(req.params, result.versions)
      if (value == null) return next()
      
      if (fresh(req.headers, value.headers)) return res.sendStatus(304)
      
      res.set(value.headers)
      res.send(value.data)
    }
  )

  // app.get('/edit/:name', handler(params => `editor/${name}`,
  //   params => renderEditor(null, `raw/${name}`, resultingVersion(result.versions))))

  app.get('/edit/:name', scHandler(
    ({name}) => `editor/${name}`,
    (params, versions) => renderEditor(null, `raw/${params.name}`, resultingVersion(versions))
  ))

  app.get('/md/:name', scHandler(
    ({name}) => `md/${name}`
  ))

  // app.get('/md/:name', async (req, res, next) => {
  //   const {name} = req.params
  //   const k = `md/${name}`
  //   const result = await store.fetch({type: 'kv', q: new Set([k])})
  //   const value = result.results.get(k)
  //   if (value == null) return next()
  //   res.setHeader('x-sc-version', JSON.stringify(result.versions))
  //   res.setHeader('content-type', 'text/html')
  //   res.send(`<!doctype html>
  // <div id=content>${value}</div>
  // `)
  // })

  app.get('/raw/:name', async (req, res, next) => {
    const {name} = req.params
    const k = `raw/${name}`
    const result = await store.fetch({type: 'kv', q: new Set([k])})
    const value = result.results.get(k)
    if (value == null) return next()
    res.setHeader('x-sc-version', JSON.stringify(result.versions))
    res.setHeader('content-type', 'text/plain')
    res.send(value)
  })

  app.get('/', async (req, res) => {
    const result = await store.fetch({type: 'static range', q: [{from: sel('raw/'), to: sel('raw/~')}]})
    res.setHeader('x-sc-version', JSON.stringify(result.versions))
    res.setHeader('content-type', 'text/html')
    res.send(`<!doctype html>
<title>Blag</title>
<style>
a {
  display: block;
  padding: 1em;
}
</style>
<body>
${result.results[0].map(([k, v]: [string, string]) => html`<a href=/${changePrefix(k, 'raw/', 'edit/')}>${v}</a>`)}
`)
  })

  const server = http.createServer(app)

  const wss = createWss({server}, (client, req) => {
    const key = changePrefix(req.url!, '/ws/')
    return onekey(store, key)
  })

  const port = process.env.PORT || '2001'
  server.listen(+port)
  console.log('http server listening on port', port)
})()