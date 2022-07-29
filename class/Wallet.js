import { WalletMS } from './external/WalletMS';
import { Exchange } from './external/Exchange';
import { RipioMS } from './external/RipioMS';
import { MockMS } from './external/MockMS';
import { Currency } from './Currency';

const config = require('../config');
const ERROR_UPPER_LIMIT_CODE = 500;

export class Wallet {
  constructor(userid, currency, redis) {
    this._userid = userid;
    this._masterAccount = config.wallet.masterAccount;
    this._currency = currency;
    this._redis = redis;
    this._walletMs = new WalletMS(this._redis);
    this._exchange = new Exchange(this._redis);
    this._exchangeService = this._createInstanceExchange(redis);
  }

  _createInstanceExchange(redis) {
    if (config.exchangeMs.mockEnable) {
      return new MockMS(redis);
    } else {
      return new RipioMS(redis);
    }
  }

  async loadAccount() {
    await this._walletMs.createAccount(this._userid);
    await this._exchangeService.createAccount(this._userid);
  }

  async getBalance() {
    return await this._walletMs.getBalance(await this.getWalletId(this._userid));
  }

  async getBalanceInSats() {
    let walletBalance = await this._walletMs.getBalance(await this.getWalletId(this._userid));
    return await this._exchange.convertToCurrency(walletBalance, this._currency, 'SATS');
  }

  async loadBalanceAmountToWallet(amountSats, transactionId) {
    await this.#_isAllowedForSwap(amountSats);

    let amountBtc = await this._exchange.convertToCurrency(amountSats, 'SATS', 'BTC');
    let response = await this._exchangeService.loadStableCoin(this._userid, transactionId, amountBtc, 'BTC', this._currency);

    let walletIdMasterAccount = await this.getWalletId(this._masterAccount);
    let walletIdUser = await this.getWalletId(this._userid);
    let amountExchange = response._amountExchange;
    let currencyOrigin = 'BTC';
    let currencyDestination = this._currency;
    let transactionProviderId = response._transactionProviderId;
    let fee = response._fee;

    await this._walletMs.saveTransaction(
      walletIdMasterAccount,
      this._masterAccount,
      amountExchange,
      currencyOrigin,
      currencyDestination,
      transactionId,
      transactionProviderId,
      fee,
    );
    return await this._walletMs.saveTransaction(
      walletIdUser,
      this._userid,
      amountExchange,
      currencyOrigin,
      currencyDestination,
      transactionId,
      transactionProviderId,
      fee,
    );
  }

  async loadStableCoinToBalance(amountSats, transactionId) {
    let amountUSDC = await this._exchange.convertToCurrency(amountSats, 'SATS', this._currency);
    let response = await this._exchangeService.unloadStableCoin(this._userid, transactionId, amountUSDC, this._currency, 'BTC');

    let walletIdMasterAccount = await this.getWalletId(this._masterAccount);
    let walletIdUser = await this.getWalletId(this._userid);
    let amountExchange = response._transactionAmount * -1;
    let currencyOrigin = this._currency;
    let currencyDestination = 'BTC';
    let transactionProviderId = response._transactionProviderId;
    let fee = response._fee;

    await this._walletMs.saveTransaction(
      walletIdMasterAccount,
      this._masterAccount,
      amountExchange,
      currencyOrigin,
      currencyDestination,
      transactionId,
      transactionProviderId,
      fee,
    );
    let transaction = await this._walletMs.saveTransaction(
      walletIdUser,
      this._userid,
      amountExchange,
      currencyOrigin,
      currencyDestination,
      transactionId,
      transactionProviderId,
      fee,
    );
    transaction.amountSats = Math.round(await this._exchange.convertToCurrency(response._transactionAmount, this._currency, 'SATS'));
    return transaction;
  }

  async getWalletId(userId) {
    return this._walletMs._getWalletId(userId);
  }

  async getCurrency() {
    return this._currency;
  }

  async #_isAllowedForSwap(amountSats) {
    await this.#_isBalanceMinorThatUpperLimit(amountSats);
  }

  async #_isBalanceMinorThatUpperLimit(amountSats) {
    let balance = await this.getBalance();
    let amountUSDC = await this._exchange.convertToCurrency(amountSats, Currency.SATS, this._currency);
    let upperLimit = config.swap.balanceUpperLimitValue;
    if (balance + amountUSDC > upperLimit) {
      throw {
        name: 'RestrictionsWalletException',
        code: ERROR_UPPER_LIMIT_CODE,
        message: `Balance upper Limit was exceed. Upper Limit: ${upperLimit} ${this._currency}`
      };
    }
  }
}
