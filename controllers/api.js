import { Invo, Lock, Paym, Totp, User, Wallet } from '../class/';
import { WalletMS } from '../class/external/WalletMS';
import { Exchange } from '../class/external/Exchange';
import Frisbee from 'frisbee';

const lnurl = require('lnurl');
const config = require('../config');
let express = require('express');
let router = express.Router();
let logger = require('../utils/logger');
const MIN_BTC_BLOCK = 670000;
/*if (process.env.NODE_ENV !== 'prod') {
  console.log('using config', JSON.stringify(config));
}*/

var Redis = require('ioredis');
var redis = new Redis(config.redis);
redis.monitor(function (err, monitor) {
  monitor.on('monitor', function (time, args, source, database) {
    // console.log('REDIS', JSON.stringify(args));
  });
});

const EXCHANGE = new Exchange(redis);

/****** START SET FEES FROM CONFIG AT STARTUP ******/
/** GLOBALS */
global.forwardFee = config.forwardReserveFee || 0.01;
global.internalFee = config.intraHubFee || 0;
/****** END SET FEES FROM CONFIG AT STARTUP ******/

let bitcoinclient = require('../bitcoin');
let lightning = require('../lightning');
let identity_pubkey = false;
// ###################### SMOKE TESTS ########################

if (config.bitcoind) {
  bitcoinclient.request('getblockchaininfo', false, function (err, info) {
    if (info && info.result && info.result.blocks) {
      if (info.result.chain === 'mainnet' && info.result.blocks < MIN_BTC_BLOCK && !config.forceStart) {
        console.error('bitcoind is not caught up');
        process.exit(1);
      }
      console.log('bitcoind getblockchaininfo:', info);
    } else {
      console.error('bitcoind failure:', err, info);
      process.exit(2);
    }
  });
}

lightning.getInfo({}, function (err, info) {
  if (err) {
    console.error('lnd failure');
    console.dir(err);
    process.exit(3);
  }
  if (info) {
    //console.info('lnd getinfo:', info);
    if (!info.synced_to_chain && !config.forceStart) {
      console.error('lnd not synced');
      // process.exit(4);
    }
    identity_pubkey = info.identity_pubkey;
  }
});

redis.info(function (err, info) {
  if (err || !info) {
    console.error('redis failure');
    process.exit(5);
  }
});

// ######################## PAY INVOICE - CALLBACK  ########################

const InvoicesStreamCallback = async function (response) {
  if (response.state !== 'SETTLED') {
    logger.log('api.InvoicesStreamCallback', [JSON.stringify(response)]);
    return;
  }

  const LightningInvoiceSettledNotification = {
    memo: response.memo,
    preimage: response.r_preimage.toString('hex'),
    hash: response.r_hash.toString('hex'),
    amt_paid_sat: response.amt_paid_msat ? Math.floor(response.amt_paid_msat / 1000) : response.amt_paid_sat,
  };
  // obtaining a lock, to make sure we push to groundcontrol only once
  // since this web server can have several instances running, and each will get the same callback from LND
  // and dont release the lock - it will autoexpire in a while
  let lock = new Lock(redis, 'groundcontrol_hash_' + LightningInvoiceSettledNotification.hash);
  if (!(await lock.obtainLock())) {
    return;
  }
  let invoice = new Invo(redis, bitcoinclient, lightning);
  await invoice._setIsPaymentHashPaidInDatabase(
    LightningInvoiceSettledNotification.hash,
    LightningInvoiceSettledNotification.amt_paid_sat || 1,
  );
  const user = new User(redis, bitcoinclient, lightning);
  user._userid = await user.getUseridByPaymentHash(LightningInvoiceSettledNotification.hash);
  await user.clearBalanceCache();
  logger.log('api.InvoicesStreamCallback', [user._userid, LightningInvoiceSettledNotification.hash, JSON.stringify(response)]);

  if (!response.type) {
    //Lightningchat
    await redis.rpush(
      'v2_invoice_paid_for_bot',
      JSON.stringify({
        user_id: user._userid,
        total_amount: LightningInvoiceSettledNotification.amt_paid_sat,
        time: Math.trunc(new Date().getTime() / 1000),
      }),
    );
    //end lightningchat
  } else if (response.type === 'bill_pay') {
    let message = {
      user_id: user._userid,
      total_amount: LightningInvoiceSettledNotification.amt_paid_sat,
      time: Math.trunc(new Date().getTime() / 1000),
      payer: response.payer,
      payee: response.payee,
      type: response.type,
      bill_amount: response.bill.amount,
      bill_currency: response.bill.currency,
    };

    await redis.rpush('v2_invoice_paid_for_bot', JSON.stringify(message));
  }

  const baseURI = process.env.GROUNDCONTROL;
  if (!baseURI) return;
  const _api = new Frisbee({ baseURI: baseURI });
  const apiResponse = await _api.post(
    '/lightningInvoiceGotSettled',
    Object.assign(
      {},
      {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
        body: LightningInvoiceSettledNotification,
      },
    ),
  );
  console.log('GroundControl:', apiResponse.originalResponse.status);
};

// ###### Subscribe to invoices stream ########
var invoicesStream;

async function invoicesStreamInit() {
  logger.log('api.invoicesStreamInit', ['Opening stream']);

  let invoicesStream2 = lightning.subscribeInvoices({});
  invoicesStream2.on('data', InvoicesStreamCallback);
  invoicesStream2.on('end', invoicesStreamInit);
  invoicesStream = invoicesStream2;
}

invoicesStreamInit();

// ######################## PAY INVOICE - SEND PAYMENT  ########################

const processPaymentCallback = async function (payment) {
  if (!payment) {
    console.error('Payment is not defined...');
    return;
  }
  try {
    let paymentHash = payment.payment_hash.toString('hex');

    let payInformationString = await redis.get(paymentHash);
    let payInformation = JSON.parse(payInformationString);
    let seconds = Math.round((new Date() - new Date(payInformation.date)) / 1000);

    logger.log('api.processPaymentCallback', [paymentHash, 'Seconds:', seconds]);
    logger.log('api.processPaymentCallback', [paymentHash, 'Saved pay information:', payInformationString]);
    logger.log('api.processPaymentCallback', [paymentHash, 'Received pay information', JSON.stringify(payment)]);

    let u = new User(redis, bitcoinclient, lightning);
    if (!(await u.loadByAuthorization(payInformation.user))) {
      logger.error('Error loading user... ' + payInformation.users, [paymentHash]);
      return;
    }

    await u.unlockFunds(payInformation.invoice);

    if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
      let PaymentShallow = new Paym(false, false, false);
      payment = PaymentShallow.processSendPaymentResponse(payment);
      payment.pay_req = payInformation.invoice;
      payment.decoded = payInformation.payment_request;
      await u.savePaidLndInvoice(payment);
      await u.clearBalanceCache();
      await redis.del(payment.payment_hash);

      let notification = {
        error: false,
        internal_invoice: false,
        type: 'user_paid_invoice',
        payment_hash: paymentHash,
        user_id: u.getUserId(),
        total_amount: +payment.payment_route.total_amt,
        total_fees: payment.payment_route.total_fees,
        time: Math.trunc(new Date().getTime() / 1000),
      };
      publishPaymentV2(notification);
      logger.log('api.processPaymentCallback', [paymentHash, 'notification', JSON.stringify(notification)]);
      logger.log('api.processPaymentCallback', [paymentHash, 'Payment successful']);
    } else {
      // payment failed
      await redis.del(paymentHash);
      let notification = {
        error: true,
        error_code: retrieveErrorCode(payment),
        error_message: payment.payment_error,
        payment_hash: paymentHash,
        user_id: u.getUserId(),
        time: Math.trunc(new Date().getTime() / 1000),
      };
      publishPaymentV2(notification);
      logger.log('api.processPaymentCallback', [paymentHash, 'notification', JSON.stringify(notification)]);
      logger.error('api.processPaymentCallback', [paymentHash, 'Payment Failed: ' + payment.payment_error]);
    }
  } catch (Error) {
    logger.error('General error with callback payment invoice V2 ', [JSON.stringify(Error), JSON.stringify(payment)]);
  }
};

