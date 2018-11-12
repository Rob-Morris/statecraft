import * as I from './types/interfaces'
import streamToIter, {Stream} from './streamToIter'
import err from './err'
import {queryTypes, wrapQuery, getQueryData} from './types/queryops'


type BufferItem = {
  source: I.Source, fromV: I.Version, toV: I.Version, txn: I.Txn, meta: I.Metadata
}

const splitFullVersions = (v: I.FullVersionRange): [I.FullVersion, I.FullVersion] => {
  const from: I.FullVersion = {}
  const to: I.FullVersion = {}
  for (const s in v) {
    from[s] = v[s].from
    to[s] = v[s].to
  }
  return [from, to]
}

type Sub = {
  qops: typeof queryTypes[''],

  // iter: I.Subscription,

  // When we get an operation, do we just send from the current version? Set
  // if SubscribeOpts.fromCurrent is set.

  // If fromCurrent is not set, this is the expected version for incoming operations.

  // This drives the state of the subscription:
  //
  // - If its null, we're waiting on fetch() and all the operations we see go into the buffer.
  // - If its 'current', we just pass all operations directly into the stream.
  //   opsBuffer should be null.
  // - If this is a version, we're either waiting for catchup (ops go into
  //   buffer) or we're ready and the ops are put straight into the stream.
  expectVersion: I.FullVersion | 'current' | null,
  // When the subscription is first opened, we buffer operations until catchup returns.
  opsBuffer: BufferItem[] | null,

  // Stream attached to the returned subscription.
  stream: Stream<I.CatchupData>,
}

const isVersion = (expectVersion: I.FullVersion | 'current' | null): expectVersion is I.FullVersion => (
  expectVersion !== 'current' && expectVersion != null
)

export default class SubGroup {
  private readonly allSubs = new Set<Sub>()
  private readonly store: I.SimpleStore
  private readonly getOps: I.GetOpsFn | null

  async catchup(query: I.Query, opts: I.SubscribeOpts): Promise<I.CatchupData> {
    // TODO: This should look at the aggregation options to decide if a fetch
    // would be the right thing to do.
    //
    // TODO: We should also catch VersionTooOldError out of catchup / getOps
    // and failover to calling fetch() directly.
    const {fromVersion} = opts
    if (fromVersion === 'current') {
      throw Error('Invalid call to catchup')

    } else if (fromVersion == null) {
      // Initialize with a full fetch.
      const {queryRun, results, versions} = await this.store.fetch(query)
      const [from, to] = splitFullVersions(versions)
      return {
        replace: {
          q: queryRun,
          with: results,
          versions: from,
        },
        txns: [],
        toVersion: to,
      }

    } else if (this.store.catchup) {
      // Use the provided catchup function to bring us up to date
      return await this.store.catchup(query, fromVersion, {
        supportedTypes: opts.supportedTypes,
        raw: opts.raw,
        aggregate: opts.aggregate,
        bestEffort: opts.bestEffort,
        // limitDocs, limitBytes.
      })

    } else {
      // Fall back to getOps
      const getOps = this.getOps!

      // _other is used for any other sources we run into in getOps.
      const versions: I.FullVersionRange = {_other: {from:0, to: -1}}

      if (fromVersion) for (const source in fromVersion) {
        versions[source] = {from:fromVersion[source], to: -1}
      }
      const {ops: txns, versions: opVersions} = await getOps(query, versions, {bestEffort: opts.bestEffort})
      const toVersion = splitFullVersions(opVersions)[1]
      return {txns, toVersion}
    }
  }

  constructor(store: I.SimpleStore, getOps?: I.GetOpsFn) {
    this.store = store
    this.getOps = getOps ? getOps : store.getOps ? store.getOps.bind(store) : null

    // Need at least one of these.
    if (this.getOps == null && store.catchup == null) {
      throw Error('Cannot attach subgroup to store without getOps or catchup function')
    }
  }

  onOp(source: I.Source, fromV: I.Version, toV: I.Version, type: I.ResultType, txn: I.Txn, meta: I.Metadata) {
    for (const sub of this.allSubs) {
      // the previous subgroup implementation handled this using qops.r.from(), but I'm not sure why.
      if (type !== sub.qops.r.name) throw new err.InvalidDataError(`Mismatched subscribe types ${type} != ${sub.qops.r.name}`)

      if (sub.opsBuffer) sub.opsBuffer.push({source, fromV, toV, txn, meta})
      else {
        if (isVersion(sub.expectVersion)) {
          if (sub.expectVersion![source] !== fromV) {
            throw Error(`Invalid version from source: from/to versions mismatch: ${sub.expectVersion[source]} != ${fromV}`)
          }

          sub.expectVersion[source] = toV
        }

        // This is pretty verbose. Might make sense at some point to do a few MS of aggregation on these.
        sub.stream.append({
          txns:[{versions: {[source]:toV}, txn, meta}],
          toVersion: {[source]:toV},
        })
      }
    }
  }

  create(query: I.Query, opts: I.SubscribeOpts = {}): I.Subscription {
    const fromCurrent = opts.fromVersion === 'current'
    const qtype = query.type
    const qops = queryTypes[qtype]

    const stream = streamToIter<I.CatchupData>(() => {
      this.allSubs.delete(sub)
    })

    var sub: Sub = {
      qops,
      expectVersion: opts.fromVersion || null,
      opsBuffer: fromCurrent ? null : [],
      stream,
    }
    this.allSubs.add(sub)

    if (!fromCurrent) this.catchup(query, opts).then(catchup => {
      const catchupVersion = catchup.toVersion
      sub.expectVersion = catchupVersion
      
      if (sub.opsBuffer == null) throw Error('Invalid internal state in subgroup')

      // Replay the operation buffer into the catchup txn
      for (let i = 0; i < sub.opsBuffer.length; i++) {
        const {source, fromV, toV, txn, meta} = sub.opsBuffer[i]
        const v = catchupVersion[source]
        if (v === fromV) {
          catchup.txns.push({versions:{[source]: toV}, txn, meta})
          catchupVersion[source] = toV
        } else if (v != null && v > toV) {
          throw Error('Invalid operation data - version span incoherent')
        }
      }
      sub.opsBuffer = null
      console.log('catchup', catchup)
      stream.append(catchup)
    }).catch(err => {
      // Bubble up to create an exception in the client.
      sub.stream.throw(err)
    })

    return stream.iter
  }
}
