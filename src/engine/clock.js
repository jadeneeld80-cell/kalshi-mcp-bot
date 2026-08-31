import { state } from './state.js';
import fs from 'fs';

import { checkFarmBot } from './farmBot.js';
import { checkAutoBuy } from './autoBuy.js';
import { checkExit } from './exitManager.js';

import {
  startSession,
  startDay,
} from './riskManager.js';

import { loadBotState } from './botStateStore.js';
import { writeStateSnapshot } from './stateSnapshot.js';

import { priceFeed } from '../prices/binance.js';
import { krakenFallback } from '../prices/kraken.js';

import { KalshiWebSocket } from '../kalshi/websocket.js';

import {
  getBalance,
  findActiveMarket,
  getPositions,
  getMarket,
} from '../kalshi/client.js';

import { executeSell } from '../kalshi/orders.js';

import { loadBrain } from '../nn/store.js';

import {
  startOfflineTraining,
  stopOfflineTraining,
} from './offlineTrainer.js';

import { notify } from '../notify.js';


// ============================================================
// OFFLINE MODE
// ============================================================

const OFFLINE_THRESHOLD = 15;
const OFFLINE_POLL_MS = 30_000;

const _offlineMode = {
  BTC: false,
  ETH: false,
};

const _marketFails = {
  BTC: 0,
  ETH: 0,
};

const _offlinePollers = {};

const _armedBeforeOffline = {};


// ============================================================
// PUBLIC MARKET POLLING FOR SIM MODE
// ============================================================
//
// SIM mode does NOT use authenticated Kalshi WebSocket.
//
// Instead:
//
// public /markets endpoint
//        ↓
// real YES/NO bid/ask prices
//        ↓
// paper trading engine
//
// ============================================================

const PUBLIC_MARKET_POLL_MS = 2000;

const _lastPublicMarketPoll = {
  BTC: 0,
  ETH: 0,
};


// ============================================================
// LIVE WEBSOCKETS
// ============================================================
//
// These are only used when NOT in simulation mode.
// ============================================================

const kalshiWS = {
  BTC: new KalshiWebSocket(
    (ask, bid) =>
      updateYes(
        'BTC',
        ask,
        bid
      )
  ),

  ETH: new KalshiWebSocket(
    (ask, bid) =>
      updateYes(
        'ETH',
        ask,
        bid
      )
  ),
};


// ============================================================
// HELPERS
// ============================================================

function updateYes(
  asset,
  yesAsk,
  yesBid
) {
  if (
    yesAsk == null ||
    yesBid == null ||
    !Number.isFinite(yesAsk) ||
    !Number.isFinite(yesBid)
  ) {
    return;
  }

  const s = state[asset];

  const now =
    Date.now();

  const mid =
    (
      yesAsk +
      yesBid
    ) /
    2;

  s.yesPriceHistory.push({
    price:
      mid,

    ts:
      now,
  });

  if (
    s.yesPriceHistory.length >
    30
  ) {
    s.yesPriceHistory.shift();
  }


  // YES velocity
  if (
    s.yesPriceHistory.length >=
    3
  ) {
    const prev =
      s.yesPriceHistory[
        s.yesPriceHistory.length -
        3
      ];

    const dt =
      (
        now -
        prev.ts
      ) /
      1000;

    s.yesVel =
      dt > 0
        ? (
            (
              mid -
              prev.price
            ) *
            100
          ) /
          dt
        : 0;
  }


  // Large price jump detector
  if (
    s.yesPriceHistory.length >=
    2
  ) {
    const prev =
      s.yesPriceHistory[
        s.yesPriceHistory.length -
        2
      ];

    const jump =
      Math.abs(
        (
          mid -
          prev.price
        ) *
        100
      );

    if (
      jump >
      3
    ) {
      s.lastLargeJumpTs =
        now;
    }
  }


  s.yesAsk =
    yesAsk;

  s.yesBid =
    yesBid;
}


// ============================================================
// CONVERT KALSHI MARKET PRICE
// ============================================================
//
// Handles both:
// yes_ask_dollars = "0.7200"
// and older:
// yes_ask = 72
//
// ============================================================