const callPaymentInvoiceInternal = async function (response) {
  if (response.state === 'SETTLED') {
    const LightningInvoiceSettledNotification = {
      memo: response.memo,
      preimage: response.r_preimage.toString('hex'),
      hash: response.r_hash.toString('hex'),
      amt_paid_sat: response.amt_paid_msat ? Math.floor(response.amt_paid_msat / 1000) : response.amt_paid_sat,
    };
    // obtaining a lock, to make sure we push to groundcontrol only once
    // since this web server can have several instances running, and each will get the same callback from LND
    // and dont release the lock - it will autoexpire in a while
    let lock = new Lock(redis, 'groundcontrol_hash_' + LightningInvoiceSettledNotification.hash);
    if (!(await lock.obtainLock())) {
      return;
    }
    let invoice = new Invo(redis, bitcoinclient, lightning);
    await invoice._setIsPaymentHashPaidInDatabase(
      LightningInvoiceSettledNotification.hash,
      LightningInvoiceSettledNotification.amt_paid_sat || 1,
    );
    const user = new User(redis, bitcoinclient, lightning);
    user._userid = await user.getUseridByPaymentHash(LightningInvoiceSettledNotification.hash);
    await user.clearBalanceCache();
    logger.log('api.callPaymentInvoiceInternal', [user._userid, LightningInvoiceSettledNotification.hash]);

    if (!response.type) {
      let notification = {
        error: false,
        payment_hash: LightningInvoiceSettledNotification.hash,
        user_id: user._userid,
        total_amount: LightningInvoiceSettledNotification.amt_paid_sat,
        time: Math.trunc(new Date().getTime() / 1000),
      };
      publishPaymentV2(notification);
      logger.log('api.callPaymentInvoiceInternal', [
        LightningInvoiceSettledNotification.hash,
        'notification',
        JSON.stringify(notification),
      ]);

      notification = {
        error: false,
        internal_invoice: true,
        type: 'user_paid_invoice',
        payment_hash: LightningInvoiceSettledNotification.hash,
        user_id: response.user,
        total_amount: LightningInvoiceSettledNotification.amt_paid_sat,
        total_fees: response.fee,
        time: Math.trunc(new Date().getTime() / 1000),
      };
      publishPaymentV2(notification);
      logger.log('api.callPaymentInvoiceInternal', [
        LightningInvoiceSettledNotification.hash,
        'notification',
        JSON.stringify(notification),
      ]);
    } else if (response.type === 'bill_pay') {
      let notification = {
        error: false,
        payment_hash: LightningInvoiceSettledNotification.hash,
        user_id: user._userid,
        total_amount: LightningInvoiceSettledNotification.amt_paid_sat,
        time: Math.trunc(new Date().getTime() / 1000),
        type: response.type,
        payer: response.payer,
      };
      publishPaymentV2(notification);
    }

    const baseURI = process.env.GROUNDCONTROL;
    if (!baseURI) return;
    const _api = new Frisbee({ baseURI: baseURI });
    const apiResponse = await _api.post(
      '/lightningInvoiceGotSettled',
      Object.assign(
        {},
        {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
          },
          body: LightningInvoiceSettledNotification,
        },
      ),
    );
    console.log('GroundControl:', apiResponse.originalResponse.status);
  } else {
    let notification = {
      error: true,
      error_code: PaymentInvoiceError.ALREADY_PAYMENT,
      error_message: response.message,
      payment_hash: response.payment_hash,
      user_id: response.user,
      total_amount: response.amt_paid_sat,
      time: Math.trunc(new Date().getTime() / 1000),
    };
    publishPaymentV2(notification);
  }
};

function retrieveErrorCode(payment) {
  if (payment.payment_error && payment.payment_error.indexOf('already paid') !== -1) {
    return PaymentInvoiceError.ALREADY_PAYMENT;
  } else if (payment.payment_error && payment.payment_error.indexOf('unable to') !== -1) {
    return PaymentInvoiceError.UNABLE_TO;
  } else if (payment.payment_error && payment.payment_error.indexOf('FinalExpiryTooSoon') !== -1) {
    return PaymentInvoiceError.FINAL_EXPIRY_TOO_SOON;
  } else if (payment.payment_error && payment.payment_error.indexOf('UnknownPaymentHash') !== -1) {
    return PaymentInvoiceError.UNKOWN_PAYMENT_HASH;
  } else if (payment.payment_error && payment.payment_error.indexOf('IncorrectOrUnknownPaymentDetails') !== -1) {
    return PaymentInvoiceError.INCORRECT_PAYMENT_DETAILS;
  } else if (payment.payment_error && payment.payment_error.indexOf('timeout') !== -1) {
    return PaymentInvoiceError.TIMEOUT;
  } else if (payment.payment_error && payment.payment_error.indexOf('no_route') !== -1) {
    return PaymentInvoiceError.NO_ROUTE;
  } else if (payment.payment_error && payment.payment_error.indexOf('payment is in transition') !== -1) {
    return PaymentInvoiceError.PAYMENT_IS_IN_TRANSACTION;
  }

  return PaymentInvoiceError.UNKOWN;
}

function publishPaymentV2(paymentNotification) {
  return redis.rpush('v2_invoice_paid_for_bot', JSON.stringify(paymentNotification));
}

// ###### Subscribe to payments stream ########
var paymentStream;

async function paymentStreamInit() {
  logger.log('api.paymentStreamInit', ['Opening stream']);
  paymentStream = lightning.sendPayment({});
  paymentStream.on('data', processPaymentCallback);
  paymentStream.on('end', paymentStreamInit);
}

paymentStreamInit();

const PaymentInvoiceError = {
  ALREADY_PAYMENT: 1,
  UNABLE_TO: 2,
  FINAL_EXPIRY_TOO_SOON: 3,
  UNKOWN_PAYMENT_HASH: 4,
  INCORRECT_PAYMENT_DETAILS: 5,
  PAYMENT_IS_IN_TRANSACTION: 6,
  TIMEOUT: 7,
  NO_ROUTE: 8,
  UNKOWN: -1,
};

