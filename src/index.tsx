import './util/handleError';
import './util/setupServiceWorker';

import React from './lib/teact/teact';
import TeactDOM from './lib/teact/teact-dom';

import {getActions, getGlobal, setGlobal,} from './global';
import updateWebmanifest from './util/updateWebmanifest';
import {IS_MULTITAB_SUPPORTED} from './util/environment';
import './global/init';

import {APP_VERSION, DEBUG, MULTITAB_LOCALSTORAGE_KEY} from './config';
import {establishMultitabRole, subscribeToMasterChange} from './util/establishMultitabRole';
import {requestGlobal, subscribeToMultitabBroadcastChannel} from './util/multitab';
import {onBeforeUnload} from './util/schedulers';
import App from './App';

import './styles/index.scss';
import Mnemonic from "./lib/ptp/wallet/Mnemonic";
import Aes256Gcm from "./lib/ptp/wallet/Aes256Gcm";
import {selectTabState} from "./global/selectors";
const crypto = require('./lib/gramjs/crypto/crypto');

async function init() {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> INIT');
  }

  if (IS_MULTITAB_SUPPORTED) {
    subscribeToMultitabBroadcastChannel();

    await requestGlobal(APP_VERSION);
    localStorage.setItem(MULTITAB_LOCALSTORAGE_KEY, '1');
    onBeforeUnload(() => {
      const global = getGlobal();
      if (Object.keys(global.byTabId).length === 1) {
        localStorage.removeItem(MULTITAB_LOCALSTORAGE_KEY);
      }
    });
  }

  getActions().initShared();
  getActions().init();

  if (IS_MULTITAB_SUPPORTED) {
    establishMultitabRole();
    subscribeToMasterChange((isMasterTab) => {
      getActions()
        .switchMultitabRole({ isMasterTab }, { forceSyncOnIOs: true });
    });
  }

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> START INITIAL RENDER');
  }

  updateWebmanifest();

  TeactDOM.render(
    <App />,
    document.getElementById('root')!,
  );

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> FINISH INITIAL RENDER');
  }

  if (DEBUG) {
    // @ts-ignore
    window['init'] = ()=>{
      getActions().updateGlobal({
        users:{},
        chats:{},
        messages:{}
      })
      localStorage.removeItem("tt-global-state");

    }
    document.addEventListener('dblclick', () => {
      // eslint-disable-next-line no-console
      console.warn('TAB STATE', selectTabState(getGlobal()));
      // eslint-disable-next-line no-console
      console.warn({
        chatIds:getGlobal().chats.listIds.active
      })
    });
  }
}

init();