function marketYesPrices(
  market
) {
  if (!market) {
    return null;
  }

  let ask =
    null;

  let bid =
    null;


  if (
    market.yes_ask_dollars !=
    null
  ) {
    ask =
      parseFloat(
        market.yes_ask_dollars
      );
  } else if (
    market.yes_ask !=
    null
  ) {
    ask =
      Number(
        market.yes_ask
      ) /
      100;
  }


  if (
    market.yes_bid_dollars !=
    null
  ) {
    bid =
      parseFloat(
        market.yes_bid_dollars
      );
  } else if (
    market.yes_bid !=
    null
  ) {
    bid =
      Number(
        market.yes_bid
      ) /
      100;
  }


  if (
    !Number.isFinite(
      ask
    ) ||
    !Number.isFinite(
      bid
    )
  ) {
    return null;
  }


  return {
    ask,
    bid,
  };
}


// ============================================================
// PUBLIC KALSHI PRICE REFRESH
// ============================================================

async function refreshPublicMarket(
  asset
) {
  if (asset === 'ETH') {
    return;
  }
  
  const s =
    state[asset];

  if (
    !s.ticker
  ) {
    return;
  }

  const now =
    Date.now();

  if (
    now -
      _lastPublicMarketPoll[
        asset
      ] <
    PUBLIC_MARKET_POLL_MS
  ) {
    return;
  }

  _lastPublicMarketPoll[
    asset
  ] =
    now;


  try {
    const market =
      await getMarket(
        s.ticker
      );

    const prices =
      marketYesPrices(
        market
      );

    if (!prices) {
      return;
    }

    updateYes(
      asset,
      prices.ask,
      prices.bid
    );
  } catch (err) {
    console.warn(
      `[Clock] ${asset} public market price refresh failed: ${err.message}`
    );
  }
}


// ============================================================
// CLOCK HELPERS
// ============================================================

function secsLeft() {
  const now =
    new Date();

  return (
    900 -
    (
      (
        now.getUTCMinutes() %
        15
      ) *
        60 +
      now.getUTCSeconds()
    )
  );
}


function windowId() {
  return Math.floor(
    Date.now() /
      (
        15 *
        60 *
        1000
      )
  );
}


function etHour() {
  return (
    new Date().getUTCHours() -
    4 +
    24
  ) %
    24;
}


// ============================================================
// LIQUIDITY
// ============================================================

function getLiquidity(
  asset,
  hour,
  yesAsk,
  yesBid
) {
  if (
    yesAsk !== null &&
    yesBid !== null
  ) {
    const spread =
      yesAsk -
      yesBid;

    if (
      spread <
      0.03
    ) {
      return 'HIGH';
    }

    if (
      spread <
      0.06
    ) {
      return 'MEDIUM';
    }

    return 'LOW';
  }


  const btcLiq =
    (
      hour >= 3 &&
      hour < 13
    ) ||
    hour >= 20
      ? 'HIGH'
      : (
          hour >= 1 &&
          hour < 3
        ) ||
        (
          hour >= 13 &&
          hour < 17
        )
      ? 'MEDIUM'
      : 'LOW';


  if (
    asset === 'BTC'
  ) {
    return btcLiq;
  }

  if (
    hour >= 9 &&
    hour < 16
  ) {
    return btcLiq;
  }

  return btcLiq ===
    'HIGH'
    ? 'MEDIUM'
    : 'LOW';
}


// ============================================================
// MARKET CONNECTION
// ============================================================

function attachMarketFeed(
  asset,
  ticker
) {
  /**
   * PAPER MODE
   *
   * Do NOT touch authenticated Kalshi WS.
   * Prices are fetched through public REST instead.
   */
  if (
    state.simMode
  ) {
    console.log(
      `[Clock] ${asset} SIM feed → public REST (${ticker})`
    );

    return;
  }


  /**
   * LIVE MODE
   */
  kalshiWS[
    asset
  ].switchTicker(
    ticker
  );
}


// ============================================================
// WINDOW ROLL
// ============================================================

const _rolling = {
  BTC: false,
  ETH: false,
};


