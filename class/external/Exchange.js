let logger = require('../../utils/logger');

export class Exchange {
  constructor(redis) {
    this._redis = redis;
  }

  async convertToCurrency(amount, currencyFrom, currencyTo) {
    if (!currencyFrom) currencyFrom = 'SATS';
    if (!currencyTo) currencyTo = 'SATS';

    let sats = await this.convertAmountToSatoshis(amount, currencyFrom);

    let convertRatio = await this.convertAmountToSatoshis(1, currencyTo);
    return sats / convertRatio;
  }

  async convertAmountToSatoshis(amount, currency) {
    if (!currency) return amount;
    if ('SATS' == currency) return amount;

    let ratio = await this.#getConvertRatioToSatoshis(currency);
    return ratio * amount;
  }

  async #getConvertRatioToSatoshis(currency) {
    if ('SATS' == currency) return 1;
    if ('BTC' == currency) return 100000000;
    if ('EURO' == currency) currency = 'EUR';

    let key = 'convert_ratio_BTC_' + currency;
    let convertRatio = await this._redis.get(key);
    logger.log('exchange.getConvertRatioToSatoshis', ['key:' + key, 'convertRatio: ' + convertRatio]);

    if (!convertRatio) {
      logger.error('Error in getConvertRatioToSatoshis', [currency]);
      throw 'Exchange::getConvertRatioToSatoshis:: Ratio is not defined';
    }
    return 100000000.0 / convertRatio;
  }

}