// ######################## DESCRIBE GRAPH  ########################

let lightningDescribeGraph = {};

function updateDescribeGraph() {
  console.log('updateDescribeGraph()');
  lightning.describeGraph({ include_unannounced: true }, function (err, response) {
    if (!err) lightningDescribeGraph = response;
    console.log('updated graph');
  });
}

if (config.enableUpdateDescribeGraph) {
  updateDescribeGraph();
  setInterval(updateDescribeGraph, 120000);
}

// ######################## ROUTES ########################

const rateLimit = require('express-rate-limit');
const postLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: config.postRateLimit || 100,
});

router.post('/estimatefee', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/estimatefee', [req.id, u.getUserId()]);

  if (!req.body.amount || /*stupid NaN*/ !(req.body.amount > 0)) return errorBadArguments(res);
  if (!req.body.address) return errorBadArguments(res);

  let amount = req.body.amount;
  let address = req.body.address;

  try {
    let map = new Map();
    map[address] = amount;

    let request = { AddrToAmount: map, target_conf: 3 };
    console.log('Request' + JSON.stringify(request));
    lightning.estimateFee(request, async function (err, info) {
      if (err) {
        console.error(err);
        return errorLndEstimateFee(res, 'Code: ' + err.code + '... Message: ' + err.details);
      }

      res.send({
        fee_sat: info.fee_sat,
        feerate_sat_per_byte: info.feerate_sat_per_byte,
      });
    });
  } catch (Error) {
    logger.log('', [req.id, 'Error getting estimate fee:', Error.message]);
    return errorSendCoins(res, Error);
  }
});

router.post('/bill', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/bill (post)', [req.id, u.getUserId()]);

  if (!req.body.amount || /*stupid NaN*/ !(req.body.amount > 0)) return errorBadArguments(res);

  let amount = req.body.amount;
  let currency = req.body.currency;
  if (!req.body.currency) currency = 'SATS';

  let amountInSats = await EXCHANGE.convertAmountToSatoshis(amount, currency);

  logger.log('User.createBill', [req.id, u.getUserId(), amount, currency, amountInSats]);
  let lock = new Lock(redis, 'creating_bill_for' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return errorLockUser(res);
  }

  try {
    let userBalance;
    try {
      await u.clearBalanceCache();
      userBalance = await u.getCalculatedBalance();
    } catch (Error) {
      logger.log('User.createBill', [req.id, 'error running getCalculatedBalance():', Error.message]);
      await lock.releaseLock();
      return errorTryAgainLater(res);
    }
    logger.log('User.createBill', [req.id, 'Balance: ' + userBalance]);

    // Check balance
    console.log('userBalance::' + userBalance + '-' + 'amountInSats:: ' + amountInSats + 'fee::' + Math.ceil(amountInSats * forwardFee));
    if (!(userBalance >= +amountInSats + Math.ceil(amountInSats * internalFee))) {
      await lock.releaseLock();
      return errorNotEnougBalance(res);
    }

    let bill = await u.createBill(req.id, amount, currency, amountInSats);
    await lock.releaseLock();
    return res.send({ bill: bill, bill_request: bill.token });
  } catch (Error) {
    logger.log('', [req.id, 'error creating bill:', Error.message]);
    await lock.releaseLock();
    return errorSendCoins(res, Error);
  }
});

router.get('/wallet/stablecoin/limits', postLimiter, async function (req, res) {
  let amountInSatsMinSwap = await EXCHANGE.convertAmountToSatoshis(config.swap.min_swap_value, config.swap.min_swap_currency);
  res.send({
    min_swap_sats: amountInSatsMinSwap,
    min_swap_value: config.swap.min_swap_value,
    min_swap_currency: config.swap.min_swap_currency,
  });
});

router.post('/wallet/stablecoin/load', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  if (!req.body.amount || /*stupid NaN*/ !(req.body.amount > 0)) return errorBadArguments(res);

  let lock = new Lock(redis, 'load_stablecoin' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return;
  }

  logger.log('/wallet/stablecoin/load (post)', [req.id, u.getUserId()]);
  let amount = req.body.amount;
  let currency = req.body.currency;
  if (!currency) currency = 'SATS';

  try {
    let amountInSats = await EXCHANGE.convertAmountToSatoshis(amount, currency);
    amountInSats = Math.round(amountInSats);
    let fee = Math.floor(0); //TODO: calculate fee;

    let amountInSatsMinSwap = await EXCHANGE.convertAmountToSatoshis(config.swap.min_swap_value, config.swap.min_swap_currency);
    if (amountInSats < amountInSatsMinSwap) {
      await lock.releaseLock();
      return errorSwapTooSmall(res, amountInSatsMinSwap);
    }

    let userBalance = await u.getBalance();

    if (!(userBalance >= amountInSats + fee)) {
      await lock.releaseLock();
      return errorNotEnougBalance(res);
    }

    let wallet = new Wallet(u.getUserId(), Currency.USDC, redis);
    await wallet.loadAccount();
    let walletTransaction = await wallet.loadBalanceAmountToWallet(amountInSats, req.id);

    await u.saveSwapTx({
      timestamp: parseInt(+new Date() / 1000),
      type: 'stablecoin',
      amount: -(amountInSats + fee),
      fee: fee,
      txid: walletTransaction.id,
      description: 'Swap to USDC: ' + amountInSats + ' SATS',
    });

    await u.clearBalanceCache();
    await lock.releaseLock();
    res.send({
      type: 'load',
      txid: walletTransaction.id,
      timestamp: parseInt(+new Date() / 1000),
      exchange_amount: amountInSats + fee,
      fee: fee,
      input: {
        amount: amount,
        currency: currency,
      },
      output: {
        amount: walletTransaction.amount,
        currency: await wallet.getCurrency(),
      },
    });
  } catch (Error) {
    await lock.releaseLock();

    let code = Error.code || 0;
    if(code == 500){
      return errorBalanceUpperLimit(res, Error)
    }else {
      logger.error('', [req.id, 'error loading stablecoin:', Error.message]);
      return errorLoadStableCoins(res, Error);
    }
  }
});