async function onWindowRoll(
  asset
) {
  if (
    _rolling[
      asset
    ] ||
    _offlineMode[
      asset
    ]
  ) {
    return null;
  }


  _rolling[
    asset
  ] =
    true;


  const s =
    state[
      asset
    ];


  console.log(
    `[Clock] ${asset} window rolled — fetching new market`
  );


  s.farmRounds =
    0;

  s.ticksAbove =
    0;

  s.ticksTotal =
    0;

  s.windowOpenPrice =
    priceFeed.getPrice(
      asset
    );

  s.yesAsk =
    null;

  s.yesBid =
    null;


  for (
    let attempt = 0;
    attempt < 10;
    attempt++
  ) {
    try {
      const market =
        await findActiveMarket(
          asset
        );


      s.ticker =
        market.ticker;


      attachMarketFeed(
        asset,
        market.ticker
      );


      if (
        state.simMode
      ) {
        await refreshPublicMarket(
          asset
        );
      }


      console.log(
        `[Clock] ${asset} new ticker: ${market.ticker}`
      );


      _rolling[
        asset
      ] =
        false;


      return true;

    } catch (err) {

      if (
        attempt ===
        9
      ) {
        console.warn(
          `[Clock] ${asset} market lookup: ${err.message}`
        );
      }


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            5000
          )
      );
    }
  }


  console.error(
    `[Clock] ${asset} market lookup failed ` +
    `(attempt ${_marketFails[asset] + 1}/${OFFLINE_THRESHOLD})`
  );


  _rolling[
    asset
  ] =
    false;


  return false;
}


// ============================================================
// OFFLINE MODE
// ============================================================

function enterOfflineMode(
  asset
) {
  if (
    _offlineMode[
      asset
    ]
  ) {
    return;
  }


  _offlineMode[
    asset
  ] =
    true;


  const s =
    state[
      asset
    ];


  _armedBeforeOffline[
    asset
  ] =
    {
      farmArmed:
        s.farmArmed,

      autoBuyArmed:
        s.autoBuyArmed,
    };


  s.farmArmed =
    false;

  s.autoBuyArmed =
    false;


  console.log(
    `[Clock] ${asset} entering offline mode after ` +
    `${OFFLINE_THRESHOLD} failed market lookups.`
  );


  notify(
    '🔴 Offline Mode',
    `${asset}: market unavailable — bots paused, NN training continues`,
    'default'
  );


  if (
    s.brain
  ) {
    startOfflineTraining(
      asset,
      s.brain
    );
  }


  _offlinePollers[
    asset
  ] =
    setInterval(
      async () => {
        try {
          const market =
            await findActiveMarket(
              asset
            );

          await exitOfflineMode(
            asset,
            market
          );

        } catch {

          const key =
            asset +
            '_count';

          const polls =
            (
              _offlinePollers[
                key
              ] =
                (
                  _offlinePollers[
                    key
                  ] ??
                  0
                ) +
                1
            );


          if (
            polls %
              5 ===
            0
          ) {
            const samples =
              s.brain?.data
                ?.length ??
              0;

            console.log(
              `[Offline] ${asset} — still waiting for market ` +
              `(${samples} samples trained)`
            );
          }
        }
      },

      OFFLINE_POLL_MS
    );
}


// ============================================================
// EXIT OFFLINE MODE
// ============================================================

async function exitOfflineMode(
  asset,
  market
) {
  clearInterval(
    _offlinePollers[
      asset
    ]
  );


  delete _offlinePollers[
    asset
  ];

  delete _offlinePollers[
    asset +
      '_count'
  ];


  _offlineMode[
    asset
  ] =
    false;

  _marketFails[
    asset
  ] =
    0;


  stopOfflineTraining(
    asset
  );


  const s =
    state[
      asset
    ];


  s.ticker =
    market.ticker;

  s.windowId =
    windowId();

  s.farmRounds =
    0;

  s.ticksAbove =
    0;

  s.ticksTotal =
    0;

  s.windowOpenPrice =
    priceFeed.getPrice(
      asset
    );

  s.yesAsk =
    null;

  s.yesBid =
    null;


  attachMarketFeed(
    asset,
    market.ticker
  );


  if (
    state.simMode
  ) {
    await refreshPublicMarket(
      asset
    );
  }


  const saved =
    _armedBeforeOffline[
      asset
    ] ??
    {};


  s.farmArmed =
    saved.farmArmed ??
    false;

  s.autoBuyArmed =
    saved.autoBuyArmed ??
    false;


  const armedLabel =
    s.farmArmed
      ? 'FARM'
      : s.autoBuyArmed
      ? 'AUTO_BUY'
      : 'disarmed';


  console.log(
    `[Clock] ${asset} market found (${market.ticker}) — ` +
    `bots resuming (${armedLabel})`
  );


  notify(
    '🟢 Market Resumed',
    `${asset}: new market found — bots back online (${armedLabel})`,
    'success'
  );
}


