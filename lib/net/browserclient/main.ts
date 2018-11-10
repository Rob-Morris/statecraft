// This was written for the boilerplate demo. Its still quite tightly tied to that.

import html from 'nanohtml'
import connect from '../../stores/wsclient'
import render from './render'
import * as I from '../../types/interfaces'
import fieldOps from '../../types/fieldops'
import onekey from '../../stores/onekey'


declare const config: {
  mimetype: string,
  key: string,
  initialValue: any,
  initialVersions: I.FullVersion,
}

// document.body.appendChild(html`<h1>oh hi</h1>`)

const content = document.getElementById('content')
if (content == null) throw Error('Could not find content root')
// content.appendChild(render('application/json', {x:5, y:[1,2,3]}))

const container = document.getElementById('content')
if (container == null) throw Error('Could not find document #content div')
const setObj = (data: any) => {
  console.log('setobj', data)
  if (typeof data === 'object' && data.type === 'Buffer') {
    const blob = new Blob([new Uint8Array(data.data)], {type: config.mimetype})
    data = URL.createObjectURL(blob)
  }

  const replace = (elem: HTMLElement | null) => {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (elem != null) {
      container.appendChild(elem)
    }
  }
  const result = data == null ? null : render(config.mimetype, data)
  if (result instanceof HTMLImageElement) {
    if (result.complete) replace(result)
    else result.onload = () => replace(result)
  } else {
    replace(result)
  }
}

;(async () => {
  const store = onekey(await connect('ws://localhost:2000/'), config.key)

  const sub = store.subscribe({type: 'single', q: true}, {
    knownDocs: new Set(['']),
    knownAtVersions: config.initialVersions,
  })
  await sub.cursorAll()
  let last: any = null

  // const r = new Map()
  for await (const update of sub) {
    if (update.replace) {
      const val = update.replace.with
      setObj(val)
      last = val
    }

    update.txns.forEach(txn => {
      console.warn('txn', txn) // NOT PROCESSING

      last = fieldOps.apply(last, txn.txn as I.SingleTxn)
      setObj(last)
    })
    // update.txns.forEach(txn => rtype.applyMut!(r, txn.txn))
    // TODO: And update the versions?
  }
})()