router.post('/wallet/stablecoin/unload', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  if (!req.body.amount || /*stupid NaN*/ !(req.body.amount > 0)) return errorBadArguments(res);

  let lock = new Lock(redis, 'unload_stablecoin' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return;
  }

  logger.log('/wallet/stablecoin/unload (post)', [req.id, u.getUserId()]);

  let amount = req.body.amount;
  let currency = req.body.currency;
  if (!currency) currency = 'SATS';

  try {
    let amountInSats = await EXCHANGE.convertAmountToSatoshis(amount, currency);
    amountInSats = Math.round(amountInSats);

    let amountInSatsMinSwap = await EXCHANGE.convertAmountToSatoshis(config.swap.min_swap_value, config.swap.min_swap_currency);
    if (amountInSats < amountInSatsMinSwap) {
      await lock.releaseLock();
      return errorSwapTooSmall(res, amountInSatsMinSwap);
    }

    let wallet = new Wallet(u.getUserId(), Currency.USDC, redis);
    await wallet.loadAccount();
    let walletBalanceSats = await wallet.getBalanceInSats();

    if (!(walletBalanceSats >= amountInSats)) {
      await lock.releaseLock();
      return errorNotEnougBalance(res);
    }

    let walletTransaction = await wallet.loadStableCoinToBalance(amountInSats, req.id);
    let fee = Math.floor(0); //TODO: calculate fee: walletTransaction.fee

    await u.saveSwapTx({
      timestamp: parseInt(+new Date() / 1000),
      type: 'stablecoin',
      amount: walletTransaction.amountSats - fee,
      fee: fee,
      txid: walletTransaction.id,
      description: 'Swap from USDC: ' + walletTransaction.amountSats + ' SATS',
    });

    await lock.releaseLock();
    res.send({
      type: 'unload',
      txid: walletTransaction.id,
      timestamp: parseInt(+new Date() / 1000),
      exchange_amount: walletTransaction.amount,
      fee: fee,
      input: {
        amount: amount,
        currency: currency,
      },
      output: {
        amount: walletTransaction.amountSats - fee,
        currency: 'SATS',
      },
    });
  } catch (Error) {
    await lock.releaseLock();
    logger.error('', [req.id, 'error unloading stablecoin:', Error]);
    return errorUnloadStableCoins(res, Error);
  }
});

async function checkMasterAccount() {
  logger.log('Checking master account in WalletMS::' + config.wallet.masterAccount + '-' + config.wallet.masterAccountCurrency, [
    'Initial configuration',
  ]);
  let walletMS = new WalletMS(redis);
  let walletId = await walletMS._getWalletIdString(config.wallet.masterAccount);
  if (!walletId) {
    logger.log('Creating master account in WalletMS::' + config.wallet.masterAccount + '-' + config.wallet.masterAccountCurrency, [
      'Initial configuration',
    ]);

    await walletMS.createAccount(config.wallet.masterAccount);
    let walletIdCreate = await walletMS._getWalletId(config.wallet.masterAccount);
    logger.log('Saving walletId for Master Account: ' + String(walletIdCreate), ['Initial configuration']);
    redis.set('wallet_account_' + config.wallet.masterAccount, String(walletIdCreate));
  } else {
    logger.log('Already account exists:: ID: ' + walletId + '. wallet_account_' + config.wallet.masterAccount, ['Initial configuration']);
  }
}

async function updateConvertRatios() {
  let currencies = config.currencyConvert.currencies;
  //console.log('api.updateConvertRatios:' + JSON.stringify(currencies));
  for (var i = 0; i < currencies.length; i++) {
    let currency = currencies[i];
    //console.log('updating currency:' + currency);

    try {
      let url = config.currencyConvert.url + currency;
      const apiResponse = await new Frisbee().get(url); //{"BTC_USD":19474.1778}
      if (!apiResponse || !apiResponse.body) {
        logger.error('api.updateConvertRatios', ['error updating currency ' + currency + ': bad response from server']);
        break;
      }
      let ratio = apiResponse.body['BTC_' + currency];
      if (!ratio || ratio.length < 1) {
        logger.error('api.updateConvertRatios', ['Empty ratio' + currency]);
        continue;
      }
      //console.log('updating currency ratio:' + currency + '=' + ratio);

      let key = 'convert_ratio_BTC_' + currency;
      await redis.set(key, ratio);

      let urlToBtc = config.currencyConvert.urlCurrencyToBtc.replace('{currency}', currency);
      const apiResponseInvert = await new Frisbee().get(urlToBtc); //{"USD_BTC":0.000050267979}
      let ratioInvert = apiResponseInvert.body[currency + '_BTC'];

      let keyInvert = 'convert_ratio_' + currency + '_BTC';
      await redis.set(keyInvert, ratioInvert);

      if (currency === 'USD') {
        currency = 'USDC';
        let key = 'convert_ratio_BTC_' + currency;
        let keyInvert = 'convert_ratio_' + currency + '_BTC';
        await redis.set(key, ratio);
        await redis.set(keyInvert, ratioInvert);
      }
    } catch (Error) {
      logger.error('api.updateConvertRatios', ['error updating currency ' + currency + ':', Error.message]);
    }
  }
  //console.log('updateConvertRatios: END');
}

checkMasterAccount();
updateConvertRatios();
setInterval(updateConvertRatios, config.currencyConvert.updateIntervalMillis);

router.get('/convertToCurrency', async function (req, res) {
  if (!req.query.amount) return errorBadArguments(res);
  if (!req.query.from) return errorBadArguments(res);
  if (!req.query.to) return errorBadArguments(res);

  let amount = 0 + req.query.amount;
  amount = await EXCHANGE.convertToCurrency(amount, req.query.from, req.query.to);
  let response = {
    amount: amount,
    currency: req.query.to,
  };
  return res.send(response);
});

router.get('/bill', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);

  if (!req.query.token) return errorBadArguments(res);

  let token = req.query.token;
  let bill = await u.getBill(token);
  if (!bill) {
    return billNotFound(res);
  }

  let currency = bill.currency;
  if (!currency) currency = 'SATS';

  let amount = await EXCHANGE.convertAmountToSatoshis(bill.amount, currency);
  amount = Math.round(amount);

  let withDrawRequest = {
    minWithdrawable: amount,
    maxWithdrawable: amount,
    defaultDescription: 'lnurl-toolbox: withdrawRequest',
    callback: config.callbackHost + config.billProcessUrl,
    k1: token,
    tag: 'withdrawRequest',
    bill_amount: bill.amount,
    bill_currency: currency,
  };

  return res.send(withDrawRequest);
});