// ============================================================
// MAIN TICK
// ============================================================

let _lastBalanceFetch =
  0;

let _tickActive =
  false;


async function tick() {
  if (
    _tickActive
  ) {
    return;
  }


  _tickActive =
    true;


  try {
    await _tickBody();
  } finally {
    _tickActive =
      false;
  }
}


async function _tickBody() {

  const now =
    Date.now();

  const sl =
    secsLeft();

  const wid =
    windowId();

  const hour =
    etHour();


  // ==========================================================
  // BALANCE
  // ==========================================================

  /**
   * FORCE SIM MODE
   *
   * Absolutely no getBalance() call.
   */
  if (
    state.simMode
  ) {

    state.balance =
      state.paperBalance;

  } else {

    /**
     * LIVE MODE ONLY
     */
    if (
      now -
        _lastBalanceFetch >
      30_000
    ) {
      try {

        const realBalance =
          (
            await getBalance()
          ) /
          100;


        state.balance =
          realBalance;


        _lastBalanceFetch =
          now;


        if (
          realBalance <
            state.SIM_TRIGGER_THRESHOLD &&
          !state.simMode
        ) {

          state.simMode =
            true;

          state.paperBalance =
            10.00;

          state.balance =
            state.paperBalance;


          console.log(
            '[Clock] Balance depleted — switching to SIM MODE.'
          );


          notify(
            '📚 Sim Mode Active',
            `Balance $${realBalance.toFixed(2)} — paper trading with $10.00`,
            'default'
          );
        }

      } catch (err) {

        console.warn(
          `[Clock] Live balance refresh failed: ${err.message}`
        );

      }
    }
  }


  // ==========================================================
  // EACH ASSET
  // ==========================================================

  for (
    const asset of [
      'BTC',
      'ETH',
    ]
  ) {

    const s =
      state[
        asset
      ];


    s.secsLeft =
      sl;

    s.spotPrice =
      priceFeed.getPrice(
        asset
      );

    s.regime =
      priceFeed.getRegime(
        asset
      );

    s._simMode =
      state.simMode;


    /**
     * PAPER MODE:
     *
     * Get REAL Kalshi prices from PUBLIC REST API.
     */
    if (
      state.simMode &&
      s.ticker
    ) {
      await refreshPublicMarket(
        asset
      );
    }


    s.liquidity =
      getLiquidity(
        asset,
        hour,
        s.yesAsk,
        s.yesBid
      );


    // ========================================================
    // YES VELOCITY
    // ========================================================

    if (
      s.yesPriceHistory.length >=
      2
    ) {

      const cutoff =
        now -
        5000;


      const window =
        s.yesPriceHistory.filter(
          p =>
            p.ts >=
            cutoff
        );


      if (
        window.length >=
        2
      ) {

        const oldest =
          window[
            0
          ];

        const newest =
          window[
            window.length -
            1
          ];


        const dt =
          (
            newest.ts -
            oldest.ts
          ) /
          1000;


        s.yesVel =
          dt > 0
            ? (
                (
                  newest.price -
                  oldest.price
                ) *
                100
              ) /
              dt
            : 0;
      }
    }


    s.yesVelHistory.push(
      s.yesVel
    );

    if (
      s.yesVelHistory.length >
      10
    ) {
      s.yesVelHistory.shift();
    }


    s.crowdVelHistory.push(
      s.yesVel
    );

    if (
      s.crowdVelHistory.length >
      4
    ) {
      s.crowdVelHistory.shift();
    }


    // ========================================================
    // pctAbove
    // ========================================================

    if (
      s.yesAsk !== null &&
      s.yesBid !== null
    ) {

      s.ticksTotal++;


      if (
        (
          s.yesAsk +
          s.yesBid
        ) /
          2 >=
        0.50
      ) {
        s.ticksAbove++;
      }
    }


    // ========================================================
    // WINDOW CHANGE
    // ========================================================

    if (
      _offlineMode[
        asset
      ]
    ) {

      // Offline poller handles it.

    } else if (
      s.windowId ===
      null
    ) {

      s.windowId =
        wid;

    } else if (
      s.windowId !==
        wid ||
      !s.ticker
    ) {

      const ok =
        await onWindowRoll(
          asset
        );


      if (
        ok === true
      ) {

        s.windowId =
          wid;

        _marketFails[
          asset
        ] =
          0;

      } else if (
        ok === false
      ) {

        _marketFails[
          asset
        ]++;


        if (
          _marketFails[
            asset
          ] >=
          OFFLINE_THRESHOLD
        ) {

          enterOfflineMode(
            asset
          );

        }
      }
    }


    // ========================================================
    // WAIT FOR MARKET DATA
    // ========================================================

    if (
      !s.ticker ||
      s.yesAsk ===
        null ||
      s.yesBid ===
        null
    ) {
      continue;
    }


    const ctx =
      {
        asset,

        s,

        balance:
          state.balance ??
          0,

        pctAbove:
          s.ticksTotal >
          0
            ? s.ticksAbove /
              s.ticksTotal
            : 0.5,
      };


    // ========================================================
    // EXIT FIRST
    // ========================================================

    if (
      s.activeTrade
    ) {

      await checkExit(
        ctx
      );

    }


    // ========================================================
    // ENTRY
    // ========================================================

    if (
      !s.activeTrade &&
      !state.disabledAssets.includes(
        asset
      )
    ) {

      if (
        s.farmArmed
      ) {

        await checkFarmBot(
          ctx
        );

      } else if (
        s.autoBuyArmed
      ) {

        await checkAutoBuy(
          ctx
        );
      }
    }
  }
}


