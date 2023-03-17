import {SESSION_TOKEN, WS_URL} from '../../../config';
import Account, {ISession} from "../../../worker/share/Account";
import LocalStorage from "../../../worker/share/db/LocalStorage";
import {Pdu} from "../protobuf/BaseMsg";
import {ERR} from "../protobuf/PTPCommon";
import {AuthLoginReq, AuthLoginRes, AuthStep1Req, AuthStep1Res, AuthStep2Req, AuthStep2Res} from "../protobuf/PTPAuth";
import {randomize} from "worktop/utils";
import {getActions} from "../../../global";

export enum MsgConnNotifyAction{
  onInitAccount,
  onConnectionStateChanged,
  onLoginOk,
  onData
}

export type MsgConnNotify = {
  action: MsgConnNotifyAction;
  payload: any;
};

export enum MsgClientState {
  connect_none,
  closed,
  connect_error,
  connecting,
  connected,
  logged,
}

let reconnect_cnt = 0;
let seq_num = 0;
let clients: Record<number, MsgConn> = {};

let currentMsgConn: MsgConn | null = null;

export default class MsgConn {
  private accountId: number;
  private serverPubKey?: Buffer;
  private autoConnect: boolean;
  public state: MsgClientState;
  public client: WebSocket | any | undefined;
  private __rev_msg_map: Record<number, Pdu>;
  private __sending_msg_map: Record<number, boolean>;
  private __msgHandler: any;
  private sendMsgTimer?: NodeJS.Timeout;
  constructor(accountId: number) {
    this.accountId = accountId;
    this.autoConnect = true;
    this.sendMsgTimer = undefined;
    this.state = MsgClientState.connect_none;
    this.__msgHandler = null;
    this.__rev_msg_map = {};
    this.__sending_msg_map = {};
  }
  getState() {
    return this.state;
  }
  getAccountId() {
    return this.accountId;
  }

  getAutoConnect() {
    return this.autoConnect;
  }
  setAutoConnect(autoConnect: boolean) {
    this.autoConnect = autoConnect;
  }
  async close() {
    if (this.client && this.isConnect()) {
      this.client.close();
    }
  }
  connect() {
    if (
      this.state === MsgClientState.logged ||
      this.state === MsgClientState.connecting ||
      this.state === MsgClientState.connected
    ) {
      return;
    }
    try {
      if (
        currentMsgConn?.isConnect() &&
        currentMsgConn?.getAccountId() !== this.accountId
      ) {
        if(currentMsgConn){
          currentMsgConn!.setAutoConnect(false);
          currentMsgConn!.close();
        }
      }
      this.notifyState(MsgClientState.connecting);
      this.client = new WebSocket(`${WS_URL}`);
      this.client.binaryType = 'arraybuffer';
      this.client.onopen = this.onConnected.bind(this);
      this.client.onmessage = this.onData.bind(this);
      this.client.onclose = this.onClose.bind(this);
    } catch (e) {
      console.error('connect error', e);
      this.reconnect(this.getAutoConnect());
    }
  }