router.get('/bill/process', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);

  if (!req.query.k1) return errorBadArguments(res);
  if (!req.query.pr) return errorBadArguments(res);

  let token = req.query.k1;
  let paymentRequest = req.query.pr;
  let bill = await u.getBill(token);
  if (!bill) {
    return errorBadAuth(res);
  }

  await u.loadByAuthorization(bill.created_by);

  if (!u.getUserId()) {
    return errorBadAuth(res);
  }

  //logger.log('/bill/process', [req.id, "Parameters are valid"]);
  /////////////////////////// TODO: REFACTOR, SAME CODE IN /PAYINVOICE

  if (!paymentRequest) return errorBadArguments(res);
  let freeAmount = false;
  if (req.body.amount) {
    freeAmount = parseInt(req.body.amount);
    if (freeAmount <= 0) return errorBadArguments(res);
  }

  // obtaining a lock
  let lock = new Lock(redis, 'invoice_paying_for_' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return errorLockUser(res);
  }

  let userBalance;
  try {
    userBalance = await u.getCalculatedBalance();
  } catch (Error) {
    logger.log('', [req.id, 'error running getCalculatedBalance():', Error.message]);
    lock.releaseLock();
    return errorTryAgainLater(res);
  }

  lightning.decodePayReq({ pay_req: paymentRequest }, async function (err, info) {
    if (err) {
      await lock.releaseLock();
      return errorNotAValidInvoice(res);
    }

    if (+info.num_satoshis === 0) {
      // 'tip' invoices
      info.num_satoshis = freeAmount;
    }

    if (userBalance >= +info.num_satoshis + Math.ceil(info.num_satoshis * internalFee)) {
      // got enough balance, including 1% of payment amount - reserve for fees

      if (identity_pubkey === info.destination) {
        // this is internal invoice
        // now, receiver add balance
        let userid_payee = await u.getUseridByPaymentHash(info.payment_hash);
        if (!userid_payee) {
          await lock.releaseLock();
          return errorGeneralServerError(res);
        }

        if (await u.getPaymentHashPaid(info.payment_hash)) {
          // this internal invoice was paid, no sense paying it again
          await lock.releaseLock();
          return errorLnd(res);
        }

        let UserPayee = new User(redis, bitcoinclient, lightning);
        UserPayee._userid = userid_payee; // hacky, fixme
        await UserPayee.clearBalanceCache();

        // sender spent his balance:
        await u.clearBalanceCache();
        await u.savePaidLndInvoice({
          timestamp: parseInt(+new Date() / 1000),
          type: 'paid_invoice',
          value: +info.num_satoshis + Math.ceil(info.num_satoshis * internalFee),
          fee: Math.ceil(info.num_satoshis * internalFee),
          memo: decodeURIComponent(info.description),
          pay_req: paymentRequest,
          payee: userid_payee,
          payer: u.getUserId(),
        });

        const invoice = new Invo(redis, bitcoinclient, lightning);
        invoice.setInvoice(paymentRequest);
        await invoice.markAsPaidInDatabase();

        // now, faking LND callback about invoice paid:
        const preimage = await invoice.getPreimage();
        if (preimage) {
          InvoicesStreamCallback({
            state: 'SETTLED',
            memo: info.description,
            r_preimage: Buffer.from(preimage, 'hex'),
            r_hash: Buffer.from(info.payment_hash, 'hex'),
            amt_paid_sat: +info.num_satoshis,
            type: 'bill_pay',
            payer: u.getUserId(),
            payee: userid_payee,
            bill: bill,
          });
        }
        await lock.releaseLock();
        logger.log('api.bill.process', [req.id, 'Payment successful', JSON.stringify(info)]);
        u.deleteBill(token);
        return res.send({ status: 'OK' });
      }

      // else - regular lightning network payment:

      var call = lightning.sendPayment();
      call.on('data', async function (payment) {
        // payment callback
        await u.unlockFunds(paymentRequest);
        if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
          let PaymentShallow = new Paym(false, false, false);
          payment = PaymentShallow.processSendPaymentResponse(payment);
          payment.pay_req = paymentRequest;
          payment.decoded = info;
          await u.savePaidLndInvoice(payment);
          await u.clearBalanceCache();
          lock.releaseLock();
          logger.log('api.bill.process', [req.id, 'Payment successful', JSON.stringify(info)]);

          u.deleteBill(token);
          return res.send({ status: 'OK' });
        } else {
          // payment failed
          lock.releaseLock();
          return errorPaymentFailed(res);
        }
      });
      if (!info.num_satoshis) {
        // tip invoice, but someone forgot to specify amount
        await lock.releaseLock();
        return errorBadArguments(res);
      }
      let inv = {
        payment_request: paymentRequest,
        amt: info.num_satoshis, // amt is used only for 'tip' invoices
        fee_limit: { fixed: Math.ceil(info.num_satoshis * forwardFee) },
      };
      try {
        await u.lockFunds(paymentRequest, info);
        call.write(inv);
      } catch (Err) {
        await lock.releaseLock();
        return errorPaymentFailed(res);
      }
    } else {
      await lock.releaseLock();
      return errorNotEnougBalance(res);
    }
  });
  /////////////////////////// END TODO: REFACTOR, SAME CODE IN /PAYINVOICE
});

router.get('/bech32/decode', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);

  if (!u.getUserId()) {
    return errorBadAuth(res);
  }
  logger.log('/bech32/decode', [req.id, u.getUserId()]);

  if (!req.query.value) return errorBadArguments(res);
  let token = req.query.value;

  try {
    const decode = lnurl.decode(token);
    res.send({ decode: decode });
  } catch (Error) {
    logger.error('/bech32/decode', [req.id, token, 'Error decoding bill bech32:', Error.message]);
    return errorSendCoins(res, Error);
  }
});

router.post('/sendcoins', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/sendcoins', [req.id, u.getUserId()]);

  if (!req.body.amount || /*stupid NaN*/ !(req.body.amount > 0)) return errorBadArguments(res);
  if (!req.body.address) return errorBadArguments(res);

  let amount = req.body.amount;
  let address = req.body.address;

  try {
    let matchAddressLocal = await u.matchAddressWithLocalInformation(address);
    if (matchAddressLocal) {
      return errorSendCoinsMatchLocalAddress(res, '');
    }

    let map = new Map();
    map[address] = amount;

    let request = { AddrToAmount: map, target_conf: 3 };
    lightning.estimateFee(request, async function (err, info) {
      if (err) {
        console.error(err);
        return errorLndEstimateFee(res, 'Code: ' + err.code + '... Message: ' + err.details);
      }

      let txid = await u.sendCoins(req.id, amount, address, parseInt(info.fee_sat));
      res.send({ txid: txid });
    });
  } catch (Error) {
    logger.error('/sendcoins', [req.id, u.getUserId(), 'error executing sendcoins:', Error.message]);
    return errorSendCoins(res, Error);
  }
});

router.post('/create', postLimiter, async function (req, res) {
  logger.log('/create', [req.id]);

  if (!req.body.userid) {
    return errorBadArguments(res);
  }

  // Valid if the partnerid isn't there or is a string (same with accounttype)
  if (
    !(
      (!req.body.partnerid || typeof req.body.partnerid === 'string' || req.body.partnerid instanceof String) &&
      (!req.body.accounttype || typeof req.body.accounttype === 'string' || req.body.accounttype instanceof String) &&
      (!req.body.userid || typeof req.body.userid === 'string' || req.body.userid instanceof String)
    )
  )
    return errorBadArguments(res);

  if (config.sunset) return errorSunset(res);

  let u = new User(redis, bitcoinclient, lightning);
  await u.create(req.body.userid);
  await u.saveMetadata({
    partnerid: req.body.partnerid,
    accounttype: req.body.accounttype,
    created_at: new Date().toISOString(),
  });
  res.send({ login: u.getLogin(), password: u.getPassword() });
});

router.post('/auth', postLimiter, async function (req, res) {
  logger.log('/auth', [req.id]);
  if (!((req.body.login && req.body.password) || req.body.refresh_token)) return errorBadArguments(res);

  let u = new User(redis, bitcoinclient, lightning);

  if (req.body.refresh_token) {
    // need to refresh token
    if (await u.loadByRefreshToken(req.body.refresh_token)) {
      res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    } else {
      return errorBadAuth(res);
    }
  } else {
    // need to authorize user
    let result = await u.loadByLoginAndPassword(req.body.login, req.body.password);
    if (result) res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    else errorBadAuth(res);
  }
});