// ============================================================
// START CLOCK
// ============================================================

export async function startClock() {

  console.log(
    '[Clock] Starting price feeds...'
  );


  priceFeed.connect();


  // ==========================================================
  // LOAD SIM OVERRIDE FIRST
  // ==========================================================

  try {

    const override =
      JSON.parse(
        fs.readFileSync(
          new URL(
            '../../data/sim_override.json',
            import.meta.url
          ),
          'utf8'
        )
      );


    if (
      override.forceSimMode
    ) {

      state.simMode =
        true;


      state.paperBalance =
        override.paperBalance ??
        50.00;


      state.balance =
        state.paperBalance;


      console.log(
        `[Clock] SIM OVERRIDE active — paper balance $${state.paperBalance.toFixed(2)}`
      );

    }


    if (
      Array.isArray(
        override.disabledAssets
      ) &&
      override.disabledAssets.length
    ) {

      state.disabledAssets =
        override.disabledAssets.map(
          a =>
            a.toUpperCase()
        );


      console.log(
        `[Clock] Disabled assets: ${state.disabledAssets.join(', ')}`
      );
    }

  } catch (err) {

    console.log(
      '[Clock] No sim override found.'
    );

  }


  // ==========================================================
  // LOAD BRAINS
  // ==========================================================

  console.log(
    '[Clock] Loading brains...'
  );


  state.BTC.brain =
    await loadBrain(
      'BTC'
    );


  state.ETH.brain =
    await loadBrain(
      'ETH'
    );


  // ==========================================================
  // LIVE ACCOUNT CLEANUP
  // ==========================================================
  //
  // Never run this in SIM.
  // ==========================================================

  if (
    !state.simMode
  ) {

    try {

      const positions =
        await getPositions();


      for (
        const p of positions
      ) {

        const fp =
          parseFloat(
            p.position_fp
          );


        if (
          fp ===
          0
        ) {
          continue;
        }


        const side =
          fp <
          0
            ? 'no'
            : 'yes';


        const count =
          Math.abs(
            fp
          );


        console.log(
          `[Clock] Closing orphaned ${side.toUpperCase()} position (${fp}) in ${p.ticker}`
        );


        try {

          await executeSell(
            p.ticker,
            side,
            count
          );

        } catch (err) {

          console.warn(
            `[Clock] Could not close orphan: ${err.message}`
          );

        }
      }

    } catch (err) {

      console.warn(
        `[Clock] Position check failed: ${err.message}`
      );

    }
  }


  // ==========================================================
  // INITIAL BALANCE
  // ==========================================================

  if (
    state.simMode
  ) {

    state.balance =
      state.paperBalance;

  } else {

    try {

      state.balance =
        (
          await getBalance()
        ) /
        100;


      _lastBalanceFetch =
        Date.now();

    } catch (err) {

      console.warn(
        `[Clock] Initial balance failed: ${err.message}`
      );

    }
  }


  const bal =
    state.balance ??
    state.paperBalance ??
    5;


  startSession(
    state.BTC,
    bal
  );

  startSession(
    state.ETH,
    bal
  );

  startDay(
    state.BTC,
    bal
  );

  startDay(
    state.ETH,
    bal
  );


  // ==========================================================
  // CONNECT TO MARKETS
  // ==========================================================

  console.log(
    '[Clock] Connecting to Kalshi markets...'
  );


  for (
    const asset of [
      'BTC',
      'ETH',
    ]
  ) {

    /**
     * Skip completely disabled assets.
     */
    if (
      state.disabledAssets.includes(
        asset
      )
    ) {

      console.log(
        `[Clock] ${asset} disabled — skipping market connection`
      );

      continue;
    }


    try {

      const market =
        await findActiveMarket(
          asset
        );


      state[
        asset
      ].ticker =
        market.ticker;


      state[
        asset
      ].windowId =
        windowId();


      state[
        asset
      ].windowOpenPrice =
        priceFeed.getPrice(
          asset
        );


      if (
        state.simMode
      ) {

        console.log(
          `[Clock] ${asset} SIM → ${market.ticker}`
        );


        await refreshPublicMarket(
          asset
        );

      } else {

        kalshiWS[
          asset
        ].connect(
          market.ticker
        );


        console.log(
          `[Clock] ${asset} LIVE → ${market.ticker}`
        );

      }

    } catch (err) {

      console.error(
        `[Clock] Init ${asset}: ${err.message}`
      );

    }
  }


  // ==========================================================
  // FINAL BALANCE MESSAGE
  // ==========================================================

  if (
    state.simMode
  ) {

    console.log(
      `[Clock] Paper Balance: $${state.balance.toFixed(2)}`
    );

  } else {

    try {

      state.balance =
        (
          await getBalance()
        ) /
        100;


      _lastBalanceFetch =
        Date.now();


      console.log(
        `[Clock] Balance: $${state.balance.toFixed(2)}`
      );

    } catch {}
  }


  // ==========================================================
  // RESTORE BOT STATE
  // ==========================================================

  loadBotState();
  
  // Railway-specific bot mode.
  // Lets multiple Railway services use the same GitHub repo
  // while running different strategies.
  const botMode = (process.env.BOT_MODE || '').toUpperCase();
  
  if (botMode === 'FARM') {
    state.BTC.farmArmed = true;
    state.BTC.autoBuyArmed = false;
    
    console.log('[Bot] BTC FARM forced ON by BOT_MODE');
  }
  
  if (botMode === 'AUTO') {
    state.BTC.autoBuyArmed = true;
    state.BTC.farmArmed = false;
    
    console.log('[Bot] BTC AUTO_BUY forced ON by BOT_MODE');
  }


  // ==========================================================
  // HEARTBEAT
  // ==========================================================

  setInterval(
    () => {

      tick().catch(
        err =>
          console.error(
            '[Clock] tick error:',
            err.message
          )
      );


      writeStateSnapshot();

    },

    1000
  );


  console.log(
    '[Clock] Running.'
  );
      }