  waitForMsgServerState(
    state: MsgClientState,
    timeout: number = 10000,
    startTime: number = 0
  ) {
    const timeout_ = 500;
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        if (this.getState() === state) {
          resolve(true);
        } else if (timeout > 0 && startTime >= timeout) {
          //console.debug('waitForMsgServerState timeout', startTime, timeout);
          resolve(false);
        } else {
          startTime += timeout_;
          // eslint-disable-next-line promise/catch-or-return
          this.waitForMsgServerState(state, timeout, startTime).then(resolve);
        }
      }, timeout_);
    });
  }

  waitTime(timeout: number = 1000, startTime: number = 0) {
    const timeout_ = 1000;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        if (startTime >= timeout) {
          resolve();
        } else {
          startTime += timeout_;
          // eslint-disable-next-line promise/catch-or-return
          this.waitTime(timeout, startTime).then(resolve);
        }
      }, timeout_);
    });
  }

  setMsgHandler(msgHandler: any) {
    this.__msgHandler = msgHandler;
  }
  onConnected() {
    currentMsgConn = this;
    this.notifyState(MsgClientState.connected);
    this.authStep1().catch(console.error)
  }
  async login(sessionData?:ISession){
    const account = Account.getInstance(this.accountId)
    let pdu:Pdu | undefined = undefined;
    let session:ISession|undefined
    if(sessionData){
      session = sessionData;
      pdu = await account.sendPduWithCallback(new AuthLoginReq({
        ...session
      }).pack());

    }else{
      session = account.getSession()
      if(session){
        pdu = await account.sendPduWithCallback(new AuthLoginReq({
          ...session
        }).pack());
      }
    }
    if(pdu != undefined){
      const {err,payload} = AuthLoginRes.parseMsg(pdu);
      if(err === ERR.NO_ERROR){
        // @ts-ignore
        const {currentUser} = JSON.parse(payload)
        account.setUid(session!.uid);
        account.setUserInfo(currentUser);
        account.setSession(session)
        await account.saveSession()
        console.log("login OK!",account.getUid(),currentUser)
        this.notifyState(MsgClientState.logged);
        return account.getUid()
      }else{
        return false;
      }
    }
  }
  async authStep2(){
    const accountClient = Account.getInstance(this.accountId);
    const ts = +(new Date())
    const { sign }= await accountClient.signMessage(ts + Buffer.concat([accountClient.getIv(),accountClient.getAad()]).toString("hex"));
    const pdu = await accountClient.sendPduWithCallback(new AuthStep2Req({
      sign,
      ts,
      address:await accountClient.getAccountAddress()
    }).pack());
    const authStep2Res = AuthStep2Res.parseMsg(pdu)
    // console.log("authStep2Res finished!",authStep2Res)
    await this.login();
  }
  async authStep1(){
    const accountClient = Account.getInstance(this.accountId);
    accountClient.setMsgConn(this)
    const p = Buffer.from(randomize(16));
    const req = new AuthStep1Req({
      p
    }).pack();
    const t = AuthStep1Req.parseMsg(req);
    const pdu = await accountClient.sendPduWithCallback(req);
    const {err,address,q,sign,ts} = AuthStep1Res.parseMsg(pdu)
    // console.log("AuthStep1Res",{err,p,q,address,sign})
    if(err == ERR.NO_ERROR){
      const res = accountClient.recoverAddressAndPubKey(sign,ts+Buffer.concat([p,q]).toString("hex"))
      // console.log(res.address,address)
      if(res.address != address){
        console.error("invalid server address")
      }else{
        await accountClient.initEcdh(res.pubKey,p,q)
        this.authStep2().catch(console.error)
      }
    }else{
      console.error(err)
    }
  }
  notify(notifyList:MsgConnNotify[]) {
    if (this.__msgHandler) {
      this.__msgHandler(this.accountId,notifyList);
    }
  }
  onData(e: { data: Buffer }) {
    if(e.data && e.data.byteLength && e.data.byteLength > 16){
      let pdu = new Pdu(Buffer.from(e.data));
      const seq_num = pdu.getSeqNum();
      if(this.__sending_msg_map[seq_num]){
        this.__rev_msg_map[seq_num] = pdu
        delete this.__sending_msg_map[seq_num];
      }else{
        if (this.__msgHandler) {
          this.notify([
            {
              action: MsgConnNotifyAction.onData,
              payload: pdu,
            },
          ]);
        }
      }
    }

  }
  notifyState(state: MsgClientState) {
    this.state = state;
    this.notify([
      {
        action: MsgConnNotifyAction.onConnectionStateChanged,
        payload: {
          msgClientState: state,
        },
      },
    ]);
  }
  onClose() {
    if (this.sendMsgTimer) {
      clearTimeout(this.sendMsgTimer);
    }
    console.log('onClose', this.autoConnect);
    this.notifyState(MsgClientState.closed);
    this.reconnect(this.getAutoConnect());
  }

  reconnect(autoConnect: boolean) {
    if (autoConnect) {
      setTimeout(() => {
        if (
          this.state === MsgClientState.closed ||
          this.state === MsgClientState.connect_error
        ) {
          if (reconnect_cnt > 20) {
            reconnect_cnt = 0;
          }
          if (reconnect_cnt < 5) {
            reconnect_cnt += 1;
          } else {
            reconnect_cnt += 2;
          }
          this.connect();
        }
      }, 1000 * (reconnect_cnt + 1));
    }
  }

  static getInstance(accountId: number): MsgConn {
    if (!clients[accountId]) {
      clients[accountId] = new MsgConn(accountId);
    }
    return clients[accountId];
  }

  waitForMsgCallback(
    seq_num: number,
    timeout: number = 5000,
    startTime: number = 0
  ) {
    return new Promise<Pdu>((resolve, reject) => {
      setTimeout(() => {
        if (this.__rev_msg_map[seq_num]) {
          const res = this.__rev_msg_map[seq_num];
          delete this.__rev_msg_map[seq_num];
          resolve(res);
        } else {
          if (startTime >= timeout) {
            reject('TIMEOUT');
          } else {
            startTime += 200;
            if (this.isConnect()) {
              this.waitForMsgCallback(seq_num, timeout, startTime)
                .then(resolve)
                .catch(reject);
            }
          }
        }
      }, 200);
    });
  }

  send(data:Buffer|Uint8Array){
    this.client.send(data);
  }

  sendPduWithCallback(
    pdu:Pdu,
    timeout: number = 10000
  ) {
    return new Promise<Pdu>((resolve, reject) => {
      if (this.isConnect()) {
        this.__sending_msg_map[pdu.getSeqNum()] = true;
        this.send(pdu.getPbData())
        this.waitForMsgCallback(pdu.getSeqNum(), timeout)
          .then(resolve)
          .catch(reject);
      } else {
        this.reconnect(this.autoConnect);
        reject('MsgClientState is not connected');
      }
    });
  }

  isLogged() {
    return [MsgClientState.logged].includes(this.state);
  }
  isConnect() {
    return [MsgClientState.connected, MsgClientState.logged].includes(
      this.state
    );
  }
  static getMsgClient() {
    return currentMsgConn;
  }
}
