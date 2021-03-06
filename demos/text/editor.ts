// This runs in the browser and is compiled to public/bundle.js

import {I, otDoc, registerType, subValues} from '@statecraft/core'
import {connectToWS, reconnectingclient} from '@statecraft/net'
import {type as texttype, TextOp} from 'ot-text-unicode'

registerType(texttype)

declare const config: {
  sources: I.Source[],
  key: string,
  initialValue: string | null,
  initialVersions: (number[] | null)[],
}

// document.body.appendChild(html`<h1>oh hi</h1>`)

const elem = document.getElementById('content') as HTMLTextAreaElement | null
if (elem == null) throw Error('Could not find document #content div')


// *** Text editing operations
interface TextCtx {
  insert(pos: number, val: string): void
  remove(pos: number, len: number): void
}


const id = <T>(x: T) => x
let prevvalue: string = ''

// Replace the content of the text area with newText, and transform the
// current cursor by the specified function.
const replaceText = (newText: string, transformCursor: (pos: number) => number = id) => {
  const newSelection = [transformCursor(elem.selectionStart), transformCursor(elem.selectionEnd)]

  // Fixate the window's scroll while we set the element's value. Otherwise
  // the browser scrolls to the element.
  const scrollTop = elem.scrollTop
  elem.value = newText
  prevvalue = elem.value // Not done on one line so the browser can do newline conversion.
  if (elem.scrollTop !== scrollTop) elem.scrollTop = scrollTop;

  // Setting the selection moves the cursor. We'll just have to let your
  // cursor drift if the element isn't active, though usually users don't
  // care.
  if (newSelection && window.document.activeElement === elem) {
    elem.selectionStart = newSelection[0];
    elem.selectionEnd = newSelection[1];
  }
}

// Edit the text in the local textarea
const localCtx: TextCtx = {
  insert(pos, text) {
    const prev = elem.value.replace(/\r\n/g, '\n')
    replaceText(prev.slice(0, pos) + text + prev.slice(pos),
      cursor => (cursor > pos) ? (cursor + text.length) : cursor
    )
  },
  remove(pos, length) {
    const prev = elem.value.replace(/\r\n/g, '\n')
    replaceText(prev.slice(0, pos) + prev.slice(pos + length),
      cursor => (cursor > pos) ? (cursor - Math.min(length, cursor-pos)) : cursor
    )
  }
}

// Shamelessly stolen from ShareJS's textarea demo
// https://github.com/josephg/ShareJS/blob/master/lib/client/textarea.js
const applyChange = (ctx: TextCtx, oldval: string, newval: string) => {
  if (oldval === newval) return

  let commonStart = 0
  while (oldval.charAt(commonStart) === newval.charAt(commonStart)) {
    commonStart++
  }

  let commonEnd = 0
  while (oldval.charAt(oldval.length - 1 - commonEnd) === newval.charAt(newval.length - 1 - commonEnd) &&
      commonEnd + commonStart < oldval.length && commonEnd + commonStart < newval.length) {
    commonEnd++
  }

  if (oldval.length !== commonStart + commonEnd) {
    ctx.remove(commonStart, oldval.length - commonStart - commonEnd)
  }
  if (newval.length !== commonStart + commonEnd) {
    ctx.insert(commonStart, newval.slice(commonStart, newval.length - commonEnd))
  }
}


;(async () => {
  const wsurl = `ws${window.location.protocol.slice(4)}//${window.location.host}/ws/${config.key}`
  console.log('connecting to ws', wsurl, '...')
  const [statusStore, storeP, uidChanged] = reconnectingclient<string>(() => connectToWS(wsurl))

  // If the server's ID changes when we reconnect, just reload the page.
  uidChanged.catch(e => { location.reload() })

  ;(async () => {
    for await (const status of subValues(I.ResultType.Single, statusStore.subscribe({type: I.QueryType.Single, q:true}))) {
      document.getElementById('connstatus')!.className = status
    }
  })()

  const store = await storeP
  console.log('Connected to websocket server', wsurl, 'storeid', store.storeInfo.uid)

  // console.log('config', config)
  
  // TODO: Check that the config data is from the store we connected to, and not
  // some other store. We might have stale cache information - in which case we
  // should throw it out (or hard-reload the page).

  // The version is sent as an array of numbers. Base64 would be better, but
  // we can't have nice things because of browser vendors. Eh, this is fine.
  const v0: I.FullVersion = config.initialVersions.map(vv => vv == null ? null : Uint8Array.from(vv))
  // for (const s in config.initialVersions) v0[s] = Uint8Array.from(config.initialVersions[s])

  // This is needed to prevent the browser from storing the text content on back / forwards navigations.
  elem.value = config.initialValue || ''

  // TODO: It would technically be better to wait until our subscription is live
  // before setting the initial value. The fetched data could be old or cached.
  if (config.initialValue == null) {
    console.log('Creating the document on the server...')
    try {
      await store.mutate(I.ResultType.Single, {type: 'set', data: ''}, v0)
    } catch (e) {
      // This is usually fine. If we conflict, its because the document was concurrently created on another peer.
      console.warn('Could not initialize the document:', e)
    }
  }

  const otdoc = await otDoc<string, TextOp>(store, 'text-unicode', {
    initial: { val: config.initialValue, version: v0 }
    // knownAtVersions: config.initialVersions,
  }, (txn, val) => {
    // console.log('listener', txn, val)

    switch (txn.type) {
      case 'set':
        applyChange(localCtx, elem.value, val)
        break
      case 'text-unicode': {
        let pos = 0
        const op = txn.data as TextOp
        for (let i = 0; i < op.length; i++) {
          const c = op[i]
          if (typeof c === 'number') pos += c // skip
          else if (typeof c === 'string') { // insert
            localCtx.insert(pos, c)
            pos += c.length
          } else { // delete
            localCtx.remove(pos, c.d)
          }
        }
        break
      }
      default: throw Error('Cannot handle txn ' + JSON.stringify(txn))
    }
  })

  const remoteCtx: TextCtx = {
    insert(pos, text) { otdoc.apply([pos, text]) },
    remove(pos, length) { otdoc.apply([pos, {d: length}]) },
  }

  // If the editor isn't instantly available, disable until it is.
  // elem.disabled = true
  // await otdoc.ready
  // elem.disabled = false
  // elem.focus()

  ;['textInput', 'keydown', 'keyup', 'select', 'cut', 'paste', 'input'].forEach(eventName => {
    elem.addEventListener(eventName, e => {
      setTimeout(() => {
        if (elem.value !== prevvalue) {
          prevvalue = elem.value
          applyChange(remoteCtx, otdoc.get(), elem.value.replace(/\r\n/g, '\n'))
        }
      }, 0)
    }, false)
  })
})()