router.post('/addinvoice', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/addinvoice', [req.id, u.getUserId()]);

  if (!req.body.amt || /*stupid NaN*/ !(req.body.amt > 0)) return errorBadArguments(res);

  let currency = Currency.SATS;
  if (req.body.currency) currency = req.body.currency;
  let amount = Math.round(await EXCHANGE.convertAmountToSatoshis(req.body.amt, currency));
  let billToken = req.body.bill_token;
  let bill;
  if (billToken) {
    bill = await u.getBill(billToken);
    if (!bill) {
      return errorBadAuth(res);
    }
  } else {
    bill = {
      created_by: '',
    };
  }

  if (config.sunset) return errorSunsetAddInvoice(res);

  const invoice = new Invo(redis, bitcoinclient, lightning);
  const r_preimage = invoice.makePreimageHex();
  lightning.addInvoice(
    {
      memo: req.body.memo,
      value: amount,
      expiry: 3600 * 24,
      r_preimage: Buffer.from(r_preimage, 'hex').toString('base64'),
    },
    async function (err, info) {
      if (err) return errorLnd(res);

      info.pay_req = info.payment_request; // client backwards compatibility
      info.payer = bill.created_by;
      await u.saveUserInvoice(info);
      await invoice.savePreimage(r_preimage);

      res.send(info);
    },
  );
});

router.post('/v2/payinvoice', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  logger.log('/v2/payinvoice', [req.id, u.getUserId(), 'invoice: ' + req.body.invoice]);

  if (!req.body.invoice) return errorBadArguments(res);
  let freeAmount = false;
  if (req.body.amount) {
    freeAmount = parseInt(req.body.amount);
    if (freeAmount <= 0) return errorBadArguments(res);
  }

  // obtaining a lock
  let lock = new Lock(redis, 'v2_invoice_paying_for_' + u.getUserId());
  if (!(await lock.obtainLock())) {
    return errorLockUser(res);
  }

  let userBalance;
  try {
    userBalance = await u.getCalculatedBalance();
  } catch (Error) {
    logger.log('', [req.id, 'error running getCalculatedBalance():', Error.message]);
    lock.releaseLock();
    return errorTryAgainLater(res);
  }

  lightning.decodePayReq({ pay_req: req.body.invoice }, async function (err, info) {
    if (err) {
      await lock.releaseLock();
      return errorNotAValidInvoice(res);
    }

    if (+info.num_satoshis === 0) {
      // 'tip' invoices
      info.num_satoshis = freeAmount;
    }

    logger.log('/v2/payinvoice', [req.id, u.getUserId(), 'userBalance: ' + userBalance, 'num_satoshis: ' + info.num_satoshis]);

    if (userBalance >= +info.num_satoshis + Math.ceil(info.num_satoshis * forwardFee)) {
      // got enough balance, including 1% of payment amount - reserve for fees

      if (identity_pubkey === info.destination) {
        // this is internal invoice
        // now, receiver add balance
        let userid_payee = await u.getUseridByPaymentHash(info.payment_hash);
        if (!userid_payee) {
          await lock.releaseLock();
          return errorGeneralServerError(res);
        }

        if (await u.getPaymentHashPaid(info.payment_hash)) {
          // this internal invoice was paid, no sense paying it again
          await lock.releaseLock();

          callPaymentInvoiceInternal({
            state: 'ERROR',
            message: 'Invoice already paid',
            payment_hash: info.payment_hash,
            user: u.getUserId(),
            amt_paid_sat: info.num_satoshis,
          });
          await lock.releaseLock();
          return res.send({
            status: 'OK',
            message: 'Transaction in progress....',
          });
        }

        let UserPayee = new User(redis, bitcoinclient, lightning);
        UserPayee._userid = userid_payee; // hacky, fixme
        await UserPayee.clearBalanceCache();

        let fees_to_pay = Math.ceil(info.num_satoshis * internalFee);
        // sender spent his balance:
        await u.clearBalanceCache();
        await u.savePaidLndInvoice({
          timestamp: parseInt(+new Date() / 1000),
          type: 'paid_invoice',
          value: +info.num_satoshis + fees_to_pay,
          fee: fees_to_pay,
          memo: decodeURIComponent(info.description),
          pay_req: req.body.invoice,
          payer: u.getUserId(),
          payee: userid_payee,
        });

        const invoice = new Invo(redis, bitcoinclient, lightning);
        invoice.setInvoice(req.body.invoice);
        await invoice.markAsPaidInDatabase();

        // now, faking LND callback about invoice paid:
        const preimage = await invoice.getPreimage();
        if (preimage) {
          callPaymentInvoiceInternal({
            state: 'SETTLED',
            memo: info.description,
            r_preimage: Buffer.from(preimage, 'hex'),
            r_hash: Buffer.from(info.payment_hash, 'hex'),
            amt_paid_sat: +info.num_satoshis,
            fee: fees_to_pay,
            user: u.getUserId(),
          });
        }
        await lock.releaseLock();
        return res.send({
          status: 'OK',
          message: 'Transaction in progress....',
        });
      }

      //External payment request

      if (!info.num_satoshis) {
        // tip invoice, but someone forgot to specify amount
        await lock.releaseLock();
        return errorBadArguments(res);
      }
      let inv = {
        payment_request: req.body.invoice,
        amt: info.num_satoshis, // amt is used only for 'tip' invoices
        fee_limit: { fixed: Math.ceil(info.num_satoshis * forwardFee) },
      };
      try {
        let payInformation = {
          req_id: req.id,
          payment_request: info,
          user: u.getUserId(),
          invoice: req.body.invoice,
          date: new Date(),
        };

        await redis.set(info.payment_hash, JSON.stringify(payInformation));
        await u.lockFunds(req.body.invoice, info);

        logger.log('Payment Invoice Date: ' + payInformation.date, [req.id]);

        paymentStream.write(inv);

        lock.releaseLock();
        return res.send({
          status: 'OK',
          message: 'Transaction in progress....',
        });
      } catch (Err) {
        logger.error('Error procesing payment: ' + JSON.stringify(Err), [req.id]);

        await redis.del(info.payment_hash);
        await lock.releaseLock();
        return errorPaymentFailed(res);
      }
    } else {
      await lock.releaseLock();
      return errorNotEnougBalance(res);
    }
  });
});
/*
router.post('/payinvoice', async function (req, res)
{
    let u = new User(redis, bitcoinclient, lightning);
    if (!(await u.loadByAuthorization(req.headers.authorization)))
    {
        return errorBadAuth(res);
    }

    logger.log('/payinvoice', [req.id, u.getUserId(), 'invoice: ' + req.body.invoice]);

    if (!req.body.invoice) return errorBadArguments(res);
    let freeAmount = false;
    if (req.body.amount)
    {
        freeAmount = parseInt(req.body.amount);
        if (freeAmount <= 0) return errorBadArguments(res);
    }

    // obtaining a lock
    let lock = new Lock(redis, 'invoice_paying_for_' + u.getUserId());
    if (!(await lock.obtainLock()))
    {
        return errorLockUser(res);
    }

    let userBalance;
    try
    {
        userBalance = await u.getCalculatedBalance();
    } catch (Error)
    {
        logger.log('', [req.id, 'error running getCalculatedBalance():', Error.message]);
        lock.releaseLock();
        return errorTryAgainLater(res);
    }

    lightning.decodePa/yReq({ pay_req: req.body.invoice }, async function (err, info)
    {
        if (err)
        {
            await lock.releaseLock();
            return errorNotAValidInvoice(res);
        }

        if (+info.num_satoshis === 0)
        {
            // 'tip' invoices
            info.num_satoshis = freeAmount;
        }

        logger.log('/payinvoice', [req.id, 'userBalance: ' + userBalance, 'num_satoshis: ' + info.num_satoshis]);

        if (userBalance >= +info.num_satoshis + Math.floor(info.num_satoshis * forwardFee) + 1)
        {
            // got enough balance, including 1% of payment amount - reserve for fees

            if (identity_pubkey === info.destination)
            {
                // this is internal invoice
                // now, receiver add balance
                let userid_payee = await u.getUseridByPaymentHash(info.payment_hash);
                if (!userid_payee)
                {
                    await lock.releaseLock();
                    return errorGeneralServerError(res);
                }

                if (await u.getPaymentHashPaid(info.payment_hash))
                {
                    // this internal invoice was paid, no sense paying it again
                    await lock.releaseLock();
                    return errorLnd(res);
                }

                let UserPayee = new User(redis, bitcoinclient, lightning);
                UserPayee._userid = userid_payee; // hacky, fixme
                await UserPayee.clearBalanceCache();

                // sender spent his balance:
                await u.clearBalanceCache();
                await u.savePaidLndInvoice({
                    timestamp: parseInt(+new Date() / 1000),
                    type: 'paid_invoice',
                    value: +info.num_satoshis + Math.floor(info.num_satoshis * internalFee),
                    fee: Math.floor(info.num_satoshis * internalFee),
                    memo: decodeURIComponent(info.description),
                    pay_req: req.body.invoice,
                });

                const invoice = new Invo(redis, bitcoinclient, lightning);
                invoice.setInvoice(req.body.invoice);
                await invoice.markAsPaidInDatabase();

                // now, faking LND callback about invoice paid:
                const preimage = await invoice.getPreimage();
                if (preimage)
                {
                    InvoicesStreamCallback({
                        state: 'SETTLED',
                        memo: info.description,
                        r_preimage: Buffer.from(preimage, 'hex'),
                        r_hash: Buffer.from(info.payment_hash, 'hex'),
                        amt_paid_sat: +info.num_satoshis,
                    });
                }
                await lock.releaseLock();
                return res.send(info);
            }

            // else - regular lightning network payment:

            console.log('Payment Invoice: Payment external invoice...');
            var call = lightning.sendPayment();
            call.on('data', async function (payment)
            {

                console.log('Payment Invoice: processiong response from LND...');

                // payment callback
                await u.unlockFunds(req.body.invoice);
                if (payment && payment.payment_route && payment.payment_route.total_amt_msat)
                {
                    let PaymentShallow = new Paym(false, false, false);
                    payment = PaymentShallow.processSendPaymentResponse(payment);
                    payment.pay_req = req.body.invoice;
                    payment.decoded = info;
                    await u.savePaidLndInvoice(payment);
                    await u.clearBalanceCache();
                    lock.releaseLock();
                    res.send(payment);
                } else
                {
                    // payment failed
                    console.log('Payment Invoice: Failed...');
                    lock.releaseLock();
                    return errorPaymentFailed(res);
                }
            });

            if (!info.num_satoshis)
            {
                // tip invoice, but someone forgot to specify amount
                await lock.releaseLock();
                return errorBadArguments(res);
            }
            let inv = {
                payment_request: req.body.invoice,
                amt: info.num_satoshis, // amt is used only for 'tip' invoices
                fee_limit: { fixed: Math.floor(info.num_satoshis * forwardFee) + 1 },
            };
            try
            {
                await u.lockFunds(req.body.invoice, info);
                call.write(inv);
            } catch (Err)
            {
                await lock.releaseLock();
                return errorPaymentFailed(res);
            }
        } else
        {
            await lock.releaseLock();
            return errorNotEnougBalance(res);
        }

        console.log('Payment Invoice: Finish decodePayReq...');

    });

    console.log('Payment Invoice: Finish method...');

});
*/

