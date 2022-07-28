let http = require('http');
let config = require('../../config');
import { HttpUtils } from './Http';

export class WalletMS {
  constructor(redis) {
    this._redis = redis;
    this._httpUtils = new HttpUtils();
  }

  async createAccount(userId) {
    if (!(await this._getWalletId(userId))) {
      let walletId = await this._performCreateAccount(userId);
      await this._saveWalletAccount(userId, walletId);
    }
  }

  async saveTransaction(walletId, userId, amount, currencyOrigin, currencyDestination, transactionId, transactionProviderId, fee) {
    let transactionUrl = config.wallet.transactionUrl.replace('{walletId}', walletId);
    let options = {
      headers: {
        'x-consumer-custom-id': config.wallet.companyId,
        'Content-Type': 'application/json',
      },
      hostname: config.wallet.hostname,
      port: config.wallet.port,
      path: transactionUrl,
      method: 'POST',
    };
    let body = [
      {
        status: 'confirmed',
        amount: amount,
        additional_info: {
          user_id: userId,
          currencyOrigin: currencyOrigin,
          currencyDestination: currencyDestination,
          txId: transactionId,
          txExternalId: transactionProviderId,
          fee: fee,
        },
      },
    ];

    let data = await this._httpUtils.doHttpPostRequest(options, body);
    await this.verifyError(data);
    return data.response[0];
  }

  async getBalance(walletId) {
    let balanceUrl = config.wallet.balanceUrl.replace('{walletId}', walletId);
    let options = {
      headers: {
        'x-consumer-custom-id': config.wallet.companyId,
      },
      hostname: config.wallet.hostname,
      port: config.wallet.port,
      path: balanceUrl,
      method: 'GET',
    };

    let data = await this._httpUtils.doHttpGetRequest(options);
    await this.verifyError(data);
    return data.response;
  }

  activity() {
    return [
      {
        amount: 203,
        timestamp: 1657053914,
      },
      {
        amount: 111,
        timestamp: 1657053914,
      },
    ];
  }

  async verifyError(data) {
    if (data.error) {
      throw { name: 'WalletMSException', code: data.error_information.code, message: data.error_information.message };
    }
  }

  async _performCreateAccount(userId) {
    let options = {
      headers: {
        'x-consumer-custom-id': config.wallet.companyId,
        'Content-Type': 'application/json',
      },
      hostname: config.wallet.hostname,
      port: config.wallet.port,
      path: config.wallet.createAccountUrl,
      method: 'POST',
    };
    let body = {
      currency: 'USDC',
      global_id: userId,
      additional_info: {
        source: 'LightningChat',
      },
    };

    let data = await this._httpUtils.doHttpPostRequest(options, body);
    return data.response.id;
  }

  async _saveWalletAccount(userId, walletId) {
    await this._redis.set('wallet_account_' + userId, new String(walletId));
  }

  async _getWalletId(userId) {
    let data = await this._redis.get('wallet_account_' + userId);
    return parseInt(data);
  }

  async _getWalletIdString(userId) {
    return await this._redis.get('wallet_account_' + userId);
  }
}
