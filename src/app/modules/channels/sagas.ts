import { takeLatest, select, call, all, put } from 'typed-redux-saga/macro';
import { selectNodeLibOrThrow } from 'modules/node/selectors';
import { requirePassword } from 'modules/crypto/sagas';
import { safeGetNodeInfo, safeConnectPeer, sleep } from 'utils/misc';
import { openChannel, getChannels, closeChannel } from './actions';
import types from './types';

export function* handleGetChannels() {
  try {
    const nodeLib = yield* select(selectNodeLibOrThrow);
    // Get open and pending channels in one go
    const [
      { channels },
      { pending_force_closing_channels, pending_open_channels, waiting_close_channels },
    ] = yield* all([
      call(nodeLib.getChannels),
      call(nodeLib.getPendingChannels),
    ] as const);

    // Map all channels' node info together
    const allChannels = [
      ...channels,
      ...pending_force_closing_channels,
      ...pending_open_channels,
      ...waiting_close_channels,
    ];
    const nodePubKeys = allChannels.reduce((prev, c) => {
      prev[c.remote_node_pub] = true;
      return prev;
    }, {} as { [pubkey: string]: boolean });
    const nodeInfoResponses = yield* all(
      Object.keys(nodePubKeys).map(pk => call(safeGetNodeInfo, nodeLib, pk)),
    );
    const nodeInfoMap = nodeInfoResponses.reduce((prev, node) => {
      prev[node.node.pub_key] = node;
      return prev;
    }, {} as { [pubkey: string]: Yielded<typeof nodeLib.getNodeInfo> });

    // Map all channels together with node info
    const payload = allChannels.map(channel => ({
      ...channel,
      node: nodeInfoMap[channel.remote_node_pub].node,
    }));
    yield put({
      type: types.GET_CHANNELS_SUCCESS,
      payload,
    });
  } catch (err) {
    yield put({
      type: types.GET_CHANNELS_FAILURE,
      payload: err,
    });
  }
}

export function* handleOpenChannel(action: ReturnType<typeof openChannel>) {
  try {
    yield call(requirePassword);
    const nodeLib = yield* select(selectNodeLibOrThrow);

    // Connect to peer and wait a sec just in case we weren't already
    yield call(safeConnectPeer, nodeLib, action.payload.address);
    yield call(sleep, 2000);

    // Construct open channel params and send
    const openParams = {
      node_pubkey_string: action.payload.address.split('@')[0],
      local_funding_amount: action.payload.capacity,
      private: action.payload.isPrivate,
      push_sat: action.payload.pushAmount,
      sat_per_byte: action.payload.fee,
    };
    const res = yield* call(nodeLib.openChannel, openParams);
    yield put({
      type: types.OPEN_CHANNEL_SUCCESS,
      payload: {
        address: action.payload.address,
        txid: res.funding_txid_str,
        index: res.output_index,
      },
    });

    // Refresh channels list
    yield call(sleep, 300);
    yield put(getChannels());
  } catch (err) {
    yield put({
      type: types.OPEN_CHANNEL_FAILURE,
      payload: err,
    });
  }
}

export function* handleCloseChannel(action: ReturnType<typeof closeChannel>) {
  try {
    yield call(requirePassword);
    const nodeLib = yield* select(selectNodeLibOrThrow);

    const { fundingTxid, outputIndex } = action.payload;
    const res = yield* call(nodeLib.closeChannel, fundingTxid, outputIndex);
    yield put({
      type: types.CLOSE_CHANNEL_SUCCESS,
      payload: {
        closingTxId: res.closing_txid,
      },
    });

    // Refresh channels list
    yield call(sleep, 300);
    yield put(getChannels());
  } catch (err) {
    yield put({
      type: types.CLOSE_CHANNEL_FAILURE,
      payload: err,
    });
  }
}

export default function* channelsSagas() {
  yield takeLatest(types.GET_CHANNELS, handleGetChannels);
  yield takeLatest(types.OPEN_CHANNEL, handleOpenChannel);
  yield takeLatest(types.CLOSE_CHANNEL, handleCloseChannel);
}