router.get('/getbtc', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);
  if (!u.getUserId()) {
    return errorBadAuth(res);
  }
  logger.log('/getbtc', [req.id, u.getUserId()]);

  if (config.sunset) return errorSunsetAddInvoice(res);

  let address = await u.getAddress();
  if (!address) {
    await u.generateAddress();
    address = await u.getAddress();
  }
  u.watchAddress(address);

  res.send([{ address }]);
});

router.get('/checkpayment/:payment_hash', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);
  if (!u.getUserId()) {
    return errorBadAuth(res);
  }
  logger.log('/checkpayment', [req.id, u.getUserId()]);

  let paid = true;
  if (!(await u.getPaymentHashPaid(req.params.payment_hash))) {
    // Not found on cache
    paid = await u.syncInvoicePaid(req.params.payment_hash);
  }
  res.send({ paid: paid });
});

router.get('/balance', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  try {
    if (!(await u.loadByAuthorization(req.headers.authorization))) {
      return errorBadAuth(res);
    }
    logger.log('/balance', [req.id, u.getUserId()]);

    if (!(await u.getAddress())) await u.generateAddress(); // onchain address needed further

    await u.accountForPosibleTxids();

    let wallet = new Wallet(u.getUserId(), Currency.USDC, redis);
    await wallet.loadAccount();
    let stableCoinBalance = await wallet.getBalance();
    let balance = await u.getBalance();

    if (balance < 0) balance = 0;
    res.send({ BTC: { AvailableBalance: balance }, USDC: { AvailableBalance: stableCoinBalance } });
  } catch (Error) {
    logger.log(Error, [req.id, 'error getting balance:', Error, 'userid:', u.getUserId()]);
    return errorGeneralServerError(res);
  }
});

router.get('/getinfo', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/getinfo', [req.id, u.getUserId()]);

  lightning.getInfo({}, function (err, info) {
    if (err) return errorLnd(res);
    res.send(info);
  });
});

router.get('/gettxs', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/gettxs', [req.id, u.getUserId()]);

  if (!(await u.getAddress())) await u.generateAddress(); // onchain addr needed further
  try {
    await u.accountForPosibleTxids();
    let txs = await u.getTxs();
    let lockedPayments = await u.getLockedPayments();
    for (let locked of lockedPayments) {
      txs.push({
        type: 'paid_invoice',
        fee: Math.floor(locked.amount * forwardFee) /* feelimit */,
        value: locked.amount + Math.floor(locked.amount * forwardFee) /* feelimit */,
        timestamp: locked.timestamp,
        memo: 'Payment in transition',
      });
    }
    res.send(txs);
  } catch (Err) {
    logger.log('', [req.id, 'error gettxs:', Err.message, 'userid:', u.getUserId()]);
    res.send([]);
  }
});

router.get('/getuserinvoices', postLimiter, async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/getuserinvoices', [req.id, u.getUserId()]);

  try {
    let invoices = await u.getUserInvoices(req.query.limit);
    res.send(invoices);
  } catch (Err) {
    logger.log('', [req.id, 'error getting user invoices:', Err.message, 'userid:', u.getUserId()]);
    res.send([]);
  }
});

router.get('/getpending', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  logger.log('/getpending', [req.id, u.getUserId()]);

  if (!(await u.getAddress())) await u.generateAddress(); // onchain address needed further
  await u.accountForPosibleTxids();
  let txs = await u.getPendingTxs();
  res.send(txs);
});

router.get('/decodeinvoice', async function (req, res) {
  logger.log('/decodeinvoice', [req.id]);
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!req.query.invoice) return errorGeneralServerError(res);

  lightning.decodePayReq({ pay_req: req.query.invoice }, function (err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

router.get('/checkrouteinvoice', async function (req, res) {
  logger.log('/checkrouteinvoice', [req.id]);
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!req.query.invoice) return errorGeneralServerError(res);

  // at the momment does nothing.
  // TODO: decode and query actual route to destination
  lightning.decodePayReq({ pay_req: req.query.invoice }, function (err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

router.get('/invoice/fee', async function (req, res) {
  logger.log('/invoice/fee', [req.id]);

  let payment = new Paym(redis, bitcoinclient, lightning);
  let paymentRequest = req.query.payment_request;

  await payment.setInvoice(paymentRequest);
  await payment.decodePayReqViaRpc(paymentRequest);

  let routes = await payment.queryRoutes();
  let estimateFee = await payment.estimateFee(routes)
  res.send(estimateFee);

});

router.get('/invoice/routes', async function (req, res) {
  logger.log('/invoice/routes', [req.id]);

  let payment = new Paym(redis, bitcoinclient, lightning);
  let paymentRequest = req.query.payment_request;

  await payment.setInvoice(paymentRequest);
  await payment.decodePayReqViaRpc(paymentRequest);

  let routes = await payment.queryRoutes();
  res.send(routes);

});

router.get('/getchaninfo/:chanid', async function (req, res) {
  logger.log('/getchaninfo', [req.id]);

  if (lightningDescribeGraph && lightningDescribeGraph.edges) {
    for (const edge of lightningDescribeGraph.edges) {
      if (edge.channel_id == req.params.chanid) {
        return res.send(JSON.stringify(edge, null, 2));
      }
    }
  }
  res.send('');
});

// ################# OTP ###########################
router.get('/getotpinfo', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);

  if (!u.getUserId()) {
    return errorBadAuth(res);
  }

  let key = 'otp_secret_for_' + u.getUserId();
  let secret = await redis.get(key);
  if (!secret) {
    var totp = new Totp();
    secret = totp.generateSecret();
    await redis.set(key, secret);
  }

  const otp_url = 'otpauth://totp/LightningChat?secret=' + secret;
  res.send([{ url: otp_url }]);
});

router.post('/checkotp', async function (req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);

  if (!u.getUserId()) {
    return errorBadAuth(res);
  }
  if (!req.body.otp) return errorBadArguments(res);

  let otp = req.body.otp;
  let key = 'otp_secret_for_' + u.getUserId();
  let secret = await redis.get(key);
  if (!secret) {
    res.send([{ check: false }]);
    return;
  }

  var totp = new Totp();

  var result = totp.getOtp(secret, 0) == otp;
  if (!result) result = totp.getOtp(secret, -1) == otp;
  if (!result) result = totp.getOtp(secret, 1) == otp;

  res.send([{ check: result }]);
});

// ################# END OTP ###########################

module.exports = router;

// ################# HELPERS ###########################

function errorBadAuth(res) {
  return res.send({
    error: true,
    code: 1,
    message: 'bad auth',
  });
}

function errorNotEnougBalance(res) {
  return res.send({
    error: true,
    code: 2,
    message: 'not enough balance. Make sure you have at least 1% reserved for potential fees',
  });
}

function errorNotAValidInvoice(res) {
  return res.send({
    error: true,
    code: 4,
    message: 'not a valid invoice',
  });
}

function errorLnd(res) {
  return res.send({
    error: true,
    code: 7,
    message: 'LND failue',
  });
}

function errorGeneralServerError(res) {
  return res.send({
    error: true,
    code: 6,
    message: 'Something went wrong. Please try again later',
  });
}

function errorBadArguments(res) {
  return res.send({
    error: true,
    code: 8,
    message: 'Bad arguments',
  });
}

function errorTryAgainLater(res) {
  return res.send({
    error: true,
    code: 9,
    message: 'Your previous payment is in transit. Try again in 5 minutes',
  });
}

function errorPaymentFailed(res) {
  return res.send({
    error: true,
    code: 10,
    message: 'Payment failed. Does the receiver have enough inbound capacity?',
  });
}

function errorSunset(res) {
  return res.send({
    error: true,
    code: 11,
    message: 'This LNDHub instance is not accepting any more users',
  });
}

function errorSunsetAddInvoice(res) {
  return res.send({
    error: true,
    code: 11,
    message: 'This LNDHub instance is scheduled to shut down. Withdraw any remaining funds',
  });
}

function billNotFound(res) {
  return res.send({
    error: true,
    code: 12,
    message: 'Bill not found',
  });
}

function errorSendCoins(res, message) {
  return res.send({
    error: true,
    code: 13,
    message: 'Error sending coins:: ' + message,
  });
}

function errorSendCoinsMatchLocalAddress(res, message) {
  return res.send({
    error: true,
    code: 14,
    message: 'Please use Lightning Chat for sending balance between users',
  });
}

function errorLockUser(res) {
  return res.send({
    error: true,
    code: 15,
    message: 'User has a active session!',
  });
}

function errorLndEstimateFee(res, message) {
  return res.send({
    error: true,
    code: 16,
    message: 'LND failue: ' + message,
  });
}

function errorLoadStableCoins(res, error) {
  return res.send({
    error: true,
    code: 17,
    message: 'Error loading stable coins: ' + error.message,
    error_object: error,
  });
}

function errorSwapTooSmall(res, message) {
  return res.send({
    error: true,
    code: 18,
    min_swap_sats: message,
    min_swap: config.swap.min_swap_value + ' ' + config.swap.min_swap_currency,
    message: 'Error swap too small: ' + message,
  });
}

function errorUnloadStableCoins(res, error) {
  return res.send({
    error: true,
    code: 19,
    message: 'Error unloading stable coins: ' + error.message,
    error_object: error,
  });
}

function errorBalanceUpperLimit(res, error) {
  return res.send({
    error: true,
    code: 20,
    max_amount_value: config.swap.balanceUpperLimitValue,
    max_amount_currency: config.swap.balanceUpperLimitCurrency,
    message: error.message,
    error_object: error,
  });
}

const Currency = {
  BTC: 'BTC',
  SATS: 'SATS',
  USDT: 'USDT',
  USDC: 'USDC',
};
